/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
import {beforeAll,afterAll,beforeEach,it,expect,vi} from 'vitest';
vi.mock('../agent/modules/idbStorage.js',()=>({set:vi.fn(async()=>{}),get:vi.fn(async()=>({}))}));
vi.mock('../agent/modules/llm.js',()=>({sendChat:vi.fn(async()=>({assistant:'We test the program.'}))}));
vi.mock('../agent/modules/promptGenerator.js',()=>({getUserCompositionPrompt:vi.fn(async()=>'Use a concise style.')}));
vi.mock('../agent/modules/utils.js',()=>({log:vi.fn(),getUniqueMessageKey:vi.fn()}));
vi.mock('../chat/modules/helpers.js',()=>({formatTimestampForAgent:()=> '2026-09-13'}));
vi.mock('../compose/modules/edit.js',()=>({runComposeEdit:vi.fn()}));
import {sendChat} from '../agent/modules/llm.js';
import {set} from '../agent/modules/idbStorage.js';
let api,context,listeners;
beforeAll(async()=>{
 vi.useFakeTimers();listeners=new Set();
 api={runtime:{getURL:x=>`https://example.com/${x}`,onMessage:{addListener:f=>listeners.add(f),removeListener:f=>listeners.delete(f)},sendMessage:vi.fn(message=>{
   for(const f of listeners){const result=f(message,{tab:{id:123}});if(result!==undefined)return result;}throw Error('No registered handler');
 })},compose:{onBeforeSend:{addListener:vi.fn()},getComposeDetails:vi.fn(async()=>({subject:'Synthetic subject',from:'sender@example.com',to:['recipient@example.com'],cc:[]}))},scripting:{compose:{unregisterScripts:vi.fn(async()=>{}),registerScripts:vi.fn(async()=>{})}}};
 globalThis.browser=globalThis.messenger=api;
 await import('../compose/background.js');await vi.advanceTimersByTimeAsync(500);
 context=createContext({browser:api,TabMail:{state:{},log:{debug(){},warn(){},error(){}}}});
 runInContext(readFileSync('compose/modules/api.js','utf8'),context,{filename:'compose/modules/api.js'});
 vi.useRealTimers();
});
beforeEach(()=>vi.clearAllMocks());
afterAll(()=>{vi.useRealTimers();delete globalThis.browser;delete globalThis.messenger;});
it.each([true,false].flatMap(isLocal=>[true,false].map(hasReference=>({isLocal,hasReference}))))('real message bridge preserves spelling reference and current draft: $isLocal/$hasReference',async({isLocal,hasReference})=>{
 const current='We test the pasdrogram.';
 const contextInput={isLocal,userMessage:current,cursorPosition:20};
 if(hasReference)contextInput.previousAcceptedSentence='We test the program.';
 const result=await context.TabMail.getCorrectionFromServer(contextInput);
 expect(sendChat).toHaveBeenCalledTimes(1);
 expect(result).toMatchObject({usertext:current,suggestion:'We test the program.'});
 const wire=sendChat.mock.calls[0][0][0];
 expect(wire.content).toBe(isLocal?'system_prompt_autocomplete_local':'system_prompt_autocomplete');
 expect(wire.previous_accepted_sentence).toBe(hasReference?'We test the program.':'');
 expect(wire.text_to_correct).toBe(current);
 expect(set).toHaveBeenCalledTimes(1);
 const stored=set.mock.calls[0][0]['activeHistory:123'][0];
 expect(stored).not.toHaveProperty('previous_accepted_sentence');expect(stored.text_to_correct).toBe(current);
 expect(wire.previous_accepted_sentence).toBe(hasReference?'We test the program.':'');
});
