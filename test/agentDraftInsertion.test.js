/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { parse } from 'acorn';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
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
async function producerSystem(rows, generatedReply = null){
 const events={};const event=k=>({addListener:fn=>{events[k]=fn},removeListener:()=>{}});

 const browser={tabs:{onCreated:event('created'),onRemoved:event('removed')},compose:{getComposeDetails:async()=>({type:'reply',relatedMessageId:7,subject:'Synthetic thread',from:'sender@example.com',to:['reader@example.com'],cc:[]}),onBeforeSend:event('beforeSend'),onAfterSend:event('afterSend')},runtime:{onMessage:event('message'),onSuspend:event('suspend')}};
 const inert={log(){},warn(){},error(){},info(){},debug(){}};
 const idb=createContext({indexedDB:new IDBFactory(),browser,console:inert});
 loadScript('agent/modules/idbStorage.js',idb);
 await idb.set(rows);
 const common={browser,messenger:browser,idb,console:inert,performance,Date,setTimeout:()=>0,clearTimeout(){},setInterval:()=>0,clearInterval(){},getUniqueMessageKey:async()=> 'synthetic-account:synthetic-message',log(){},formatForLog:x=>x};
 const tracker=createContext({...common,createReply:async()=>{ if (!generatedReply) throw Error('unexpected generator'); await idb.set({'reply:synthetic-account:synthetic-message': generatedReply}); },STORAGE_PREFIX:'reply:',applyPriorityTag:async()=>{},ACTIONS:{},getActionForWeId:async()=>null,getSentFoldersForAccount:async()=>[]});
 loadScript('agent/modules/composeTracker.js',tracker);tracker.initComposeHandlers();
 const created=events.created,removed=events.removed;
 const bg=createContext({...common,generateCorrection:async()=>{throw Error('unexpected LLM call');},runComposeEdit:async()=>{throw Error('unexpected inline call');}});bg.window=bg;
 loadScript('compose/background.js',bg);
 return {idb,read:async key=>(await idb.get(key))[key],created,removed,request:(tabId,message)=>events.message(message,{tab:{id:tabId}})};
}
function wire(s,sys,id){
 const filename=resolve('compose/modules/api.js');runInContext(readFileSync(filename,'utf8'),s.dom.getInternalVMContext(),{filename});
 s.w.browser.runtime.sendMessage=vi.fn(msg=>sys.request(id,msg));
}
it('real tracker/background/API round trip inserts once in its original window',async()=>{
 const key='reply:synthetic-account:synthetic-message';
 // This exact shape is written by runStateSendEmail before beginReply.
 const sys=await producerSystem({[key]:{reply:'Synthetic agent draft.',source:'chat_compose',ts:Date.now(),directReplace:true}});
 await sys.created({id:41});
 const s=setup('');wire(s,sys,41);
 await s.tm.triggerCorrectionBackend(s.body,'','',0,true);
 expect(s.w.browser.runtime.sendMessage).toHaveBeenCalledTimes(1);expect(s.body.textContent).toBe('Synthetic agent draft.');expect(s.w.document.execCommand).toHaveBeenCalledTimes(1);
 expect((await sys.read('activePrecompose:41')).directReplace).toBe(false);
});
it('a later manual reply must not re-arm an earlier chat draft insertion',async()=>{
 const key='reply:synthetic-account:synthetic-message';
 const sys=await producerSystem({[key]:{reply:'Earlier chat draft.',source:'chat_compose',ts:Date.now(),directReplace:true}});
 await sys.created({id:41});const a=setup('');wire(a,sys,41);
 await a.tm.triggerCorrectionBackend(a.body,'','',0,true);
 expect((await sys.read('activePrecompose:41')).directReplace).toBe(false);
 await sys.removed(41);expect(await sys.read('activePrecompose:41')).toBeUndefined();
 await sys.created({id:42});const b=setup('');wire(b,sys,42);
 await b.tm.triggerCorrectionBackend(b.body,'','',0,true);
 expect(b.w.browser.runtime.sendMessage).toHaveBeenCalledTimes(1);
 expect(b.body.textContent).toBe('');expect(b.w.document.execCommand).not.toHaveBeenCalled();
 expect(b.tm.acceptComposePreview()).toBe(true);expect(b.body.textContent).toBe('Earlier chat draft.');
 expect((await sys.read(key)).reply).toBe('Earlier chat draft.');
});
it('real response cannot replace a newer cleared body',async()=>{
 const key='reply:synthetic-account:synthetic-message';
 const sys=await producerSystem({[key]:{reply:'Older agent draft.',source:'chat_compose',ts:Date.now(),directReplace:true}});
 await sys.created({id:41});const s=setup('');wire(s,sys,41);s.tm.attachAutocomplete(s.body);
 let unblock;const response=sys.request;sys.request=async(...args)=>{const value=await response(...args);expect(value.directReplace).toBe(true);expect(value.suggestion).toBe('Older agent draft.');await new Promise(r=>unblock=r);return value;};
 const pending=s.tm.triggerCorrectionBackend(s.body,'','',0,true);await vi.waitFor(()=>expect(unblock).toBeTypeOf('function'));
 s.body.textContent='New wording';s.body.dispatchEvent(new s.w.InputEvent('input',{bubbles:true,inputType:'insertText'}));
 s.body.textContent='';s.body.dispatchEvent(new s.w.InputEvent('input',{bubbles:true,inputType:'deleteContentBackward'}));
 expect(s.tm.state.autocompleteIdleTimer).not.toBeNull();
 unblock();await pending;
 expect(s.body.textContent).toBe('');expect(s.w.document.execCommand).not.toHaveBeenCalled();
});

it.each([false, true])('generated reply cache only permits one automatic insertion: %s', async directReplace => {
  const draft = { reply: 'Generated draft.', directReplace };
  const sys = await producerSystem({}, draft);
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
  expect(later.tm.acceptComposePreview()).toBe(true);
  expect(later.body.textContent).toBe('Generated draft.');
  expect(await sys.read('reply:synthetic-account:synthetic-message')).toEqual({...draft, directReplace: false});
});

it('overlapping reply windows receive insertion permission only once', async () => {
  const key = 'reply:synthetic-account:synthetic-message';
  const sys = await producerSystem({ [key]: { reply: 'One draft.', directReplace: true } });
  await Promise.all([sys.created({id: 61}), sys.created({id: 62})]);
  const drafts = [setup(''), setup('')];
  for (const [i, draft] of drafts.entries()) {
    wire(draft, sys, 61 + i);
    await draft.tm.triggerCorrectionBackend(draft.body, '', '', 0, true);
  }
  expect(drafts.map(draft => draft.body.textContent).sort()).toEqual(['', 'One draft.']);
  expect(await sys.read(key)).toEqual({reply: 'One draft.', directReplace: false});
});

it('a concurrent newer producer write remains the cached proposal', async () => {
  const key = 'reply:synthetic-account:synthetic-message';
  const older = {reply: 'Older draft.', directReplace: true, source: 'chat_compose', ts: 1};
  const newer = {reply: 'Newer draft.', directReplace: true, source: 'chat_compose', ts: 2};
  const sys = await producerSystem({[key]: older});
  let newerWrite;
  for (const name of ['get', 'getAndClearFlag']) {
    const original = sys.idb[name];
    sys.idb[name] = (...args) => {
      const pending = original(...args);
      // Queue the producer write while the activation's read is pending.
      if (args[0] === key && !newerWrite) newerWrite = sys.idb.set({[key]: newer});
      return pending;
    };
  }
  await sys.created({id: 71});
  expect(newerWrite).toBeDefined();
  await newerWrite;
  const cached = await sys.read(key);
  expect(cached).toEqual(newer);
  const s = setup(''); wire(s, sys, 71);
  await s.tm.triggerCorrectionBackend(s.body, '', '', 0, true);
  expect(s.body.textContent).toBe('Older draft.');
  expect((await sys.read(key)).reply).toBe('Newer draft.');
  await sys.created({id: 72});
  const next = setup(''); wire(next, sys, 72);
  await next.tm.triggerCorrectionBackend(next.body, '', '', 0, true);
  expect(next.body.textContent).toBe('Newer draft.');
  expect(await sys.read(key)).toEqual({...newer, directReplace: false});
});

it('an aborted flag transaction cannot activate a draft and remains retryable', async () => {
  const key = 'reply:synthetic-account:synthetic-message';
  const payload = {reply: 'Retry this draft.', directReplace: true};
  const sys = await producerSystem({[key]: payload});
  const originalPut = IDBObjectStore.prototype.put;
  let aborted = false;
  const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (row, ...args) {
    const result = originalPut.call(this, row, ...args);
    if (row.key === key && row.value.directReplace === false && !aborted) {
      aborted = true;
      queueMicrotask(() => this.transaction.abort());
    }
    return result;
  });
  try {
    await sys.created({id: 81});
    expect(aborted).toBe(true);
    expect(await sys.read('activePrecompose:81')).toBeUndefined();
    expect(await sys.read(key)).toEqual(payload);
  } finally {
    put.mockRestore();
  }
  await sys.created({id: 82});
  const draft = setup(''); wire(draft, sys, 82);
  await draft.tm.triggerCorrectionBackend(draft.body, '', '', 0, true);
  expect(draft.body.textContent).toBe(payload.reply);
  expect(await sys.read(key)).toEqual({...payload, directReplace: false});
});

// Thunderbird inserts the identity signature itself. Agent drafts and
// suggestions that copy a "-- " signature must not show it a second time.
const ownSignature = '<pre class="moz-signature" cols="72">-- \nPat Example\nExample Co</pre>';
const signedDraft = 'Hi Alex,\n\nSynthetic agent draft.\n\nBest,\nPat\n\n-- \nPat Example\nExample Co';
const signatureCount = body => body.textContent.split('Pat Example').length - 1;
function respond(s, suggestion) {
  const filename = resolve('compose/modules/api.js');
  runInContext(readFileSync(filename, 'utf8'), s.dom.getInternalVMContext(), { filename });
  s.w.browser.runtime.sendMessage = vi.fn(async () => ({ suggestion, usertext: '' }));
}

it.each([true, false])('an agent draft that copies the signature shows it once (direct insertion: %s)', async directReplace => {
  const key = 'reply:synthetic-account:synthetic-message';
  const sys = await producerSystem({ [key]: { reply: signedDraft, source: 'chat_compose', ts: Date.now(), directReplace } });
  await sys.created({ id: 91 });
  const s = setup(`<p><br></p>${ownSignature}`); wire(s, sys, 91);
  await s.tm.triggerCorrectionBackend(s.body, s.tm.extractUserAndQuoteTexts(s.body).originalUserMessage, '', 0, true);
  if (!directReplace) expect(s.tm.acceptComposePreview()).toBe(true);
  expect(s.tm.extractUserAndQuoteTexts(s.body).originalUserMessage).toBe('Hi Alex,\n\nSynthetic agent draft.\n\nBest,\nPat');
  expect(signatureCount(s.body)).toBe(1);
  expect(s.body.querySelectorAll('.moz-signature')).toHaveLength(1);
});

// Only an empty draft is filtered, so text the user wrote is never cut.
async function suggest(html, typed, suggestion) {
  const s = setup(html); respond(s, suggestion);
  await s.tm.triggerCorrectionBackend(s.body, typed, '', 0, true);
  return s;
}

it.each([
  ['no signature of its own', '', signedDraft],
  ['no signature of its own (bare delimiter)', '', 'Hi Alex,\n\nThanks.\n-- '],
  ['only a quoted copy of the same signature', '<blockquote type="cite">Earlier<div class="moz-signature">-- <br>Pat Example<br>Example Co</div></blockquote>', signedDraft],
  ['only a forwarded copy of the same signature', '<div class="moz-forward-container">Forwarded<div class="moz-signature">-- <br>Pat Example<br>Example Co</div></div>', signedDraft],
])('a suggested signature stays when the draft has %s', async (_, tail, suggestion) => {
  const s = await suggest(`<p><br></p>${tail}`, '', suggestion);
  expect(s.tm.state.correctedText).toBe(suggestion);
});

// Gecko stores a typed "-- " in HTML as "--&nbsp;"; model output arrives NFKC-normalized.
it.each([
  ['a copied signature', 'Hi Alex,', 'Hi Alex,\n\n-- \nPat Example\nExample Co'],
  ['a copied signature without a delimiter', 'Hi Alex,', 'Hi Alex,\n\nPat Example\nExample Co'],
  ['a typed delimiter', 'Hi Alex,<br>--&nbsp;<br>Pat', 'Hi Alex,\n-- \nPat\nExample Co'],
  ['contact lines under a model-added delimiter', 'Hi Alex,<br>Thanks,<br>Pat Example, Example Co', 'Hi Alex,\nThanks,\n-- \nPat Example\nExample Co'],
  ['a line without letters under a model-added delimiter', 'Hi Alex,<br>Thanks<br>:)', 'Hi Alex,\nThanks a lot\n-- \n:)'],
])('a draft the user has written in is never filtered: %s', async (_, html, suggestion) => {
  const s = setup(`<p>${html}</p>${ownSignature}`);
  const typed = s.tm.extractUserAndQuoteTexts(s.body).originalUserMessage;
  respond(s, suggestion);
  await s.tm.triggerCorrectionBackend(s.body, typed, '', 0, true);
  expect(s.tm.state.correctedText).toBe(suggestion);
});

// A copy is the last paragraph, made of exactly the signature's words (any
// line breaks, order, case or punctuation), with a "-- " line just above it
// or none. Nothing else is ever dropped.
const longSignature = '<pre class="moz-signature">-- \nPat Example\nSenior Engineer, Example Co\nTel 555-0100</pre>';
it.each([
  ['a copy after a delimiter', 'Hi Alex,\n\n-- \nPat Example\nExample Co', ownSignature, 'Hi Alex,'],
  ['a copy right under a delimiter', 'Hi Alex,\nThanks,\n-- \nPat Example\nExample Co', ownSignature, 'Hi Alex,\nThanks,'],
  ['a copy without a delimiter', 'Hi Alex,\n\nBest,\nPat\n\nPat Example\nExample Co', ownSignature, 'Hi Alex,\n\nBest,\nPat'],
  ['a copy with blank lines under a delimiter', 'Hi Alex,\n--\n\n\nPat Example\nExample Co', ownSignature, 'Hi Alex,'],
  ['a copy followed by a whitespace-only line', 'Hi Alex,\n\n-- \nPat Example\nExample Co\n \n', ownSignature, 'Hi Alex,'],
  ['two copies', 'Hi Alex,\n\n-- \nPat Example\nExample Co\n\n-- \nPat Example\nExample Co', ownSignature, 'Hi Alex,'],
  ['two copies without delimiters', 'Hi Alex,\n\nPat Example\nExample Co\n\nPat Example\nExample Co', ownSignature, 'Hi Alex,'],
  ['a re-wrapped copy', 'Hi Alex,\n\n-- \nPat Example, Example Co', ownSignature, 'Hi Alex,'],
  ['a copy with its lines swapped', 'Hi Alex,\n\nExample Co\nPat Example', ownSignature, 'Hi Alex,'],
  ['full-width digits the model normalized', 'Hi Alex,\n\n-- \nPat Example\nTel 555-0100', '<pre class="moz-signature">-- \nPat Example\nTel ５５５-０１００</pre>', 'Hi Alex,'],
  ['a capitalized copy', 'Hi Alex,\n\n-- \nPAT EXAMPLE\nExample Co', ownSignature, 'Hi Alex,'],
  ['Windows line ends', 'Hi Alex,\r\n\r\n-- \r\nPat Example\r\nExample Co', ownSignature, 'Hi Alex,'],
  ['a copy of an HTML signature', 'Hi Alex,\n\n-- \nPat Example\nExample Co', '<div class="moz-signature">-- <br>Pat <b>Example</b><br><a href="https://example.com">Example Co</a></div>', 'Hi Alex,'],
  ['a copy of a longer signature', 'Hi Alex,\n\nBest,\nPat\n\n-- \nPat Example\nSenior Engineer, Example Co\nTel 555-0100', longSignature, 'Hi Alex,\n\nBest,\nPat'],
  ['a copy of a signature with an emoji', 'Hi Alex,\n\n-- \nPat Example 🎉', '<pre class="moz-signature">-- \nPat Example 🎉</pre>', 'Hi Alex,'],
  ['a copy of a one-word signature', 'Hi Alex,\n\n-- \nPat', '<pre class="moz-signature">-- \nPat</pre>', 'Hi Alex,'],
  ['a copy of a two-word name', 'Hi Alex,\n\nAnn Marie', '<pre class="moz-signature">-- \nAnn Marie</pre>', 'Hi Alex,'],
  ['a copy of a Devanagari signature', 'नमस्ते,\n\n-- \nसीमा शर्मा\nउदाहरण कंपनी', '<pre class="moz-signature">-- \nसीमा शर्मा\nउदाहरण कंपनी</pre>', 'नमस्ते,'],
])('a copied signature is dropped: %s', async (_, suggestion, signature, kept) => {
  const s = await suggest(`<p><br></p>${signature}`, '', suggestion);
  expect(s.tm.state.correctedText).toBe(kept);
});

// Never drop text that is not the signature: anything not exactly a copy stays.
const addressSignature = '<pre class="moz-signature">-- \nPat Example\n12 Main St\nSpringfield</pre>';
const phoneSignature = '<pre class="moz-signature">-- \nPat Example\n+1 555 0100</pre>';
it.each([
  ['an older signature with a word the current one lacks', 'Hi Alex,\n\n-- \nPat Example\nFormer Co', ownSignature],
  ['an edited signature with a new number', 'Hi Alex,\n\n-- \nPat Example\nSenior Engineer, Example Co\nTel 555-0199', longSignature],
  ['a copy missing a word', 'Hi Alex,\n\n-- \nPat Example\nEngineer, Example Co\nTel 555-0100', longSignature],
  ['a copy missing a line', 'Hi Alex,\n\n-- \nPat Example\nSenior Engineer, Example Co', longSignature],
  ['half of the signature', 'Hi Alex,\n\n-- \nPat Example', ownSignature],
  ['a copy with a word repeated', 'Hi Alex,\n\n-- \nPat Example\nExample Co\nExample', ownSignature],
  ['a copy right under the sign-off', 'Hi Alex,\n\nBest,\nPat Example\nExample Co', ownSignature],
  ['a copy under a dash line that is not a delimiter', 'Hi Alex,\nNotes below --\nPat Example\nExample Co', ownSignature],
  ['a copy under a longer dash line', 'Hi Alex,\n---\nPat Example\nExample Co', ownSignature],
  ['a copy whose first line starts with dashes', 'Hi Alex,\n--Pat Example\nExample Co', ownSignature],
  ['a copy under an indented dash line', 'Hi Alex,\n -- \nPat Example\nExample Co', ownSignature],
  ['the name-only signature as the sign-off name', 'Hi Alex,\n\nBest,\nPat Example', '<pre class="moz-signature">-- \nPat Example</pre>'],
  ['the one-word signature as the sign-off name', 'Hi Alex,\n\nBest,\nPat', '<pre class="moz-signature">-- \nPat</pre>'],
  ['a sign-off name of a longer signature', 'Hi Alex,\n\nBest,\nPat Example', longSignature],
  ['a line after the copy', 'Hi Alex,\n\n-- \nPat Example\nExample Co\n\nSee you then.', ownSignature],
  ['a line without words after the copy', 'Hi Alex,\n\n-- \nPat Example\nExample Co\n:)', ownSignature],
  ['an emoji on the copy', 'Hi Alex,\n\n-- \nPat Example 🎉\nExample Co', ownSignature],
  ['the sign-off on the signature line', 'Hi Alex,\n\nThanks, Pat Example, Example Co', ownSignature],
  ['a sentence with the signature words', 'Hi Alex,\n\nCall Pat Example at Example Co.', ownSignature],
  ['a sentence ending in the signature words', 'Hi Sam,\n\nThe agreement was signed by\nPat Example, Example Co', ownSignature],
  ['a sentence wrapped across the signature words', 'Hi Alex,\n\nThe contract is with\nExample Co\nand Pat Example.', ownSignature],
  ['a closing line naming the company', 'Hi Sam,\n\nWe are excited to join\nExample Co', '<pre class="moz-signature">-- \nPat\nExample Co</pre>'],
  ['a team sign-off', 'Hi Sam,\n\nCheers,\nThe team at\nExample Co', '<pre class="moz-signature">-- \nPat\nExample Co</pre>'],
  ['an address under its sentence', 'Hi Sam,\n\nPlease ship it to:\n12 Main St\nSpringfield', addressSignature],
  ['an address in a paragraph of its own', 'Hi Sam,\n\nPlease ship it to my address:\n\n12 Main St\nSpringfield', addressSignature],
  ['a phone number under its sentence', 'Hi Sam,\n\nYou can reach me at:\n+1 555 0100', phoneSignature],
  ['a phone number in a paragraph of its own', 'Hi Sam,\n\nYou can reach me at:\n\n+1 555 0100', phoneSignature],
  ['names under a heading', 'Hi Sam,\n\nFrom our side:\nPat Example\nSales', '<pre class="moz-signature">-- \nPat Example\nExample Co\nSales</pre>'],
  ['a winner announced', 'Hi Sam,\n\nThe winner is\nPat Example', '<pre class="moz-signature">-- \nPat Example</pre>'],
  ['dash lines with no copy', 'Hi Alex,\n--Pat\n---\nwait -- what\n -- \nThanks.', ownSignature],
  ['a paragraph after the copy sharing a signature word', 'Hi Alex,\n\nPat Example\nSenior Engineer\n\nExample Co is hiring!', longSignature],
  ['the signature words run together', 'Hi Alex,\n\nAnnmarie', '<pre class="moz-signature">-- \nAnn Marie</pre>'],
  ['a signature without words', 'Hi Alex,\n\n-- \n:)', '<pre class="moz-signature">-- \n:)</pre>'],
  ['a different Devanagari name as the sign-off', 'नमस्ते,\n\nमासी', '<pre class="moz-signature">-- \nसीमा</pre>'],
  ['a different Devanagari name in a closing line', 'नमस्ते,\n\nइनसे बात करें:\nमासी शर्मा', '<pre class="moz-signature">-- \nसीमा शर्मा</pre>'],
])('a suggestion that does not end in a copy stays whole: %s', async (_, suggestion, signature) => {
  const s = await suggest(`<p><br></p>${signature}`, '', suggestion);
  expect(s.tm.state.correctedText).toBe(suggestion);
});

// The invariant, checked without the production code's own helpers: whatever
// the draft, only its end is dropped, and what is dropped is nothing but
// "-- " lines, blank lines and whole paragraphs that each hold exactly the
// signature's words (punctuation aside), the first of them starting after a
// blank line, a "-- " line or nothing.
it('never drops anything but whole copies of the signature (seeded random drafts)', () => {
  let seed = 0x5eed;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = list => list[Math.floor(random() * list.length)];
  const signatureWords = ['Pat', 'Example', 'Co', 'Senior', 'Engineer', 'Tel', '555', '0100'];
  const otherWords = ['Hi', 'Alex', 'thanks', 'team', 'see', 'you', 'Friday', 'Former', '0199', 'and', 'with', 'is', 'hiring', ':)', '🎉', '+'];
  const copyLines = ['Pat Example', 'Senior Engineer, Example Co', 'Tel 555-0100'];
  const key = text => (text.toLowerCase().match(/[a-z0-9]+/g) || []).sort().join(' ');
  const signatureKey = key(copyLines.join(' '));
  const isDelimiter = line => /^--[^\S\r\n]*$/.test(line);
  const s = setup(`<p><br></p>${longSignature}`);
  let cuts = 0;
  for (let n = 0; n < 2000; n++) {
    const lines = Array.from({ length: 1 + Math.floor(random() * 8) }, () => {
      const kind = random();
      if (kind < 0.1) return '';
      if (kind < 0.18) return pick(['-- ', '--', '---', '--Pat', ' -- ']);
      const words = Array.from({ length: 1 + Math.floor(random() * 4) }, () => pick(random() < 0.6 ? signatureWords : otherWords));
      return words.join(pick([' ', ', ']));
    });
    // Half the drafts end in a copy of the signature: whole or damaged,
    // re-wrapped or not, in a paragraph of its own or not.
    if (random() < 0.5) {
      const copy = copyLines.filter(() => random() < 0.9);
      if (copy.length && random() < 0.3) copy[Math.floor(random() * copy.length)] += ` ${pick(otherWords)}`;
      lines.push(...pick([['', '-- '], [''], ['-- '], []]), ...(random() < 0.3 ? [copy.join(' ')] : copy));
    }
    const draft = lines.join('\n');
    const result = s.tm.withoutAddedSignature(s.body, '', draft);
    expect(draft.startsWith(result)).toBe(true);
    if (result === draft) continue;
    cuts++;
    // The first entry is what is left of the last kept line (or, when the
    // whole draft goes, its first line).
    const rest = draft.slice(result.length).split('\n');
    const first = rest.findIndex(line => line.trim());
    const lost = `${JSON.stringify(draft)} lost ${JSON.stringify(rest.join('\n'))}`;
    expect(isDelimiter(rest[first]) || result === '' || first >= 2, lost).toBe(true);
    const paragraphs = [[]];
    for (const line of rest.slice(first)) {
      if (!line.trim() || isDelimiter(line)) paragraphs.push([]);
      else paragraphs.at(-1).push(line);
    }
    for (const paragraph of paragraphs.filter(p => p.length)) {
      expect(paragraph.every(line => /[a-z0-9]/i.test(line) && !/[^\s\p{P}a-z0-9]/iu.test(line)), lost).toBe(true);
      expect(key(paragraph.join(' ')), lost).toBe(signatureKey);
    }
  }
  // Not vacuous: the drafts do exercise the cut.
  expect(cuts).toBeGreaterThan(250);
});

it('a reply whose quote carries a signature still shows its own signature once', async () => {
  const key = 'reply:synthetic-account:synthetic-message';
  const sys = await producerSystem({ [key]: { reply: signedDraft, source: 'chat_compose', ts: Date.now(), directReplace: true } });
  await sys.created({ id: 92 });
  const s = setup(`<p><br></p><div class="moz-cite-prefix">Alex wrote:</div><blockquote type="cite">Earlier<div class="moz-signature">-- <br>Alex</div></blockquote>${ownSignature}`); wire(s, sys, 92);
  await s.tm.triggerCorrectionBackend(s.body, s.tm.extractUserAndQuoteTexts(s.body).originalUserMessage, '', 0, true);
  expect(s.tm.extractUserAndQuoteTexts(s.body).originalUserMessage).toBe('Hi Alex,\n\nSynthetic agent draft.\n\nBest,\nPat');
  expect(signatureCount(s.body)).toBe(1);
});

it.each(['-- \nPat Example\nExample Co', 'Pat Example\nExample Co'])('a suggestion that is only a signature proposes nothing: %j', async suggestion => {
  const s = await suggest(`<p><br></p>${ownSignature}`, '', suggestion);
  expect(s.tm.state.correctedText).toBeFalsy();
  expect(s.w.document.getElementById('tm-compose-preview')).toBeNull();
});
