/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

vi.mock('../agent/modules/config.js',()=>({SETTINGS:{}}));
import {beforeEach,expect,it,vi} from 'vitest';
import {experimentFunctions} from './helpers/experimentFunctions.js';
vi.mock('../theme/palette/palette.js',()=>({getTAG_COLORS:async()=>({tm_reply:'#112233',tm_none:'#223344',tm_archive:'#334455',tm_delete:'#445566'})}));
beforeEach(()=>vi.resetModules());
async function harness(fail){
 globalThis.browser={messages:{tags:{list:vi.fn().mockImplementationOnce(async()=>{if(fail)throw new Error('synthetic tag service unavailable');return [];}),create:vi.fn(async()=>{})}},tagSort:{init:vi.fn()}};
 const {ensureActionTags}=await import('../agent/modules/tagDefs.js');
 const reached=vi.fn(()=>{throw new Error('bootstrap checkpoint reached');});
 const {init}=experimentFunctions(new URL('../agent/background.js',import.meta.url),['init'],{
 _initOnce:false,log:()=>{},setDefaultSortForLargeInbox:async()=>{},checkAndShowWelcomeWizard:()=>{},SETTINGS:{},browser,ensureActionTags,initSummaryFeatures:reached,
 });
 return {init,reached};
}
it('reaches core initialization with healthy tag definitions',async()=>{
 const {init,reached}=await harness(false);await init().catch(()=>{});expect(reached).toHaveBeenCalledOnce();
});
it('a tag-list rejection does not permanently prevent core initialization',async()=>{
 const {init,reached}=await harness(true);await init().catch(()=>{});
 browser.messages.tags.list.mockResolvedValue([]);
 await init().catch(()=>{});
 expect(reached).toHaveBeenCalledOnce();
});
