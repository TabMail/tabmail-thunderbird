import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ store: {}, native: new Map(), events: [], query: vi.fn(), resolve: vi.fn(), remove: vi.fn(), sort: vi.fn() }));
vi.mock('../agent/modules/idbStorage.js', () => ({
 get: async keys => Object.fromEntries((Array.isArray(keys)?keys:[keys]).filter(k=>k in h.store).map(k=>[k,h.store[k]])),
 set: async values => { h.events.push('commit'); Object.assign(h.store, values); },
 remove: async keys => { await h.remove(); h.events.push('commit'); for(const k of keys) delete h.store[k]; },
 clear: async () => { h.store={}; }, getAllKeys: async()=>Object.keys(h.store),
 purgeOlderThanByPrefixes: vi.fn(),
}));
vi.mock('../agent/modules/utils.js', () => ({
 getUniqueMessageKey: async m => m?.folder ? `${m.folder.accountId}:${m.folder.path}:${m.headerMessageId}` : null,
 resolveUniqueMessageKey: (...args)=>h.resolve(...args), log: vi.fn(),
}));
vi.mock('../agent/modules/config.js', () => ({ SETTINGS: { actionCache:{repairDebounceMs:1000},actionTagging:{actionPriority:{reply:3,archive:2,delete:1,none:0}} } }));
vi.mock('../agent/modules/tagDefs.js', () => ({triggerSortRefresh:()=>{h.events.push('sort');h.sort();},maxPriorityAction: actions=>['reply','archive','delete','none'].find(a=>actions.includes(a))}));
const folder={id:'inbox',accountId:'acc',path:'/INBOX',specialUse:['inbox']};
const header={id:1,headerMessageId:'synthetic@example.test',folder};
const key='acc:/INBOX:synthetic@example.test';
let owner;
beforeEach(async()=>{
 vi.resetModules(); vi.useFakeTimers(); h.store={};h.native=new Map();h.events=[];h.sort.mockClear();h.remove.mockReset();h.query.mockReset();h.resolve.mockReset();
 h.query.mockResolvedValue({messages:[header,{...header,id:2}]});
 h.resolve.mockResolvedValue({status:'resolved',weIds:[1,2],folder});
 globalThis.browser={messages:{query:h.query,get:async()=>header},tmHdr:{setAction:async(id,a)=>{h.events.push(`paint:${id}:${a}`);h.native.set(id,a);return true;}},tmMessageHeaderChip:{refreshAll:async()=>h.events.push('chips')},tmMultiMessageChip:{refreshAll:async()=>{}},folders:{query:async()=>[folder]},accounts:{list:async()=>[]}};
 owner=await import('../agent/modules/actionCache.js');
});
afterEach(()=>{owner.cleanupActionCache?.();vi.useRealTimers();});
describe('action mutation owner',()=>{
 it('clears the native state of all exact-folder twins after a key-only removal',async()=>{
  h.store[`action:${key}`]='reply';h.native.set(1,'reply');h.native.set(2,'reply');
  await owner.clearActionByUniqueKey(key);
  expect(h.store[`action:${key}`]).toBeUndefined();
  expect([...h.native.values()]).toEqual(['','']);
  expect(h.events).toEqual(['commit','paint:1:','paint:2:','chips','sort']);
 });
 it('projects every set before chips and delays sorting only for changed payloads',async()=>{
  await owner.setAction(header,'reply');
  expect(h.events).toEqual(['commit','paint:1:reply','paint:2:reply','chips','sort']);
  h.events=[];await owner.setAction(header,'reply');expect(h.events).not.toContain('sort');
 });
 it('does not paint a failed removal and keeps the queue usable',async()=>{
  h.store[`action:${key}`]='reply';h.remove.mockRejectedValueOnce(new Error('synthetic transaction failure'));
  await expect(owner.clearActionByUniqueKey(key)).rejects.toThrow('synthetic');
  expect(h.events).toEqual([]);await owner.setAction(header,'none');expect(h.native.get(1)).toBe('none');
 });
 it('lets manual clear defeat every attempt of earlier automatic work',async()=>{
  const token=owner.beginAutomaticWork(key);await owner.clearActionByUniqueKey(key);
  expect(await owner.setAction(header,'reply',{token})).toBeNull();
  expect(await owner.setAction(header,'archive',{token})).toBeNull();
  expect(h.store[`action:${key}`]).toBeUndefined();
 });
});

describe('ordering and recovery boundaries',()=>{
 it('refuses non-inbox writes but clears stale props there',async()=>{
  const outside={...header,folder:{...folder,path:'/Sent',specialUse:['sent']}};
  expect(await owner.setAction(outside,'reply')).toBeNull();expect(h.events).toEqual([]);
  await owner.clearAction(outside);expect(h.native.get(1)).toBe('');
 });
 it('never trusts a supplied WE id when exact-folder resolution fails',async()=>{
  h.query.mockRejectedValue(new Error('synthetic unavailable inventory'));
  await owner.setAction(header,'reply');
  expect(h.native.size).toBe(0);expect(h.store[`action:${key}`]).toBe('reply');
 });
 it('invalidates a token minted while the wipe is awaiting resolution',async()=>{
  h.store[`action:${key}`]='reply';let release;
  h.resolve.mockImplementationOnce(()=>new Promise(r=>{release=r;}));
  const wiping=owner.wipeAll();await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
  const token=owner.beginAutomaticWork(key);release({status:'resolved',weIds:[1],folder});await wiping;
  expect(await owner.setAction(header,'reply',{token})).toBeNull();
  await owner.setAction(header,'none');expect(h.native.get(1)).toBe('none');
 });
 it('serializes same-tick writes through their native projections',async()=>{
  let release;browser.tmHdr.setAction=vi.fn(async(id,a)=>{if(a==='reply'&&id===1)await new Promise(r=>{release=r;});h.native.set(id,a);return true;});
  const first=owner.setAction(header,'reply');const second=owner.setAction(header,'delete');
  await vi.waitFor(()=>expect(release).toBeTypeOf('function'));expect(h.store[`action:${key}`]).toBe('reply');
  release();await Promise.all([first,second]);expect([...h.native.values()]).toEqual(['delete','delete']);
 });
 it('does not resurrect a purged payload with a later timestamp touch',async()=>{
  h.store[`action:${key}`]='reply';h.store[`action:ts:${key}`]={ts:1};
  await owner.purgeExpired({cutoffTs:2});await owner.touchAction(key);
  expect(h.store).toEqual({});
 });
 it('retains expired data when inventory is unknown, but evicts confirmed absence',async()=>{
  h.store[`action:${key}`]='reply';h.resolve.mockResolvedValue({status:'unknown',weIds:[],folder:null});
  await owner.purgeExpired({cutoffTs:2});expect(h.store[`action:${key}`]).toBe('reply');
  h.resolve.mockResolvedValue({status:'absent',weIds:[],folder:null});
  await owner.purgeExpired({cutoffTs:2});expect(h.store[`action:${key}`]).toBeUndefined();
 });
 it('clears metadata-only records without a sort',async()=>{
  h.store[`action:orig:${key}`]='reply';h.store.other='keep';await owner.clearAllActions();
  expect(h.store).toEqual({other:'keep'});expect(h.sort).not.toHaveBeenCalled();
 });
 it('commits write-once metadata with the action and never replaces it',async()=>{
  await owner.setAction(header,'reply',{meta:{orig:'reply',userprompt:'synthetic original'}});
  await owner.setAction(header,'none',{meta:{orig:'none',userprompt:'replacement'}});
  expect(h.store[`action:orig:${key}`]).toBe('reply');expect(h.store[`action:userprompt:${key}`]).toBe('synthetic original');
 });
 it('uses current member actions for effective tagging and skips a missing member',async()=>{
  const other={...header,id:3,headerMessageId:'second@example.test'};
  browser.messages.get=async id=>id===3?other:header;
  h.query.mockImplementation(async({headerMessageId})=>({messages:[headerMessageId===other.headerMessageId?other:header]}));
  h.store[`action:${key}`]='archive';
  expect(await owner.applyThreadEffective([1,3])).toBe(false);
  const otherKey='acc:/INBOX:second@example.test';h.store[`action:${otherKey}`]='archive';
  const manual=owner.setAction(header,'reply');const aggregate=owner.applyThreadEffective([1,3]);await Promise.all([manual,aggregate]);
  expect(h.store[`action:${otherKey}`]).toBe('reply');h.events=[];
  expect(await owner.applyThreadEffective([1,3])).toBe(false);expect(h.events).toEqual([]);
 });
 it('marks a failed twin for symmetric account repair after a clear',async()=>{
  browser.accounts.list=async()=>[{id:'acc'}];browser.messages.list=async()=>({messages:[header]});
  browser.tmHdr.setAction=vi.fn(async(id,a)=>{if(id===2)return false;h.native.set(id,a);return true;});
  browser.tmHdr.setActionsBulk=vi.fn(async entries=>{for(const e of entries)h.native.set(e.weMsgId,e.action);return entries.length;});
  h.store[`action:${key}`]='reply';h.native.set(2,'reply');await owner.clearActionByUniqueKey(key);
  expect(h.native.get(2)).toBe('reply');await vi.advanceTimersByTimeAsync(1000);
  expect(h.native.get(2)).toBe('');expect(browser.tmHdr.setActionsBulk).toHaveBeenCalledOnce();
 });
});
