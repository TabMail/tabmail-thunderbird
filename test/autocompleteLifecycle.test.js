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
    const content = tm.state.previewView.root.querySelector('.content').textContent;
    place(35); tm.renderComposePreview();
    expect(tm.state.previewView.host).toBe(host);
    expect(tm.state.previewView.root.querySelector('.content').textContent).toBe(content);
    expect(tm.state.previewView.root.querySelector('.inserted').textContent).toContain('Thursday');
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
    const content = tm.state.previewView.root.querySelector('.content').textContent;
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
    const controls = [...tm.state.previewView.root.querySelectorAll('button')];
    expect(controls.map(button => button.textContent)).toEqual(['Tab Accept', 'Esc Dismiss', '⇧Esc Disable suggestions']);
    expect(controls.map(button=>button.getAttribute('aria-keyshortcuts'))).toEqual(['Tab','Escape','Shift+Escape']);
    expect(controls.map(button=>button.querySelector('kbd').getAttribute('aria-hidden'))).toEqual(['true','true','true']);
    controls[2].click();
    expect(tm.state.autocompleteDisabled).toBe(true);
    expect(w.browser.storage.local.set).toHaveBeenCalledWith({ autocompleteEnabled: false });
    expect(w.document.getElementById('tm-compose-preview')).toBeNull();
    const banner = w.document.getElementById('tm-compose-hints-banner');
    expect(banner.parentElement).toBe(w.document.documentElement);
    expect(banner.textContent).toBe('⇧Esc Enable suggestions');
    expect(banner.querySelector('button').getAttribute('aria-keyshortcuts')).toBe('Shift+Escape');
    expect(banner.querySelector('button').style.background).toBe('var(--tm-preview-bg)');
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
    [...tm.state.previewView.root.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === 'Dismiss').click();
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
  wrapper.id='tm-inline-edit';body.appendChild(wrapper);
  wrapper._tm_cleanup = vi.fn(()=>wrapper.remove());
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
  expect((tm.state.previewView?.root.querySelectorAll('.source-underline') ?? []).length).toBeGreaterThan(0);
  tm.cleanupEventListeners();
  expect((tm.state.previewView?.root.querySelector('.source-underline') ?? null)).toBeNull();
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
 const content=tm.state.previewView.root.querySelector('.content');expect(content.textContent).toContain('<em>world</em>');expect(content.querySelector('em')).toBeNull();expect(body.innerHTML).toBe(before);
});
it('repeated dismissal removes source highlights without draft mutation',()=>{
 const {w,tm,body}=setup('Hello.');const before=body.innerHTML;tm.state.correctedText='Hello there.';tm.renderText(true);expect((tm.state.previewView?.root.querySelector('.source-underline') ?? null)).not.toBeNull();
 tm.dismissComposeSuggestion();tm.dismissComposeSuggestion();expect((tm.state.previewView?.root.querySelector('.source-underline') ?? null)).toBeNull();expect(body.innerHTML).toBe(before);expect(tm.state.previewView).toBeNull();
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
 expect(tm.state.previewView.root.querySelector('.content').textContent).toBe('Good.');
 expect(tm.acceptComposePreview()).toBe(true);
 expect(body.innerHTML).toBe('<p>Good.</p>');expect(w.document.execCommand).toHaveBeenCalledTimes(1);
});


it('preserves same-line inline typography in the preview without cloning authored markup', () => {
  const { tm, body } = setup('<b>Context.</b> This is very useful.');
  tm.state.correctedText = 'Context. This is useful.';
  tm.setCursorByOffset(body, 15);tm.renderComposePreview();
  const context = tm.state.previewView.root.querySelector('.context');
  expect(context.textContent).toBe('Context.');
  expect(context.style.fontWeight).toBe('bold');
  expect(tm.state.previewView.root.querySelector('b')).toBeNull();
});

it('scrolling a long empty-draft proposal preserves the visible scroll position and draft',()=>{
 const {w,tm,body}=setup('');
 try {
  tm.attachAutocomplete(body);
  tm.state.correctedText='A complete proposed paragraph.\n'.repeat(100);
  tm.renderComposePreview();
  const bubble=tm.state.previewView.root.querySelector('.preview');
  const content=bubble.querySelector('.content').textContent;
  expect(content.length).toBeGreaterThan(2500);
  expect(body.innerHTML).toBe('');
  bubble.scrollTop=150;
  bubble.dispatchEvent(new w.Event('scroll',{bubbles:false}));
  const current=tm.state.previewView.root.querySelector('.preview');
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
  if(tm.state.previewModel){expect(tm.state.previewModel.edits.length).toBeGreaterThan(0);expect(tm.state.previewView.root.querySelector('.content').textContent).toContain('Here is the proposal.');}
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
  tm.state.previewView.root.querySelector('button').click();
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

it.each(['keyboard','click'])('the real inline editor restores the compose host before applying formatted text via %s', async mode => {
  const { w, tm, body } = setup('<p>Hello <b>bad</b>.</p><div class="moz-signature">Signature</div>');
  tm.attachAutocomplete(body);
  w.document.designMode = 'on';
  tm.state.correctedText = 'Hello better.';
  tm.renderComposePreview();
  expect(tm.state.previewView).not.toBeNull();
  w.browser.runtime.sendMessage.mockResolvedValue({body:'Hello good.'});
  // Native editor transactions can move focus while replacing the selection.
  body.tabIndex = 0;
  const focusSink=w.document.createElement('button');w.document.head.appendChild(focusSink);
  const nativeEdit=w.document.execCommand;
  w.document.execCommand=vi.fn((...args)=>{const result=nativeEdit(...args);focusSink.focus();return result;});
  body.dispatchEvent(new w.KeyboardEvent('keydown', {key:'k',ctrlKey:true,bubbles:true,cancelable:true}));
  const wrapper = w.document.getElementById('tm-inline-edit');
  expect(wrapper).not.toBeNull();
  expect(tm.state.inlineEditActive).toBe(true);
  expect(tm.state.previewView).toBeNull();
  tm.renderComposePreview();
  expect(tm.state.previewView).toBeNull();
  expect(parseFloat(wrapper.style.width)).toBe(w.innerWidth - 2 * tm.config.preview.margin);
  const input = wrapper.querySelector('iframe').contentDocument.querySelector('textarea');
  input.value = 'Correct the wording';
  const actionRoot = wrapper.querySelector('.tm-inline-actions').shadowRoot;
  const actions = [...actionRoot.querySelectorAll('button')];
  expect(actionRoot.querySelector('style').textContent).toBe(tm.composeActionCSS);
  expect(wrapper.textContent).not.toContain('Esc');
  expect(actionRoot.querySelector('.tm-compose-actions').getAttribute('contenteditable')).toBe('false');
  expect(actions.map(b=>b.textContent)).toEqual(['Enter Edit draft','Esc Dismiss','⇧Enter Newline']);
  expect(actionRoot.querySelector('.tm-compose-actions')).not.toBeNull();
  expect(wrapper.querySelector('.tm-inline-actions').getAttribute('spellcheck')).toBe('false');
  const actionSheet=w.document.getElementById('tm-compose-action-styles').sheet;
  const hoverRule=[...actionSheet.cssRules].find(rule=>rule.selectorText?.includes(':hover'));
  expect(hoverRule.style.background).toBe('var(--tm-preview-insert)');
  expect(hoverRule.style.color).toBe('var(--tm-preview-text)');
  expect(actions.every(button=>button.matches(hoverRule.selectorText.split(',')[0].replace(':hover','')))).toBe(true);
  expect(actions.every(button=>!button.style.background && !button.style.color)).toBe(true);
  expect(wrapper.querySelector('.tm-inline-overlay').style.background).toBe('transparent');
  const ph=input.ownerDocument.querySelector('.ph');
  expect(input.ownerDocument.defaultView.getComputedStyle(input).paddingLeft).toBe('0px');
  expect(input.ownerDocument.defaultView.getComputedStyle(ph).left).toBe('0px');
  expect(input.ownerDocument.defaultView.getComputedStyle(ph).lineHeight).toBe(input.ownerDocument.defaultView.getComputedStyle(input).lineHeight);
  if (mode === 'click') {
    input.setSelectionRange(input.value.length,input.value.length);actions[2].click();
    expect(input.value).toBe('Correct the wording\n');
    expect(w.browser.runtime.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({type:'runInlineComposeEdit'}));
  }
  const newline = new w.KeyboardEvent('keydown', {key:'Enter',shiftKey:true,bubbles:true,cancelable:true});
  input.dispatchEvent(newline);
  expect(newline.defaultPrevented).toBe(false);
  expect(w.document.getElementById('tm-inline-edit')).toBe(wrapper);
  const composing = new w.KeyboardEvent('keydown', {key:'Enter',isComposing:true,bubbles:true,cancelable:true});
  input.dispatchEvent(composing);
  expect(composing.defaultPrevented).toBe(false);
  if (mode === 'click') actions[0].click();
  else input.dispatchEvent(new w.KeyboardEvent('keydown', {key:'Enter',bubbles:true,cancelable:true}));
  await vi.waitFor(() => expect(body.querySelector('b').textContent).toBe('good'));
  expect(w.document.getElementById('tm-inline-edit')).toBeNull();
  expect(w.document.designMode).toBe('on');
  expect(tm.state.inlineEditActive).toBe(false);
  expect(body.querySelector('.moz-signature').textContent).toBe('Signature');
  expect(w.document.activeElement === body).toBe(true);
  expect(body.style.caretColor).not.toBe('transparent');
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
it('cursor hint Tab jump navigates before allowing acceptance',()=>{
 const {w,tm,body}=setup('Hello. This is bad.');const before=body.innerHTML;
 tm.attachAutocomplete(body);tm.state.correctedText='Hello. This is good.';tm.renderComposePreview();
 expect(tm.state.previewModel).toBeNull();expect(tm.state.previewJumpOffset).toBeGreaterThan(6);
 expect(tm.state.previewView.root.querySelector('.preview')).toBeNull();
 expect(tm.state.previewView.root.querySelector('.tm-fake-caret')).not.toBeNull();
 body.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));
 expect(body.innerHTML).toBe(before);expect(tm.composeCursorOffset(tm.indexComposeText(body))).toBeGreaterThan(6);
 expect(tm.state.previewModel.replacement).toContain('This is good.');expect(w.document.execCommand).not.toHaveBeenCalled();
 tm.state.previewView.root.querySelector('button').click();expect(body.textContent).toBe('Hello. This is good.');expect(w.document.execCommand).toHaveBeenCalledTimes(1);
});


it('underlines only source text fragments outside the authored DOM without the Highlight API', () => {
  const {w,tm,body}=setup('<p>Before. Target <b>sentence</b><img alt="kept" src="cid:fixture"> here. After.</p>');
  w.CSS=undefined;w.Highlight=undefined;
  const style=w.document.createElement('style');style.textContent=tm.composePreviewCSS;w.document.head.appendChild(style);
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
  const lines=[...(tm.state.previewView?.root.querySelectorAll('.source-underline') ?? [])];
  expect(lines).toHaveLength(3);
  expect(measured).toEqual(['Target ', 'Targ', 't', 'sentence', ' here. ']);
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
  expect(w.getComputedStyle((tm.state.previewView?.root.querySelector('.preview') ?? null)).position).toBe('relative');
  expect(w.getComputedStyle((tm.state.previewView?.root.querySelector('.preview') ?? null)).zIndex).toBe('1');
  shift=100;tm.renderText(true);
  expect((tm.state.previewView?.root.querySelectorAll('.source-underline') ?? [])).toHaveLength(3);
  expect(lines.every(line=>!line.isConnected)).toBe(true);
  expect((tm.state.previewView?.root.querySelector('.source-underline') ?? null).style.left).toBe('172px');
  expect(body.innerHTML).toBe(before);
  tm.dismissComposeSuggestion();
  expect((tm.state.previewView?.root.querySelector('.source-underline') ?? null)).toBeNull();
  expect(body.innerHTML).toBe(before);
});

it('an empty-draft proposal has no source underline',()=>{
  const {w,tm,body}=setup('');tm.state.correctedText='Hello Alex.';tm.renderText(true);
  expect((tm.state.previewView?.root.querySelector('.preview .content') ?? null).textContent).toBe('Hello Alex.');
  expect((tm.state.previewView?.root.querySelector('.source-underline') ?? null)).toBeNull();
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
 const lines=[...(tm.state.previewView?.root.querySelectorAll('.source-underline') ?? [])];
 expect(lines.map(line=>[line.style.left,line.style.top,line.style.width])).toEqual([['8px','39px','240px'],['8px','59px','112px']]);
 expect(lines.every(line=>!body.contains(line))).toBe(true);
 expect(body.innerHTML).toBe(before);
 tm.dismissComposeSuggestion();
 expect((tm.state.previewView?.root.querySelectorAll('.source-underline') ?? [])).toHaveLength(0);
 expect(body.innerHTML).toBe(before);
});
it('moving from a proposal to jump-only context clears the previously underlined sentence',()=>{
 const {w,tm,body}=setup('First is bad. Second is fine.');
 const before=body.innerHTML;
 tm.state.correctedText='First is good. Second is fine.';
 tm.renderText(true);
 const first=[...(tm.state.previewView?.root.querySelectorAll('.source-underline') ?? [])];
 expect(first.length).toBeGreaterThan(0);
 tm.setCursorByOffset(body,20);
 tm.renderText(true);
 expect(tm.state.previewModel).toBeNull();
 expect(tm.state.previewJumpOffset).toBeGreaterThanOrEqual(0);
 expect((tm.state.previewView?.root.querySelector('.preview') ?? null)).toBeNull();
 expect((tm.state.previewView?.root.querySelector('.tm-fake-caret') ?? null)).not.toBeNull();
 expect((tm.state.previewView?.root.querySelectorAll('.source-underline') ?? [])).toHaveLength(0);
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
 expect((tm.state.previewView?.root.querySelectorAll('.source-underline') ?? [])).toHaveLength(1);
 expect(body.innerHTML).toBe(before);
});

it.each([[200,'left'],[200,'right'],[1024,'left'],[1024,'right']])('keeps the suggestion inset on both sides of a %ipx viewport with a %s anchor',(viewport,anchor)=>{
 const {w,tm,body}=setup('Bad sentence.');
 Object.defineProperty(w,'innerWidth',{value:viewport,configurable:true});
 body.getBoundingClientRect=()=>({left:0,right:viewport,top:0,bottom:100,width:viewport,height:100});
 w.Range.prototype.getBoundingClientRect=()=>({left:anchor==='left'?8:viewport-20,right:anchor==='left'?16:viewport-12,top:20,bottom:40,width:8,height:20});
 tm.state.correctedText='Good sentence.';
 tm.renderComposePreview();
 const host=tm.state.previewView.host,left=parseFloat(host.style.left),width=parseFloat(host.style.width);
 expect(left).toBeGreaterThanOrEqual(8);
 expect(width).toBeGreaterThan(100);
 expect(left+width).toBeLessThanOrEqual(viewport-8);
 const bubble=host.shadowRoot.querySelector('.preview');
 expect(parseFloat(bubble.style.paddingLeft)).toBe(12);expect(parseFloat(bubble.style.paddingRight)).toBe(12);
 expect(width-parseFloat(bubble.style.paddingLeft)-parseFloat(bubble.style.paddingRight)-2).toBeGreaterThanOrEqual(94);
 expect(body.textContent).toBe('Bad sentence.');
});
it('reduces preview typography proportionally while preserving authored emphasis and content',()=>{
 const {w,tm,body}=setup('<p style="font:20px/30px Arial">Bad <b style="font-size:24px">sentence</b>.</p>');
 const before=body.innerHTML;
 tm.state.correctedText='Good sentence.';tm.renderComposePreview();
 const content=tm.state.previewView.root.querySelector('.content');
 expect(content.style.fontSize).toBe('18px');expect(content.style.lineHeight).toBe('27px');
 const bold=[...content.children].find(span=>span.textContent==='sentence');
 expect(bold).toBeDefined();expect(bold.style.fontSize).toBe('21.6px');expect(bold.style.fontWeight).toBe('bold');
 expect(content.querySelector('.inserted').style.fontSize).toBe('18px');
 expect(body.innerHTML).toBe(before);expect(w.document.execCommand).not.toHaveBeenCalled();
});

it.each(['This is a test. We','<p>This is a test. We</p>'])('shows and accepts only the next sentence of a continuation: %s',html=>{
 const {tm,body}=setup(html);
 const original=tm.extractUserAndQuoteTexts(body).originalUserMessage;
 tm.setCursorByOffset(body,original.length);
 tm.state.correctedText=original+' will meet Monday. Bring notes. Thanks.';
 tm.renderComposePreview();
 const preview=tm.state.previewView.root.querySelector('.content').textContent;
 expect(preview).toContain('We will meet Monday.');expect(preview).not.toContain('Bring notes');expect(preview).not.toContain('Thanks.');
 expect(tm.acceptComposePreview()).toBe(true);
 expect(tm.extractUserAndQuoteTexts(body).originalUserMessage).toBe(original+' will meet Monday. ');
 expect(tm.state.previewModel.replacement).toContain('Bring notes.');
 expect(tm.state.previewModel.replacement).not.toContain('Thanks.');
});

it.each(['keyboard','click'])('continues the cached suggestion immediately after %s acceptance',mode=>{
 const {w,tm,body}=setup('We');tm.setCursorByOffset(body,2);
 tm.state.correctedText='We meet Monday. Bring notes. Thanks.';tm.renderComposePreview();
 const accept=()=>mode==='keyboard'?tm.handleKeyDown(new w.KeyboardEvent('keydown',{key:'Tab',cancelable:true})):tm.state.previewView.root.querySelector('button[aria-label="Accept"]').click();
 accept();expect(body.textContent).toBe('We meet Monday. ');
 expect(tm.state.previewModel.replacement).toContain('Bring notes.');expect(tm.state.previewModel.replacement).not.toContain('Thanks.');
 accept();expect(body.textContent).toBe('We meet Monday. Bring notes. ');
 expect(tm.state.previewModel.replacement).toContain('Thanks.');
 accept();expect(body.textContent).toBe('We meet Monday. Bring notes. Thanks.');expect(tm.state.previewView).toBeNull();
});
it('retains a Tab cursor jump to the remaining edit after acceptance',()=>{
 const {w,tm,body}=setup('Bad first. Unchanged middle. Bad last.');
 tm.state.correctedText='Good first. Unchanged middle. Good last.';tm.renderComposePreview();
 expect(tm.acceptComposePreview()).toBe(true);
 expect(body.textContent).toBe('Good first. Unchanged middle. Bad last.');
 expect(tm.state.previewModel).toBeNull();expect(tm.state.previewJumpOffset).toBeGreaterThan(20);
 const before=body.innerHTML;tm.handleKeyDown(new w.KeyboardEvent('keydown',{key:'Tab',cancelable:true}));
 expect(body.innerHTML).toBe(before);expect(tm.state.previewModel.replacement).toContain('Good last.');
});

it('adds a subtle red underline only over removed source wording and clears it on dismiss',()=>{
 const {w,tm,body}=setup('This is very useful.');const before=body.innerHTML;
 w.Range.prototype.getClientRects=function(){return [{left:this.startOffset*8,top:20,bottom:40,width:(this.endOffset-this.startOffset)*8,height:20}];};
 tm.state.correctedText='This is useful.';tm.renderComposePreview();
 const style=w.document.createElement('style');style.textContent=tm.composePreviewCSS;w.document.head.appendChild(style);
 const blue=(tm.state.previewView?.root.querySelectorAll('.source-underline') ?? []),red=(tm.state.previewView?.root.querySelectorAll('.source-deletion') ?? []);
 expect(blue).toHaveLength(1);expect(red).toHaveLength(1);
 expect(w.getComputedStyle(blue[0]).borderBottomWidth).toBe('1px');expect(w.getComputedStyle(red[0]).borderBottomWidth).toBe('2px');
 expect(red[0].style.left).toBe('64px');expect(red[0].style.width).toBe('40px');expect(red[0].style.top).toBe('39px');
 expect(body.contains(red[0])).toBe(false);expect(red[0].getAttribute('aria-hidden')).toBe('true');expect(body.innerHTML).toBe(before);
 tm.state.correctedText='This is very useful indeed.';tm.renderComposePreview();
 expect((tm.state.previewView?.root.querySelector('.source-deletion') ?? null)).toBeNull();
 tm.dismissComposeSuggestion();expect((tm.state.previewView?.root.querySelector('.source-underline') ?? null)).toBeNull();expect(body.innerHTML).toBe(before);
});

it.each([[-40,'↑'],[1200,'↓']])('keeps the offscreen cursor prompt outside the draft at %ipx',(top,direction)=>{
 const {w,tm,body}=setup('Hello. This is bad.');const before=body.innerHTML;
 const originalRect=w.HTMLElement.prototype.getBoundingClientRect;
 w.HTMLElement.prototype.getBoundingClientRect=function(){return this.classList.contains('tm-fake-caret')?{left:20,right:22,top,bottom:top+20,width:2,height:20}:originalRect.call(this);};
 tm.state.correctedText='Hello. This is good.';tm.renderComposePreview();
 const overlay=w.document.getElementById('tm-jump-overlay');
 expect(overlay?.textContent).toBe(`Press Tab to jump ${direction}`);expect(overlay.parentElement).toBe(w.document.documentElement);
 expect(overlay.style.background).toBe('var(--tm-preview-bg)');expect((tm.state.previewView?.root.querySelector('.preview') ?? null)).toBeNull();expect(body.innerHTML).toBe(before);
 tm.dismissComposeSuggestion();expect(w.document.getElementById('tm-jump-overlay')).toBeNull();expect((tm.state.previewView?.root.querySelector('.tm-fake-caret') ?? null)).toBeNull();
});

it('accept preserves the baseline idle reset and pending request cancellation', () => {
 const {tm,body}=setup('Bad.');
 tm.state.correctedText='Good.';tm.renderComposePreview();
 tm.state.currentIdleTime=9000;tm.state.lastSuggestionShownTime=123;tm.state.textLengthAtLastSuggestion=4;
 tm.state.latestLocalRequestId=7;tm.state.latestGlobalRequestId=9;
 tm.state.isLocalRequestInFlight=true;tm.state.isGlobalRequestInFlight=true;
 tm.state.hasPendingLocalTrigger=true;tm.state.hasPendingGlobalTrigger=true;
 const trigger=vi.spyOn(tm,'triggerCorrection');
 expect(tm.acceptComposePreview()).toBe(true);
 expect(body.textContent).toBe('Good.');
 expect(tm.state.currentIdleTime).toBe(tm.config.autocompleteDelay.INITIAL_IDLE_MS);
 expect(tm.state.lastSuggestionShownTime).toBe(0);
 expect(tm.state.textLengthAtLastSuggestion).toBe(0);
 expect(tm.state.latestLocalRequestId).toBe(8);expect(tm.state.latestGlobalRequestId).toBe(10);
 expect(tm.state.isLocalRequestInFlight).toBe(false);expect(tm.state.isGlobalRequestInFlight).toBe(false);
 expect(tm.state.hasPendingLocalTrigger).toBe(false);expect(tm.state.hasPendingGlobalTrigger).toBe(false);
 expect(trigger).not.toHaveBeenCalled();
});

it('native adherent typing keeps the cached proposal and skips the idle request, like baseline', () => {
 const {w,tm,body}=setup('Hello');tm.attachAutocomplete(body);
 tm.setCursorByOffset(body,5);tm.state.correctedText='Hello world.';tm.renderComposePreview();
 const schedule=vi.spyOn(tm,'scheduleTrigger').mockImplementation(()=>{});
 body.dispatchEvent(new w.KeyboardEvent('keydown',{key:' ',bubbles:true}));
 body.firstChild.textContent='Hello ';tm.setCursorByOffset(body,6);
 body.dispatchEvent(new w.InputEvent('input',{data:' ',bubbles:true}));
 expect(tm.state.correctedText).toBe('Hello world.');expect(schedule).not.toHaveBeenCalled();
 expect(tm.state.previewModel).not.toBeNull();
});

it('ordinary typing and IME do not invalidate requests ahead of the scheduled LOCAL trigger', () => {
 const {w,tm,body}=setup('Hello');tm.attachAutocomplete(body);
 vi.spyOn(tm,'scheduleTrigger').mockImplementation(()=>{});
 tm.state.latestLocalRequestId=7;tm.state.latestGlobalRequestId=9;
 tm.state.correctedText='Hello world.';tm.renderComposePreview();
 body.dispatchEvent(new w.KeyboardEvent('keydown',{key:'x',bubbles:true}));
 body.dispatchEvent(new w.InputEvent('input',{data:'x',bubbles:true}));
 expect(tm.state.latestLocalRequestId).toBe(7);expect(tm.state.latestGlobalRequestId).toBe(9);
 body.dispatchEvent(new w.CompositionEvent('compositionstart',{bubbles:true}));
 expect(tm.state.latestLocalRequestId).toBe(7);expect(tm.state.latestGlobalRequestId).toBe(9);
});

it('LOCAL completion sends GLOBAL the full assumed-accepted proposal, independent of the sentence preview', async () => {
 const {w,tm,body}=setup('We meet.');
 tm.state.originalText='';tm.state.correctedText=null;
 tm.getCorrectionFromServer=vi.fn(async ({isLocal,userMessage})=>({usertext:userMessage,suggestion:isLocal?'We meet Monday. Bring notes.':'We meet Monday. Bring notes.'}));
 await tm.triggerCorrection(body);
 await vi.waitFor(()=>expect(tm.getCorrectionFromServer).toHaveBeenCalledTimes(2));
 expect(tm.getCorrectionFromServer.mock.calls[0][0]).toMatchObject({isLocal:true,userMessage:'We meet.'});
 expect(tm.getCorrectionFromServer.mock.calls[1][0]).toMatchObject({isLocal:false,userMessage:'We meet Monday. Bring notes.'});
 expect(body.textContent).toBe('We meet.');
});

it('displays and accepts an interior GLOBAL correction when LOCAL returns unchanged text', async () => {
 const {w,tm,body}=setup('Hello,\n\nEveryone, we are testing the new pograsdasam. Can you please let me know if everything is working as expected?\nCheers,\nExample');
 tm.setCursorByOffset(body,52);tm.state.originalText='';
 tm.getCorrectionFromServer=vi.fn(async c=>({usertext:c.userMessage,suggestion:c.isLocal?c.userMessage:c.userMessage.replace('pograsdasam','program')}));
 tm.triggerCorrection(body);
 await vi.waitFor(()=>expect(tm.getCorrectionFromServer.mock.calls.map(([c])=>c.isLocal)).toEqual([true,false]));
 expect(tm.state.previewView.root.querySelector('.content').textContent).toContain('program.');
 tm.handleKeyDown(new w.KeyboardEvent('keydown',{key:'Tab',cancelable:true}));
 expect(body.textContent).toContain('new program. Can you please let me know if everything is working as expected?');
 expect(body.textContent).not.toContain('pograsdasam');
});

it('sends only the changed sentence from accepted wording as spelling context', async () => {
 const {w,tm,body}=setup('Hello. We test the przzogram. Keep the following sentence.');
 tm.setCursorByOffset(body,20);tm.state.correctedText='Hello. We test the program. Keep the following sentence.';tm.renderComposePreview();
 expect(tm.acceptComposePreview()).toBe(true);
 expect(tm.state.lastAcceptedText).toBe('Hello. We test the program. Keep the following sentence.');
 body.textContent='Hello. We test the pograsdasam. Keep the following sentence.';
 tm.setCursorByOffset(body,29);
 expect(tm.previousAcceptedSentence(body.textContent)).toBe('We test the program.');
 // Let the acceptance text-sync tick complete, then make a native-like edit.
 await new Promise(resolve=>w.setTimeout(resolve,0));
 body.textContent='Hello. We test the pasdrogram. Keep the following sentence.';tm.setCursorByOffset(body,28);
 tm.getCorrectionFromServer=vi.fn(async c=>({usertext:c.userMessage,suggestion:c.userMessage.replace('pasdrogram','program')}));
 tm.triggerCorrection(body);await new Promise(resolve=>w.setTimeout(resolve,20));
 expect(tm.getCorrectionFromServer).toHaveBeenCalled();
 for(const [context] of tm.getCorrectionFromServer.mock.calls) {
  expect(context.previousAcceptedSentence).toBe('We test the program.');
  expect(context.previousAcceptedSentence).not.toContain('following');
 }
});

it('omits accepted spelling context for empty drafts, broad rewrites, and long sentences', () => {
 const {tm}=setup('');
 tm.state.lastAcceptedText='One sentence. Two sentences.';
 expect(tm.previousAcceptedSentence('')).toBe('');
 expect(tm.previousAcceptedSentence('One sentence. Two sentences.')).toBe('');
 expect(tm.previousAcceptedSentence('Other sentence. Three sentences.')).toBe('');
 expect(tm.previousAcceptedSentence('x'.repeat(100))).toBe('');
 tm.state.lastAcceptedText='x'.repeat(600)+'.';
 expect(tm.previousAcceptedSentence('x'.repeat(599)+'y.')).toBe('');
});

it('does not send prior wording for a new sentence or an intentional whole-word replacement',()=>{
 const {tm}=setup('');tm.state.lastAcceptedText='We test the program.';
 expect(tm.previousAcceptedSentence('We test the program. More text.')).toBe('');
 expect(tm.previousAcceptedSentence('We test the application.')).toBe('');
 expect(tm.previousAcceptedSentence('We test PostgreSQL.')).toBe('');
 expect(tm.previousAcceptedSentence('We test the pasdrogram.')).toBe('We test the program.');
});

it('replacing selected text must invalidate the old suggestion and request for the new draft', () => {
 const {w,tm,body}=setup('Hello world.');tm.attachAutocomplete(body);
 tm.state.correctedText='Hello wonderful world.';
 const r=w.document.createRange();r.setStart(body.firstChild,6);r.setEnd(body.firstChild,12);w.getSelection().removeAllRanges();w.getSelection().addRange(r);
 const schedule=vi.spyOn(tm,'scheduleTrigger').mockImplementation(()=>{});
 body.dispatchEvent(new w.KeyboardEvent('keydown',{key:'w',bubbles:true}));
 r.deleteContents();r.insertNode(w.document.createTextNode('w'));
 body.dispatchEvent(new w.InputEvent('input',{data:'w',inputType:'insertText',bubbles:true}));
 expect(body.textContent).toBe('Hello w');
 expect(tm.state.correctedText).toBeNull();
 expect(schedule).toHaveBeenCalledTimes(1);
});

it.each(['keyboard','click'])('registered inline cancellation via %s unlocks newer typing and late results cannot overwrite it',async mode=>{
 const {w,tm,body}=setup('<p>Initial text.</p><div class="moz-signature">Signature</div>');
 tm.attachAutocomplete(body);w.document.designMode='on';w.focus=()=>{};
 let finish;w.browser.runtime.sendMessage=vi.fn(()=>new Promise(resolve=>finish=resolve));
 const execution=vi.spyOn(tm,'_runInlineEditInstruction');
 body.dispatchEvent(new w.KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true,cancelable:true}));
 const wrapper=w.document.getElementById('tm-inline-edit');expect(wrapper).not.toBeNull();expect(tm.state.inlineEditActive).toBe(true);
 expect(w.document.designMode).toBe('off');
 const input=wrapper.querySelector('iframe').contentDocument.querySelector('textarea');input.value='Rewrite wording';
 input.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
 expect(execution).toHaveBeenCalledTimes(1);expect(w.browser.runtime.sendMessage).toHaveBeenCalledTimes(1);expect(wrapper._tm_executing).toBe(true);
 const pending=execution.mock.results[0].value;
 if(mode==='click') wrapper.querySelector('.tm-inline-actions').shadowRoot.querySelector('button[aria-label="Dismiss"]').click();
 else input.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
 expect(tm.state.inlineEditActive).toBe(false);expect(w.document.designMode).toBe('on');expect(w.document.getElementById('tm-inline-edit')).toBeNull();
 vi.spyOn(tm,'scheduleTrigger').mockImplementation(()=>{});
 body.firstChild.textContent='Newer authored text.';tm.setCursorByOffset(body,5);
 body.dispatchEvent(new w.InputEvent('input',{data:'x',inputType:'insertText',bubbles:true}));
 const expected=body.innerHTML;
 finish({body:'Earlier edit result.'});await pending;
 expect(body.innerHTML).toBe(expected);expect(w.document.execCommand).not.toHaveBeenCalled();expect(body.querySelector('.moz-signature').textContent).toBe('Signature');
});


it('unaccepted preview text is excluded from whole-document serialization', () => {
 const {w,tm,body}=setup('AUTHORED CONTENT ONLY.');
 tm.state.correctedText='UNACCEPTED PROPOSAL MARKER.';tm.renderComposePreview();
 expect(tm.state.previewView.root.textContent).toContain('UNACCEPTED PROPOSAL MARKER.');
 expect(w.document.documentElement.outerHTML).not.toContain('UNACCEPTED PROPOSAL');
 expect(w.document.documentElement.textContent).not.toContain('UNACCEPTED PROPOSAL');
 expect(body.textContent).toBe('AUTHORED CONTENT ONLY.');
 expect(tm.state.previewView.host.shadowRoot.querySelector('style').textContent).toContain('overflow: auto');
});

it.each(['finish','typing','scroll'])('inline application wipe leaves authored HTML intact and clears on %s',async ending=>{
 const {w,tm,body}=setup('<p>Updated <b>wording</b>.</p><div class="moz-signature">Signature</div>');
 body.getBoundingClientRect=()=>({left:8,top:20,width:600,bottom:240});
 body.querySelector('.moz-signature').getBoundingClientRect=()=>({top:180});
 let finish;
 const animation={finished:new Promise(resolve=>finish=resolve),cancel:vi.fn()};
 w.HTMLElement.prototype.animate=vi.fn(()=>animation);
 const before=body.innerHTML;
 tm.animateInlineEditApplication(body);
 const host=w.document.documentElement.lastElementChild;
 expect(host).not.toBe(body);expect(host.shadowRoot.firstChild.style.height).toBe('160px');
 expect(body.innerHTML).toBe(before);expect(host.textContent).toBe('');
 expect(w.HTMLElement.prototype.animate).toHaveBeenCalledWith([{clipPath:'inset(0 0 0 0)'},{clipPath:'inset(100% 0 0 0)'}],expect.objectContaining({duration:tm.config.inlineEdit.diffWipeFadeMs}));
 if(ending==='finish'){finish();await Promise.resolve();}
 else w.dispatchEvent(new w.Event(ending==='typing'?'input':'scroll'));
 expect(host.isConnected).toBe(false);expect(body.innerHTML).toBe(before);expect(animation.cancel).toHaveBeenCalledTimes(1);
});

it.each(['div','p'].flatMap(tag=>['keyboard','click'].map(mode=>({tag,mode}))))('accepts punctuation and wording at an HTML $tag end via $mode without joining paragraphs',({tag,mode})=>{
 const {w,tm,body}=setup(`<${tag}>Earlier sentence. No action needed here!</${tag}><${tag}>Another paragraph.</${tag}>`);
 tm.attachAutocomplete(body);tm.setCursorByOffset(body,28);
 tm.state.correctedText='Earlier sentence. No action is needed here. Another paragraph.';
 tm.renderComposePreview();expect(tm.state.previewModel).not.toBeNull();
 if(mode==='click')tm.state.previewView.root.querySelector('button').click();
 else body.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));
 expect(body.innerHTML).toBe(`<${tag}>Earlier sentence. No action is needed here.</${tag}><${tag}>Another paragraph.</${tag}>`);
 expect(w.document.execCommand).toHaveBeenCalledTimes(1);
 expect(tm.state.previewModel).toBeNull();expect(tm.state.previewJumpOffset).toBeNull();
});

// Signature text stays outside every request/edit offset; only navigation is shown.
it('shows a jump from the signature without including it in editable text',()=>{
 const {w,tm,body}=setup('<p>This is bad.</p><div class="moz-signature">Private signature</div>');
 tm.attachAutocomplete(body);
 const signature=body.querySelector('.moz-signature');
 const r=w.document.createRange();r.setStart(signature.firstChild,4);r.collapse(true);
 w.getSelection().removeAllRanges();w.getSelection().addRange(r);
 const before=body.innerHTML;
 tm.state.correctedText='This is good.';tm.renderComposePreview();
 expect(tm.state.previewJumpOffset).toBe(8);expect(tm.state.previewModel).toBeNull();
 expect(tm.state.previewView.root.querySelector('.tm-fake-caret')).not.toBeNull();
 expect(tm.extractUserAndQuoteTexts(body).originalUserMessage).toBe('This is bad.');
 expect(tm.composeCursorOffset(tm.indexComposeText(body,tm.getQuoteBoundaryNode(body)))).toBeNull();
 expect(body.innerHTML).toBe(before);expect(w.document.execCommand).not.toHaveBeenCalled();
 body.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));
 expect(tm.state.previewModel).not.toBeNull();expect(body.innerHTML).toBe(before);
});

it.each(['plain','html'])('sends the complete body for a %s Cmd-K expansion and applies the result',async format=>{
 const original='Hello,\n\nWe are testing the new system. Please report issues.\n\nThanks,\n\nExample';
 const expanded='Hello team,\n\nWe are testing the new system. Please report issues, including delivery delays and formatting problems.\n\nYour feedback will help us prepare the rollout.\n\nThanks,\n\nExample';
 const html=format==='html'?'<p>Hello,<br><br></p><p>We are testing the new system. Please report issues.</p><p><br>Thanks,<br><br>Example</p>':original;
 const {w,tm,body}=setup(html+'<pre class="moz-signature">Private signature</pre>');
 tm.attachAutocomplete(body);w.document.designMode='on';
 w.browser.runtime.sendMessage.mockImplementation(async message=>{
  if(message.type!=='runInlineComposeEdit')return;
  expect(message.body).toBe(original);expect(message.selectedText).toBe('');
  expect(message.request).toBe('Make it longer');
  return {body:expanded};
 });
 body.dispatchEvent(new w.KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true,cancelable:true}));
 const input=w.document.getElementById('tm-inline-edit').querySelector('iframe').contentDocument.querySelector('textarea');
 input.value='Make it longer';input.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
 await vi.waitFor(()=>expect(tm.extractUserAndQuoteTexts(body).originalUserMessage).toBe(expanded));
 expect(w.browser.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({type:'runInlineComposeEdit',body:original}));
 expect(body.querySelector('.moz-signature').textContent).toBe('Private signature');
 expect(w.document.execCommand).toHaveBeenCalledTimes(1);
});

it.each(['success','empty','whitespace','native-failure','dismissed'])('retains inline history only after successful application: %s',async outcome=>{
 const {w,tm,body}=setup('<p>Draft.</p>');
 const previous=[{userRequest:'Earlier'}],candidate=[...previous,{userRequest:'Expand'}];tm.state.editChatHistory=previous;
 const wrapper=w.document.createElement('div');wrapper.id='tm-inline-edit';body.appendChild(wrapper);
 wrapper._tm_cleanup=()=>wrapper.remove();
 w.browser.runtime.sendMessage.mockImplementation(async()=>{
  if(outcome==='dismissed')wrapper.remove();
  return {body:outcome==='empty'?'':outcome==='whitespace'?'   ':'Expanded draft.',chatHistory:candidate};
 });
 if(outcome==='native-failure')w.document.execCommand.mockReturnValue(false);
 await tm._runInlineEditInstruction({instruction:'Expand',wrapper});
 expect(tm.state.editChatHistory).toEqual(outcome==='success'?candidate:previous);
 if(outcome==='empty'||outcome==='whitespace'){
  expect(wrapper.isConnected).toBe(true);expect(wrapper.querySelector('[role="alert"]').textContent).toContain('Please try again');
  expect(wrapper._tm_executing).toBe(false);expect(w.document.execCommand).not.toHaveBeenCalled();
 }
 if(outcome==='dismissed')expect(w.document.execCommand).not.toHaveBeenCalled();
});
