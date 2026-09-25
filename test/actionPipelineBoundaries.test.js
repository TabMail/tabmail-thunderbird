/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

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
 resolveUniqueMessageKey: (...args)=>h.resolve(...args), log: vi.fn(), indexHeader: vi.fn(), extractBodyFromParts:async()=>'', stripHtml:x=>x, safeGetFull:async()=>({body:'synthetic body'}), saveChatLog:vi.fn(), getRealSubject:async()=> 'Synthetic subject', getUniqueMessageKeyCandidates:()=>[],
}));
vi.mock('../agent/modules/config.js', () => ({ SETTINGS: { actionTagging:{actionPriority:{reply:3,archive:2,delete:1,none:0}} } }));
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
afterEach(()=>{owner.cleanupActionCache?.();vi.clearAllTimers();vi.useRealTimers();});

const dependencies=vi.hoisted(()=>({reply:vi.fn(),chat:vi.fn(),peer:vi.fn(),summary:vi.fn(),internal:vi.fn()}));
vi.mock('../chat/modules/helpers.js',()=>({getUserName:async()=> 'Example User'}));
vi.mock('../agent/modules/summaryGenerator.js',()=>({getSummary:(...a)=>dependencies.summary(...a),purgeExpiredSummaryEntries:async()=>{}}));
vi.mock('../agent/modules/messagePrefilter.js',()=>({analyzeEmailForReplyFilter:async()=>({skipCachedReply:false})}));
vi.mock('../agent/modules/senderFilter.js',()=>({isInternalSender:(...a)=>dependencies.internal(...a)}));
vi.mock('../agent/modules/replyGenerator.js',()=>({createReply:(...args)=>dependencies.reply(...args),purgeExpiredReplyEntries:async()=>{}}));
vi.mock('../agent/modules/tagHelper.js',()=>({runThreadAggregation:async()=>{},applyPriorityTag:async(_id,action)=>owner.setAction(header,action)}));
vi.mock('../agent/modules/promptGenerator.js',()=>({getUserActionPrompt:async()=>''}));
vi.mock('../agent/modules/deviceSync.js',()=>({probeAICache:(...a)=>dependencies.peer(...a)}));
vi.mock('../agent/modules/llm.js',()=>({sendChat:(...args)=>dependencies.chat(...args),processJSONResponse:JSON.parse}));
vi.mock('../agent/modules/proactiveCheckin.js',()=>({onInboxUpdated:async()=>{}}));

beforeEach(async()=>{
 dependencies.reply.mockReset().mockResolvedValue({});
 dependencies.chat.mockReset().mockResolvedValue({assistant:'{"action":"archive"}'});
 dependencies.peer.mockReset().mockResolvedValue(null);
 dependencies.summary.mockReset().mockResolvedValue({id:key,blurb:'Synthetic summary',todos:''});
 dependencies.internal.mockReset().mockResolvedValue(false);
 const {SETTINGS}=await import('../agent/modules/config.js');
 SETTINGS.actionGenerationParallelCalls=1;
 SETTINGS.agentQueues={processMessage:{watchIntervalMs:0,kickDelayMs:-1,persistDebounceMs:0,batchSize:100,retryDelayMs:10000,itemTimeoutMs:120000}};
 browser.storage={local:{get:async()=>({}),set:async()=>{}}};
});
const waitStarted=async f=>{for(let n=0;n<250&&!f();n++)await Promise.resolve();expect(f()).toBeTruthy();};
it('clear-all overrides an older user recompute on a cache miss; fresh user work remains usable',async()=>{
 h.resolve.mockResolvedValue({weID:1,weFolder:folder,headerID:header.headerMessageId});
 let release;dependencies.chat.mockImplementationOnce(()=>new Promise(r=>{release=r;}));
 const queue=await import('../agent/modules/messageProcessorQueue.js');
 await queue.enqueueProcessMessage(header,{forceRecompute:true,source:'contextMenu:recomputeAction'});
 const old=queue.drainProcessMessageQueue();await waitStarted(()=>release);
 expect(h.store['action:'+key]).toBeUndefined();
 await owner.clearAllActions();
 expect(h.store['action:'+key]).toBeUndefined();
 release({assistant:'{"action":"reply"}'});await old;
 const afterOld={durable:h.store['action:'+key],native:h.native.get(1)};
 await queue.enqueueProcessMessage(header,{forceRecompute:true,source:'contextMenu:recomputeAction'});
 await queue.drainProcessMessageQueue();
 expect(queue.getProcessMessageQueueStatus().pending).toBe(0);
 expect(h.store['action:'+key]).toBe('archive');expect(h.native.get(1)).toBe('archive');
 expect(afterOld).toEqual({durable:undefined,native:undefined});
});
it('stale peer response preserves newer manual action; fresh generation still commits',async()=>{
 const {getAction}=await import('../agent/modules/actionGenerator.js');
 let release;dependencies.peer.mockImplementationOnce(()=>new Promise(r=>{release=r;}));
 const old=getAction(header);await waitStarted(()=>release);
 await owner.setAction(header,'delete');
 expect(h.store['action:'+key]).toBe('delete');expect(h.native.get(1)).toBe('delete');
 release('reply');await old;
 const afterOld={durable:h.store['action:'+key],native:h.native.get(1)};
 expect(dependencies.chat).not.toHaveBeenCalled();
 await getAction(header,{forceRecompute:true});
 expect(h.store['action:'+key]).toBe('archive');expect(h.native.get(1)).toBe('archive');
 expect(afterOld).toEqual({durable:'delete',native:'delete'});
});
it('all exact-folder twins are painted and cleared across query pagination, preserving unrelated rows',async()=>{
 const twins=Array.from({length:101},(_,n)=>({...header,id:n+1}));
 h.query.mockResolvedValue({id:'reused-list',messages:twins.slice(0,100)});
 browser.messages.continueList=vi.fn(async()=>({messages:twins.slice(100)}));
 for(const twin of twins)h.native.set(twin.id,'delete');h.native.set(999,'none');
 await owner.setAction(header,'reply');
 const projected=twins.map(t=>h.native.get(t.id));
 expect(h.store['action:'+key]).toBe('reply');
 await owner.clearActions([{header}]);
 expect(h.store['action:'+key]).toBeUndefined();
 expect(twins.map(t=>h.native.get(t.id))).toEqual(Array(101).fill(''));
 expect(projected).toEqual(Array(101).fill('reply'));expect(h.native.get(999)).toBe('none');
});
it('a failed continuation retains canonical state and prevents partial native mutation',async()=>{
 h.query.mockResolvedValue({id:'list',messages:[header]});
 browser.messages.continueList=vi.fn(async()=>{throw Error('synthetic unavailable page');});
 h.native.set(1,'delete');h.native.set(999,'none');
 await owner.setAction(header,'reply');
 expect(h.store['action:'+key]).toBe('reply');expect(h.native.get(1)).toBe('delete');
 h.query.mockResolvedValue({messages:[header]});
 await owner.setAction(header,'reply');
 expect(h.native.get(1)).toBe('reply');expect(h.native.get(999)).toBe('none');
});
it('newer thread-effective action defeats older recompute and allows fresh work',async()=>{
 const other={...header,id:3,headerMessageId:'other@example.test'};
 browser.messages.get=async id=>id===3?other:header;
 h.query.mockImplementation(async q=>({messages:q.headerMessageId===other.headerMessageId?[other]:[header]}));
 await owner.setAction(header,'none');await owner.setAction(other,'reply');
 const {getAction}=await import('../agent/modules/actionGenerator.js');
 let release;dependencies.chat.mockImplementationOnce(()=>new Promise(r=>{release=r;}));
 const old=getAction(header,{forceRecompute:true});await waitStarted(()=>release);
 await owner.applyThreadEffective([1,3]);
 expect(h.store['action:'+key]).toBe('reply');expect(h.native.get(1)).toBe('reply');
 release({assistant:'{"action":"delete"}'});await old;
 const afterOld={durable:h.store['action:'+key],native:h.native.get(1)};
 await getAction(header,{forceRecompute:true});
 expect(h.store['action:'+key]).toBe('archive');expect(h.native.get(1)).toBe('archive');
 expect(afterOld).toEqual({durable:'reply',native:'reply'});
});
it('an older internal queue item cannot repopulate a completed wipe; fresh work can',async()=>{
 h.resolve.mockResolvedValue({weID:1,weFolder:folder,headerID:header.headerMessageId});
 dependencies.internal.mockResolvedValue(true);
 let release;dependencies.summary.mockImplementationOnce(()=>new Promise(r=>{release=r;}));
 const queue=await import('../agent/modules/messageProcessorQueue.js');
 await queue.enqueueProcessMessage(header);
 const old=queue.drainProcessMessageQueue();await waitStarted(()=>release);
 await owner.wipeAll();expect(h.store).toEqual({});
 release({id:key,blurb:'Synthetic summary'});await old;
 const afterOld={durable:h.store['action:'+key],native:h.native.get(1)};
 await queue.enqueueProcessMessage(header);await queue.drainProcessMessageQueue();
 expect(h.store['action:'+key]).toBe('none');expect(h.native.get(1)).toBe('none');
 expect(queue.getProcessMessageQueueStatus().pending).toBe(0);
 expect(afterOld).toEqual({durable:undefined,native:undefined});
});

it('invalid generated action remains retryable and a valid retry writes both stores',async()=>{
 h.resolve.mockResolvedValue({weID:1,weFolder:folder,headerID:header.headerMessageId});
 dependencies.chat.mockResolvedValueOnce({assistant:'{"action":"snooze"}'});
 const queue=await import('../agent/modules/messageProcessorQueue.js');
 await queue.enqueueProcessMessage(header); await queue.drainProcessMessageQueue();
 const afterInvalid={pending:queue.getProcessMessageQueueStatus().pending,durable:h.store['action:'+key],native:h.native.get(1)};
 await queue.drainProcessMessageQueue();
 expect(afterInvalid).toEqual({pending:1,durable:undefined,native:undefined});
 expect(dependencies.chat).toHaveBeenCalledTimes(2);
 expect({pending:queue.getProcessMessageQueueStatus().pending,durable:h.store['action:'+key],native:h.native.get(1)}).toEqual({pending:0,durable:'archive',native:'archive'});
});

vi.mock('../agent/modules/autoUpdateUserPrompt.js',()=>({autoUpdateUserPromptOnTag:vi.fn()}));
vi.mock('../agent/modules/messageDebugDump.js',()=>({debugDumpSelectedMessages:vi.fn()}));
vi.mock('../agent/modules/tagCleanup.js',()=>({clearTabMailActionTags:vi.fn()}));
vi.mock('../agent/modules/userNotice.js',()=>({notifyCannotTagSelf:vi.fn()}));
it('actual recompute menu clears selected state before creating durable fresh work',async()=>{
 let listener;const created=[];let disk={debugMode:true};
 browser.storage.local={get:async()=>structuredClone(disk),set:async v=>Object.assign(disk,structuredClone(v)),remove:async keys=>{for(const k of [].concat(keys))delete disk[k];}};
 browser.menus={removeAll:async()=>{},create:v=>created.push(v),refresh:async()=>{},onClicked:{addListener:f=>{listener=f;},removeListener:()=>{}},onShown:{addListener:()=>{},removeListener:()=>{}}};
 h.resolve.mockResolvedValue({weID:1,weFolder:folder,headerID:header.headerMessageId});
 await owner.setAction(header,'reply',{meta:{orig:'reply',userprompt:'synthetic old prompt'}});
 h.store.unrelated='keep';h.native.set(999,'none');
 const menus=await import('../agent/modules/contextMenus.js');const queue=await import('../agent/modules/messageProcessorQueue.js');
 expect(listener).toBeTypeOf('function'); // Primed before asynchronous menu reconstruction.
 await listener({menuItemId:'tabmail-agent-recompute-action',selectedMessages:{messages:[header]}});
 await menus.initContextMenus();expect(created.some(m=>m.id==='tabmail-agent-recompute-action')).toBe(true);
 expect(h.store['action:'+key]).toBeUndefined();expect(h.store['action:orig:'+key]).toBeUndefined();expect(h.native.get(1)).toBe('');
 expect(queue.getProcessMessageQueueStatus().pending).toBe(1);expect(disk.agent_processmessage_pending).toHaveLength(1);
 await queue.drainProcessMessageQueue();
 expect({action:h.store['action:'+key],native:h.native.get(1),orig:h.store['action:orig:'+key],pending:queue.getProcessMessageQueueStatus().pending}).toEqual({action:'archive',native:'archive',orig:'archive',pending:0});
 expect(h.store.unrelated).toBe('keep');expect(h.native.get(999)).toBe('none');expect(disk.agent_processmessage_pending).toBeUndefined();
 await queue.cleanupProcessMessageQueue();menus.cleanupContextMenus();
});
it('ordinary menu clicks work before and during menu reconstruction without stacking listeners',async()=>{
 const clicked=new Set(),created=[];
 let releaseRemove;
 browser.menus={removeAll:vi.fn(()=>new Promise(resolve=>{releaseRemove=resolve;})),create:item=>created.push(item.id),refresh:async()=>{},
  onClicked:{addListener:fn=>clicked.add(fn),removeListener:fn=>clicked.delete(fn)},
  onShown:{addListener:()=>{},removeListener:()=>{}}};
 browser.storage.local.get=async()=>({debugMode:false});
 h.native.set(999,'archive');h.store.unrelated='keep';
 const menus=await import('../agent/modules/contextMenus.js');
 expect(clicked.size).toBe(1);
 const click=[...clicked][0];
 const commands=[['tabmail-agent-tag-reply','reply'],['tabmail-agent-tag-archive','archive'],['tabmail-agent-tag-delete','delete'],['tabmail-agent-remove-tag','none']];
 await click({menuItemId:commands[0][0],selectedMessages:{messages:[header]}});
 expect(h.store['action:'+key]).toBe('reply');expect(h.native.get(1)).toBe('reply');
 const initializing=menus.initContextMenus();
 expect(browser.menus.removeAll).toHaveBeenCalledTimes(1);
 for(const [menuItemId,action] of commands.slice(1)){
  await click({menuItemId,selectedMessages:{messages:[header]}});
  expect(h.store['action:'+key]).toBe(action);expect(h.native.get(1)).toBe(action);
 }
 expect(h.store.unrelated).toBe('keep');expect(h.native.get(999)).toBe('archive');
 releaseRemove();await initializing;
 expect(created).toEqual(expect.arrayContaining(commands.map(([id])=>id)));
 expect([...clicked]).toEqual([click]);
 menus.cleanupContextMenus();expect(clicked.size).toBe(0);
});
it('menu events keep one stable owner across repeated init and cleanup',async()=>{
 const clicked=new Set(),shown=new Set();
 const addClicked=vi.fn(fn=>clicked.add(fn)),addShown=vi.fn(fn=>shown.add(fn));
 browser.menus={removeAll:async()=>{},create:()=>{},refresh:async()=>{},
  onClicked:{addListener:addClicked,removeListener:fn=>clicked.delete(fn)},
  onShown:{addListener:addShown,removeListener:fn=>shown.delete(fn)}};
 const menus=await import('../agent/modules/contextMenus.js');
 expect(clicked.size).toBe(1);expect(shown.size).toBe(0);
 const click=[...clicked][0];
 await menus.initContextMenus();await menus.initContextMenus();
 expect(shown.size).toBe(1);
 expect(addClicked).toHaveBeenCalledTimes(1);expect(addShown).toHaveBeenCalledTimes(1);
 menus.cleanupContextMenus();expect(clicked.size).toBe(0);expect(shown.size).toBe(0);
 await menus.initContextMenus();
 expect([...clicked]).toEqual([click]);expect(shown.size).toBe(1);
 expect(addClicked).toHaveBeenCalledTimes(2);expect(addShown).toHaveBeenCalledTimes(2);
 menus.cleanupContextMenus();
});
it('unknown member lookup prevents partial thread writes while a complete retry succeeds',async()=>{
 const other={...header,id:3,headerMessageId:'other@example.test'};
 h.query.mockImplementation(async q=>({messages:q.headerMessageId===other.headerMessageId?[other]:[header]}));
 await owner.setAction(header,'archive');await owner.setAction(other,'reply');
 browser.messages.get=async id=>{if(id===4)throw Error('synthetic lookup unavailable');return id===3?other:header;};
 h.events=[];
 expect(await owner.applyThreadEffective([1,3,4])).toBe(false);
 expect(h.store['action:'+key]).toBe('archive');expect(h.native.get(1)).toBe('archive');expect(h.events).toEqual([]);
 expect(await owner.applyThreadEffective([1,3])).toBe(true);
 expect(h.store['action:'+key]).toBe('reply');expect(h.native.get(1)).toBe('reply');
});

it('actual menu replaces retained failed work with an effective new recompute',async()=>{
 let listener;const disk={debugMode:true};
 browser.storage.local={get:async()=>structuredClone(disk),set:async v=>Object.assign(disk,structuredClone(v)),remove:async keys=>{for(const k of [].concat(keys))delete disk[k];}};
 browser.menus={removeAll:async()=>{},create:()=>{},refresh:async()=>{},onClicked:{addListener:f=>{listener=f;},removeListener:()=>{}},onShown:{addListener:()=>{},removeListener:()=>{}}};
 h.resolve.mockResolvedValue({weID:1,weFolder:folder,headerID:header.headerMessageId});
 const queue=await import('../agent/modules/messageProcessorQueue.js');
 dependencies.reply.mockRejectedValueOnce(Error('synthetic temporary reply failure'));
 await queue.enqueueProcessMessage(header);await queue.drainProcessMessageQueue();
 expect(queue.getProcessMessageQueueStatus().pending).toBe(1);expect(h.store[owner.payloadKey(key)]).toBe('archive');
 dependencies.chat.mockResolvedValue({assistant:'{"action":"delete"}'});
 const menus=await import('../agent/modules/contextMenus.js');await menus.initContextMenus();
 await listener({menuItemId:'tabmail-agent-recompute-action',selectedMessages:{messages:[header]}});
 expect(h.store[owner.payloadKey(key)]).toBeUndefined();expect(disk.agent_processmessage_pending).toHaveLength(1);
 await queue.drainProcessMessageQueue();expect(queue.getProcessMessageQueueStatus().pending).toBe(0);
 expect(h.store[owner.payloadKey(key)]).toBe('delete');expect(h.native.get(1)).toBe('delete');
 await queue.cleanupProcessMessageQueue();menus.cleanupContextMenus();
});
it.each(['outside','gone'])('%s terminal work leaves no retained cancellation authority',async mode=>{
 const queue=await import('../agent/modules/messageProcessorQueue.js');
 const begin=owner.beginAutomaticWork,tokens=[],messages=[];
 const spy=vi.spyOn(owner,'beginAutomaticWork').mockImplementation(key=>{const token=begin(key);tokens.push(token);return token;});
 try {
 for(let n=0;n<20;n++){
  const message={...header,id:100+n,headerMessageId:`terminal-${n}@example.test`};messages.push(message);
  h.resolve.mockResolvedValue({weID:message.id,weFolder:folder,headerID:message.headerMessageId});
  if(mode==='outside'){h.resolve.mockResolvedValue(null);h.query.mockResolvedValue({messages:[{...message,folder:{...folder,path:'/Sent',specialUse:['sent']}}]});}
  else{
   browser.messages.get=vi.fn().mockResolvedValueOnce(message).mockRejectedValueOnce(Error('synthetic message disappeared'));
   dependencies.summary.mockResolvedValueOnce(null);dependencies.chat.mockResolvedValueOnce({assistant:'{"action":"invalid"}'});
  }
  await queue.enqueueProcessMessage(message);for(let attempt=0;attempt<(mode==='outside'?5:1);attempt++)await queue.drainProcessMessageQueue();
  expect(queue.getProcessMessageQueueStatus().pending).toBe(0);
 }
 expect(h.store).toEqual({});expect(h.native.size).toBe(0);
 expect(tokens).toHaveLength(20);
 for(let n=0;n<20;n++)expect(await owner.setAction(messages[n],'reply',{token:tokens[n]})).toBeNull();
 expect(h.store).toEqual({});expect(h.native.size).toBe(0);
 browser.messages.get=async()=>header;h.query.mockResolvedValue({messages:[header,{...header,id:2}]});h.resolve.mockResolvedValue({weID:1,weFolder:folder,headerID:header.headerMessageId});
 await queue.enqueueProcessMessage(header);await queue.drainProcessMessageQueue();
 expect(h.store[owner.payloadKey(key)]).toBe('archive');expect(h.native.get(1)).toBe('archive');
 } finally {spy.mockRestore();await queue.cleanupProcessMessageQueue();}
});

it('older completion cannot consume a later actual menu recompute',async()=>{
 let listener;const disk={debugMode:true};
 browser.storage.local={get:async()=>structuredClone(disk),set:async v=>Object.assign(disk,structuredClone(v)),remove:async keys=>{for(const k of [].concat(keys))delete disk[k];}};
 browser.menus={removeAll:async()=>{},create:()=>{},refresh:async()=>{},onClicked:{addListener:f=>{listener=f;},removeListener:()=>{}},onShown:{addListener:()=>{},removeListener:()=>{}}};
 h.resolve.mockResolvedValue({weID:1,weFolder:folder,headerID:header.headerMessageId});
 const queue=await import('../agent/modules/messageProcessorQueue.js');
 let release;dependencies.chat.mockImplementationOnce(()=>new Promise(r=>{release=r;})).mockResolvedValue({assistant:'{"action":"delete"}'});
 await queue.enqueueProcessMessage(header,{forceRecompute:true});const old=queue.drainProcessMessageQueue();await waitStarted(()=>release);
 const menus=await import('../agent/modules/contextMenus.js');await menus.initContextMenus();
 await listener({menuItemId:'tabmail-agent-recompute-action',selectedMessages:{messages:[header]}});
 release({assistant:'{"action":"reply"}'});await old;
 expect(queue.getProcessMessageQueueStatus().pending).toBe(1);expect(disk.agent_processmessage_pending).toHaveLength(1);
 expect(h.store[owner.payloadKey(key)]).toBeUndefined();expect(h.native.get(1)).toBe('');
 await queue.drainProcessMessageQueue();expect(queue.getProcessMessageQueueStatus().pending).toBe(0);
 expect(h.store[owner.payloadKey(key)]).toBe('delete');expect(h.native.get(1)).toBe('delete');
 await queue.cleanupProcessMessageQueue();menus.cleanupContextMenus();
});
