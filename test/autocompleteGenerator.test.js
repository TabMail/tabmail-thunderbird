/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('../agent/modules/idbStorage.js',()=>({set:vi.fn(async()=>{})}));
vi.mock('../agent/modules/llm.js',()=>({sendChat:vi.fn(async()=>({assistant:'We test the program.'}))}));
vi.mock('../agent/modules/promptGenerator.js',()=>({getUserCompositionPrompt:vi.fn(async()=>'Use a concise style.')}));
vi.mock('../agent/modules/utils.js',()=>({log:vi.fn()}));
vi.mock('../chat/modules/helpers.js',()=>({formatTimestampForAgent:()=> '2026-09-13'}));
import {generateCorrection} from '../compose/modules/autocompleteGenerator.js';
import {sendChat} from '../agent/modules/llm.js';
import {set} from '../agent/modules/idbStorage.js';
beforeEach(()=>vi.clearAllMocks());
it.each([true,false])('sends accepted reference in mode %s without persisting it in debug history',async isLocal=>{
 await generateCorrection({userMessage:'We test the pasdrogram.',previousAcceptedSentence:'We test the program.',cursorPosition:20,isLocal,sessionId:123});
 const [messages]=sendChat.mock.calls[0];
 expect(messages[0]).toMatchObject({content:isLocal?'system_prompt_autocomplete_local':'system_prompt_autocomplete',text_to_correct:'We test the pasdrogram.',previous_accepted_sentence:'We test the program.',cursor_position:20,user_composition_prompt:'Use a concise style.'});
 expect(set).toHaveBeenCalledTimes(1);
 const history=set.mock.calls[0][0]['activeHistory:123'][0];
 expect(history).not.toHaveProperty('previous_accepted_sentence');
 expect(history.text_to_correct).toBe('We test the pasdrogram.');
 // Removing the reference from persisted history must not mutate the request.
 expect(messages[0].previous_accepted_sentence).toBe('We test the program.');
});
