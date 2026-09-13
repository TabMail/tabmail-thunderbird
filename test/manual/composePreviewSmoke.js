/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Run with scripting.executeScript ONLY in a disposable compose draft whose
// initial body is exactly COMPOSE PREVIEW SMOKE. No mail is sent by this probe.
(() => {
  const tm = TabMail;
  const body = tm.state.editorRef;
  if (body.textContent.trim() !== 'COMPOSE PREVIEW SMOKE') throw new Error('Disposable smoke draft marker required');
  const results = [];
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const fixture = html => {
    tm.dismissComposeSuggestion();
    body.innerHTML = html;
    body.focus();
    const range = document.createRange();range.selectNodeContents(body);range.collapse(true);
    getSelection().removeAllRanges();getSelection().addRange(range);
    tm.state.autocompleteDisabled = false;
  };
  const run = (name, fn) => { try { fn(); results.push({name, pass:true}); } catch (error) { results.push({name, pass:false, error:error.message}); } };
  const propose = text => { tm.state.correctedText = text;tm.renderComposePreview();assert(tm.state.previewModel, 'No preview'); };
  run('HTML formatting, native undo/redo, signature and serialization', () => {
    fixture('<p>Hello <b>bad</b>.</p><div class="moz-signature">Synthetic signature</div>');
    propose('Hello good.');
    assert(!body.querySelector('#tm-compose-preview'), 'Preview entered serialized body');
    assert(getComputedStyle(tm.state.previewView.host.querySelector('.preview')).backgroundColor !== 'rgba(0, 0, 0, 0)', 'Preview CSS missing');
    assert(tm.acceptComposePreview(), 'Accept failed');
    assert(body.querySelector('b').textContent === 'good', 'Formatting lost');
    assert(document.execCommand('undo'), 'Undo refused');
    assert(body.querySelector('b').textContent === 'bad', 'Undo did not restore');
    assert(document.execCommand('redo'), 'Redo refused');
    assert(body.querySelector('b').textContent === 'good', 'Redo did not restore');
    assert(body.querySelector('.moz-signature').textContent === 'Synthetic signature', 'Signature changed');
  });
  run('media crossing refuses without mutation', () => {
    fixture('Hello very <img src="cid:synthetic">bad.');
    const before = body.innerHTML;
    propose('Hello good.');
    assert(!tm.acceptComposePreview(), 'Unsafe media crossing accepted');
    assert(body.innerHTML === before, 'Media or authored HTML changed');
  });
  run('empty draft is a full proposal until accepted', () => {
    fixture('<div class="moz-signature">Synthetic signature</div>');
    propose('Hello Alex.\n\nEnjoy the holiday.');
    assert(!body.textContent.includes('Hello'), 'Proposal inserted early');
    assert(tm.acceptComposePreview(), 'Full suggestion refused');
    assert(body.textContent.includes('Enjoy the holiday.'), 'Full suggestion incomplete');
    assert(body.querySelector('.moz-signature'), 'Signature removed');
  });
  run('next sentence is part of one accepted suggestion', () => {
    fixture('The holiday starts tomorrow.');
    tm.setCursorByOffset(body, 27);
    propose('The holiday starts tomorrow. We will be back Monday.');
    assert(tm.state.previewModel.replacement.includes('We will be back Monday.'), 'Continuation missing');
    assert(tm.acceptComposePreview(), 'Continuation refused');
    assert(body.textContent === 'The holiday starts tomorrow. We will be back Monday.', 'Continuation incomplete');
  });
  tm.dismissComposeSuggestion();
  return {passed:results.filter(r=>r.pass).length, total:results.length, results};
})();
