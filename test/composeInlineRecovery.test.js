/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import { describe, it, expect, afterEach, vi } from 'vitest';

const windows = [];
function setup(html = '') {
  const dom = new JSDOM(`<body contenteditable="true">${html}</body>`, { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  windows.push(w);
  w.browser = { runtime: { getURL: path => `https://example.com/${path}`, sendMessage: vi.fn(), onMessage: { addListener: vi.fn(), removeListener: vi.fn() } }, storage: { local: { set: vi.fn() } } };
  w.Range.prototype.getBoundingClientRect = function () {
    const top = Math.floor(this.startOffset / 30) * 20 + 20;
    return { left: (this.startOffset % 30) * 8 + 8, right: (this.startOffset % 30) * 8 + 16, top, bottom: top + 20, height: 20, width: 8 };
  };
  w.Range.prototype.getClientRects = function () { return [this.getBoundingClientRect()]; };
  for (const name of ['libs/jsdiff.min.js', 'libs/diff-match-patch.js', 'modules/config.js', 'modules/logger.js', 'modules/state.js', 'modules/sentences.js', 'modules/tokens.js', 'modules/dom.js', 'modules/core.js', 'modules/diff.js', 'modules/previewModel.js', 'modules/richText.js', 'modules/preview.js', 'modules/autohideDiff.js', 'modules/events.js', 'modules/caret.js', 'modules/inlineEditor.js']) {
    const filename = resolve('compose', name);
    runInContext(readFileSync(filename, 'utf8'), dom.getInternalVMContext(), { filename });
  }
  installNativeModel(w);
  const tm = w.TabMail;
  tm.log = { debug() {}, trace() {}, info() {}, warn() {}, error() {} };
  tm.state.editorRef = w.document.body;
  tm.state.correctedText = '';
  const node = w.document.body.firstChild || w.document.body;
  const r = w.document.createRange(); r.setStart(node, 0); r.collapse(true);
  w.getSelection().addRange(r);
  return { w, tm, body: w.document.body };
}
afterEach(() => { for (const w of windows.splice(0)) w.close(); });

// A stateful command model with distinct text/HTML semantics. Actual Gecko
// transactions and undo are additionally checked by test/manual probes.
function installNativeModel(w) {
  w.document.execCommand = vi.fn((command, ui, value) => {
    if (!['insertHTML', 'insertText'].includes(command)) return false;
    const range = w.getSelection().getRangeAt(0);
    range.deleteContents();
    range.insertNode(command === 'insertHTML' ? range.createContextualFragment(value) : w.document.createTextNode(value));
    w.document.body.dispatchEvent(new w.InputEvent('input', {bubbles:true, inputType:'insertText'}));
    return true;
  });
}

vi.mock('../agent/modules/idbStorage.js',()=>({}));
vi.mock('../agent/modules/utils.js',()=>({getUniqueMessageKey:vi.fn()}));
vi.mock('../compose/modules/autocompleteGenerator.js',()=>({generateCorrection:vi.fn()}));
vi.mock('../compose/modules/edit.js',()=>({runComposeEdit:vi.fn()}));
import {runComposeEdit} from '../compose/modules/edit.js';
async function wireBackground(w) {
  vi.resetModules();
  const listeners = new Set();
  const current = {to:['first@example.com'],cc:[],bcc:[],subject:'Synthetic',type:'new'};
  const api={runtime:{onMessage:{addListener:f=>listeners.add(f),removeListener:f=>listeners.delete(f)},getURL:p=>p},
    compose:{getComposeDetails:vi.fn(async()=>structuredClone(current)),setComposeDetails:vi.fn(async(id,patch)=>Object.assign(current,structuredClone(patch))),onBeforeSend:{addListener:vi.fn()}},
    scripting:{compose:{unregisterScripts:vi.fn(async()=>{}),registerScripts:vi.fn(async()=>{})}},
    tabs:{sendMessage:vi.fn(async()=>{})}};
  globalThis.browser=globalThis.messenger=api;globalThis.window={};
  await import('../compose/background.js');
  w.browser.runtime.sendMessage=vi.fn(message=>[...listeners].map(f=>f(message,{tab:{id:1}})).find(v=>v!==undefined));
  return {api,current};
}
afterEach(()=>{delete globalThis.browser;delete globalThis.messenger;delete globalThis.window;runComposeEdit.mockReset()});
it.each(['empty','whitespace'])('keeps %s recovery visible but outside serialized mail, then applies a retry',async outcome=>{
 const {w,tm,body}=setup('<p>A synthetic draft ready to save.</p>');
 const {api,current}=await wireBackground(w);
 tm.state.editChatHistory=[];
 runComposeEdit.mockResolvedValueOnce({body:outcome==='empty'?'':'   ',error:'empty_edit_body',chatHistory:[]});
 tm.showInlineEditDropdown();
 const wrapper=w.document.getElementById('tm-inline-edit');
 await tm._runInlineEditInstruction({instruction:'Expand the draft',wrapper});
 expect(runComposeEdit).toHaveBeenCalledTimes(1);
 expect(wrapper.isConnected).toBe(true);
 const alert=wrapper.querySelector('[role="alert"]') || wrapper.querySelector('.tm-inline-actions').shadowRoot.querySelector('[role="alert"]');
 expect(alert.textContent).toBe('No usable edit was returned. Please try again.');
 expect(wrapper._tm_container.style.visibility).toBe('');
 expect(wrapper._tm_executing).toBe(false);
 expect(tm.extractUserAndQuoteTexts(body).originalUserMessage).toBe('A synthetic draft ready to save.');
 expect(tm.state.editChatHistory).toEqual([]);
 expect(current.to).toEqual(['first@example.com']);
 expect(api.compose.setComposeDetails).not.toHaveBeenCalled();
 expect(w.document.execCommand).not.toHaveBeenCalled();
 expect(w.document.documentElement.outerHTML).not.toContain(alert.textContent);
 const history=[{userRequest:'Expand the draft'}];
 runComposeEdit.mockResolvedValueOnce({body:'An expanded synthetic draft.',chatHistory:history});
 await tm._runInlineEditInstruction({instruction:'Expand the draft',wrapper});
 expect(runComposeEdit).toHaveBeenCalledTimes(2);
 expect(alert.isConnected).toBe(false);
 expect(w.document.getElementById('tm-inline-edit')).toBeNull();
 expect(tm.extractUserAndQuoteTexts(body).originalUserMessage).toBe('An expanded synthetic draft.');
 expect(tm.state.editChatHistory).toEqual(history);
 expect(current.to).toEqual(['first@example.com']);
 expect(api.compose.setComposeDetails).not.toHaveBeenCalled();
 expect(w.document.execCommand).toHaveBeenCalledTimes(1);
 expect(w.document.documentElement.outerHTML).not.toContain('No usable edit was returned');
});

it.each(['structural','native-false','native-throw'])('preserves the instruction after %s refusal and applies a later retry',async kind=>{
 const html=kind==='structural'?'<p>First sentence.</p><p>Second sentence.</p>':'<p>Draft.</p>';
 const {w,tm,body}=setup(html),{api,current}=await wireBackground(w);
 const original=tm.extractUserAndQuoteTexts(body).originalUserMessage;
 const instruction='Please revise this draft.';
 const proposed=kind==='structural'?'First sentence. Second sentence.':'Expanded draft.';
 const previous=[{userRequest:'Earlier successful edit'}];tm.state.editChatHistory=previous;
 if(kind==='native-false')w.document.execCommand.mockReturnValue(false);
 if(kind==='native-throw')w.document.execCommand.mockImplementation(()=>{throw Error('Synthetic native refusal')});
 runComposeEdit.mockResolvedValueOnce({body:proposed,chatHistory:[...previous,{userRequest:instruction}]});
 tm.showInlineEditDropdown();const wrapper=w.document.getElementById('tm-inline-edit');
 wrapper._tm_iinput.value=instruction;
 await tm._runInlineEditInstruction({instruction,wrapper});
 expect(runComposeEdit).toHaveBeenCalledWith(expect.objectContaining({body:original,request:instruction}));
 expect(w.document.execCommand).toHaveBeenCalledTimes(kind==='structural'?0:1);
 const retry=w.document.getElementById('tm-inline-edit');
 expect(retry?.isConnected).toBe(true);
 expect(retry._tm_iinput.value).toBe(instruction);
 expect(retry._tm_executing).not.toBe(true);
 const alert=retry.querySelector('.tm-inline-actions').shadowRoot.querySelector('[role="alert"]');
 expect(alert.textContent).toContain('could not be applied');
 const authored=body.cloneNode(true);authored.querySelector('#tm-inline-edit').remove();
 expect(authored.innerHTML).toBe(html);
 expect(tm.extractUserAndQuoteTexts(body).originalUserMessage).toBe(original);
 expect(tm.state.editChatHistory).toEqual(previous);
 expect(current.to).toEqual(['first@example.com']);
 expect(api.compose.setComposeDetails).not.toHaveBeenCalled();
 expect(w.document.documentElement.outerHTML).not.toContain(alert.textContent);
 installNativeModel(w);
 const revised=kind==='structural'?'Revised sentence.\nSecond sentence.':'Expanded draft.';
 const history=[...previous,{userRequest:instruction}];
 runComposeEdit.mockResolvedValueOnce({body:revised,chatHistory:history});
 await tm._runInlineEditInstruction({instruction,wrapper:retry});
 expect(w.document.getElementById('tm-inline-edit')).toBeNull();
 expect(w.document.execCommand).toHaveBeenCalledTimes(1);
 expect(tm.extractUserAndQuoteTexts(body).originalUserMessage).toBe(revised);
 expect(tm.state.editChatHistory).toEqual(history);
 expect(runComposeEdit).toHaveBeenCalledTimes(2);
});

it.each(['typing','composition'])('does not reopen old instructions over newer %s',async action=>{
 const {w,tm,body}=setup('<p>Draft.</p>');tm.attachAutocomplete(body);
 await wireBackground(w);let resolveEdit;
 runComposeEdit.mockImplementation(()=>new Promise(resolve=>resolveEdit=resolve));
 tm.showInlineEditDropdown();const wrapper=w.document.getElementById('tm-inline-edit');
 const pending=tm._runInlineEditInstruction({instruction:'An older instruction',wrapper});
 await vi.waitFor(()=>expect(runComposeEdit).toHaveBeenCalledTimes(1));
 if(action==='typing')body.querySelector('p').textContent='Newer draft.';
 else body.dispatchEvent(new w.CompositionEvent('compositionstart',{bubbles:true}));
 resolveEdit({body:'An older result.',chatHistory:[{userRequest:'An older instruction'}]});
 await pending;
 expect(w.document.getElementById('tm-inline-edit')).toBeNull();
 expect(w.document.execCommand).not.toHaveBeenCalled();
 expect(tm.extractUserAndQuoteTexts(body).originalUserMessage).toBe(action==='typing'?'Newer draft.':'Draft.');
 expect(tm.state.editChatHistory||[]).toEqual([]);
});
