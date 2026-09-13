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
vi.mock('../agent/modules/tagHelper.js',()=>({
 runThreadAggregation:async()=>{},findInboxFolderForAccount:async()=>folder,
 getConversationForWeMsgId:async()=>({ok:true,conversationId:'synthetic-thread',headerMessageIds:['one@example.test','two@example.test']}),
 getInboxWeIdsForConversation:async()=>thread.ids,
 readCachedActionForWeId:async id=>{const v=thread.headers.get(id);return v?h.store['action:'+`${v.folder.accountId}:${v.folder.path}:${v.headerMessageId}`]:null;},
}));
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
 h.query.mockImplementation(async q=>({messages:[...thread.headers.values()].filter(x=>x.folder.id===q.folderId&&x.headerMessageId===q.headerMessageId)}));
});
it('toggle enabling applies current aggregate durably and leaves unrelated message unchanged',async()=>{
 const one={...header,id:1,headerMessageId:'one@example.test'},two={...header,id:2,headerMessageId:'two@example.test'},unrelated={...header,id:9,headerMessageId:'unrelated@example.test'};
 for(const x of [one,two,unrelated])thread.headers.set(x.id,x);thread.ids=[1,2];
 await owner.setAction(one,'none');await owner.setAction(two,'reply');await owner.setAction(unrelated,'delete');
 browser.accounts.list=async()=>[{id:'acc'}];browser.messages.list=async()=>({messages:[one,two]});
 const {retagAllInboxesForTagByThreadToggle}=await import('../agent/modules/threadTagGroup.js');
 await retagAllInboxesForTagByThreadToggle(true);
 expect([h.store[actionFor(one)],h.store[actionFor(two)]]).toEqual(['reply','reply']);
 expect([h.native.get(1),h.native.get(2)]).toEqual(['reply','reply']);
 expect(h.store[actionFor(unrelated)]).toBe('delete');expect(h.native.get(9)).toBe('delete');
});
it('persisted prior-session thread members never direct current writes; ready current members still aggregate',async()=>{
 const one={...header,id:1,headerMessageId:'one@example.test'},two={...header,id:2,headerMessageId:'two@example.test'};
 thread.headers=new Map([[1,one],[2,two]]);thread.ids=[1,2];
 await owner.setAction(one,'none');await owner.setAction(two,'reply');
 browser.storage.local.get=async()=>({tagByThreadEnabled:true});
 let mod=await import('../agent/modules/threadTagGroup.js');
 const produced=await mod.computeAndStoreThreadTagList(1);
 expect(produced.ok).toBe(true);expect(produced.allActionsReady).toBe(true);
 const storeKey='threadTags:'+produced.threadKey;
 expect(h.store[storeKey].weIds).toEqual([1,2]);
 // A new Thunderbird session resolves this persisted thread to current IDs.
 const nowOne={...one,id:101},nowTwo={...two,id:102};
 const otherOne={...header,id:1,headerMessageId:'different-one@example.test'},otherTwo={...header,id:2,headerMessageId:'different-two@example.test'};
 thread.headers=new Map([[101,nowOne],[102,nowTwo],[1,otherOne],[2,otherTwo]]);thread.ids=[101,102];
 h.native.clear();vi.resetModules();mod=await import('../agent/modules/threadTagGroup.js');
 owner=await import('../agent/modules/actionCache.js');
 await owner.clearAction(nowTwo);await owner.setAction(otherOne,'none');await owner.setAction(otherTwo,'delete');
 const partial=await mod.computeAndStoreThreadTagList(101);
 expect(partial.ok).toBe(true);expect(partial.allActionsReady).toBe(false);
 expect(h.store[storeKey].weIds).toEqual([1,2]);
 await mod.updateThreadEffectiveTagsIfNeeded(101,partial);
 const afterPartial={current:h.store[actionFor(nowOne)],missing:h.store[actionFor(nowTwo)],unrelated:h.store[actionFor(otherOne)],nativeOther:h.native.get(1)};
 await owner.setAction(nowTwo,'reply');await mod.updateThreadEffectiveTagsIfNeeded(101);
 expect([h.store[actionFor(nowOne)],h.store[actionFor(nowTwo)],h.native.get(101),h.native.get(102)]).toEqual(['reply','reply','reply','reply']);
 expect(afterPartial).toEqual({current:'none',missing:undefined,unrelated:'none',nativeOther:'none'});
 expect(h.store[actionFor(otherOne)]).toBe('none');expect(h.store[actionFor(otherTwo)]).toBe('delete');
});
