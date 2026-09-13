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
  w.CSS = { highlights: new Map() };
  w.Highlight = class { constructor(range) { this.range = range; } };
  w.browser = { runtime: { getURL: path => `https://example.com/${path}`, sendMessage: vi.fn(), onMessage: { addListener: vi.fn(), removeListener: vi.fn() } }, storage: { local: { set: vi.fn() } } };
  w.Range.prototype.getBoundingClientRect = function () {
    const top = Math.floor(this.startOffset / 30) * 20 + 20;
    return { left: (this.startOffset % 30) * 8 + 8, right: (this.startOffset % 30) * 8 + 16, top, bottom: top + 20, height: 20, width: 8 };
  };
  for (const name of ['libs/jsdiff.min.js', 'libs/diff-match-patch.js', 'modules/config.js', 'modules/logger.js', 'modules/state.js', 'modules/sentences.js', 'modules/tokens.js', 'modules/dom.js', 'modules/core.js', 'modules/diff.js', 'modules/previewModel.js', 'modules/richText.js', 'modules/preview.js', 'modules/events.js', 'modules/caret.js', 'modules/inlineEditor.js']) {
    const filename = resolve('compose', name);
    runInContext(readFileSync(filename, 'utf8'), dom.getInternalVMContext(), { filename });
  }
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
  expect(w.CSS.highlights.size).toBeGreaterThan(0);
  tm.cleanupEventListeners();
  expect(w.CSS.highlights.size).toBe(0);
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
 const {w,tm,body}=setup('Hello.');const before=body.innerHTML;tm.state.correctedText='Hello there.';tm.renderText(true);expect(w.CSS.highlights.has('tm-compose-sentence')).toBe(true);
 tm.dismissComposeSuggestion();tm.dismissComposeSuggestion();expect(w.CSS.highlights.has('tm-compose-sentence')).toBe(false);expect(body.innerHTML).toBe(before);expect(tm.state.previewView).toBeNull();
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
