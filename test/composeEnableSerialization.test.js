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
it('disabled-control writer cannot leave UI wording in a reopened plaintext draft after beforeSend',async()=>{
 const dom=new JSDOM('<body contenteditable="true">AUTHORED ROUNDTRIP MARKER</body>',{runScripts:'outside-only'}),w=dom.window;
 w.TabMail={state:{autocompleteDisabled:true},setAutocompleteEnabled:vi.fn()};
 runInContext(readFileSync(resolve('compose/modules/caret.js'),'utf8'),dom.getInternalVMContext(),{filename:resolve('compose/modules/caret.js')});
 w.TabMail.showComposeHintsBanner();
 const control=w.document.getElementById('tm-compose-hints-banner');
 expect(control).not.toBeNull();
 const label=(control.shadowRoot||control).textContent;
 expect(label).toContain('Enable suggestions');
 expect(w.document.body.textContent).toBe('AUTHORED ROUNDTRIP MARKER');
 // Encoder scope characterized from Gecko EditorBase and Thunderbird ext-compose:
 // serialize the light DOM document, then parse its HTML for plaintext conversion.
 // This is a serialization contract model, not a claim of native Save execution.
 const decoded=new JSDOM(dom.serialize());
 const savedPlainText=decoded.window.document.body.textContent;
 expect(savedPlainText).toContain('AUTHORED ROUNDTRIP MARKER');
 expect(savedPlainText).not.toContain(label);
 const reopened=new JSDOM('<body></body>');reopened.window.document.body.textContent=savedPlainText;
 const stored={isPlainText:true,body:reopened.serialize(),plainTextBody:savedPlainText};
 let beforeSend;
 const api={runtime:{onMessage:{addListener:vi.fn(),removeListener:vi.fn()},getURL:p=>p},
  compose:{getComposeDetails:vi.fn(async()=>({...stored})),setComposeDetails:vi.fn(async(_,patch)=>Object.assign(stored,patch)),onBeforeSend:{addListener:f=>beforeSend=f}},
  scripting:{compose:{unregisterScripts:vi.fn(async()=>{}),registerScripts:vi.fn(async()=>{})}},
  tabs:{sendMessage:vi.fn(async()=>{})}};
 globalThis.browser=globalThis.messenger=api;globalThis.window={};
 await import('../compose/background.js');
 expect(typeof beforeSend).toBe('function');await beforeSend({id:1});
 expect(api.tabs.sendMessage).toHaveBeenCalledWith(1,{command:'cleanupBeforeSend'});
 expect(stored.plainTextBody).toContain('AUTHORED ROUNDTRIP MARKER');
 expect(stored.plainTextBody).not.toContain(label);
 dom.window.close();decoded.window.close();reopened.window.close();
 delete globalThis.browser;delete globalThis.messenger;delete globalThis.window;
});
