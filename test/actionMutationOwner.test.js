import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ store: {}, native: new Map(), events: [], query: vi.fn(), resolve: vi.fn(), remove: vi.fn(), sort: vi.fn(), clear: vi.fn() }));
vi.mock('../agent/modules/idbStorage.js', () => ({
 get: async keys => Object.fromEntries((Array.isArray(keys)?keys:[keys]).filter(k=>k in h.store).map(k=>[k,h.store[k]])),
 set: async values => { h.events.push('commit'); Object.assign(h.store, values); },
 remove: async keys => { await h.remove(); h.events.push('commit'); for(const k of keys) delete h.store[k]; },
 clear: async () => { await h.clear(); h.store={}; }, getAllKeys: async()=>Object.keys(h.store),
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
 vi.resetModules(); vi.useFakeTimers(); h.store={};h.native=new Map();h.events=[];h.sort.mockClear();h.clear.mockReset();h.remove.mockReset();h.query.mockReset();h.resolve.mockReset();
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
 it('invalidates a token minted while the wipe is awaiting commit',async()=>{
  h.store[`action:${key}`]='reply';let release;
  h.clear.mockImplementationOnce(()=>new Promise(r=>{release=r;}));
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
 it('keeps canonical state on projection failure without autonomous scans',async()=>{
  browser.accounts.list=vi.fn(async()=>[{id:'acc'}]);
  browser.tmHdr.setAction=vi.fn(async()=>false);
  await owner.setAction(header,'reply');
  expect(h.store[`action:${key}`]).toBe('reply');
  await vi.advanceTimersByTimeAsync(10000);
  expect(browser.accounts.list).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
  browser.tmHdr.setAction=async(id,a)=>{h.native.set(id,a);return true;};
  await owner.setAction(header,'none');expect([...h.native.values()]).toEqual(['none','none']);
 });
});


describe('mutation boundary regression coverage',()=>{
 it('wipes non-action storage as well as actions and invalidates earlier work',async()=>{
  h.store={other:'synthetic', [`action:${key}`]:'reply'};
  const token=owner.beginAutomaticWork(key);
  await owner.wipeAll();
  expect(h.store).toEqual({});
  expect(await owner.setAction(header,'reply',{token})).toBeNull();
 });
 it('rejects invalid action values without committing or projecting',async()=>{
  expect(await owner.setAction(header,'invalid')).toBeNull();
  expect(h.store).toEqual({});expect(h.events).toEqual([]);
 });
 it('refreshes both chip surfaces after a successful mutation',async()=>{
  browser.tmMultiMessageChip.refreshAll=vi.fn();
  await owner.setAction(header,'archive');
  expect(browser.tmMultiMessageChip.refreshAll).toHaveBeenCalledOnce();
 });
 it('excludes non-inbox thread members and projects the changed inbox member',async()=>{
  const second={...header,id:3,headerMessageId:'second@example.test'};
  const outside={...header,id:4,headerMessageId:'outside@example.test',folder:{...folder,specialUse:['sent'],path:'/Sent'}};
  browser.messages.get=async id=>({1:header,3:second,4:outside}[id]);
  h.query.mockImplementation(async({headerMessageId})=>({messages:[headerMessageId===second.headerMessageId?second:header]}));
  h.store[`action:${key}`]='archive';h.store['action:acc:/INBOX:second@example.test']='reply';
  h.store['action:acc:/Sent:outside@example.test']='delete';
  expect(await owner.applyThreadEffective([1,3,4])).toBe(true);
  expect(h.native.get(1)).toBe('reply');expect(h.native.has(4)).toBe(false);
  expect(h.store['action:acc:/Sent:outside@example.test']).toBe('delete');
 });
 it('removes the registered account and folder listeners on cleanup',async()=>{
  browser.accounts.onCreated={addListener:vi.fn(),removeListener:vi.fn()};
  browser.folders.onCreated={addListener:vi.fn(),removeListener:vi.fn()};
  await owner.pushAllActionsToExperimentsOnStartup();owner.cleanupActionCache();
  expect(browser.accounts.onCreated.removeListener).toHaveBeenCalledWith(browser.accounts.onCreated.addListener.mock.calls[0][0]);
  expect(browser.folders.onCreated.removeListener).toHaveBeenCalledWith(browser.folders.onCreated.addListener.mock.calls[0][0]);
 });
 it('backfills every listed chunk and page without rescanning the folder',async()=>{
  const messages=Array.from({length:103},(_,i)=>({...header,id:i+10,headerMessageId:`page-${i}@example.test`}));
  const twins=[{...messages[0],id:1000},{...messages[0],id:1001}];
  browser.messages.list=vi.fn(async()=>({messages:messages.slice(0,101),id:'inbox-next'}));
  let inboxPage=0;
  browser.messages.continueList=vi.fn(async()=>++inboxPage===1
   ?{messages:[messages[101],twins[0]],id:'inbox-next'}
   :{messages:[messages[102],twins[1]],id:null});
  h.store['action:acc:/INBOX:page-0@example.test']='reply';
  browser.tmHdr.setActionsBulk=vi.fn(async entries=>{for(const e of entries)h.native.set(e.weMsgId,e.action);return entries.length;});
  expect(await owner.backfillAccount('acc')).toBe(true);
  expect(browser.tmHdr.setActionsBulk.mock.calls.map(([entries])=>entries.length)).toEqual([100,1,2,2]);
  expect(h.native.size).toBe(105);
  for(const m of [messages[0],...twins])expect(h.native.get(m.id)).toBe('reply');
  expect(h.native.get(messages[102].id)).toBe('');
  expect(h.query).not.toHaveBeenCalled();
  expect(browser.messages.continueList).toHaveBeenCalledTimes(2);
  expect(browser.messages.continueList).toHaveBeenCalledWith('inbox-next');
 });
});

it('routes metadata retention through the serialized owner',async()=>{
 const idb=await import('../agent/modules/idbStorage.js');
 await owner.purgeMetadataOlderThan(123);
 expect(idb.purgeOlderThanByPrefixes).toHaveBeenCalledWith(owner.METADATA_PREFIXES,123);
});

describe('lifecycle outcomes for work without an existing row',()=>{
 it.each(['wipe','suspend'])('refuses pre-%s work and accepts newly-started work',async transition=>{
  const token=owner.beginAutomaticWork(key);
  expect(h.store[`action:${key}`]).toBeUndefined();
  if(transition==='wipe')await owner.wipeAll();else owner.cleanupActionCache();
  expect(await owner.setAction(header,'reply',{token,meta:{userprompt:'synthetic old prompt'}})).toBeNull();
  expect(h.store).toEqual({});expect(h.native.size).toBe(0);
  const fresh=owner.beginAutomaticWork(key);
  await owner.setAction(header,'archive',{token:fresh});
  expect(h.store[`action:${key}`]).toBe('archive');
  expect([...h.native.values()]).toEqual(['archive','archive']);
 });
 it('does not let a recovered old identity overwrite a manual action at a different identity',async()=>{
  const oldToken=owner.beginAutomaticWork('acc:/PreviousInbox:synthetic@example.test');
  await owner.setAction(header,'delete');
  h.events=[];
  expect(await owner.setAction(header,'reply',{token:oldToken})).toBeNull();
  expect(h.store[`action:${key}`]).toBe('delete');
  expect([...h.native.values()]).toEqual(['delete','delete']);expect(h.events).toEqual([]);
  await owner.setAction(header,'archive',{token:owner.beginAutomaticWork(key)});
  expect(h.store[`action:${key}`]).toBe('archive');expect([...h.native.values()]).toEqual(['archive','archive']);
 });
});
