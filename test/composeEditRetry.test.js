/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import {beforeEach,it,expect,vi} from 'vitest';
vi.mock('../agent/modules/config.js',()=>({SETTINGS:{},getBackendUrl:()=> 'https://example.com'}));
vi.mock('../agent/modules/llm.js',()=>({sendChat:vi.fn(),processEditResponse:vi.fn()}));
vi.mock('../agent/modules/promptGenerator.js',()=>({getUserCompositionPrompt:async()=>'',getUserKBPrompt:async()=>''}));
vi.mock('../agent/modules/utils.js',()=>({extractBodyFromParts:vi.fn(),safeGetFull:vi.fn(),saveChatLog:vi.fn(),stripHtml:vi.fn()}));
vi.mock('../chat/modules/helpers.js',()=>({getUserName:async()=>'Example',formatTimestampForAgent:()=> '2026-09-13'}));
vi.mock('../chat/tools/core.js',()=>({executeToolsHeadless:vi.fn()}));
import {sendChat,processEditResponse} from '../agent/modules/llm.js';
import {runComposeEdit} from '../compose/modules/edit.js';
beforeEach(()=>{vi.clearAllMocks();processEditResponse.mockImplementation(raw=>raw==='valid'?{body:'Expanded draft.'}:{body:raw==='whitespace'?'   ':undefined,subject:'Update'});});
it.each(['missing','whitespace'])('retries a %s body once without retaining the failed response',async invalid=>{
 sendChat.mockResolvedValueOnce({assistant:invalid}).mockResolvedValueOnce({assistant:'valid'});
 const result=await runComposeEdit({body:'Draft.',request:'Make it longer'});
 expect(sendChat).toHaveBeenCalledTimes(2);expect(result.body).toBe('Expanded draft.');
 expect(result.chatHistory).toHaveLength(1);expect(result.chatHistory[0].assistantResponse).toBe('valid');
 expect(sendChat.mock.calls[1][0][0].current_body).toBe('Draft.');
 expect(sendChat.mock.calls[1][0][0].edit_conversation_history).toBe('');
 expect(sendChat.mock.calls[1][0][0].user_request).toContain('Body:');
 expect(sendChat.mock.calls[1][1].disableTools).toBe(true);
});
it('fails after two empty bodies and preserves only prior history',async()=>{
 sendChat.mockResolvedValue({assistant:'missing'});
 const history=[{userRequest:'Earlier',bodyAtRequest:'Old',subjectAtRequest:'Test',assistantResponse:'valid'}];
 const result=await runComposeEdit({body:'Draft.',request:'Expand',chatHistory:history});
 expect(sendChat).toHaveBeenCalledTimes(2);expect(result.error).toBe('empty_edit_body');expect(result.body).toBe('');expect(result.chatHistory).toEqual(history);expect(result.subject).toBeUndefined();
});
it('does not retry a valid first body',async()=>{
 sendChat.mockResolvedValue({assistant:'valid'});const result=await runComposeEdit({body:'Draft.'});
 expect(sendChat).toHaveBeenCalledTimes(1);expect(result.body).toBe('Expanded draft.');
});

it('does not retain a failed retry or attempt a third request',async()=>{
 sendChat.mockResolvedValueOnce({assistant:'missing'}).mockResolvedValueOnce({err:'Unavailable'});
 const result=await runComposeEdit({body:'Draft.',request:'Expand'});
 expect(sendChat).toHaveBeenCalledTimes(2);expect(result.body).toBe('');expect(result.chatHistory).toEqual([]);expect(result.error).toBe('empty_edit_body');
});

it.each([true, false])('real missing-Body parser response recovers safely: retry succeeds=%s', async succeeds => {
 const {processEditResponse: parse} = await vi.importActual('../agent/modules/llm.js');
 processEditResponse.mockImplementation(parse);
 const malformed = 'Response: Expanded the draft.\n\nSubject: Test update\n\nHello team,\n\nHere is a longer update with additional details.';
 const valid = 'Subject: Test update\n\nBody:\nHello team,\n\nHere is a longer update with additional details.';
 expect(parse(malformed).body).toBeUndefined();
 sendChat.mockResolvedValueOnce({assistant:malformed}).mockResolvedValueOnce({assistant:succeeds?valid:malformed});
 const result = await runComposeEdit({body:'Hello team,\n\nBrief update.', request:'Make it longer'});
 expect(sendChat).toHaveBeenCalledTimes(2);
 expect(sendChat.mock.calls[1][0][0].current_body).toBe('Hello team,\n\nBrief update.');
 expect(sendChat.mock.calls[1][0][0].edit_conversation_history).toBe('');
 expect(sendChat.mock.calls[1][1].disableTools).toBe(true);
 if (succeeds) {
  expect(result.body).toBe('Hello team,\n\nHere is a longer update with additional details.');
  expect(result.chatHistory).toHaveLength(1);
  expect(result.chatHistory[0].assistantResponse).toBe(valid);
 } else {
  expect(result.error).toBe('empty_edit_body');
  expect(result.body).toBe(''); expect(result.subject).toBeUndefined();
  expect(result.chatHistory).toEqual([]);
 }
});
