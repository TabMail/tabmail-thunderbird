/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const url=new URL('../theme/experiments/tagSort/tagSort.sys.mjs',import.meta.url);
function runtime(){
 const view={msgFolder:{flags:1},rowCount:2,sort:vi.fn(),addColumnHandler:vi.fn()};
 const tree={style:{visibility:''}};
 const tabmail={currentTabInfo:{mode:{name:'mail3PaneTab'}}};
 const win={gDBView:view,setTimeout,clearTimeout,requestAnimationFrame:fn=>fn(),
  document:{readyState:'complete',getElementById:id=>id==='tabmail'?tabmail:id==='threadTree'?tree:null,
   querySelector:()=>null,documentElement:{setAttribute(){},removeAttribute(){}}}};
 const Services={prefs:{getIntPref:(_key,value)=>value,setIntPref(){}},wm:{getEnumerator:()=>{
  let used=false;return {hasMoreElements:()=>!used,getNext:()=>{used=true;return win;}};
 }}};
 const sandbox={Services,Date,Ci:{nsMsgFolderFlags:{Inbox:1,Virtual:2},nsMsgViewSortType:{byCustom:99,byDate:18}},
  console:{log(){},error(){}},ChromeUtils:{generateQI:()=>()=>{},importESModule:()=>({
   ExtensionCommon:{ExtensionAPI:class{}},ExtensionSupport:{},MailServices:{},ThreadPaneColumns:{addCustomColumn(){}}
  })}};
 runInNewContext(readFileSync(url,'utf8')+'\nglobalThis.Experiment=tagSort;',sandbox,{filename:fileURLToPath(url)});
 return {api:new sandbox.Experiment().getAPI({extension:{id:'synthetic@example.test'}}).tagSort,win,view};
}
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(50);});
afterEach(()=>vi.useRealTimers());
it('delayed refresh executes the native date and action sorts after 30 seconds',async()=>{
 const {api,win,view}=runtime();api.refresh();api.refresh();
 expect(vi.getTimerCount()).toBe(1);expect(view.sort).not.toHaveBeenCalled();
 await vi.advanceTimersByTimeAsync(30000);
 expect(view.sort.mock.calls).toEqual([[18,2],[99,2]]);
 expect(win.__tmTagSortDelayedTimer).toBeNull();expect(treeVisible(win)).toBe('');
 api.shutdown();
});
function treeVisible(win){return win.document.getElementById('threadTree').style.visibility;}
it('shutdown cancels delayed sorting before it can run',async()=>{
 const {api,view}=runtime();api.refresh();expect(vi.getTimerCount()).toBe(1);
 api.shutdown();expect(vi.getTimerCount()).toBe(0);
 await vi.advanceTimersByTimeAsync(30000);expect(view.sort).not.toHaveBeenCalled();
});
