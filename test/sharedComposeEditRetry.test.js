/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
const shared=vi.hoisted(()=>({ctx:{},calls:[]}));
vi.mock('../agent/modules/llm.js',()=>({sendChat:vi.fn(),processEditResponse:raw=>raw?JSON.parse(raw):{}}));
vi.mock('../agent/modules/utils.js',()=>({log:vi.fn(),saveChatLog:vi.fn(),resolveUniqueMessageKey:async()=>({weID:3}),safeGetFull:async()=>({body:'Synthetic original.'}),extractBodyFromParts:async()=> 'Synthetic original.',stripHtml:s=>s}));
vi.mock('../agent/modules/promptGenerator.js',()=>({getUserCompositionPrompt:async()=>'',getUserKBPrompt:async()=>''}));
vi.mock('../agent/modules/senderFilter.js',()=>({getUserEmailSetCached:async()=>new Set(['self@example.com']),extractEmailFromAuthor:s=>s}));
vi.mock('../chat/chat.js',()=>({createNewAgentBubble:async()=>({classList:{remove(){},add(){}}})}));
vi.mock('../chat/modules/context.js',()=>({ctx:shared.ctx,initFsmSession:(pid,tool)=>{shared.ctx.fsmSessions[pid]={toolName:tool}}}));
vi.mock('../chat/modules/helpers.js',()=>({initialiseEmailCompose:()=>{shared.ctx.composeDraft={subject:'',body:'',recipients:[],cc:[],bcc:[]}},streamText:vi.fn(),getUserName:async()=>'Synthetic',formatTimestampForAgent:()=>''}));
vi.mock('../chat/fsm/emailCompose.js',()=>({validateAndNormalizeRecipientSets:async p=>({ok:true,recipients:p.recipients||[],cc:p.cc||[],bcc:p.bcc||[]})}));
vi.mock('../chat/fsm/core.js',()=>({executeAgentAction:async()=>{shared.calls.push(structuredClone({state:shared.ctx.state,draft:shared.ctx.composeDraft}))}}));
vi.mock('../chat/tools/core.js',()=>({executeToolsHeadless:vi.fn()}));
import {sendChat} from '../agent/modules/llm.js';
beforeEach(()=>{
 vi.clearAllMocks();shared.calls.length=0;
 Object.keys(shared.ctx).forEach(k=>delete shared.ctx[k]);
 Object.assign(shared.ctx,{fsmSessions:{},composeDraft:{},state:''});
 globalThis.browser={messages:{get:vi.fn(async()=>({id:3,subject:'Synthetic subject',author:'source@example.com',recipients:['self@example.com'],ccList:[]}))}};
 globalThis.TabMailQuoteDetection={splitPlainTextForQuote:text=>({main:text,quote:''})};
 globalThis.requestAnimationFrame=cb=>setTimeout(cb,0);
});
afterEach(()=>{delete globalThis.browser;delete globalThis.TabMailQuoteDetection;delete globalThis.requestAnimationFrame});
it.each(['compose','reply','forward'].flatMap(mode=>['valid','retry-valid','empty','retry-error','first-error'].map(outcome=>({mode,outcome}))))('shared edit result reaches $mode workflow after $outcome',async({mode,outcome})=>{
 const valid={assistant:JSON.stringify({subject:'Generated subject',body:'Generated body.'})};
 const empty={assistant:JSON.stringify({subject:'Incomplete subject'})};
 if(outcome==='valid')sendChat.mockResolvedValueOnce(valid);
 if(outcome==='retry-valid')sendChat.mockResolvedValueOnce(empty).mockResolvedValueOnce(valid);
 if(outcome==='empty')sendChat.mockResolvedValueOnce(empty).mockResolvedValueOnce(empty);
 if(outcome==='retry-error')sendChat.mockResolvedValueOnce(empty).mockResolvedValueOnce({err:'Synthetic unavailable'});
 if(outcome==='first-error')sendChat.mockResolvedValueOnce({err:'Synthetic unavailable'});
 const tool=await import('../chat/tools/email_'+mode+'.js');
 const marker=await tool.run({unique_id:'synthetic-message',request:'Write a synthetic note',recipients:[{name:'Recipient',email:'recipient@example.com'}]},{callId:'synthetic-call',agentBubble:{classList:{remove:vi.fn()},textContent:''}});
 expect(marker).toMatchObject({fsm:true,tool:'email_'+mode,pid:'synthetic-call'});
 await vi.waitFor(()=>expect(shared.calls).toHaveLength(1));
 const result=shared.calls[0],validResult=['valid','retry-valid'].includes(outcome);
 expect(result.state).toBe('send_email');
 expect(result.draft.body).toBe(validResult?'Generated body.':'');
 expect(result.draft.subject).toBe(validResult?'Generated subject':undefined);
 expect(result.draft.recipients.map(x=>x.email)).toEqual([mode==='reply'?'source@example.com':'recipient@example.com']);
 expect(result.draft.request).toContain('Write a synthetic note');
 expect(sendChat.mock.calls.length).toBe(['valid','first-error'].includes(outcome)?1:2);
 for(const [messages,opts]of sendChat.mock.calls){
  expect(messages[0].mode).toBe('edit_'+(mode==='compose'?'new':mode));
  expect(messages[0].current_body).toBe('');
 }
 if(sendChat.mock.calls.length===2){expect(sendChat.mock.calls[1][1].disableTools).toBe(true);expect(sendChat.mock.calls[1][0][0].user_request).toContain('Body:')}
 if(mode==='reply')expect(result.draft.replyToId).toBe(3);
 if(mode==='forward')expect(result.draft.forwardOfId).toBe(3);
});
