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
 getUniqueMessageKey: async m => { if (typeof m === 'number') m = await browser.messages.get(m); return m?.folder ? `${m.folder.accountId}:${m.folder.path}:${m.headerMessageId}` : null; },
 resolveUniqueMessageKey: (...args)=>h.resolve(...args), log: vi.fn(), indexHeader: vi.fn(), extractBodyFromParts:async()=>'', stripHtml:x=>x, safeGetFull:async()=>({body:'synthetic body'}), saveChatLog:vi.fn(), getRealSubject:async()=> 'Synthetic subject', getUniqueMessageKeyCandidates:()=>[],
}));
vi.mock('../agent/modules/config.js', () => ({ SETTINGS: { actionTagging:{actionPriority:{reply:3,archive:2,delete:1,none:0}} } }));
vi.mock('../agent/modules/tagDefs.js', () => ({triggerSortRefresh:()=>{h.events.push('sort');h.sort();},ACTION_TAG_IDS:{},isDebugTagRaceEnabled:()=>false,maxPriorityAction: actions=>['reply','archive','delete','none'].find(a=>actions.includes(a))}));
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
const thread=vi.hoisted(()=>({ids:[],headers:new Map()}));
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

const actionFor=m=>'action:'+`${m.folder.accountId}:${m.folder.path}:${m.headerMessageId}`;
beforeEach(()=>{
 thread.ids=[];thread.headers=new Map();
 browser.messages.get=async id=>thread.headers.get(id);
 h.query.mockImplementation(async q=>({messages:[...thread.headers.values()].filter(x=>x.folder.id===(Array.isArray(q.folderId)?q.folderId[0]:q.folderId)&&x.headerMessageId===q.headerMessageId)}));
});

it.each([true,false])('internal-message durable and native grouping with mode=%s',async enabled=>{
 const one={...header,id:1,headerMessageId:'one@example.test'},two={...header,id:2,headerMessageId:'two@example.test'},unrelated={...header,id:9,headerMessageId:'unrelated@example.test'};
 for(const x of [one,two,unrelated])thread.headers.set(x.id,x);thread.ids=[1,2];
 browser.accounts.list=async()=>[{id:'acc',rootFolder:{id:'root',accountId:'acc',path:'/'}}];
 browser.folders.getSubFolders=async()=>[folder];
 browser.glodaSearch={getConversationMessages:async()=>({success:true,conversationId:'synthetic-thread',messages:[one,two]})};
 browser.storage.local.get=async()=>({tagByThreadEnabled:enabled});
 dependencies.internal.mockResolvedValue(true);
 await owner.setAction(two,'reply');await owner.setAction(unrelated,'delete');
 const {processMessage}=await import('../agent/modules/messageProcessor.js');
 const result=await processMessage(one);
 expect(result.ok).toBe(true);expect(dependencies.summary).toHaveBeenCalledTimes(1);
 expect(dependencies.chat).not.toHaveBeenCalled();expect(dependencies.reply).not.toHaveBeenCalled();
 const after={durable:[h.store[actionFor(one)],h.store[actionFor(two)]],native:[h.native.get(1),h.native.get(2)]};
 // The same live graph can produce the expected aggregate using the external-message follow-up.
 const {updateThreadEffectiveTagsIfNeeded}=await import('../agent/modules/threadTagGroup.js');
 await updateThreadEffectiveTagsIfNeeded(1);
 expect([h.store[actionFor(one)],h.store[actionFor(two)]]).toEqual([enabled?'reply':'none','reply']);
 expect(h.store[actionFor(unrelated)]).toBe('delete');expect(h.native.get(9)).toBe('delete');
 expect(after).toEqual({durable:[enabled?'reply':'none','reply'],native:[enabled?'reply':'none','reply']});
});
