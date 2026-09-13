/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {runInContext} from 'node:vm';
import {JSDOM} from 'jsdom';
import {it,expect,vi} from 'vitest';
vi.mock('../agent/modules/idbStorage.js',()=>({}));
vi.mock('../agent/modules/utils.js',()=>({getUniqueMessageKey:vi.fn()}));
vi.mock('../compose/modules/autocompleteGenerator.js',()=>({generateCorrection:vi.fn()}));
vi.mock('../compose/modules/edit.js',()=>({runComposeEdit:vi.fn()}));

it('the registered scripts and styles produce a passive preview and clean it before sending',async()=>{
  vi.useFakeTimers();
  const messageListeners = new Set();
  const runtime = {getURL:p=>`https://example.com/${p}`,sendMessage:vi.fn(async()=>({})),onMessage:{addListener:f=>messageListeners.add(f),removeListener:f=>messageListeners.delete(f)}};
  const api = {
    runtime,
    storage:{local:{get:vi.fn(async defaults=>defaults),set:vi.fn()},onChanged:{addListener:vi.fn(),removeListener:vi.fn()}},
    compose:{onBeforeSend:{addListener:vi.fn()}},
    scripting:{compose:{unregisterScripts:vi.fn(async()=>{}),registerScripts:vi.fn(async()=>{})}},
  };
  globalThis.browser = globalThis.messenger = api;
  let dom;
  try {
    await import('../compose/background.js');
    await vi.advanceTimersByTimeAsync(500);
    const registrations = api.scripting.compose.registerScripts.mock.calls[0][0];
    expect(api.scripting.compose.unregisterScripts).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
    dom = new JSDOM('<body contenteditable="true"><p>This is very useful.</p><div class="moz-signature">Signature</div></body>',{runScripts:'outside-only',pretendToBeVisual:true});
    const w = dom.window;
    w.browser = api;
    w.CSS={highlights:new Map()};w.Highlight=class{};
    w.Range.prototype.getBoundingClientRect=()=>({left:8,top:20,right:200,bottom:40,width:192,height:20});
    for(const registration of registrations){
      for(const css of registration.css||[]){const style=w.document.createElement('style');style.textContent=readFileSync(resolve(css),'utf8');w.document.head.appendChild(style);}
      for(const file of registration.js||[])runInContext(readFileSync(resolve(file),'utf8'),dom.getInternalVMContext(),{filename:resolve(file)});
    }
    const tm=w.TabMail,body=w.document.body;
    await vi.waitFor(()=>expect(tm._eventListeners.attachedEditor).toBe(body));
    const range=w.document.createRange();range.setStart(body.firstChild.firstChild,5);range.collapse(true);w.getSelection().addRange(range);
    const before=body.innerHTML;
    tm.state.correctedText='This is useful.';tm.renderText(true);
    const bubble=w.document.querySelector('.tm-compose-preview .preview');
    expect(bubble.querySelector('.content').textContent).toBe('This is useful.');
    expect(w.getComputedStyle(bubble).borderRadius).toBe('8px');
    expect(body.innerHTML).toBe(before);
    expect(w.CSS.highlights.size).toBe(1);
    for(const listener of messageListeners)await listener({command:'cleanupBeforeSend'},{},()=>{});
    expect(w.document.querySelector('.tm-compose-preview')).toBeNull();
    expect(w.CSS.highlights.size).toBe(0);
    expect(tm.state.beforeSendCleanupActive).toBe(true);
    tm.renderText(true);
    expect(w.document.querySelector('.tm-compose-preview')).toBeNull();
    expect(body.innerHTML).toBe(before);
  } finally {
    dom?.window.close();
    vi.useRealTimers();
    delete globalThis.browser;delete globalThis.messenger;
  }
});
