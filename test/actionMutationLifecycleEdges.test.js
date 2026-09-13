/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ store: {}, native: new Map(), events: [], query: vi.fn(), resolve: vi.fn(), remove: vi.fn(), sort: vi.fn(), rowTs:new Map() }));
vi.mock('../agent/modules/idbStorage.js', () => ({
 get: async keys => Object.fromEntries((Array.isArray(keys)?keys:[keys]).filter(k=>k in h.store).map(k=>[k,h.store[k]])),
 set: async values => { h.events.push('commit'); Object.assign(h.store, values);for(const k of Object.keys(values))h.rowTs.set(k,Date.now()); },
 remove: async keys => { await h.remove(); h.events.push('commit'); for(const k of keys) delete h.store[k]; },
 clear: async () => { h.store={}; }, getAllKeys: async()=>Object.keys(h.store),
 purgeOlderThanByPrefixes: async(prefixes,cutoff)=>{let removed=0;for(const key of Object.keys(h.store))if(prefixes.some(p=>key.startsWith(p))&&h.rowTs.get(key)<cutoff){delete h.store[key];removed++;}return removed;},
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


import {experimentFunctions} from './helpers/experimentFunctions.js';
const source=path=>new URL('../'+path,import.meta.url);
const other={...header,id:9,headerMessageId:'unrelated@example.test'};
const otherKey='acc:/INBOX:unrelated@example.test';
beforeEach(()=>{h.rowTs=new Map();h.query.mockImplementation(async q=>({messages:q.headerMessageId===other.headerMessageId?[other]:[header]}));});
it('recompute removes the previous action and baseline metadata, permits a fresh baseline, and preserves unrelated data',async()=>{
 await owner.setAction(header,'reply',{meta:{orig:'reply',userprompt:'synthetic earlier prompt'}});
 await owner.setAction(other,'delete',{meta:{orig:'delete',userprompt:'synthetic unrelated prompt'}});
 const {clearActionCache}=experimentFunctions(source('agent/modules/contextMenus.js'),['clearActionCache'],{clearActions:owner.clearActions});
 await clearActionCache([header]);
 const removed=owner.allKeysFor(key).map(k=>h.store[k]);
 expect(removed).toEqual([undefined,undefined,undefined,undefined,undefined]);
 expect(h.native.get(1)).toBe('');expect(h.store[owner.origKey(otherKey)]).toBe('delete');expect(h.native.get(9)).toBe('delete');
 await owner.setAction(header,'none',{meta:{orig:'none',userprompt:'synthetic updated prompt'}});
 expect(h.store[owner.origKey(key)]).toBe('none');expect(h.store[owner.userPromptKey(key)]).toBe('synthetic updated prompt');
 expect(h.store[owner.payloadKey(key)]).toBe('none');expect(h.native.get(1)).toBe('none');
});
it('confirmed deletion evicts a fresh action without waiting for its TTL and preserves a live fresh action',async()=>{
 vi.setSystemTime(100000);
 await owner.setAction(header,'reply');await owner.setAction(other,'delete');
 h.resolve.mockImplementation(async k=>k===key?{status:'absent',weIds:[],folder}:{status:'resolved',weIds:[9],folder});
 h.native.delete(1);
 await owner.purgeExpired({cutoffTs:99999});
 expect(h.store[owner.payloadKey(key)]).toBeUndefined();expect(h.store[owner.tsKey(key)]).toBeUndefined();
 expect(h.store[owner.payloadKey(otherKey)]).toBe('delete');expect(h.native.get(9)).toBe('delete');
});
it('the semaphore cache-hit return normalizes a reply after the native replied flag changes',async()=>{
 browser.tmHdr.getMsgKey=async()=>1;browser.tmHdr.getReplied=vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
 const {getAction}=await import('../agent/modules/actionGenerator.js');
 let release;dependencies.chat.mockImplementationOnce(()=>new Promise(r=>{release=r;}));
 const first=getAction(header);await waitStarted(()=>release);
 const waiter=getAction(header);for(let n=0;n<40;n++)await Promise.resolve();
 release({assistant:'{"action":"reply"}'});
 expect(await first).toBe('reply');expect(await waiter).toBe('none');
 expect(dependencies.chat).toHaveBeenCalledTimes(1);
 expect(browser.tmHdr.getReplied).toHaveBeenCalledTimes(2);
 expect(h.store[owner.payloadKey(key)]).toBe('reply');expect(h.native.get(1)).toBe('reply');
 // A newly-started read may persist normalization; superseded waiting work cannot.
 browser.tmHdr.getReplied.mockResolvedValue(true);expect(await getAction(header)).toBe('none');expect(h.store[owner.payloadKey(key)]).toBe('none');expect(h.native.get(1)).toBe('none');
});
it('deferred leave-inbox cleanup clears the moved native projection while preserving an unrelated inbox action',async()=>{
 await owner.setAction(header,'reply');await owner.setAction(other,'delete');
 const moved={...header,id:3,folder:{...folder,id:'archive',path:'/Archive',specialUse:['archive']}};
 h.native.set(3,h.native.get(1));h.native.delete(1);
 h.resolve.mockResolvedValue({status:'absent',weIds:[],folder});
 await owner.clearActionByUniqueKey(key);
 h.query.mockResolvedValue({messages:[moved]});
 const {performLeaveInboxTagCleanup}=experimentFunctions(source('agent/modules/onMoved.js'),['performLeaveInboxTagCleanup'],{
  log:()=>{},_stripActionTagsByIdBestEffort:async()=>{},_clearActionTagsAcrossSpecialUseFoldersByHeaderMessageId:async()=>{},removeTmLabelsFromGmailMessage:async()=>{},
  getUniqueMessageKey:async m=>`${m.folder.accountId}:${m.folder.path}:${m.headerMessageId}`,clearActions:owner.clearActions,
 });
 expect(await performLeaveInboxTagCleanup(moved)).toEqual({ok:true});
 expect(h.native.get(3)).toBe('');expect(h.store[owner.payloadKey(key)]).toBeUndefined();
 expect(h.store[owner.payloadKey(otherKey)]).toBe('delete');expect(h.native.get(9)).toBe('delete');
});
it('a recycled non-inbox table root loses its aggregate tint while an inbox root still paints',()=>{
 const names=['_isInboxOrUnifiedInboxFolder_MLTV','_lookupActionForRow_MLTV','_aggregateActionForThread_MLTV','_paintRowForAction_MLTV'];
 const actions=['reply','none','archive','delete'];
 const f=experimentFunctions(source('theme/experiments/tmMessageListTableView/tmMessageListTableView.sys.mjs'),names,{
  Ci:{nsMsgFolderFlags:{Inbox:1,Virtual:2}},TM_ACTION_PROP_NAME_MLTV:'tm-action',TM_ACTION_PRIORITY_MLTV:actions,_ACTION_CLASSES_MLTV:actions.map(a=>'tm-action-'+a),_colorForAction_MLTV:()=> '#123456',
 });
 const make=(flags,action)=>({folder:{flags},getStringProperty:p=>p==='tm-action'?action:''});
 const inbox=make(1,'reply'),outside=make(0,'');
 const view={isContainer:()=>true,isContainerOpen:()=>false,getThreadContainingIndex:()=>({numChildren:2,getChildHdrAt:i=>[outside,inbox][i]})};
 const cls=new Set(),style=new Map();const row={classList:{contains:k=>cls.has(k),add:k=>cls.add(k),remove:k=>cls.delete(k)},style:{setProperty:(k,v)=>style.set(k,v),removeProperty:k=>style.delete(k)}};
 f._paintRowForAction_MLTV(row,f._aggregateActionForThread_MLTV(view,0,inbox));
 expect(cls.has('tm-action-reply')).toBe(true);expect(style.has('--tag-color')).toBe(true);
 f._paintRowForAction_MLTV(row,f._aggregateActionForThread_MLTV(view,0,outside));
 expect(cls.size).toBe(0);expect(style.size).toBe(0);expect(inbox.getStringProperty('tm-action')).toBe('reply');
});
it.each(['scan','debounced'])('%s retention expires old payloads and metadata while preserving fresh unknown-inventory data',async mode=>{
 vi.setSystemTime(100000);await owner.setAction(header,'reply',{meta:{orig:'reply',userprompt:'synthetic expired prompt'}});
 vi.setSystemTime(200000);await owner.setAction(other,'delete',{meta:{orig:'delete',userprompt:'synthetic fresh prompt'}});
 h.resolve.mockResolvedValue({status:'unknown',weIds:[],folder:null});
 const {SETTINGS}=await import('../agent/modules/config.js');SETTINGS.actionTTLSeconds=1;
 const {purgeExpiredActionEntries}=await import('../agent/modules/actionGenerator.js');
 const env={browser,Date,log:()=>{},SETTINGS:{replyTTLSeconds:1,actionTTLSeconds:1,summaryTTLSeconds:1,cacheCleanupDebounceMs:10},
 purgeExpiredReplyEntries:async()=>{},purgeExpiredSummaryEntries:async()=>{},purgeExpiredActionEntries,purgeOlderThanByPrefixes:async()=>0,purgeMetadataOlderThan:owner.purgeMetadataOlderThan};
 if(mode==='scan'){
  const {scanAllInboxes}=experimentFunctions(source('agent/modules/messageProcessor.js'),['scanAllInboxes'],env);await scanAllInboxes();
 }else{
  const {scheduleCacheCleanup}=experimentFunctions(source('agent/background.js'),['scheduleCacheCleanup'],{...env,setTimeout,clearTimeout,_cacheCleanupTimer:null});
  scheduleCacheCleanup();await vi.advanceTimersByTimeAsync(10);
 }
 expect(h.store[owner.origKey(key)]).toBeUndefined();expect(h.store[owner.userPromptKey(key)]).toBeUndefined();
 expect(h.store[owner.origKey(otherKey)]).toBe('delete');expect(h.store[owner.userPromptKey(otherKey)]).toBe('synthetic fresh prompt');
 expect(h.store[owner.payloadKey(key)]).toBeUndefined();expect(h.store[owner.tsKey(key)]).toBeUndefined();
 expect(h.store[owner.payloadKey(otherKey)]).toBe('delete');expect(h.native.get(9)).toBe('delete');
});

it('completed direct processor calls retire their own cached-read work and leave fresh actions usable',async()=>{
 await owner.setAction(header,'archive');
 const {processMessage}=await import('../agent/modules/messageProcessor.js');
 const begin=owner.beginAutomaticWork,tokens=[];
 const spy=vi.spyOn(owner,'beginAutomaticWork').mockImplementation(key=>{const token=begin(key);tokens.push(token);return token;});
 try{
  for(let i=0;i<20;i++)expect((await processMessage(header)).ok).toBe(true);
  expect(tokens).toHaveLength(20);expect(dependencies.chat).not.toHaveBeenCalled();
  for(const token of tokens)expect(await owner.setAction(header,'reply',{token})).toBeNull();
  expect(h.store[owner.payloadKey(key)]).toBe('archive');expect(h.native.get(1)).toBe('archive');
  await owner.setAction(header,'delete');
  expect(h.store[owner.payloadKey(key)]).toBe('delete');expect(h.native.get(1)).toBe('delete');
 }finally{spy.mockRestore();for(const token of tokens)owner.finishAutomaticWork(token);}
});
it('a current thread action survives retention while an unrelated old action expires',async()=>{
 const second={...header,id:4,headerMessageId:'second@example.test'};
 const members=[header,second,other];
 browser.messages.get=async id=>members.find(m=>m.id===id);
 h.query.mockImplementation(async q=>({messages:members.filter(m=>m.headerMessageId===q.headerMessageId)}));
 h.resolve.mockImplementation(async k=>({status:'resolved',weIds:[members.find(m=>`acc:/INBOX:${m.headerMessageId}`===k).id],folder}));
 vi.setSystemTime(100000);await owner.setAction(header,'archive');await owner.setAction(other,'delete');
 vi.setSystemTime(200000);await owner.setAction(second,'reply');
 expect(await owner.applyThreadEffective([1,4])).toBe(true);
 expect(h.store[owner.payloadKey(key)]).toBe('reply');expect(h.native.get(1)).toBe('reply');
 await owner.purgeExpired({cutoffTs:150000});
 expect(h.store[owner.payloadKey(key)]).toBe('reply');expect(h.native.get(1)).toBe('reply');
 expect(h.store[owner.payloadKey('acc:/INBOX:second@example.test')]).toBe('reply');expect(h.native.get(4)).toBe('reply');
 expect(h.store[owner.payloadKey(otherKey)]).toBeUndefined();expect(h.native.get(9)).toBe('');
});
