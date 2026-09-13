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
vi.mock('../agent/modules/tagHelper.js',()=>({runThreadAggregation:async()=>{}}));
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
