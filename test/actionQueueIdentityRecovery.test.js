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
const folder={id:'inbox',accountId:'acc',path:'/Parent/Inbox',name:'Inbox',specialUse:[]};
const header={id:1,headerMessageId:'synthetic@example.test',folder};
const key='acc:/Parent/Inbox:synthetic@example.test';
let owner;
beforeEach(async()=>{
 vi.resetModules(); vi.useFakeTimers(); h.store={};h.native=new Map();h.events=[];h.sort.mockClear();h.remove.mockReset();h.query.mockReset();h.resolve.mockReset();
 h.query.mockResolvedValue({messages:[header,{...header,id:2}]});
 h.resolve.mockResolvedValue({status:'resolved',weIds:[1,2],folder});
 globalThis.browser={messages:{query:h.query,get:async()=>header},tmHdr:{setAction:async(id,a)=>{h.events.push(`paint:${id}:${a}`);h.native.set(id,a);return true;}},tmMessageHeaderChip:{refreshAll:async()=>h.events.push('chips')},tmMultiMessageChip:{refreshAll:async()=>{}},folders:{query:async()=>[folder]},accounts:{list:async()=>[]}};
 owner=await import('../agent/modules/actionCache.js');
});
afterEach(()=>{owner.cleanupActionCache?.();vi.clearAllTimers();vi.useRealTimers();});

const dependencies=vi.hoisted(()=>({reply:vi.fn(),chat:vi.fn()}));
vi.mock('../chat/modules/helpers.js',()=>({getUserName:async()=> 'Example User'}));
vi.mock('../agent/modules/summaryGenerator.js',()=>({getSummary:async m=>({id:m.folder.accountId+':'+m.folder.path+':'+m.headerMessageId,blurb:'Synthetic summary',todos:''}),purgeExpiredSummaryEntries:async()=>{}}));
vi.mock('../agent/modules/messagePrefilter.js',()=>({analyzeEmailForReplyFilter:async()=>({skipCachedReply:false})}));
vi.mock('../agent/modules/senderFilter.js',()=>({isInternalSender:async()=>false}));
vi.mock('../agent/modules/replyGenerator.js',()=>({createReply:(...args)=>dependencies.reply(...args),purgeExpiredReplyEntries:async()=>{}}));
vi.mock('../agent/modules/tagHelper.js',()=>({runThreadAggregation:async()=>{},applyActionTags:async(messages,actions)=>{const owner=await import('../agent/modules/actionCache.js');for(const m of messages)await owner.setAction(m,actions[m.folder.accountId+':'+m.folder.path+':'+m.headerMessageId]);}}));
vi.mock('../agent/modules/promptGenerator.js',()=>({getUserActionPrompt:async()=>''}));
vi.mock('../agent/modules/deviceSync.js',()=>({probeAICache:async()=>null}));
vi.mock('../agent/modules/llm.js',()=>({sendChat:(...args)=>dependencies.chat(...args),processJSONResponse:JSON.parse}));
vi.mock('../agent/modules/proactiveCheckin.js',()=>({onInboxUpdated:async()=>{}}));

it('discards obsolete cross-path work and permits fresh current-identity processing',async()=>{
 const {SETTINGS}=await import('../agent/modules/config.js');
 SETTINGS.actionGenerationParallelCalls=1;
 SETTINGS.agentQueues={processMessage:{watchIntervalMs:0,kickDelayMs:-1,persistDebounceMs:0,batchSize:100,retryDelayMs:10000,itemTimeoutMs:120000,maxResolveAttempts:5}};
 browser.storage={local:{get:async()=>({}),set:async()=>{},remove:async()=>{}}};
 dependencies.reply.mockResolvedValue({});
 dependencies.chat.mockResolvedValue({assistant:'{"action":"archive"}'});
 const queue=await import('../agent/modules/messageProcessorQueue.js');
 await queue.enqueueProcessMessage({...header,folder:{...folder}});
 folder.path='/RenamedParent/Inbox';folder.id='renamed-inbox';header.id=3;
 h.query.mockResolvedValue({messages:[header]});
 h.resolve.mockResolvedValue(null);
 browser.folders.query=async()=>[folder];
 for(let i=0;i<5;i++) await queue.drainProcessMessageQueue();
 const liveKey=folder.accountId+':'+folder.path+':'+header.headerMessageId;
 expect(dependencies.chat).not.toHaveBeenCalled();
 expect(dependencies.reply).not.toHaveBeenCalled();
 expect(queue.getProcessMessageQueueStatus().pending).toBe(0);
 expect(h.store).toEqual({});expect(h.native.size).toBe(0);
 h.resolve.mockResolvedValue({weID:header.id,weFolder:folder,headerID:header.headerMessageId});
 await queue.enqueueProcessMessage(header);
 await queue.drainProcessMessageQueue();
 expect(dependencies.chat).toHaveBeenCalledTimes(1);
 expect(dependencies.reply).toHaveBeenCalledTimes(1);
 expect(queue.getProcessMessageQueueStatus().pending).toBe(0);
 expect(h.store['action:'+key]).toBeUndefined();
 expect(h.store['action:'+liveKey]).toBe('archive');
 expect([...h.native.values()]).toContain('archive');
 await queue.cleanupProcessMessageQueue();
});
