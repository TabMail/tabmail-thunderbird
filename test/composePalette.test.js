/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {convert} from '@asamuzakjp/css-color';
import {it,expect,vi} from 'vitest';
import {injectPaletteIntoDocument} from '../theme/palette/palette.js';

const data=JSON.parse(readFileSync(new URL('../theme/palette/palette.data.json',import.meta.url),'utf8'));
it.each(['LIGHT','DARK'])('injected %s compose colors tint insertions with the app accent without changing the draft',async mode=>{
  const dom=new JSDOM('<body><p>Authored <b>draft</b>.</p></body>');
  const {document}=dom.window,before=document.body.innerHTML;
  vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>data})));
  try {
    const injected=await injectPaletteIntoDocument(document,'https://example.com/palette');
    const rootRule=mode==='LIGHT'?injected.sheet.cssRules[0]:injected.sheet.cssRules[1].cssRules[0];
    const css=document.createElement('style');css.textContent=readFileSync(new URL('../compose/preview.css',import.meta.url),'utf8');document.head.appendChild(css);
    const insertionRule=[...css.sheet.cssRules].find(rule=>rule.selectorText==='.tm-compose-preview .inserted');
    // Resolve the real consumer's custom property against each injected theme.
    // JSDOM does not resolve custom properties in computed styles.
    const tint=insertionRule.style.getPropertyValue('background').replace(/var\((--[^)]+)\)/g,(_,name)=>rootRule.style.getPropertyValue(name));
    const actual=convert.colorToRgb(tint),accent=convert.colorToRgb(data.THEME[mode].ACCENT_COLOR);
    expect(actual).toHaveLength(4);
    for(let channel=0;channel<3;channel++)expect(Math.abs(actual[channel]-accent[channel])).toBeLessThan(1);
    expect(actual[3]).toBeGreaterThan(0);expect(actual[3]).toBeLessThan(1);
    expect(actual[3]).toBeCloseTo(mode==='LIGHT'?data.OPACITY.SUBTLE_LIGHT:data.OPACITY.SELECTED_DARK,2);
    const underlineCSS=document.createElement('style');underlineCSS.textContent=readFileSync(new URL('../compose/highlight.css',import.meta.url),'utf8');document.head.appendChild(underlineCSS);
    const underlineRule=[...underlineCSS.sheet.cssRules].find(rule=>rule.selectorText==='.tm-compose-preview .source-underline');
    const underlineColor=underlineRule.style.getPropertyValue('border-bottom-color').replace(/var\((--[^)]+)\)/g,(_,name)=>rootRule.style.getPropertyValue(name));
    const sourceColor=convert.colorToRgb(underlineColor);
    expect(sourceColor).toHaveLength(4);
    for(let channel=0;channel<3;channel++)expect(Math.abs(sourceColor[channel]-accent[channel])).toBeLessThan(1);
    expect(sourceColor[3]).toBe(1);
    expect(document.body.innerHTML).toBe(before);
  } finally {dom.window.close();vi.unstubAllGlobals();}
});
