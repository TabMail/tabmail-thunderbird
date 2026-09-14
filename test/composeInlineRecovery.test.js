/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInContext, runInNewContext } from 'node:vm';
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
    compose:{getComposeDetails:vi.fn(async()=>structuredClone(current)),setComposeDetails:vi.fn((id,patch)=>Object.assign(current,structuredClone(patch))),onBeforeSend:{addListener:vi.fn()}},
    scripting:{compose:{unregisterScripts:vi.fn(async()=>{}),registerScripts:vi.fn(async()=>{})}},
    tabs:{sendMessage:vi.fn(async()=>{}),onRemoved:{addListener:vi.fn(),removeListener:vi.fn()}}};
  // Execute the real experiment against a native-window boundary model.
  // Header parsing is supplied by Thunderbird; arrays here represent its output.
  const parse=value=>{const m=value.match(/^(.*?)\s*<([^<>]+)>$/);return [{name:m?m[1].replace(/^"|"$/g,''):'',email:m?m[2]:value}]};
  const nativeWindow={closed:false,document:{activeElement:{focus:vi.fn()},querySelector:vi.fn(()=>null)},
    GetComposeDetails:()=>structuredClone(current),
    SetComposeDetails:patch=>api.compose.setComposeDetails(1,Object.fromEntries(Object.entries(patch).map(([key,value])=>[key,value?value.split(','):[]])))};
  let sequence=0;
  const Experiment=runInNewContext(readFileSync(resolve('compose/experiments/tmComposeRecipients/tmComposeRecipients.sys.mjs'),'utf8')+'\n;tmComposeRecipients;',{
    ChromeUtils:{importESModule:path=>path.includes('ExtensionCommon')?{ExtensionCommon:{ExtensionAPI:class{}}}:path.includes('MailServices')?{MailServices:{headerParser:{makeFromDisplayAddress:parse,makeMimeAddress:(name,email)=>name?`${name} <${email}>`:email}}}:{parseEncodedAddrHeader:value=>value||[]}},
    Services:{uuid:{generateUUID:()=>({toString:()=>String(++sequence)})}}
  }) || undefined;
  const experiment=new Experiment();
  const otherWindow={...nativeWindow};
  const nativeAPI=experiment.getAPI({extension:{tabManager:{get:id=>({type:'messageCompose',nativeTab:id===1?nativeWindow:otherWindow})}}}).tmComposeRecipients;
  api.tmComposeRecipients={begin:vi.fn(nativeAPI.begin),commit:vi.fn((tabId,id,baseline,patch)=>nativeAPI.commit(tabId,id,baseline,{to:null,cc:null,bcc:null,...patch}))};
  api._nativeWindow=nativeWindow;api._experiment=experiment;
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
 expect(alert.nextElementSibling.className).toBe('tm-compose-actions');
 const warningCSS=alert.getRootNode().querySelector('style').textContent;
 expect(warningCSS).toMatch(/\.tm-inline-error\s*\{[^}]*color:\s*var\(--tag-tm-archive\)/);
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

// Exercise the registered background handler and the actual inline consumer:
// receiving a proposal is not authorization to write native recipients.
it.each(['accepted','recipient-only','dismissed','body-refused','body-changed','recipients-changed','empty'])('commits recipient proposals only for accepted current edits: %s',async outcome=>{
 const {w,tm,body}=setup('<p>Draft.</p>');
 const {api,current}=await wireBackground(w);
 const history=[{userRequest:'Earlier'}];tm.state.editChatHistory=history;
 let resolveResult;
 runComposeEdit.mockImplementation(()=>new Promise(resolve=>{resolveResult=resolve}));
 tm.showInlineEditDropdown();const wrapper=w.document.getElementById('tm-inline-edit');
 const pending=tm._runInlineEditInstruction({instruction:'Add a recipient',wrapper});
 await vi.waitFor(()=>expect(resolveResult).toBeTypeOf('function'));
 expect(api.compose.setComposeDetails).not.toHaveBeenCalled();
 if(outcome==='dismissed')tm.cancelInlineEditDropdown();
 if(outcome==='body-refused')w.document.execCommand.mockReturnValue(false);
 if(outcome==='body-changed')body.firstChild.textContent='Newer draft.';
 if(outcome==='recipients-changed')current.to=['newer@example.com'];
 resolveResult({body:outcome==='empty'?'':outcome==='recipient-only'?'Draft.':'Expanded draft.',
   toDelta:{adds:[{name:'Example',email:'added@example.com'}],removes:[]},chatHistory:[...history,{userRequest:'Add a recipient'}]});
 await pending;
 const accepted=['accepted','recipient-only','recipients-changed'].includes(outcome);
 expect(tm.extractUserAndQuoteTexts(body).originalUserMessage).toBe(outcome==='body-changed'?'Newer draft.':accepted&&outcome!=='recipient-only'?'Expanded draft.':'Draft.');
 expect(current.to).toEqual(outcome==='recipients-changed'?['newer@example.com']:accepted?['first@example.com','Example <added@example.com>']:['first@example.com']);
 expect(api.compose.setComposeDetails).toHaveBeenCalledTimes(accepted&&outcome!=='recipients-changed'?1:0);
 expect(tm.state.editChatHistory).toHaveLength(accepted?2:1);
});

it('rejects replay and a superseded commit while native details are pending',async()=>{
 const {w}=setup('Draft.');const {api,current}=await wireBackground(w);
 runComposeEdit.mockResolvedValue({body:'Draft.',toDelta:{adds:[{email:'added@example.com'}],removes:['*']}});
 const run=()=>w.browser.runtime.sendMessage({type:'runInlineComposeEdit',body:'Draft.',request:'Change recipients'});
 const first=await run();
 let release;
 const nativeCommit=api.tmComposeRecipients.commit.getMockImplementation();
 api.tmComposeRecipients.commit.mockImplementationOnce((...args)=>new Promise(r=>{release=()=>nativeCommit(...args).then(r)}));
 const commit={type:'commitInlineComposeRecipients',recipientEdit:first.recipientEdit};
 const pending=w.browser.runtime.sendMessage(commit);
 await run();release();
 await pending;expect(api.compose.setComposeDetails).not.toHaveBeenCalled();
 const last=await run();const lastCommit={type:'commitInlineComposeRecipients',recipientEdit:last.recipientEdit};
 await w.browser.runtime.sendMessage(lastCommit);await w.browser.runtime.sendMessage(lastCommit);
 expect(current.to).toEqual(['added@example.com']);expect(api.compose.setComposeDetails).toHaveBeenCalledTimes(1);
});

it.each(['to','cc','bcc'])('preserves delta semantics and rejects newer %s recipients',async field=>{
 const {w}=setup('Draft.');const {api,current}=await wireBackground(w);
 current[field]=['"Example" <keep@example.com>','remove@example.com'];
 const delta={adds:[{email:'KEEP@example.com'},{name:'New',email:'new@example.com'},{email:'*'}],removes:['REMOVE@example.com']};
 runComposeEdit.mockResolvedValue({body:'Draft.',[field+'Delta']:delta});
 const run=()=>w.browser.runtime.sendMessage({type:'runInlineComposeEdit',body:'Draft.',request:'Update'});
 const proposal=await run();await w.browser.runtime.sendMessage({type:'commitInlineComposeRecipients',recipientEdit:proposal.recipientEdit});
 expect(current[field]).toEqual(['Example <keep@example.com>','New <new@example.com>']);
 const stale=await run();current[field]=['manual@example.com'];
 await w.browser.runtime.sendMessage({type:'commitInlineComposeRecipients',recipientEdit:stale.recipientEdit});
 expect(current[field]).toEqual(['manual@example.com']);expect(api.compose.setComposeDetails).toHaveBeenCalledTimes(1);
});
it.each(['read','write'])('native recipient %s failure does not corrupt body/history or retry the write',async failure=>{
 const {w,tm,body}=setup('<p>Draft.</p>');const {api}=await wireBackground(w);
 runComposeEdit.mockResolvedValue({body:'Expanded.',chatHistory:[{userRequest:'Expand'}],toDelta:{adds:[{email:'new@example.com'}],removes:[]}});
 if(failure==='read')api._nativeWindow.GetComposeDetails=()=>{throw Error('Synthetic read failure')};
 else api.compose.setComposeDetails.mockImplementationOnce(()=>{throw Error('Synthetic write failure')});
 tm.showInlineEditDropdown();await tm._runInlineEditInstruction({instruction:'Expand',wrapper:w.document.getElementById('tm-inline-edit')});
 expect(tm.extractUserAndQuoteTexts(body).originalUserMessage).toBe('Expanded.');expect(tm.state.editChatHistory).toEqual([{userRequest:'Expand'}]);
 expect(api.compose.setComposeDetails).toHaveBeenCalledTimes(failure==='read'?0:1);
});
it('forgets recipient operations on extension shutdown',async()=>{
 const {w}=setup('Draft.');const {api}=await wireBackground(w);
 runComposeEdit.mockResolvedValue({body:'Draft.',toDelta:{adds:[{email:'new@example.com'}],removes:[]}});
 const proposal=await w.browser.runtime.sendMessage({type:'runInlineComposeEdit',body:'Draft.',request:'Update'});
 api._experiment.onShutdown();
 await w.browser.runtime.sendMessage({type:'commitInlineComposeRecipients',recipientEdit:proposal.recipientEdit});
 expect(api.compose.setComposeDetails).not.toHaveBeenCalled();
});

it.each(Array.from({length:12},(_,i)=>i+1))('keeps the newest recipient action under seeded delayed results (%s)',async seed=>{
 const {w,tm,body}=setup('<p>Draft.</p>');const {api,current}=await wireBackground(w);
 let state=Math.imul(seed,0x9e3779b9)>>>0;const random=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296};
 const pendingResults=[];
 runComposeEdit.mockImplementation(()=>new Promise(resolve=>pendingResults.push(resolve)));
 const start=()=>{tm.showInlineEditDropdown();return tm._runInlineEditInstruction({instruction:'Update',wrapper:w.document.getElementById('tm-inline-edit')})};
 const first=start();await vi.waitFor(()=>expect(pendingResults).toHaveLength(1));tm.cancelInlineEditDropdown();
 const second=start();await vi.waitFor(()=>expect(pendingResults).toHaveLength(2));
 const manual=random()<0.5;if(manual)current.to=['manual@example.com'];
 const order=random()<0.5?[0,1]:[1,0];
 for(const n of order){for(let j=0,count=Math.floor(random()*4);j<count;j++)await Promise.resolve();pendingResults[n]({body:'Draft.',toDelta:{adds:[{email:`proposal${n}@example.com`}],removes:['*']}});await Promise.resolve();}
 await Promise.all([first,second]);
 expect(current.to).toEqual(manual?['manual@example.com']:['proposal1@example.com']);
 expect(api.compose.setComposeDetails).toHaveBeenCalledTimes(manual?0:1);
 expect(tm.extractUserAndQuoteTexts(body).originalUserMessage).toBe('Draft.');
});

it.each(['manual','newer-request','closed'])('rejects an obsolete proposal at the actual native commit boundary: %s',async change=>{
 const {w}=setup('Draft.');const {api,current}=await wireBackground(w);
 runComposeEdit.mockResolvedValue({body:'Draft.',toDelta:{adds:[{email:'proposal@example.com'}],removes:['*']}});
 const run=()=>w.browser.runtime.sendMessage({type:'runInlineComposeEdit',body:'Draft.',request:'Update'});
 const proposal=await run();
 const originalCommit=api.tmComposeRecipients.commit.getMockImplementation();let release;
 api.tmComposeRecipients.commit.mockImplementationOnce((...args)=>new Promise((resolve,reject)=>{release=()=>originalCommit(...args).then(resolve,reject)}));
 const pending=w.browser.runtime.sendMessage({type:'commitInlineComposeRecipients',recipientEdit:proposal.recipientEdit});
 if(change==='manual')current.to=['manual@example.com'];
 if(change==='newer-request')await run();
 if(change==='closed')api._nativeWindow.closed=true;
 release();
 if(change==='closed')await expect(pending).rejects.toThrow('Invalid compose tab');else await pending;
 expect(current.to).toEqual(change==='manual'?['manual@example.com']:['first@example.com']);expect(api.compose.setComposeDetails).not.toHaveBeenCalled();
});
it('does not allow another compose window to consume a proposal',async()=>{
 const {w}=setup('Draft.');const {api,current}=await wireBackground(w);
 runComposeEdit.mockResolvedValue({body:'Draft.',toDelta:{adds:[{email:'new@example.com'}],removes:[]}});
 const result=await w.browser.runtime.sendMessage({type:'runInlineComposeEdit',body:'Draft.',request:'Update'});
 const p=result.recipientEdit;
 expect(await api.tmComposeRecipients.commit(2,p.id,p.baseline,{to:['wrong@example.com']})).toBe(false);
 await w.browser.runtime.sendMessage({type:'commitInlineComposeRecipients',recipientEdit:p});
 expect(current.to).toEqual(['first@example.com','new@example.com']);
});
it('finishes the native check/write before a queued later user action',async()=>{
 const {w}=setup('Draft.');const {api,current}=await wireBackground(w);
 runComposeEdit.mockResolvedValue({body:'Draft.',toDelta:{adds:[{email:'proposal@example.com'}],removes:['*']}});
 const result=await w.browser.runtime.sendMessage({type:'runInlineComposeEdit',body:'Draft.',request:'Update'});
 api._nativeWindow.GetComposeDetails=()=>{const snapshot=structuredClone(current);queueMicrotask(()=>{current.to=['manual@example.com']});return snapshot};
 await w.browser.runtime.sendMessage({type:'commitInlineComposeRecipients',recipientEdit:result.recipientEdit});
 expect(api.compose.setComposeDetails).toHaveBeenCalledTimes(1);
 expect(current.to).toEqual(['manual@example.com']);
});

it.each(['to', 'cc', 'bcc'].flatMap(field => ['input', 'pill'].map(kind => [field, kind])))('preserves unfinished manual %s %s edits', async (field, kind) => {
 const {w}=setup('Draft.');const {api,current}=await wireBackground(w);
 runComposeEdit.mockResolvedValue({body:'Draft.',toDelta:{adds:[{email:'proposal@example.com'}],removes:['*']}});
 const result=await w.browser.runtime.sendMessage({type:'runInlineComposeEdit',body:'Draft.',request:'Update'});
 const input={value:kind==='input'?'unfinished@':''};const pill={isEditing:kind==='pill'};
 api._nativeWindow.document.querySelector.mockImplementation(selector=>selector===`.address-row[data-recipienttype="addr_${field}"]`?{
  querySelector:selector=>selector==='.address-row-input'?input:null,
  querySelectorAll:selector=>selector==='mail-address-pill'?[pill]:[]
 }:null);
 await w.browser.runtime.sendMessage({type:'commitInlineComposeRecipients',recipientEdit:result.recipientEdit});
 expect(api.compose.setComposeDetails).not.toHaveBeenCalled();expect(current.to).toEqual(['first@example.com']);
 expect(input.value).toBe(kind==='input'?'unfinished@':'');expect(pill.isEditing).toBe(kind==='pill');
 // A refused proposal is consumed, not deferred until the user's input is gone.
 input.value='';pill.isEditing=false;
 await w.browser.runtime.sendMessage({type:'commitInlineComposeRecipients',recipientEdit:result.recipientEdit});
 expect(api.compose.setComposeDetails).not.toHaveBeenCalled();
});
