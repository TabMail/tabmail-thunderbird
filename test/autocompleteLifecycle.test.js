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
  for (const name of ['libs/jsdiff.min.js', 'libs/diff-match-patch.js', 'modules/config.js', 'modules/logger.js', 'modules/state.js', 'modules/sentences.js', 'modules/tokens.js', 'modules/dom.js', 'modules/core.js', 'modules/diff.js', 'modules/previewModel.js', 'modules/richText.js', 'modules/preview.js', 'modules/events.js', 'modules/caret.js', 'modules/inlineEditor.js']) {
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

function commandCapture(w) {
  let html;
  w.document.execCommand = vi.fn((command, ui, value) => { html = value; return true; });
  return () => html;
}

describe('passive autocomplete preview lifecycle', () => {
  it.each([true, false])('does not mutate a rich body when visibility is %s', show => {
    const { tm, body } = setup('<p>Hello <b>Alex</b>.</p><p>I can send it next week.</p><div class="moz-signature">Signature</div>');
    const before = body.innerHTML;
    tm.state.correctedText = 'Hello Alex.\nI can send it Thursday.\n';
    tm.renderText(show);
    expect(body.innerHTML).toBe(before);
    expect(body.querySelector('[data-tabmail-diff]')).toBeNull();
  });
  it('puts the preview outside the serialized body and removes it without changing content', () => {
    const { w, tm, body } = setup('This is very useful.');
    const before = body.innerHTML;
    tm.state.correctedText = 'This is useful.';
    tm.renderText(true);
    const host = w.document.getElementById('tm-compose-preview');
    expect(host).not.toBeNull();
    expect(host.parentNode).toBe(w.document.documentElement);
    expect(body.innerHTML).toBe(before);
    tm.renderText(false);
    expect(w.document.getElementById('tm-compose-preview')).toBeNull();
    expect(body.innerHTML).toBe(before);
  });
  it.each(['isIMEComposing', 'inlineEditActive', 'beforeSendCleanupActive', 'autocompleteDisabled'])('suppresses preview during %s', flag => {
    const { w, tm } = setup('This is very useful.');
    tm.state.correctedText = 'This is useful.';
    tm.state[flag] = true;
    tm.renderText(true);
    expect(w.document.getElementById('tm-compose-preview')).toBeNull();
  });
  it('dismissal invalidates both in-flight request generations', () => {
    const { tm } = setup('Hello.');
    tm.state.latestLocalRequestId = 7; tm.state.latestGlobalRequestId = 9;
    tm.state.correctedText = 'Hello Alex.';
    tm.dismissComposeSuggestion();
    expect(tm.state.latestLocalRequestId).toBe(8);
    expect(tm.state.latestGlobalRequestId).toBe(10);
    expect(tm.state.correctedText).toBeNull();
  });
  it('Shift+Tab has no acceptance or jump action', () => {
    const { tm } = setup('Hello.');
    const e = { key: 'Tab', shiftKey: true, ctrlKey: false, altKey: false, metaKey: false, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    tm.state.previewJumpOffset = 1;
    expect(tm.handleAcceptRejectKey(e)).toBe(false);
    expect(tm.handleCursorMovementKey(e)).toBe(false);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });
  it('native undo shortcut is not intercepted', () => {
    const { tm } = setup('Hello.');
    const e = { key: 'z', metaKey: true, preventDefault: vi.fn() };
    expect(tm.handleUndoRedoKey(e)).toBe(false);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });
});

describe('shared HTML text/range projection', () => {
  it('uses one separator for nested blocks', () => {
    const { tm, body } = setup('<div><p>First sentence.</p></div><p>Second sentence.</p>');
    const index = tm.indexComposeText(body);
    expect(index.text).toBe('First sentence.\nSecond sentence.');
    const range = tm.composeRange(index, 16, 22);
    expect(range.toString()).toBe('Second');
  });
  it('does not add a synthetic paragraph newline before a caret inside that paragraph', () => {
    const { w, tm, body } = setup('<p>First sentence.</p><p>Second sentence.</p>');
    const r = w.document.createRange();r.setStart(body.lastChild.firstChild, 3);r.collapse(true);
    w.getSelection().removeAllRanges();w.getSelection().addRange(r);
    expect(tm.composeCursorOffset(tm.indexComposeText(body))).toBe(19);
  });
  it('excludes signature and quoted reply from editable offsets', () => {
    const { tm, body } = setup('Draft<div class="moz-signature">Signature</div><blockquote>Quoted text</blockquote>');
    expect(tm.extractUserAndQuoteTexts(body)).toMatchObject({ originalUserMessage: 'Draft', quoteAndSignatureText: 'Signature\nQuoted text' });
  });
  it('keeps list items on distinct lines', () => {
    const { tm, body } = setup('<ul><li>First</li><li>Second</li></ul>');
    expect(tm.indexComposeText(body).text).toBe('First\nSecond');
  });
});

describe('native acceptance payload (Gecko transaction semantics require live smoke tests)', () => {
  it('preserves unchanged rich markup and inline images between edits', () => {
    const { w, tm, body } = setup('<p><b>Bad</b> <img src="cid:synthetic"> <a href="https://example.com">link</a> bad</p><div class="moz-signature">Signature</div>');
    const read = commandCapture(w);
    const before = tm.extractUserAndQuoteTexts(body).originalUserMessage;
    expect(tm.applyComposeEdits(body, before, [{ start: 0, end: 3, text: 'Good' }, { start: before.indexOf('bad'), end: before.indexOf('bad') + 3, text: 'good' }])).toBe(true);
    expect(w.document.execCommand).toHaveBeenCalledTimes(1);
    const output = new JSDOM(read()).window.document.body;
    expect(output.querySelector('b').textContent).toBe('Good');
    expect(output.querySelector('img').getAttribute('src')).toBe('cid:synthetic');
    expect(output.querySelector('a').getAttribute('href')).toBe('https://example.com');
    expect(output.querySelector('.moz-signature')).toBeNull();
  });
  it('escapes proposed HTML as literal text', () => {
    const { w, tm, body } = setup('Hello');
    const read = commandCapture(w);
    expect(tm.applyComposeEdits(body, 'Hello', [{ start: 0, end: 5, text: '<img src=x onerror=alert(1)>' }])).toBe(true);
    expect(read()).toContain('&lt;img');
    expect(read()).not.toContain('<img');
  });
  it('rejects stale baseline without a native command', () => {
    const { w, tm, body } = setup('New user text');commandCapture(w);
    expect(tm.applyComposeEdits(body, 'Old text', [{ start: 0, end: 8, text: 'Suggestion' }])).toBe(false);
    expect(w.document.execCommand).not.toHaveBeenCalled();
    expect(body.textContent).toBe('New user text');
  });
  it('preserves an empty draft’s signature while proposing a complete native insertion', () => {
    const { w, tm, body } = setup('<div class="moz-signature">Signature</div>');
    const read = commandCapture(w);
    expect(tm.applyComposeEdits(body, '', [{ start: 0, end: 0, text: 'Hello\n\nBest,\nSam' }])).toBe(true);
    expect(read()).toBe('Hello<br><br>Best,<br>Sam');
    expect(body.querySelector('.moz-signature').textContent).toBe('Signature');
  });
});


describe('preview content and atomic keyboard integration', () => {
  it('reuses its styled bubble while the caret moves within the same sentence', () => {
    const { w, tm, body } = setup('The team is available. I can send it next week. Thanks.');
    tm.state.correctedText = 'The team is available. I can send it Thursday. Thanks.';
    const place = offset => { const r = w.document.createRange(); r.setStart(body.firstChild, offset); r.collapse(true); w.getSelection().removeAllRanges(); w.getSelection().addRange(r); };
    place(25); tm.renderComposePreview();
    const host = tm.state.previewView.host;
    const content = tm.state.previewView.host.querySelector('.content').textContent;
    place(35); tm.renderComposePreview();
    expect(tm.state.previewView.host).toBe(host);
    expect(tm.state.previewView.host.querySelector('.content').textContent).toBe(content);
    expect(tm.state.previewView.host.querySelector('.inserted').textContent).toContain('Thursday');
    expect(content).not.toContain('next week');
    expect(body.textContent).toContain('next week');
  });
  it('measures only the rendered lines intersecting the target sentence', () => {
    const { tm, body } = setup('A'.repeat(120));
    const context = tm.composeLineContext(tm.indexComposeText(body), 35, 65);
    expect(context).toMatchObject({ start: 30, end: 90, top: 40, bottom: 80 });
  });
  it('shows no extra paragraph delimiter in the bubble', () => {
    const { tm } = setup('<p>This is very useful.</p><p>Unrelated paragraph.</p>');
    tm.state.correctedText = 'This is useful.\nUnrelated paragraph.\n';
    tm.renderComposePreview();
    const content = tm.state.previewView.host.querySelector('.content').textContent;
    expect(content).toBe('This is useful.');
  });
  it('Tab applies every displayed edit once, preserves the signature, and leaves the caret at the accepted change', () => {
    const { w, tm, body } = setup('Hello. This is very bad. Thanks.<div class="moz-signature">Signature</div>');
    const r = w.document.createRange(); r.setStart(body.firstChild, 14); r.collapse(true); w.getSelection().removeAllRanges(); w.getSelection().addRange(r);
    tm.state.correctedText = 'Hello. This is good. Thanks.';
    tm.renderComposePreview();
    // This models DOM insertion for integration assertions; Gecko undo remains
    // a separate runtime smoke requirement.
    w.document.execCommand = vi.fn((command, ui, html) => {
      const range = w.getSelection().getRangeAt(0);
      range.deleteContents(); range.insertNode(range.createContextualFragment(html));
      return true;
    });
    const event = { key: 'Tab', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    tm.attachAutocomplete(body);
    tm.renderComposePreview();
    const key = new w.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    body.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(true);
    expect(body.textContent).toBe('Hello. This is good. Thanks.Signature');
    expect(w.document.execCommand).toHaveBeenCalledTimes(1);
    expect(tm.state.previewModel).toBeNull();
    const caret = tm.composeCursorOffset(tm.indexComposeText(body, tm.getQuoteBoundaryNode(body)));
    expect(body.textContent.slice(0, caret)).toBe('Hello. This is goo');
    expect(body.querySelector('.moz-signature').textContent).toBe('Signature');
  });
  it('restores selection and releases suppression after a failed native command', async () => {
    const { w, tm, body } = setup('Hello');
    const original = w.getSelection().getRangeAt(0).cloneRange();
    w.document.execCommand = vi.fn(() => { throw new Error('native failure'); });
    expect(tm.applyComposeEdits(body, 'Hello', [{ start: 0, end: 5, text: 'Hi' }])).toBe(false);
    expect(body.textContent).toBe('Hello');
    expect(w.getSelection().anchorNode).toBe(original.startContainer);
    expect(tm.state.applyingPreview).toBe(false);
    await new Promise(resolve => w.setTimeout(resolve, 0));
    expect(tm.state.selectionMuteDepth).toBe(0);
  });
});


describe('clickable suggestion controls', () => {
  it('offers disable inside a live preview and enable only in the disabled bottom floater', () => {
    const { w, tm, body } = setup('This is very useful.');
    tm.state.correctedText = 'This is useful.';
    tm.renderComposePreview(); tm.showComposeHintsBanner();
    expect(w.document.getElementById('tm-compose-hints-banner')).toBeNull();
    const controls = [...tm.state.previewView.host.querySelectorAll('button')];
    expect(controls.map(button => button.textContent)).toEqual(['Accept', 'Dismiss', 'Disable suggestions']);
    controls[2].click();
    expect(tm.state.autocompleteDisabled).toBe(true);
    expect(w.browser.storage.local.set).toHaveBeenCalledWith({ autocompleteEnabled: false });
    expect(w.document.getElementById('tm-compose-preview')).toBeNull();
    const banner = w.document.getElementById('tm-compose-hints-banner');
    expect(banner.parentElement).toBe(w.document.documentElement);
    expect(banner.textContent).toBe('Enable suggestions');
    expect(body.textContent).toBe('This is very useful.');
    banner.querySelector('button').click();
    expect(tm.state.autocompleteDisabled).toBe(false);
    expect(w.browser.storage.local.set).toHaveBeenLastCalledWith({ autocompleteEnabled: true });
    expect(w.document.getElementById('tm-compose-hints-banner')).toBeNull();
  });
  it('mouse dismissal preserves the draft and clears all suggestion state', () => {
    const { tm, body } = setup('This is very useful.');
    tm.state.correctedText = 'This is useful.';
    tm.renderComposePreview();
    [...tm.state.previewView.host.querySelectorAll('button')].find(button => button.textContent === 'Dismiss').click();
    expect(body.textContent).toBe('This is very useful.');
    expect(tm.state.correctedText).toBeNull();
    expect(tm.state.previewView).toBeNull();
  });
});


describe('rich acceptance invariants', () => {
  function nativeModel(w) {
    w.document.execCommand = vi.fn((command, ui, html) => {
      const range = w.getSelection().getRangeAt(0);
      range.deleteContents(); range.insertNode(range.createContextualFragment(html));
      return true;
    });
  }
  it.each(['b', 'a'])('keeps replacement letters inside the original %s node', tag => {
    const { w, tm, body } = setup(`Hello <${tag}>bad</${tag}>.`);
    nativeModel(w);
    expect(tm.applyComposeEdits(body, 'Hello bad.', [{ start: 6, end: 8, text: 'goo' }])).toBe(true);
    expect(body.querySelector(tag).textContent).toBe('good');
    expect(body.textContent).toBe('Hello good.');
  });
  it('accepts a paragraph proposal without a synthetic trailing separator', () => {
    const { w, tm, body } = setup('<p>Bad.</p>');
    nativeModel(w);
    expect(tm.applyComposeEdits(body, 'Bad.', [{ start: 0, end: 3, text: 'Good' }])).toBe(true);
    expect(body.innerHTML).toBe('<p>Good.</p>');
  });
  it('refuses a replacement across authored media without touching the draft', () => {
    const { w, tm, body } = setup('Hello very <img src="cid:synthetic">bad.');
    nativeModel(w);
    const before = body.innerHTML;
    expect(tm.applyComposeEdits(body, 'Hello very bad.', [{ start: 6, end: 14, text: 'good' }])).toBe(false);
    expect(body.innerHTML).toBe(before);
    expect(w.document.execCommand).not.toHaveBeenCalled();
  });
  it('does not turn the empty no-suggestion sentinel into a deletion proposal', () => {
    const { tm, body } = setup('Keep this draft.');
    tm.renderComposePreview();
    expect(tm.state.previewModel).toBeFalsy();
    expect(body.textContent).toBe('Keep this draft.');
  });
});


it('inline editing applies the returned text through the real callback and preserves formatting', async () => {
  const { w, tm, body } = setup('<p>Hello <b>bad</b>.</p><div class="moz-signature">Signature</div>');
  w.browser.runtime.sendMessage.mockResolvedValue({ body: 'Hello good.' });
  w.document.execCommand = vi.fn((command, ui, html) => {
    const range = w.getSelection().getRangeAt(0);
    range.deleteContents(); range.insertNode(range.createContextualFragment(html));
    return true;
  });
  const wrapper = w.document.createElement('div');
  wrapper._tm_cleanup = vi.fn();
  await tm._runInlineEditInstruction({ instruction: 'Correct the wording', wrapper });
  expect(body.querySelector('b').textContent).toBe('good');
  expect(body.querySelector('.moz-signature').textContent).toBe('Signature');
  expect(tm.state.originalText).toBe('Hello good.');
  expect(w.document.execCommand).toHaveBeenCalledTimes(1);
});

it('detaches keyboard and layout listeners and removes highlights on cleanup', () => {
  const { w, tm, body } = setup('This is very useful.');
  tm.attachAutocomplete(body);
  tm.state.correctedText = 'This is useful.';
  tm.renderComposePreview();
  expect(w.document.querySelectorAll('.source-underline').length).toBeGreaterThan(0);
  tm.cleanupEventListeners();
  expect(w.document.querySelector('.source-underline')).toBeNull();
  const render = vi.spyOn(tm, 'renderComposePreview');
  w.dispatchEvent(new w.Event('resize'));
  w.document.dispatchEvent(new w.Event('scroll'));
  const key = new w.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  body.dispatchEvent(key);
  expect(key.defaultPrevented).toBe(false);
  expect(render).not.toHaveBeenCalled();
  expect(body.textContent).toBe('This is very useful.');
});


it('does not map a quoted-message caret onto the editable draft', () => {
  const { w, tm, body } = setup('Draft.<blockquote type="cite">Quoted text.</blockquote>');
  const range = w.document.createRange();
  range.setStart(body.querySelector('blockquote').firstChild, 3);range.collapse(true);
  w.getSelection().removeAllRanges();w.getSelection().addRange(range);
  expect(tm.composeCursorOffset(tm.indexComposeText(body, tm.getQuoteBoundaryNode(body)))).toBeNull();
});

it.each([true,false])('dismissal defeats an awaited late response in local mode=%s',async(isLocal)=>{
 const {w,tm,body}=setup('Hello.');const before=body.innerHTML;tm.state.latestLocalRequestId=1;tm.state.latestGlobalRequestId=1;
 tm.state.correctedText='Hello there.';tm.renderText(true);expect(tm.state.previewModel).not.toBeNull();
 let resolveReply;tm.getCorrectionFromServer=vi.fn(()=>new Promise(resolve=>{resolveReply=resolve}));
 const pending=tm.triggerCorrectionBackend(body,'Hello.','',1,isLocal);expect(tm.getCorrectionFromServer).toHaveBeenCalledTimes(1);
 tm.dismissComposeSuggestion();resolveReply({suggestion:'Hello late.',usertext:'Hello.'});await pending;
 expect(tm.state.correctedText).toBeNull();expect(tm.state.previewModel).toBeNull();expect(w.document.getElementById('tm-compose-preview')).toBeNull();expect(body.innerHTML).toBe(before);
 expect(isLocal?tm.state.isLocalRequestInFlight:tm.state.isGlobalRequestInFlight).toBe(false);
});
it('preview renders model markup as literal text',()=>{
 const {tm,body}=setup('Hello.');const before=body.innerHTML;tm.state.correctedText='Hello <em>world</em>.';tm.renderText(true);
 const content=tm.state.previewView.host.querySelector('.content');expect(content.textContent).toContain('<em>world</em>');expect(content.querySelector('em')).toBeNull();expect(body.innerHTML).toBe(before);
});
it('repeated dismissal removes source highlights without draft mutation',()=>{
 const {w,tm,body}=setup('Hello.');const before=body.innerHTML;tm.state.correctedText='Hello there.';tm.renderText(true);expect(w.document.querySelector('.source-underline')).not.toBeNull();
 tm.dismissComposeSuggestion();tm.dismissComposeSuggestion();expect(w.document.querySelector('.source-underline')).toBeNull();expect(body.innerHTML).toBe(before);expect(tm.state.previewView).toBeNull();
});
it('composition start forbids a previously displayed acceptance',()=>{
 const {w,tm,body}=setup('Hello.');w.document.execCommand=vi.fn();tm.state.correctedText='Hello there.';tm.renderText(true);expect(tm.state.previewModel).not.toBeNull();tm.state.isIMEComposing=true;
 expect(tm.acceptComposePreview()).toBe(false);expect(body.textContent).toBe('Hello.');expect(w.document.execCommand).not.toHaveBeenCalled();
});

vi.mock('../agent/modules/llm.js',()=>({sendChat:vi.fn(async()=>({assistant:'Good.\n'}))}));
vi.mock('../agent/modules/idbStorage.js',()=>({set:vi.fn()}));
vi.mock('../agent/modules/promptGenerator.js',()=>({getUserCompositionPrompt:vi.fn(async()=>'')}));
vi.mock('../agent/modules/utils.js',()=>({log:vi.fn()}));
vi.mock('../chat/modules/helpers.js',()=>({formatTimestampForAgent:()=>''}));
import {generateCorrection} from '../compose/modules/autocompleteGenerator.js';

function nativeDOM(w) {
 w.document.execCommand=vi.fn((cmd,ui,html)=>{const r=w.getSelection().getRangeAt(0);r.deleteContents();r.insertNode(r.createContextualFragment(html));return true;});
}
it('a real generated correction can be accepted in a single HTML paragraph',async()=>{
 const {w,tm,body}=setup('<p>Bad.</p>');nativeDOM(w);
 tm.state.correctedText=await generateCorrection({userMessage:tm.extractUserAndQuoteTexts(body).originalUserMessage});
 expect(tm.state.correctedText).toBe('Good.');tm.renderText(true);
 expect(tm.state.previewView.host.querySelector('.content').textContent).toBe('Good.');
 expect(tm.acceptComposePreview()).toBe(true);
 expect(body.innerHTML).toBe('<p>Good.</p>');expect(w.document.execCommand).toHaveBeenCalledTimes(1);
});


it('preserves same-line inline typography in the preview without cloning authored markup', () => {
  const { tm, body } = setup('<b>Context.</b> This is very useful.');
  tm.state.correctedText = 'Context. This is useful.';
  tm.setCursorByOffset(body, 15);tm.renderComposePreview();
  const context = tm.state.previewView.host.querySelector('.context');
  expect(context.textContent).toBe('Context.');
  expect(context.style.fontWeight).toBe('bold');
  expect(tm.state.previewView.host.querySelector('b')).toBeNull();
});

it('scrolling a long empty-draft proposal preserves the visible scroll position and draft',()=>{
 const {w,tm,body}=setup('');
 try {
  tm.attachAutocomplete(body);
  tm.state.correctedText='A complete proposed paragraph.\n'.repeat(100);
  tm.renderComposePreview();
  const bubble=tm.state.previewView.host.querySelector('.preview');
  const content=bubble.querySelector('.content').textContent;
  expect(content.length).toBeGreaterThan(2500);
  expect(body.innerHTML).toBe('');
  bubble.scrollTop=150;
  bubble.dispatchEvent(new w.Event('scroll',{bubbles:false}));
  const current=tm.state.previewView.host.querySelector('.preview');
  expect(current.scrollTop).toBe(150);
  expect(current.querySelector('.content').textContent).toBe(content);
  expect(body.innerHTML).toBe('');
  const render=vi.spyOn(tm,'renderComposePreview');
  w.document.dispatchEvent(new w.Event('scroll'));
  expect(render).toHaveBeenCalledTimes(1);
  w.dispatchEvent(new w.Event('resize'));
  expect(render).toHaveBeenCalledTimes(2);
  expect(body.innerHTML).toBe('');
 } finally {w.close();}
});

it('a newer caret action prevents Tab from editing the previous sentence',()=>{
 const {w,tm,body}=setup('First is bad. Second is bad.');
 try {
  tm.attachAutocomplete(body);tm.state.correctedText='First is good. Second is good.';tm.renderComposePreview();
  expect(tm.state.previewModel.replacement.trim()).toBe('First is good.');
  tm.setCursorByOffset(body,20);w.document.dispatchEvent(new w.Event('selectionchange'));
  body.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));
  expect(body.textContent).toBe('First is bad. Second is bad.');
  expect(w.document.execCommand).not.toHaveBeenCalled();
  tm.renderComposePreview();
  body.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));
  expect(body.textContent).toBe('First is bad. Second is good.');
 } finally {w.close();}
});

it('a cached precompose reply must remain a proposal until the user accepts it',async()=>{
 const {w,tm,body}=setup('');
 try{
  tm.state.latestGlobalRequestId=1;
  tm.getCorrectionFromServer=async()=>({suggestion:'Hello Alex.\n\nHere is the proposal.',usertext:'',directReplace:true});
  await tm.triggerCorrectionBackend(body,'','',1,false);
  expect(tm.state.correctedText).toBe('Hello Alex.\n\nHere is the proposal.');
  expect(body.innerHTML).toBe('');
  expect(tm.state.isGlobalRequestInFlight).toBe(false);
  if(tm.state.previewModel){expect(tm.state.previewModel.edits.length).toBeGreaterThan(0);expect(tm.state.previewView.host.querySelector('.content').textContent).toContain('Here is the proposal.');}
 }finally{w.close();}
});


it('refuses an inline-produced paragraph join without altering authored structure', () => {
  const { w, tm, body } = setup('<p>One.</p><p>Two.</p>');
  const before = body.innerHTML;
  w.document.execCommand = vi.fn();
  const original = tm.indexComposeText(body).text;
  const edits = tm.composeEditsFromDiff(tm.computeDiff(original, 'One. Two.'));
  expect(tm.applyComposeEdits(body, original, edits)).toBe(false);
  expect(body.innerHTML).toBe(before);
  expect(w.document.execCommand).not.toHaveBeenCalled();
});


it('mouse Accept applies the displayed rich edit through its registered click handler', () => {
  const { w, tm, body } = setup('<p>Hello <b>bad</b>.</p>');
  tm.attachAutocomplete(body);
  const schedule = vi.spyOn(tm, 'scheduleTrigger');
  tm.state.correctedText = 'Hello good.';tm.renderComposePreview();
  tm.state.previewView.host.querySelector('button').click();
  expect(body.innerHTML).toBe('<p>Hello <b>good</b>.</p>');
  expect(tm.state.previewModel).toBeNull();
  expect(schedule).not.toHaveBeenCalled();
  expect(w.document.execCommand).toHaveBeenCalledTimes(1);
});

it('registered typing and IME handlers invalidate previews and defer requests until composition ends', () => {
  const { w, tm, body } = setup('Hello.');
  tm.attachAutocomplete(body);
  const schedule = vi.spyOn(tm, 'scheduleTrigger').mockImplementation(() => {});
  tm.state.correctedText = 'Hello Alex.';tm.renderComposePreview();
  body.dispatchEvent(new w.InputEvent('input', {bubbles:true, data:'x'}));
  expect(tm.state.correctedText).toBeNull();
  expect(tm.state.previewModel).toBeNull();
  expect(schedule).toHaveBeenCalledTimes(1);
  tm.state.correctedText = 'Hello Alex.';tm.renderComposePreview();
  body.dispatchEvent(new w.CompositionEvent('compositionstart', {bubbles:true}));
  body.dispatchEvent(new w.InputEvent('input', {bubbles:true, isComposing:true}));
  expect(tm.state.isIMEComposing).toBe(true);
  expect(tm.state.previewModel).toBeNull();
  expect(schedule).toHaveBeenCalledTimes(1);
  body.dispatchEvent(new w.CompositionEvent('compositionend', {bubbles:true}));
  expect(tm.state.isIMEComposing).toBe(false);
  expect(schedule).toHaveBeenCalledTimes(2);
  expect(body.textContent).toBe('Hello.');
});

it('the real inline editor restores the compose host before applying formatted text', async () => {
  const { w, tm, body } = setup('<p>Hello <b>bad</b>.</p><div class="moz-signature">Signature</div>');
  tm.attachAutocomplete(body);
  w.document.designMode = 'on';
  w.browser.runtime.sendMessage.mockResolvedValue({body:'Hello good.'});
  body.dispatchEvent(new w.KeyboardEvent('keydown', {key:'k',ctrlKey:true,bubbles:true,cancelable:true}));
  const wrapper = w.document.getElementById('tm-inline-edit');
  expect(wrapper).not.toBeNull();
  expect(tm.state.inlineEditActive).toBe(true);
  const input = wrapper.querySelector('iframe').contentDocument.querySelector('textarea');
  input.value = 'Correct the wording';
  input.dispatchEvent(new w.KeyboardEvent('keydown', {key:'Enter',ctrlKey:true,bubbles:true,cancelable:true}));
  await vi.waitFor(() => expect(body.querySelector('b').textContent).toBe('good'));
  expect(w.document.getElementById('tm-inline-edit')).toBeNull();
  expect(w.document.designMode).toBe('on');
  expect(tm.state.inlineEditActive).toBe(false);
  expect(body.querySelector('.moz-signature').textContent).toBe('Signature');
});

it('registered selection changes refresh the sentence preview after a user caret move', async () => {
  const { w, tm, body } = setup('First is bad. Second is bad.');
  tm.attachAutocomplete(body);
  tm.state.correctedText = 'First is good. Second is good.';tm.renderComposePreview();
  expect(tm.state.previewModel.replacement.trim()).toBe('First is good.');
  const caret = w.document.createRange();caret.setStart(body.firstChild,20);caret.collapse(true);
  w.getSelection().removeAllRanges();w.getSelection().addRange(caret);
  w.document.dispatchEvent(new w.Event('selectionchange'));
  await vi.waitFor(()=>expect(tm.state.previewModel.replacement.trim()).toBe('Second is good.'));
  expect(body.textContent).toBe('First is bad. Second is bad.');
});

it.each(['img','svg','video','audio','iframe','object','embed','input','textarea','select','canvas','hr'])('protects authored %s when a generated replacement crosses it',tag=>{
 const {w,tm,body}=setup('Hello very <'+tag+'></'+tag+'>bad.');
 const before=body.innerHTML;
 const original=tm.indexComposeText(body).text;
 const edits=tm.composeEditsFromDiff(tm.computeDiff(original,'Hello good.'));
 expect(edits.length).toBeGreaterThan(0);
 expect(tm.applyComposeEdits(body,original,edits)).toBe(false);
 expect(body.innerHTML).toBe(before);expect(w.document.execCommand).not.toHaveBeenCalled();
});
it.each([false,'throw'])('native command %s leaves retryable draft/selection intact',failure=>{
 const {w,tm,body}=setup('Hello bad.');tm.setCursorByOffset(body,7);
 const before=body.innerHTML, saved=w.getSelection().anchorOffset;
 w.document.execCommand=vi.fn(()=>{if(failure==='throw')throw Error('dependency failure');return false;});
 tm.state.correctedText='Hello good.';tm.renderComposePreview();
 expect(tm.acceptComposePreview()).toBe(false);expect(body.innerHTML).toBe(before);
 expect(w.getSelection().anchorOffset).toBe(saved);expect(tm.state.applyingPreview).toBe(false);
 expect(tm.state.correctedText).toBe('Hello good.');
 installNativeModel(w);tm.renderComposePreview();expect(tm.acceptComposePreview()).toBe(true);
 expect(body.textContent).toBe('Hello good.');
});
it.each([true,false])('newer input defeats late local=%s response', async local=>{
 const {w,tm,body}=setup('Hello.');tm.attachAutocomplete(body);
 let finish;tm.getCorrectionFromServer=vi.fn(()=>new Promise(r=>finish=r));
 tm.state.latestLocalRequestId=1;tm.state.latestGlobalRequestId=1;
 const request=tm.triggerCorrectionBackend(body,'Hello.','',1,local);
 body.firstChild.textContent='A different message.';body.dispatchEvent(new w.InputEvent('input',{bubbles:true}));
 finish({suggestion:'Hello older.',usertext:'Hello.'});await request;
 expect(body.textContent).toBe('A different message.');expect(tm.state.correctedText).toBeNull();
 expect(w.document.execCommand).not.toHaveBeenCalled();
});
it('new proposal and newer draft are both rechecked before acceptance',()=>{
 const {w,tm,body}=setup('Hello bad.');tm.state.correctedText='Hello good.';tm.renderComposePreview();
 tm.state.correctedText='Hello excellent.';
 expect(tm.acceptComposePreview()).toBe(false);expect(body.textContent).toBe('Hello bad.');
 expect(w.document.execCommand).not.toHaveBeenCalled();
 body.firstChild.textContent='Newer authored message.';
 expect(tm.acceptComposePreview()).toBe(false);expect(body.textContent).toBe('Newer authored message.');
});
it('two windows isolate proposal and acceptance state',()=>{
 const a=setup('Hello bad.'),b=setup('Hello bad.');
 a.tm.state.correctedText='Hello good.';a.tm.renderComposePreview();
 b.tm.state.correctedText='Hello excellent.';b.tm.renderComposePreview();
 a.tm.acceptComposePreview();
 expect(a.body.textContent).toBe('Hello good.');expect(b.body.textContent).toBe('Hello bad.');
 expect(b.tm.state.previewModel.replacement).toBe('Hello excellent.');
});

it('a range selection suppresses the visible proposal without changing the draft',()=>{
 const {w,tm,body}=setup('Hello bad.');const before=body.innerHTML;
 tm.state.correctedText='Hello good.';tm.renderComposePreview();expect(tm.state.previewModel).not.toBeNull();
 const range=w.document.createRange();range.setStart(body.firstChild,1);range.setEnd(body.firstChild,4);w.getSelection().removeAllRanges();w.getSelection().addRange(range);
 tm.renderComposePreview();expect(w.document.getElementById('tm-compose-preview')).toBeNull();expect(body.innerHTML).toBe(before);
});
it('moving the caret into the quote suppresses draft acceptance controls',()=>{
 const {w,tm,body}=setup('Hello bad.<blockquote type="cite">Quoted text.</blockquote>');const before=body.innerHTML;
 tm.state.correctedText='Hello good.';tm.renderComposePreview();expect(tm.state.previewModel).not.toBeNull();
 const range=w.document.createRange();range.setStart(body.querySelector('blockquote').firstChild,3);range.collapse(true);w.getSelection().removeAllRanges();w.getSelection().addRange(range);
 tm.renderComposePreview();expect(w.document.getElementById('tm-compose-preview')).toBeNull();expect(body.innerHTML).toBe(before);
});
it.each(['mouse','keyboard'])('%s jump navigates before allowing acceptance',mode=>{
 const {w,tm,body}=setup('Hello. This is bad.');const before=body.innerHTML;
 tm.attachAutocomplete(body);tm.state.correctedText='Hello. This is good.';tm.renderComposePreview();
 expect(tm.state.previewModel).toBeNull();expect(tm.state.previewJumpOffset).toBeGreaterThan(6);
 if(mode==='mouse')tm.state.previewView.host.querySelector('button').click();
 else body.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));
 expect(body.innerHTML).toBe(before);expect(tm.composeCursorOffset(tm.indexComposeText(body))).toBeGreaterThan(6);
 expect(tm.state.previewModel.replacement).toContain('This is good.');expect(w.document.execCommand).not.toHaveBeenCalled();
 tm.state.previewView.host.querySelector('button').click();expect(body.textContent).toBe('Hello. This is good.');expect(w.document.execCommand).toHaveBeenCalledTimes(1);
});


it('underlines only source text fragments outside the authored DOM without the Highlight API', () => {
  const {w,tm,body}=setup('<p>Before. Target <b>sentence</b><img alt="kept" src="cid:fixture"> here. After.</p>');
  w.CSS=undefined;w.Highlight=undefined;
  const style=w.document.createElement('style');style.textContent=readFileSync(resolve('compose/highlight.css'),'utf8')+readFileSync(resolve('compose/preview.css'),'utf8');w.document.head.appendChild(style);
  const before=body.innerHTML,measured=[];
  let shift=0;
  w.Range.prototype.getClientRects=function(){
    expect(this.startContainer.nodeType).toBe(w.Node.TEXT_NODE);
    expect(this.endContainer).toBe(this.startContainer);
    measured.push(this.toString());
    const left=this.startContainer.parentElement.tagName==='B'?128: this.startContainer.nodeValue.startsWith('Before')?72:8;
    const top=left===8?40:20;
    return [{left:left+shift,right:left+shift+48,top,bottom:top+20,width:48,height:20},{left:0,top:0,right:0,bottom:20,width:0,height:20},{left:0,top:0,right:48,bottom:0,width:48,height:0}];
  };
  tm.setCursorByOffset(body,10);tm.state.correctedText='Before. Revised sentence here. After.';tm.renderText(true);
  const lines=[...w.document.querySelectorAll('.source-underline')];
  expect(lines).toHaveLength(3);
  expect(measured.join('').trim()).toBe('Target sentence here.');
  expect(lines.map(line=>[line.style.left,line.style.top,line.style.width])).toEqual([['72px','39px','48px'],['128px','39px','48px'],['8px','59px','48px']]);
  for(const line of lines){
    expect(body.contains(line)).toBe(false);
    expect(line.getAttribute('aria-hidden')).toBe('true');
    const painted=w.getComputedStyle(line);
    expect(painted.position).toBe('fixed');
    expect(painted.zIndex).toBe('0');
    expect(painted.pointerEvents).toBe('none');
    expect(painted.backgroundColor).toBe('rgba(0, 0, 0, 0)');
    expect(painted.borderBottomStyle).toBe('solid');
    expect(painted.borderBottomWidth).toBe('1px');
  }
  expect(w.getComputedStyle(w.document.querySelector('.preview')).position).toBe('relative');
  expect(w.getComputedStyle(w.document.querySelector('.preview')).zIndex).toBe('1');
  shift=100;tm.renderText(true);
  expect(w.document.querySelectorAll('.source-underline')).toHaveLength(3);
  expect(lines.every(line=>!line.isConnected)).toBe(true);
  expect(w.document.querySelector('.source-underline').style.left).toBe('172px');
  expect(body.innerHTML).toBe(before);
  tm.dismissComposeSuggestion();
  expect(w.document.querySelector('.source-underline')).toBeNull();
  expect(body.innerHTML).toBe(before);
});

it('an empty-draft proposal has no source underline',()=>{
  const {w,tm,body}=setup('');tm.state.correctedText='Hello Alex.';tm.renderText(true);
  expect(w.document.querySelector('.preview .content').textContent).toBe('Hello Alex.');
  expect(w.document.querySelector('.source-underline')).toBeNull();
  expect(body.innerHTML).toBe('');
});

it('every wrapped source fragment is underlined while authored content is unchanged', () => {
 const {w,tm,body}=setup('This is a long sentence that wraps onto another line.');
 const before=body.innerHTML;
 const boxes=[{left:8,top:20,right:248,bottom:40,width:240,height:20},{left:8,top:40,right:120,bottom:60,width:112,height:20}];
 w.Range.prototype.getClientRects=function(){return boxes;};
 tm.state.correctedText='This is a clear sentence that wraps onto another line.';
 tm.renderText(true);
 expect(tm.state.previewModel.replacement).toBe('This is a clear sentence that wraps onto another line.');
 const lines=[...w.document.querySelectorAll('.source-underline')];
 expect(lines.map(line=>[line.style.left,line.style.top,line.style.width])).toEqual([['8px','39px','240px'],['8px','59px','112px']]);
 expect(lines.every(line=>!body.contains(line))).toBe(true);
 expect(body.innerHTML).toBe(before);
 tm.dismissComposeSuggestion();
 expect(w.document.querySelectorAll('.source-underline')).toHaveLength(0);
 expect(body.innerHTML).toBe(before);
});
it('moving from a proposal to jump-only context clears the previously underlined sentence',()=>{
 const {w,tm,body}=setup('First is bad. Second is fine.');
 const before=body.innerHTML;
 tm.state.correctedText='First is good. Second is fine.';
 tm.renderText(true);
 const first=[...w.document.querySelectorAll('.source-underline')];
 expect(first.length).toBeGreaterThan(0);
 tm.setCursorByOffset(body,20);
 tm.renderText(true);
 expect(tm.state.previewModel).toBeNull();
 expect(tm.state.previewJumpOffset).toBeGreaterThanOrEqual(0);
 expect(w.document.querySelector('.preview .content').textContent).toBe('Tab to jump to suggestion');
 expect(w.document.querySelectorAll('.source-underline')).toHaveLength(0);
 expect(first.every(line=>!line.isConnected)).toBe(true);
 expect(body.innerHTML).toBe(before);
});
it.each(['<p>Target bad.</p><p>After.</p>','Target bad.<br>After.'])('paragraph and line-break separators do not produce painted source fragments: %s',html=>{
 const {w,tm,body}=setup(html);
 const before=body.innerHTML;
 w.Range.prototype.getClientRects=function(){return [{left:8,top:20,right:120,bottom:40,width:112,height:20}];};
 tm.state.correctedText='Target good.\nAfter.';
 tm.setCursorByOffset(body,3);
 tm.renderText(true);
 expect(tm.state.previewModel.replacement.trim()).toBe('Target good.');
 expect(tm.state.previewModel.original).toBe('Target bad.\nAfter.');
 expect(w.document.querySelectorAll('.source-underline')).toHaveLength(1);
 expect(body.innerHTML).toBe(before);
});
