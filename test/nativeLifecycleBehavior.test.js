import { describe, it, expect } from 'vitest';
import { experiment, makeWindow } from './helpers/nativeLifecycleHarness.js';

describe('independent coverage probes', () => {
 it('preview selection uses the newest background enablement after context handoff',async()=>{
  const w=makeWindow(),classes=new Set();
  w.doc.documentElement.classList={add:c=>classes.add(c),remove:c=>classes.delete(c),contains:c=>classes.has(c)};
  const x=experiment('theme/experiments/tmPreviewGate/tmPreviewGate.sys.mjs','tmPreviewGate',{windows:[w.win]});
  await x.api.init();await x.api.setPreviewAutoGateEnabled({enabled:false});
  w.tree.dispatch('select');expect(classes.has('tm-message-preview-gated')).toBe(false);
  const next=x.instance.getAPI({extension:x.context.extension}).tmPreviewGate;
  await next.init();await next.setPreviewAutoGateEnabled({enabled:true});
  w.tree.dispatch('select');expect(classes.has('tm-message-preview-gated')).toBe(true);
  await next.setPreviewAutoGateEnabled({enabled:false});
  classes.delete('tm-message-preview-gated');
  w.tree.dispatch('select');expect(classes.has('tm-message-preview-gated')).toBe(false);
  x.instance.onShutdown(false);
 });
 it('preview gates a pane navigation event after a background context handoff',async()=>{
  const w=makeWindow(),classes=new Set(),get=w.doc.getElementById;
  w.doc.documentElement.classList={add:c=>classes.add(c),remove:c=>classes.delete(c),contains:c=>classes.has(c)};
  w.doc.getElementById=id=>id==='messagepane'?w.pane:get(id);
  const x=experiment('theme/experiments/tmPreviewGate/tmPreviewGate.sys.mjs','tmPreviewGate',{windows:[w.win]});
  await x.api.init();
  const next=x.instance.getAPI({extension:x.context.extension}).tmPreviewGate;
  await next.init();await next.setPreviewAutoGateEnabled({enabled:true});
  expect(w.pane.handlers.get('loadstart')?.size).toBe(1);
  w.pane.dispatch('loadstart');
  expect(classes.has('tm-message-preview-gated')).toBe(true);
  x.instance.onShutdown(false);
 });
 it('preview gates a message pane inserted lazily after a background context handoff',async()=>{
  const w=makeWindow(),classes=new Set(),get=w.doc.getElementById;
  w.doc.documentElement.classList={add:c=>classes.add(c),remove:c=>classes.delete(c),contains:c=>classes.has(c)};
  let paneReady=false;w.doc.getElementById=id=>id==='messagepane'?(paneReady?w.pane:null):get(id);
  const x=experiment('theme/experiments/tmPreviewGate/tmPreviewGate.sys.mjs','tmPreviewGate',{windows:[w.win]});
  await x.api.init();
  const next=x.instance.getAPI({extension:x.context.extension}).tmPreviewGate;
  await next.init();await next.setPreviewAutoGateEnabled({enabled:true});
  const finder=w.doc.__tmPreviewGateAuto?.paneFinderMO;
  expect(finder).toBeTruthy();
  expect(classes.has('tm-message-preview-gated')).toBe(false);
  paneReady=true;finder.callback([{type:'childList'}]);
  expect(classes.has('tm-message-preview-gated')).toBe(true);
  x.instance.onShutdown(false);
 });
 for (const name of ['tmTheme','tmPreviewGate']) {
  it(`${name}: background context restarts keep one stylesheet and hand off window delivery`, async () => {
   const w=makeWindow();
   const x=experiment(`theme/experiments/${name}/${name}.sys.mjs`,name,{windows:[w.win]});
   await x.api.init();
   expect(x.sheets.size).toBe(1);
   let previousListener=[...x.windowListeners.values()][0];
   for(let wake=0;wake<100;wake++){
    const nextContext={extension:x.context.extension};
    expect(nextContext).not.toBe(x.context);
    const next=x.instance.getAPI(nextContext)[name];
    await next.init();
    expect(x.instance._tmCleanups.size).toBe(1);
    expect(x.sheets.size).toBe(1);
    expect(x.windowListeners.size).toBe(1);
    const listener=[...x.windowListeners.values()][0];
    expect(listener).not.toBe(previousListener);
    previousListener=listener;
    if(name==='tmTheme') expect(x.observers.get('look-and-feel-changed').size).toBe(1);
   }
   const future=makeWindow();x.openWindow(future.win);
   if(name==='tmTheme') expect(future.media.handlers.get('change')?.size).toBe(1);
   else expect(future.tree.handlers.get('select')?.size).toBe(1);
   x.instance.onShutdown(false);
   expect(x.instance._tmCleanups.size).toBe(0);
   expect(x.sheets.size).toBe(0);
   if(name==='tmTheme') expect(x.observers.get('look-and-feel-changed').size).toBe(0);
   expect(x.windowListeners.size).toBe(0);
  });
  it(`${name}: shutdown during a context handoff releases the extension window listener`, async () => {
   const w=makeWindow();
   const x=experiment(`theme/experiments/${name}/${name}.sys.mjs`,name,{windows:[w.win]});
   await x.api.init();
   expect(x.windowListeners.size).toBe(1);
   const replacement=x.instance.getAPI({extension:x.context.extension})[name].init();
   x.instance.onShutdown(false);
   await replacement;
   expect(x.windowListeners.size).toBe(0);
   expect(x.sheets.size).toBe(0);
   const future=makeWindow();
   x.openWindow(future.win);
   future.media.dispatch('change',{matches:true});
   expect(x.sheets.size).toBe(0);
  });
 }
 it('preview gates real selection when an existing about3pane gains its thread tree at load', async () => {
  const w=makeWindow();
  const classes=new Set();
  w.doc.documentElement.classList={add:c=>classes.add(c),remove:c=>classes.delete(c),contains:c=>classes.has(c)};
  const get=w.doc.getElementById;
  let treeReady=false;
  w.doc.getElementById=id=>id==='threadTree'&&!treeReady?null:get(id);
  w.win.document.readyState='loading';
  const x=experiment('theme/experiments/tmPreviewGate/tmPreviewGate.sys.mjs','tmPreviewGate',{windows:[w.win]});
  await x.api.init();
  await x.api.setPreviewAutoGateEnabled({enabled:true});
  expect(w.win.document.getElementById('tabmail')).toBeTruthy();
  expect(w.doc.getElementById('threadTree')).toBeNull();
  expect(w.win.handlers.get('load')?.size).toBe(1);
  w.tree.dispatch('select');
  expect(classes.has('tm-message-preview-gated')).toBe(false);
  treeReady=true;w.win.document.readyState='complete';w.win.dispatch('load');
  expect(w.tree.handlers.get('select')?.size||0).toBe(1);
  w.tree.dispatch('select');
  expect(classes.has('tm-message-preview-gated')).toBe(true);
  x.instance.onShutdown(false);
  expect(classes.has('tm-message-preview-gated')).toBe(false);
 });
});

it('newly installed card wrapper preserves Thunderbird row contents', async () => {
 const w=makeWindow();
 class Row { fillRow(index, _row, data) { this.renderedSubject=data.subject; this.renderedIndex=index; } }
 Row.ROW_HEIGHT=46;
 w.cw.customElements={get:name=>name==='thread-card'?Row:undefined};
 const original=Row.prototype.fillRow;
 let ready=false;const get=w.win.document.getElementById;
 w.win.document.getElementById=(...a)=>ready?get(...a):null;
 w.win.document.readyState='loading';
 const x=experiment('theme/experiments/tmMessageListCardView/tmMessageListCardView.sys.mjs','tmMessageListCardView',{windows:[w.win]});
 await x.api.init();
 expect(Row.prototype.fillRow).toBe(original);
 ready=true;w.win.document.readyState='complete';w.win.dispatch('load');
 expect(Row.prototype.fillRow).not.toBe(original);
 const row=new Row();row.ownerDocument=w.doc;
 row.fillRow(2,null,{subject:'Synthetic subject'},w.view);
 expect(row.renderedSubject).toBe('Synthetic subject');
 expect(row.renderedIndex).toBe(2);
 x.instance.onShutdown(false);
 expect(Row.prototype.fillRow).toBe(original);
});
for (const name of ['tagSort','staleRowFilter','tmTheme','tmMessageListCardView','tmMessageHeaderChip','tmMultiMessageChip','tmMessageListTableView','tmPreviewGate']) {
 it(`${name}: true shutdown releases deferred window callbacks from each API context`,async()=>{
  const w=makeWindow();
  let ready=false;const get=w.win.document.getElementById;
  w.win.document.getElementById=(...a)=>ready?get(...a):null;
  w.win.document.readyState='loading';
  const x=experiment(`theme/experiments/${name}/${name}.sys.mjs`,name,{windows:[w.win]});
  await x.api.init();
  const second=x.instance.getAPI({extension:x.context.extension})[name];
  await second.init();
  expect(w.win.handlers.get('load')?.size).toBe(1);
  expect(w.win.handlers.get('unload')?.size).toBe(1);
  if (name === 'tmTheme' || name === 'tmPreviewGate') {
   expect(x.instance._tmCleanups.size).toBe(1);
  }
  x.instance.onShutdown(false);
  expect(w.win.handlers.get('load')?.size||0).toBe(0);
  expect(w.win.handlers.get('unload')?.size||0).toBe(0);
  ready=true;w.win.document.readyState='complete';w.win.dispatch('load');
  expect(w.tree.handlers.get('select')?.size||0).toBe(0);
 });
}
