/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The action request carries `recipient_status: "cc"` exactly when the REAL classifier
// (`senderFilter.computeRecipientStatus`) finds the receiving account only in Cc, on every
// path that asks for an action: first generation, forced recomputation, `processMessage`
// and the message-display listener. Only browser APIs and the LLM are stubbed.

import {beforeEach, afterEach, it, expect, vi} from 'vitest';
const h=vi.hoisted(()=>({store:{},native:new Map(),chat:vi.fn(),get:vi.fn(),list:vi.fn(),peer:vi.fn(),header:null,owner:null}));
vi.mock('../agent/modules/config.js',()=>({SETTINGS:{actionTTLSeconds:604800,actionGenerationParallelCalls:3}}));
vi.mock('../agent/modules/utils.js',()=>({log:vi.fn(),indexHeader:vi.fn(),getUniqueMessageKey:async m=>`${m.folder.accountId}:${m.folder.path}:${m.headerMessageId}`,resolveUniqueMessageKey:async()=>({status:'unknown',weIds:[]}),safeGetFull:async()=>({body:'Synthetic text'}),extractBodyFromParts:async()=> 'Synthetic text',stripHtml:x=>x,saveChatLog:vi.fn(),getRealSubject:async m=>m.subject}));
vi.mock('../agent/modules/idbStorage.js',()=>({get:async keys=>Object.fromEntries([].concat(keys).filter(k=>k in h.store).map(k=>[k,h.store[k]])),set:async values=>Object.assign(h.store,values),remove:async keys=>{for(const k of keys)delete h.store[k];},getAllKeys:async()=>Object.keys(h.store),purgeOlderThanByPrefixes:async()=>0}));
vi.mock('../agent/modules/tagDefs.js',()=>({triggerSortRefresh:vi.fn(),maxPriorityAction:vi.fn()}));
vi.mock('../chat/modules/helpers.js',()=>({getUserName:async()=> 'Example User'}));
vi.mock('../agent/modules/summaryGenerator.js',()=>({getSummary:async()=>({id:'account1:/INBOX:review@example.test',blurb:'Synthetic summary',todos:''}),purgeExpiredSummaryEntries:async()=>{}}));
vi.mock('../agent/modules/promptGenerator.js',()=>({getUserActionPrompt:async()=>''}));
vi.mock('../agent/modules/messagePrefilter.js',()=>({analyzeEmailForReplyFilter:async()=>({isNoReply:false,hasUnsubscribe:false})}));
vi.mock('../agent/modules/deviceSync.js',()=>({probeAICache:(...a)=>h.peer(...a),isAutoEnabled:async()=>false}));
vi.mock('../agent/modules/llm.js',()=>({sendChat:(...a)=>h.chat(...a),processJSONResponse:JSON.parse}));
const account={id:'account1',type:'imap',identities:[{email:'me@example.com'},{email:'alias@example.com'}]};
const other={id:'account2',type:'imap',identities:[{email:'secondary@company.com'}]};
let getAction;
const key='account1:/INBOX:review@example.test';
beforeEach(async()=>{
 vi.resetModules();h.store={};h.native=new Map();
 h.header={id:1,headerMessageId:'review@example.test',subject:'Synthetic subject',author:'sender@example.com',recipients:['recipient@example.com'],ccList:['me@example.com'],folder:{id:'inbox',accountId:'account1',path:'/INBOX',specialUse:['inbox']}};
 h.chat.mockReset().mockResolvedValue({assistant:'{"action":"archive"}'});h.peer.mockReset().mockResolvedValue(null);
 h.get.mockReset().mockImplementation(async id=>id===account.id?account:id===other.id?other:null);h.list.mockReset().mockResolvedValue([account,other]);
 globalThis.browser={accounts:{get:h.get,list:h.list},messages:{query:async()=>({messages:[h.header]})},tmHdr:{getRepliedBulk:async()=>[false],setAction:async(id,a)=>{h.native.set(id,a);return true;}}};
 ({getAction}=await import('../agent/modules/actionGenerator.js'));h.owner=await import('../agent/modules/actionCache.js');
});
afterEach(()=>h.owner.cleanupActionCache());
function expectRequest(status){
 expect(h.chat).toHaveBeenCalledTimes(3);
 for(const [messages] of h.chat.mock.calls){expect(messages).toHaveLength(1);expect(messages[0].content).toBe('system_prompt_action');expect(messages[0].subject).toBe(h.header.subject);if(status)expect(messages[0].recipient_status).toBe(status);else expect(Object.hasOwn(messages[0],'recipient_status')).toBe(false);}
}
function expectDurable(action){expect(h.store['action:'+key]).toBe(action);expect(h.native.get(1)).toBe(action);}
it.each([
 ['receiving identity in Cc',{},'cc'],
 ['receiving alias in Cc',{ccList:['alias@example.com']},'cc'],
 ['same identity in To and Cc',{recipients:['me@example.com']},''],
 ['cross-account own identity in To',{recipients:['secondary@company.com']},''],
 ['other account only in Cc',{ccList:['secondary@company.com']},''],
 ['unknown delivery',{ccList:[]},''],
 ['plus alias in To',{recipients:['me+tag@example.com']},''],
 ['plus alias only in Cc',{ccList:['me+tag@example.com']},''],
 ['malformed Cc display name',{ccList:['"me@example.com" <recipient@example.com>']},''],
 ['oversized Cc',{ccList:['x'.repeat(65537)]},''],
])('real classifier action boundary: %s',async(_name,patch,status)=>{
 Object.assign(h.header,patch);
 expect(await getAction(h.header)).toBe('archive');expectRequest(status);expectDurable('archive');
 expect(await getAction(h.header)).toBe('archive');expect(h.chat).toHaveBeenCalledTimes(3);
});
it('self-authored mail cannot produce an action or action request',async()=>{
 h.header.author='me@example.com';expect(await getAction(h.header)).toBeNull();expect(h.chat).not.toHaveBeenCalled();expect(h.store).toEqual({});expect(h.native.size).toBe(0);
});
it('lookup failure omits the hint and leaves subsequent recomputation usable',async()=>{
 h.get.mockRejectedValueOnce(Error('synthetic unavailable'));
 expect(await getAction(h.header)).toBe('archive');expectRequest('');expectDurable('archive');
 await h.owner.clearAction(h.header);h.chat.mockClear();
 expect(await getAction(h.header,{forceRecompute:true})).toBe('archive');expectRequest('cc');expectDurable('archive');
});
it('forced recomputation sends the actual recipient role over a cached action',async()=>{
 await h.owner.setAction(h.header,'reply');expectDurable('reply');
 expect(await getAction(h.header,{forceRecompute:true})).toBe('archive');expectRequest('cc');expectDurable('archive');
});
it('a newer manual action survives a suspended recipient lookup and fresh work still commits',async()=>{
 let release;const started=new Promise(resolve=>h.get.mockImplementationOnce(()=>new Promise(r=>{release=r;resolve();})));
 const pending=getAction(h.header,{forceRecompute:true});await started;await h.owner.setAction(h.header,'delete');expectDurable('delete');
 release(account);expect(await pending).toBe('archive');expectRequest('cc');expectDurable('delete');
 h.chat.mockClear();expect(await getAction(h.header,{forceRecompute:true})).toBe('archive');expectRequest('cc');expectDurable('archive');
});
it('failed LLM calls preserve empty state, release generation, and allow a CC-aware retry',async()=>{
 h.chat.mockRejectedValueOnce(Error('synthetic offline'));
 await expect(getAction(h.header)).rejects.toThrow('synthetic offline');expect(h.store).toEqual({});expect(h.native.size).toBe(0);
 h.chat.mockClear();expect(await getAction(h.header)).toBe('archive');expectRequest('cc');expectDurable('archive');
});

vi.mock('../agent/modules/replyGenerator.js',()=>({createReply:async()=>({}),purgeExpiredReplyEntries:async()=>{}}));
vi.mock('../agent/modules/tagHelper.js',()=>({runThreadAggregation:async()=>{}}));
vi.mock('../agent/modules/messageProcessorQueue.js',()=>({enqueueProcessMessage:async()=>{}}));
vi.mock('../chat/modules/privacySettings.js',()=>({getPrivacyOptOutAllAiEnabled:async()=>false}));
vi.mock('../agent/modules/summaryDisplaySettings.js',()=>({getShowAiSummariesEnabled:async()=>false}));
vi.mock('../agent/modules/supabaseAuth.js',()=>({getAccessToken:async()=>null}));
it.each([false,true])('the real processMessage caller preserves recipient context (force=%s)',async forceRecompute=>{
 const {processMessage}=await import('../agent/modules/messageProcessor.js');
 const result=await processMessage(h.header,{forceRecompute});expect(result.ok).toBe(true);expect(result.action).toBe('archive');expectRequest('cc');expectDurable('archive');
});
it('the real display listener carries its selected header through getAction',async()=>{
 let listener;
 browser.tabs={sendMessage:async()=>{}};
 browser.messageDisplay={onMessagesDisplayed:{addListener:f=>{listener=f;},removeListener:()=>{}}};
 const display=await import('../agent/modules/summary.js');
 expect(listener).toBeTypeOf('function');await listener({id:42},{messages:[h.header]});
 expectRequest('cc');expectDurable('archive');
});
