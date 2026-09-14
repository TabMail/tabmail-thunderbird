/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// Run only in a disposable plain-text compose draft with the marker below.
(() => {
  const tm = TabMail, body = tm.state.editorRef;
  if (body.textContent.trim() !== 'COMPOSE PREVIEW SMOKE') throw new Error('Disposable smoke draft marker required');
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  tm.dismissComposeSuggestion();
  body.textContent = 'This is very useful.';
  body.focus();
  tm.setCursorByOffset(body, 5);
  tm.state.correctedText = 'This is useful.';
  tm.renderComposePreview();
  assert(tm.state.previewModel, 'No plaintext preview');
  const event = new KeyboardEvent('keydown', {key:'Tab',bubbles:true,cancelable:true});
  body.dispatchEvent(event);
  assert(event.defaultPrevented && body.textContent === 'This is useful.', 'Registered Tab did not accept');
  assert(document.execCommand('undo') && body.textContent === 'This is very useful.', 'Native Undo failed');
  assert(document.execCommand('redo') && body.textContent === 'This is useful.', 'Native Redo failed');
  tm.setCursorByOffset(body, 5);
  tm.state.correctedText = 'This is helpful.';tm.renderComposePreview();
  tm.state.previewView.root.querySelectorAll('button')[1].click();
  assert(!tm.state.previewModel && body.textContent === 'This is useful.', 'Dismiss changed text');
  tm.state.correctedText = 'This is helpful.';tm.renderComposePreview();
  tm.state.previewView.root.querySelectorAll('button')[2].click();
  const banner = document.getElementById('tm-compose-hints-banner');
  assert(banner?.textContent === '⇧Esc Enable suggestions', 'Disabled control missing or redundant');
  banner.querySelector('button').click();
  assert(!tm.state.autocompleteDisabled && !document.getElementById('tm-compose-hints-banner'), 'Enable failed');
  tm.dismissComposeSuggestion();
  return {pass:true,checks:['registered Tab','native Undo/Redo','click Dismiss','click Disable','disabled-only Enable','click Enable']};
})();
