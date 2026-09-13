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

const recoveryCases = ['inline','ime','inline-ime'].flatMap(mode =>
  [false,true].flatMap(repeat => [20,120].flatMap(delay =>
    ['none','details','delivery-after-cleanup'].map(failure =>
      ({mode,inline:mode.startsWith('inline'),repeat,delay,failure})))));
recoveryCases.push(...[false,true].map(repeat => ({mode:'ordinary',inline:false,repeat,delay:20,failure:'none'})));

it.each(recoveryCases)('registered send cleanup preserves preview recovery (mode=$mode, repeat=$repeat, delay=$delay, failure=$failure)',async({inline,repeat,mode,delay,failure})=>{
  vi.resetModules();
  vi.useFakeTimers();
  const messageListeners = new Set();
  const contentMessageListeners = new Set();
  const runtime = {getURL:p=>`https://example.com/${p}`,sendMessage:vi.fn(async()=>({})),onMessage:{addListener:f=>messageListeners.add(f),removeListener:f=>messageListeners.delete(f)}};
  const api = {
    runtime,
    storage:{local:{get:vi.fn(async defaults=>defaults),set:vi.fn()},onChanged:{addListener:vi.fn(),removeListener:vi.fn()}},
    tabs:{sendMessage:vi.fn(async(tabId,message)=>{expect(tabId).toBe(1);for(const listener of contentMessageListeners)await listener(message,{},()=>{});})},
    compose:{onBeforeSend:{addListener:vi.fn()},getComposeDetails:vi.fn(async()=>({body:dom.window.document.body.innerHTML})),setComposeDetails:vi.fn()},
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
    dom = new JSDOM('<body contenteditable="true"><p>This is very useful.</p><div class="moz-signature">Signature</div></body>',{url:'https://example.com/compose',runScripts:'outside-only',pretendToBeVisual:true});
    const w = dom.window;
    w.browser = {...api,runtime:{...runtime,onMessage:{addListener:f=>contentMessageListeners.add(f),removeListener:f=>contentMessageListeners.delete(f)}}};
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
    vi.useFakeTimers();
    tm.config.DIFF_RESTORE_DELAY_MS = delay;
    tm.config.BEFORE_SEND_CLEANUP_SUPPRESS_MS = 60;
    tm.state.currentIdleTime = 30;
    if(inline){
      body.dispatchEvent(new w.KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true,cancelable:true}));
      expect(w.document.getElementById('tm-inline-edit')).not.toBeNull();
      expect(tm.state.inlineEditActive).toBe(true);
      tm.cancelInlineEditDropdown();
      expect(w.document.getElementById('tm-inline-edit')).toBeNull();
      expect(tm.state.inlineEditActive).toBe(false);
      expect(tm.state.autoHideDiff).toBe(true);
      expect(tm.state.diffRestoreTimer).not.toBeNull();
      expect(body.innerHTML).toBe(before);
    }
    if(mode.includes('ime')) {
      body.dispatchEvent(new w.CompositionEvent('compositionstart',{bubbles:true}));
      expect(tm.state.isIMEComposing).toBe(true);
      body.dispatchEvent(new w.CompositionEvent('compositionend',{bubbles:true}));
      expect(tm.state.isIMEComposing).toBe(false);
      expect(tm.state.diffRestoreTimer).not.toBeNull();
    }
    const snapshot=body.innerHTML;
    const nativeWrite=vi.fn();w.document.execCommand=nativeWrite;
    tm.getCorrectionFromServer=vi.fn(async()=>({}));
    if(failure==='details')api.compose.getComposeDetails.mockRejectedValue(new Error('Synthetic details failure'));
    if(failure==='delivery-after-cleanup')api.tabs.sendMessage.mockImplementation(async(tabId,message)=>{
      for(const listener of contentMessageListeners)await listener(message,{},()=>{});
      throw new Error('Synthetic response delivery failure after cleanup');
    });
    const beforeSend=api.compose.onBeforeSend.addListener.mock.calls[0][0];
    await beforeSend({id:1});
    expect(api.compose.setComposeDetails).not.toHaveBeenCalled();
    expect(w.document.querySelector('.tm-compose-preview')).toBeNull();
    expect(w.CSS.highlights.size).toBe(0);
    expect(tm.state.beforeSendCleanupActive).toBe(true);
    tm.renderText(true);
    expect(w.document.querySelector('.tm-compose-preview')).toBeNull();
    expect(body.innerHTML).toBe(before);
    // A canceled/failed send leaves the same compose window open. Successful
    // subsequent corrections must become visible after the snapshot guard ends.
    await vi.advanceTimersByTimeAsync(40);
    expect(tm.getCorrectionFromServer).not.toHaveBeenCalled();
    expect(tm.state.beforeSendCleanupActive).toBe(true);
    expect(w.document.querySelector('.tm-compose-preview')).toBeNull();
    expect(body.innerHTML).toBe(before);
    if(repeat)await beforeSend({id:1});
    await vi.advanceTimersByTimeAsync(20);
    expect(tm.state.beforeSendCleanupActive).toBe(repeat);
    if(repeat){
      tm.renderText(true);
      expect(w.document.querySelector('.tm-compose-preview')).toBeNull();
      expect(body.innerHTML).toBe(before);
      await vi.advanceTimersByTimeAsync(40);
    }
    expect(tm.state.beforeSendCleanupActive).toBe(false);
    await vi.advanceTimersByTimeAsync(150);
    expect(body.innerHTML).toBe(snapshot);
    expect(nativeWrite).not.toHaveBeenCalled();
    body.firstChild.textContent = 'New draft.';
    expect(tm.extractUserAndQuoteTexts(body).originalUserMessage).toBe('New draft.');
    tm.setCursorByOffset(body, 3);
    tm.getCorrectionFromServer = vi.fn(async()=>({suggestion:'New corrected draft.',usertext:'New draft.'}));
    body.dispatchEvent(new w.KeyboardEvent('keydown', {key:'x', bubbles:true}));
    body.dispatchEvent(new w.InputEvent('input', {bubbles:true, data:'x'}));
    const afterTyping = body.innerHTML;
    await vi.advanceTimersByTimeAsync(40);
    expect(tm.getCorrectionFromServer).toHaveBeenCalled();
    expect(tm.getCorrectionFromServer.mock.calls[0][0]).toMatchObject({userMessage:'New draft.',isLocal:true,quoteAndSignature:'\nSignature'});
    expect(tm.state.correctedText).toBe('New corrected draft.');
    expect(tm.state.previewModel).not.toBeNull();
    expect(tm.state.previewView.host.querySelector('.content').textContent).toBe('New corrected draft.');
    expect(body.innerHTML).toBe(afterTyping);
    expect(nativeWrite).not.toHaveBeenCalled();
  } finally {
    dom?.window.close();
    vi.useRealTimers();
    delete globalThis.browser;delete globalThis.messenger;
  }
});
