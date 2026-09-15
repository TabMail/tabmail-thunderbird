/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { parse } from 'acorn';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';
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
  return { dom, w, tm, body: w.document.body };
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

function loadScript(relative,scope){
 const filename=resolve(relative),source=readFileSync(filename,'utf8');
 const ast=parse(source,{ecmaVersion:'latest',sourceType:'module'});let text=source;
 for(const n of [...ast.body].reverse()){
  const end=n.type==='ImportDeclaration'?n.end:n.type==='ExportNamedDeclaration'?n.declaration?.start:null;
  if(end!=null)text=text.slice(0,n.start)+text.slice(n.start,end).replace(/[^\n]/g,' ')+text.slice(end);
 }
 runInContext(text,scope,{filename});
}
function producerSystem(rows, generatedReply = null){
 const events={};const event=k=>({addListener:fn=>{events[k]=fn},removeListener:()=>{}});
 const idb={get:async k=>({[k]:structuredClone(rows[k])}),getAndClearFlag:async(k,flag)=>{const value=structuredClone(rows[k]);if(rows[k]?.[flag]===true) rows[k][flag]=false;return {[k]:value};},set:async values=>Object.assign(rows,structuredClone(values)),remove:async k=>delete rows[k]};
 const browser={tabs:{onCreated:event('created'),onRemoved:event('removed')},compose:{getComposeDetails:async()=>({type:'reply',relatedMessageId:7,subject:'Synthetic thread',from:'sender@example.com',to:['reader@example.com'],cc:[]}),onBeforeSend:event('beforeSend'),onAfterSend:event('afterSend')},runtime:{onMessage:event('message'),onSuspend:event('suspend')}};
 const inert={log(){},warn(){},error(){},info(){},debug(){}};
 const common={browser,messenger:browser,idb,console:inert,performance,Date,setTimeout:()=>0,clearTimeout(){},setInterval:()=>0,clearInterval(){},getUniqueMessageKey:async()=> 'synthetic-account:synthetic-message',log(){},formatForLog:x=>x};
 const tracker=createContext({...common,createReply:async()=>{ if (!generatedReply) throw Error('unexpected generator'); rows['reply:synthetic-account:synthetic-message'] = structuredClone(generatedReply); },STORAGE_PREFIX:'reply:',applyPriorityTag:async()=>{},ACTIONS:{},getActionForWeId:async()=>null,getSentFoldersForAccount:async()=>[]});
 loadScript('agent/modules/composeTracker.js',tracker);tracker.initComposeHandlers();
 const created=events.created,removed=events.removed;
 const bg=createContext({...common,generateCorrection:async()=>{throw Error('unexpected LLM call');},runComposeEdit:async()=>{throw Error('unexpected inline call');}});bg.window=bg;
 loadScript('compose/background.js',bg);
 return {rows,created,removed,request:(tabId,message)=>events.message(message,{tab:{id:tabId}})};
}
function wire(s,sys,id){
 const filename=resolve('compose/modules/api.js');runInContext(readFileSync(filename,'utf8'),s.dom.getInternalVMContext(),{filename});
 s.w.browser.runtime.sendMessage=vi.fn(msg=>sys.request(id,msg));
}
it('real tracker/background/API round trip inserts once in its original window',async()=>{
 const key='reply:synthetic-account:synthetic-message';
 // This exact shape is written by runStateSendEmail before beginReply.
 const sys=producerSystem({[key]:{reply:'Synthetic agent draft.',source:'chat_compose',ts:Date.now(),directReplace:true}});
 await sys.created({id:41});
 const s=setup('');wire(s,sys,41);
 await s.tm.triggerCorrectionBackend(s.body,'','',0,true);
 expect(s.w.browser.runtime.sendMessage).toHaveBeenCalledTimes(1);expect(s.body.textContent).toBe('Synthetic agent draft.');expect(s.w.document.execCommand).toHaveBeenCalledTimes(1);
 expect(sys.rows['activePrecompose:41'].directReplace).toBe(false);
});
it('a later manual reply must not re-arm an earlier chat draft insertion',async()=>{
 const key='reply:synthetic-account:synthetic-message';
 const sys=producerSystem({[key]:{reply:'Earlier chat draft.',source:'chat_compose',ts:Date.now(),directReplace:true}});
 await sys.created({id:41});const a=setup('');wire(a,sys,41);
 await a.tm.triggerCorrectionBackend(a.body,'','',0,true);
 expect(sys.rows['activePrecompose:41'].directReplace).toBe(false);
 await sys.removed(41);expect(sys.rows['activePrecompose:41']).toBeUndefined();
 await sys.created({id:42});const b=setup('');wire(b,sys,42);
 await b.tm.triggerCorrectionBackend(b.body,'','',0,true);
 expect(b.w.browser.runtime.sendMessage).toHaveBeenCalledTimes(1);
 expect(b.body.textContent).toBe('');expect(b.w.document.execCommand).not.toHaveBeenCalled();
});
it('real response cannot replace a newer cleared body',async()=>{
 const key='reply:synthetic-account:synthetic-message';
 const sys=producerSystem({[key]:{reply:'Older agent draft.',source:'chat_compose',ts:Date.now(),directReplace:true}});
 await sys.created({id:41});const s=setup('');wire(s,sys,41);s.tm.attachAutocomplete(s.body);
 let unblock;const response=sys.request;sys.request=async(...args)=>{const value=await response(...args);await new Promise(r=>unblock=r);return value;};
 const pending=s.tm.triggerCorrectionBackend(s.body,'','',0,true);await vi.waitFor(()=>expect(unblock).toBeTypeOf('function'));
 s.body.textContent='New wording';s.body.dispatchEvent(new s.w.InputEvent('input',{bubbles:true,inputType:'insertText'}));
 s.body.textContent='';s.body.dispatchEvent(new s.w.InputEvent('input',{bubbles:true,inputType:'deleteContentBackward'}));
 expect(s.tm.state.autocompleteIdleTimer).not.toBeNull();
 unblock();await pending;
 expect(s.body.textContent).toBe('');expect(s.w.document.execCommand).not.toHaveBeenCalled();
});

it.each([false, true])('generated reply cache only permits one automatic insertion: %s', async directReplace => {
  const draft = { reply: 'Generated draft.', directReplace };
  const sys = producerSystem({}, draft);
  await sys.created({ id: 51 });
  const first = setup(''); wire(first, sys, 51);
  await first.tm.triggerCorrectionBackend(first.body, '', '', 0, true);
  expect(first.body.textContent).toBe(directReplace ? 'Generated draft.' : '');
  if (!directReplace) expect(first.w.document.getElementById('tm-compose-preview')).not.toBeNull();
  await sys.created({ id: 52 });
  const later = setup(''); wire(later, sys, 52);
  await later.tm.triggerCorrectionBackend(later.body, '', '', 0, true);
  expect(later.body.textContent).toBe('');
  expect(later.w.document.execCommand).not.toHaveBeenCalled();
  expect(later.w.document.getElementById('tm-compose-preview')).not.toBeNull();
});

it('overlapping reply windows receive insertion permission only once', async () => {
  const key = 'reply:synthetic-account:synthetic-message';
  const sys = producerSystem({ [key]: { reply: 'One draft.', directReplace: true } });
  await Promise.all([sys.created({id: 61}), sys.created({id: 62})]);
  const drafts = [setup(''), setup('')];
  for (const [i, draft] of drafts.entries()) {
    wire(draft, sys, 61 + i);
    await draft.tm.triggerCorrectionBackend(draft.body, '', '', 0, true);
  }
  expect(drafts.map(draft => draft.body.textContent).sort()).toEqual(['', 'One draft.']);
  expect(sys.rows[key]).toEqual({reply: 'One draft.', directReplace: false});
});
