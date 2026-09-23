import { describe, it, expect } from 'vitest';
import { experiment, makeWindow } from './helpers/nativeLifecycleHarness.js';

const specs = [
 ['tagSort','theme/experiments/tagSort/tagSort.sys.mjs'],
 ['staleRowFilter','theme/experiments/staleRowFilter/staleRowFilter.sys.mjs'],
 ['tmTheme','theme/experiments/tmTheme/tmTheme.sys.mjs'],
 ['tmMessageListCardView','theme/experiments/tmMessageListCardView/tmMessageListCardView.sys.mjs'],
 ['tmMessageHeaderChip','theme/experiments/tmMessageHeaderChip/tmMessageHeaderChip.sys.mjs'],
 ['tmMultiMessageChip','theme/experiments/tmMultiMessageChip/tmMultiMessageChip.sys.mjs'],
 ['tmMessageListTableView','theme/experiments/tmMessageListTableView/tmMessageListTableView.sys.mjs'],
 ['tmPreviewGate','theme/experiments/tmPreviewGate/tmPreviewGate.sys.mjs'],
];
const create=(name,options)=>experiment(specs.find(x=>x[0]===name)[1],name,options);
const tick=async()=>{for(let i=0;i<12;i++)await Promise.resolve()};
function populatedWindow(name){
 const w=makeWindow();w.sorts=[];w.view.sort=(...a)=>w.sorts.push(a);
 if(name==='tmMessageHeaderChip'||name==='tmMultiMessageChip'){
  const el={querySelector:()=>null,querySelectorAll:()=>[]};
  const landmarks=name==='tmMessageHeaderChip'?['messageHeader']:['messageList'];
  const old=w.doc.getElementById;w.doc.getElementById=id=>landmarks.includes(id)?el:old(id);
  w.doc.querySelectorAll=()=>[];
 }
 return w;
}
const nativeEffects=w=>w.sorts.length+[w.media,w.tree,w.cw,w.tabContainer,w.doc].reduce((n,t)=>n+[...t.handlers.values()].reduce((a,s)=>a+s.size,0),0);

describe('native lifecycle across init, window load and shutdown',()=>{
 for (const n of ['staleRowFilter','tmTheme','tmMessageHeaderChip','tmMultiMessageChip','tmMessageListCardView','tmMessageListTableView']) {
  it(`${n} activates native behavior in a future ready window`,async()=>{
   const x=create(n);await x.api.init();
   const w=populatedWindow(n);
   const before=nativeEffects(w);
   x.openWindow(w.win);
   expect(nativeEffects(w)).toBeGreaterThan(before);
   if(n==='tmTheme'){
    const beforeLogs=x.logs.length;
    w.media.dispatch('change',{matches:true});
    await tick();
    expect(x.logs.length).toBeGreaterThan(beforeLogs);
   }
   x.instance.onShutdown(false);
   expect(nativeEffects(w)).toBe(before);
   expect(x.windowListeners.size).toBe(0);
  });
 }
 for (const n of ['tmMessageHeaderChip','tmMultiMessageChip']) {
  it(`${n} delivers a chip click from a future window`,async()=>{
   const x=create(n);await x.api.init();
   const seen=[];x.api.onActionChipClick.addListener(info=>seen.push(info));
   const w=populatedWindow(n);x.openWindow(w.win);
   w.doc.dispatch('click',{target:{closest:()=>({dataset:{tmWeMsgId:'42'}})},stopPropagation(){},preventDefault(){}});
   expect(seen).toHaveLength(1);
   expect(seen[0].weMsgId).toBe(42);
   x.instance.onShutdown(false);
  });
 }
 for (const [n,elementName] of [['tmMessageListCardView','thread-card'],['tmMessageListTableView','thread-row']]) {
  it(`${n} patches the row renderer in a future window`,async()=>{
   const x=create(n);await x.api.init();
   const w=populatedWindow(n);
   class Row { fillRow() {} }
   Row.ROW_HEIGHT=46;
   const original=Row.prototype.fillRow;
   w.cw.customElements={get:name=>name===elementName?Row:undefined};
   x.openWindow(w.win);
   expect(Row.prototype.fillRow).not.toBe(original);
   x.instance.onShutdown(false);
   expect(Row.prototype.fillRow).toBe(original);
  });
 }
 it('stale row filter repairs selection in a future window',()=>{
  const x=create('staleRowFilter');x.api.init();
  const w=populatedWindow('staleRowFilter');
  const pending=[];w.cw.setTimeout=fn=>{pending.push(fn);return pending.length};
  const blank={getAttribute:()=>''};
  w.tree.querySelector=()=>({id:'threadTree-row1',querySelector:()=>blank});
  const get=w.doc.getElementById;
  w.doc.getElementById=id=>id==='threadTree-row0'?{id,querySelector:()=>null}:get(id);
  const selected=[];w.view.selection.select=index=>selected.push(index);
  x.openWindow(w.win);
  w.tree.dispatch('select');
  expect(pending).toHaveLength(1);
  pending[0]();
  expect(selected).toEqual([0]);
  x.instance.onShutdown(false);
 });
 it('stale row filter transfers inactive-tab handlers and repairs selection when the tab returns',()=>{
  const a=makeWindow(),b=makeWindow();
  const tabmail=a.win.document.getElementById('tabmail');
  tabmail.tabInfo.push({chromeBrowser:{contentDocument:b.doc,contentWindow:b.cw}});
  const pending=new Map();let nextId=0;
  for(const w of [a,b]){
   w.cw.setTimeout=fn=>{const id=++nextId;pending.set(id,fn);return id};
   w.cw.clearTimeout=id=>pending.delete(id);
  }
  const blank={getAttribute:()=>''};
  a.tree.querySelector=()=>({id:'threadTree-row1',querySelector:()=>blank});
  const get=a.doc.getElementById;
  a.doc.getElementById=id=>id==='threadTree-row0'?{id,querySelector:()=>null}:get(id);
  const selected=[];a.view.selection.select=i=>selected.push(i);
  const flush=()=>{for(const [id,fn] of pending){pending.delete(id);fn()}};
  const x=create('staleRowFilter',{windows:[a.win]});x.api.init();
  a.tree.dispatch('select');flush();expect(selected).toEqual([0]);selected.length=0;
  tabmail.currentAbout3Pane=b.cw;tabmail.tabContainer.dispatch('TabSelect');
  x.instance.getAPI({extension:x.context.extension}).staleRowFilter.init();
  expect(a.tree.handlers.get('select')?.size||0).toBe(0);
  tabmail.currentAbout3Pane=a.cw;tabmail.tabContainer.dispatch('TabSelect');
  expect(a.tree.handlers.get('select')?.size).toBe(1);
  a.tree.dispatch('select');flush();expect(selected).toEqual([0]);
  x.instance.onShutdown(false);
  expect(a.tree.handlers.get('select')?.size||0).toBe(0);
  expect(b.tree.handlers.get('select')?.size||0).toBe(0);
 });
 for (const unload of ['document', 'window']) {
  it(`stale row filter releases a ready ${unload} on unload`,()=>{
   const w=makeWindow();
   const pending=new Map();let nextId=0;
   w.cw.setTimeout=fn=>{const id=++nextId;pending.set(id,fn);return id};
   w.cw.clearTimeout=id=>pending.delete(id);
   const blank={getAttribute:()=>''};
   w.tree.querySelector=()=>({id:'threadTree-row1',querySelector:()=>blank});
   const get=w.doc.getElementById;
   w.doc.getElementById=id=>id==='threadTree-row0'?{id,querySelector:()=>null}:get(id);
   const selected=[];w.view.selection.select=i=>selected.push(i);
   const observers=[];
   w.cw.MutationObserver=class {
    constructor(callback){this.callback=callback;this.connected=false;observers.push(this)}
    observe(){this.connected=true}
    disconnect(){this.connected=false}
   };
   const x=create('staleRowFilter',{windows:[w.win]});x.api.init();
   w.tree.dispatch('select');
   for(const [id,fn] of pending){pending.delete(id);fn()}
   expect(selected).toEqual([0]);
   expect(observers[0].connected).toBe(true);
   (unload==='document'?w.cw:w.win).dispatch('unload');
   expect(observers[0].connected).toBe(false);
   expect(w.tree.handlers.get('select')?.size||0).toBe(0);
   expect(w.cw.handlers.get('folderURIChanged')?.size||0).toBe(0);
   expect(pending.size).toBe(0);
   w.tree.dispatch('select');
   expect(selected).toEqual([0]);
   x.instance.onShutdown(false);
  });
 }
 it('stale row filter releases each replaced document and keeps repairing its successor',()=>{
  const w=makeWindow(),pending=new Map(),observers=[];let nextId=0;
  w.cw.setTimeout=fn=>{const id=++nextId;pending.set(id,fn);return id};
  w.cw.clearTimeout=id=>pending.delete(id);
  w.cw.MutationObserver=class {
   constructor(callback){this.callback=callback;this.connected=false;observers.push(this)}
   observe(){this.connected=true}
   disconnect(){this.connected=false}
  };
  const x=create('staleRowFilter',{windows:[w.win]});
  const selected=[];w.view.selection.select=i=>selected.push(i);
  const prepare=next=>{
   const blank={getAttribute:()=>''};
   next.tree.querySelector=()=>({id:'threadTree-row1',querySelector:()=>blank});
   const get=next.doc.getElementById;
   next.doc.getElementById=id=>id==='threadTree-row0'?{id,querySelector:()=>null}:get(id);
  };
  const flush=()=>{for(const [id,fn] of pending){pending.delete(id);fn()}};
  prepare(w);x.api.init();w.tree.dispatch('select');flush();expect(selected).toEqual([0]);
  let current=w;
  for(let i=0;i<4;i++){
   const prior=current;current=makeWindow();prepare(current);
   current.doc.defaultView=w.cw;w.cw.document=current.doc;
   w.cw.dispatch('folderURIChanged');expect(pending.size).toBe(1);flush();
   expect(current.tree.handlers.get('select')?.size).toBe(1);
   current.tree.dispatch('select');flush();expect(selected.length).toBe(i+2);
   expect(prior.tree.handlers.get('select')?.size||0).toBe(0);
   expect(observers.filter(observer=>observer.connected)).toHaveLength(1);
   const count=selected.length;prior.tree.dispatch('select');flush();expect(selected.length).toBe(count);
  }
  x.instance.onShutdown(false);
  expect(observers.filter(observer=>observer.connected)).toHaveLength(0);
 });
 it('theme media changes replace the live sheet after handoff and stop at shutdown',async()=>{
  const w=makeWindow();const x=create('tmTheme',{windows:[w.win]});
  await x.api.init();
  await x.instance.getAPI({extension:x.context.extension}).tmTheme.init();
  expect(x.sheets.size).toBe(1);
  const before=[...x.sheets][0];
  w.media.dispatch('change',{matches:true});
  for(let i=0;i<100;i++)await Promise.resolve();
  await new Promise(resolve=>setImmediate(resolve));
  expect(x.sheets.size).toBe(1);
  expect([...x.sheets][0]).not.toBe(before);
  x.instance.onShutdown(false);expect(x.sheets.size).toBe(0);
  w.media.dispatch('change',{matches:false});
  for(let i=0;i<100;i++)await Promise.resolve();
  await new Promise(resolve=>setImmediate(resolve));
  expect(x.sheets.size).toBe(0);
 });
 for(const topic of ['look-and-feel-changed','widget:ui-resolution-changed']){
  it(`theme ${topic} refreshes the live sheet after handoff`,async()=>{
   const w=makeWindow();const x=create('tmTheme',{windows:[w.win]});
   let recalcs=0;
   w.doc.documentElement.classList.add=name=>{if(name==='tm-theme-recalc')recalcs++};
   await x.api.init();
   await x.instance.getAPI({extension:x.context.extension}).tmTheme.init();
   expect(x.observers.get(topic)?.size).toBe(1);
   const previous=[...x.sheets][0];
   expect(previous).toContain('data:text/css');
   recalcs=0;
   x.Services.obs.notifyObservers(null,topic);
   for(let i=0;i<100;i++)await Promise.resolve();
   await new Promise(resolve=>setImmediate(resolve));
   expect(x.sheets.size).toBe(1);
   expect([...x.sheets][0]).not.toBe(previous);
   expect(recalcs).toBeGreaterThan(0);
   x.instance.onShutdown(false);
   recalcs=0;
   x.Services.obs.notifyObservers(null,topic);
   for(let i=0;i<100;i++)await Promise.resolve();
   await new Promise(resolve=>setImmediate(resolve));
   expect(x.sheets.size).toBe(0);
   expect(x.observers.get(topic)?.size||0).toBe(0);
   expect(recalcs).toBe(0);
  });
 }
 it('stale row filter scans newly rendered rows after document replacement',()=>{
  const w=makeWindow(),pending=new Map(),observers=[],effects=[];let nextId=0;
  w.cw.setTimeout=fn=>{const id=++nextId;pending.set(id,fn);return id};
  w.cw.clearTimeout=id=>pending.delete(id);
  w.cw.MutationObserver=class {
   constructor(callback){this.callback=callback;observers.push(this)}
   observe(){this.connected=true}
   disconnect(){this.connected=false}
  };
  const staleRow=index=>({id:`threadTree-row${index}`,querySelector:()=>({getAttribute:()=>''})});
  const makeHeader=(id,subject='')=>({
   messageId:id,subject,author:'',date:0,isRead:false,
   markRead(value){this.isRead=value;effects.push(['read',id,value])},
   folder:{deleteMessages(messages){effects.push(['delete',messages.items[0].messageId])}},
  });
  let headers=[makeHeader('first@example.test')];
  w.view.getMsgHdrAt=index=>headers[index];
  w.tree.querySelectorAll=()=>[staleRow(0)];
  const x=create('staleRowFilter',{windows:[w.win]});
  x.sandbox.Cc={'@mozilla.org/array;1':{createInstance:()=>({items:[],appendElement(item){this.items.push(item)}})}};
  x.api.init();
  expect(effects).toContainEqual(['read','first@example.test',true]);
  expect(effects).toContainEqual(['delete','first@example.test']);
  effects.length=0;
  const next=makeWindow();next.doc.defaultView=w.cw;w.cw.document=next.doc;
  let rows=[];next.tree.querySelectorAll=()=>rows;
  const flush=()=>{for(const [id,fn] of pending){pending.delete(id);fn()}};
  w.cw.dispatch('folderURIChanged');flush();
  expect(observers.filter(observer=>observer.connected)).toHaveLength(1);
  headers=[makeHeader('replacement@example.test'),makeHeader('ordinary@example.test','Ordinary subject')];
  rows=[staleRow(0),staleRow(1)];
  observers.at(-1).callback([{type:'childList'}]);
  expect(effects).toEqual([['read','replacement@example.test',true],['delete','replacement@example.test']]);
  x.instance.onShutdown(false);
  expect(pending.size).toBe(0);
 });
 it('stale row filter reattaches to the new thread tree after folder change',()=>{
  const w=populatedWindow('staleRowFilter');
  const pending=[];w.cw.setTimeout=fn=>{pending.push(fn);return pending.length};
  const x=create('staleRowFilter',{windows:[w.win]});x.api.init();
  const replacement=makeWindow();
  replacement.doc.defaultView=w.cw;
  w.cw.document=replacement.doc;
  w.cw.dispatch('folderURIChanged');
  expect(pending).toHaveLength(1);
  pending[0]();
  expect(replacement.tree.handlers.get('select')?.size).toBe(1);
  x.instance.onShutdown(false);
 });
 it('multi-message refresh before init owns and releases handlers and observer',async()=>{
  const w=populatedWindow('tmMultiMessageChip');
  const old=w.doc.getElementById;
  w.doc.getElementById=id=>id==='content'?{}:old(id);
  const observers=[];
  w.cw.MutationObserver=class {
   connected=false;
   constructor(callback){this.callback=callback;observers.push(this)}
   observe(){this.connected=true}
   disconnect(){this.connected=false}
  };
  const x=create('tmMultiMessageChip',{windows:[w.win]});
  await x.api.refreshAll();
  expect(w.doc.handlers.get('click')?.size).toBe(1);
  expect(observers.at(-1)?.connected).toBe(true);
  x.instance.onShutdown(false);
  expect(w.doc.handlers.get('mousedown')?.size||0).toBe(0);
  expect(w.doc.handlers.get('click')?.size||0).toBe(0);
  expect(w.doc.handlers.get('keydown')?.size||0).toBe(0);
  expect(observers.at(-1)?.connected).toBe(false);
  observers[0].callback();
  await x.api.refreshAll();
  expect(w.doc.handlers.get('click')?.size||0).toBe(0);
  expect(observers.at(-1)?.connected).toBe(false);
 });
 it('preview: sequential re-init preserves future window delivery and one sheet',async()=>{
  const x=create('tmPreviewGate');await x.api.init();const a=makeWindow();x.openWindow(a.win);expect(a.tree.handlers.get('select')?.size).toBe(1);
  await x.api.init();const b=makeWindow();x.openWindow(b.win);expect.soft(x.sheets.size).toBe(1);expect.soft(x.windowListeners.size).toBe(1);expect(b.tree.handlers.get('select')?.size||0).toBe(1);
 });
 it('theme: overlapping initializations leave one owned sheet and shutdown removes it',async()=>{
  const x=create('tmTheme',{holdFetch:true});const a=x.api.init(),b=x.api.init();await tick();expect(x.queued.length).toBeGreaterThan(0);
  for(let turn=0;turn<4;turn++){const next=x.queued.splice(0,3);for(const f of next)f();await new Promise(r=>setTimeout(r,5));await tick()}await Promise.all([a,b]);
  expect.soft(x.sheets.size).toBe(1);x.instance.onShutdown(false);expect(x.sheets.size).toBe(0);
 });
 it('theme: native UI observers and media hooks cannot recreate a stylesheet after shutdown',async()=>{
  const w=populatedWindow('tmTheme');
  const x=create('tmTheme',{windows:[w.win]});
  await x.api.init();
  expect(x.sheets.size).toBe(1);
  expect(x.observers.get('look-and-feel-changed')?.size).toBe(1);
  x.instance.onShutdown(false);
  expect(x.observers.get('look-and-feel-changed')?.size||0).toBe(0);
  x.Services.obs.notifyObservers(null,'look-and-feel-changed');
  w.media.dispatch('change',{matches:false});
  await new Promise(resolve=>setImmediate(resolve));
  expect(x.sheets.size).toBe(0);
 });
 for(const n of ['tmTheme','tmPreviewGate']){
  it(`${n}: a pending CSS read cannot recreate resources after extension shutdown`,async()=>{
   const x=create(n,{holdFetch:true}),pending=x.api.init();await tick();expect(x.queued.length).toBeGreaterThan(0);expect(x.sheets.size).toBe(0);
   x.instance.onShutdown(false);for(const f of x.queued)f();await pending;
   expect.soft(x.sheets.size).toBe(0);expect(x.windowListeners.size).toBe(0);
  });
  it(`${n}: queued initialization cannot take ownership after shutdown`,async()=>{
   const x=create(n,{holdFetch:true});
   const first=x.api.init(),second=x.api.init();
   await tick();
   expect(x.queued.length).toBeGreaterThan(0);
   x.instance.onShutdown(false);
   for(let turn=0;turn<4;turn++){
    const ready=x.queued.splice(0);
    for(const release of ready)release();
    await new Promise(resolve=>setImmediate(resolve));
   }
   await Promise.all([first,second]);
   expect(x.sheets.size).toBe(0);
   expect(x.windowListeners.size).toBe(0);
  });
  it(`${n}: repeated initialization cannot reattach a ready window after shutdown`,async()=>{
   const w=populatedWindow(n);
   const x=create(n,{windows:[w.win]});
   await x.api.init();
   const repeated=x.api.init();
   x.instance.onShutdown(false);
   await repeated;
   expect(x.sheets.size).toBe(0);
   expect(x.windowListeners.size).toBe(0);
   expect(w.tree.handlers.get('select')?.size||0).toBe(0);
  });
 }
 it('selection control: explicit cleanup stops native input work as well as event delivery',()=>{
  const w=makeWindow(),x=experiment('chat/experiments/messageSelection/messageSelection.sys.mjs','messageSelection',{windows:[w.win]}),seen=[];
  x.api.init();x.api.onSelectionChanged.addListener(i=>seen.push(i));w.tree.dispatch('select');expect(seen[0].selectedMessages[0].messageId).toBe(w.hdr.messageId);
  x.api.shutdown();const before=x.logs.length;w.tree.dispatch('select');expect(x.logs.length).toBe(before);expect(seen.length).toBe(1);expect(x.windowListeners.size).toBe(0);
 });
 it('selection: actual extension shutdown stops native input work after event context closes',()=>{
  const w=makeWindow(),x=experiment('chat/experiments/messageSelection/messageSelection.sys.mjs','messageSelection',{windows:[w.win]}),seen=[];
  x.api.init();x.api.onSelectionChanged.addListener(i=>seen.push(i));w.tree.dispatch('select');expect(seen[0].selectedMessages[0].messageId).toBe(w.hdr.messageId);
  x.api.onSelectionChanged.close();x.instance.onShutdown(false);const before=x.logs.length;w.tree.dispatch('select');
  expect.soft(seen.length).toBe(1);expect.soft(x.windowListeners.size).toBe(0);expect.soft(w.tree.handlers.get('select')?.size||0).toBe(0);expect(x.logs.length).toBe(before);
 });
 it('tagSort: closed windows release native service references before extension shutdown',()=>{
  const x=create('tagSort');x.api.init();const counts=[];
  for(let i=0;i<3;i++){const w=populatedWindow('tagSort');x.openWindow(w.win);expect(w.sorts.length).toBeGreaterThan(0);x.closeWindow(w.win);counts.push(x.mfn.size)}
  x.instance.onShutdown(false);expect.soft(counts).toEqual([0,0,0]);expect(x.mfn.size).toBe(0);
 });
 it('stale row filter cancels folder repair and selection timers on shutdown',()=>{
  const w=populatedWindow('staleRowFilter');
  const pending=new Map();let nextId=0;
  w.cw.setTimeout=(fn,delay)=>{const id=++nextId;pending.set(id,{fn,delay});return id};
  w.cw.clearTimeout=id=>pending.delete(id);
  const x=create('staleRowFilter',{windows:[w.win]});
  x.api.init();
  expect(w.cw.handlers.get('folderURIChanged')?.size).toBe(1);
  for(let i=0;i<50;i++){
   w.cw.dispatch('folderURIChanged');
   w.tree.dispatch('select');
  }
  expect([...pending.values()].map(({delay})=>delay).sort()).toEqual([10,50]);
  const callbacks=[...pending.values()].map(({fn})=>fn);
  x.instance.onShutdown(false);
  expect(pending.size).toBe(0);
  for(const callback of callbacks)callback();
  expect(w.doc.__tmSRF_MO).toBeUndefined();
  expect(w.tree.handlers.get('select')?.size||0).toBe(0);
  expect(w.cw.handlers.get('folderURIChanged')?.size||0).toBe(0);
 });
 it('stale row filter cannot move selection from a queued callback after shutdown',()=>{
  const w=populatedWindow('staleRowFilter');
  const pending=[];
  w.cw.setTimeout=fn=>{pending.push(fn);return pending.length};
  w.cw.clearTimeout=()=>{};
  const blankCell={getAttribute:()=>''};
  const staleRow={id:'threadTree-row1',querySelector:()=>blankCell};
  w.tree.querySelector=()=>staleRow;
  const get=w.doc.getElementById;
  w.doc.getElementById=id=>id==='threadTree-row0'?{id,querySelector:()=>null}:get(id);
  const selected=[];
  w.view.selection.select=index=>selected.push(index);
  const x=create('staleRowFilter',{windows:[w.win]});
  x.api.init();
  w.tree.dispatch('select');
  expect(pending.length).toBe(1);
  x.instance.onShutdown(false);
  pending[0]();
  expect(selected).toEqual([]);
 });
 it('tagSort: extension shutdown releases its globally registered column callbacks',()=>{
  const w=populatedWindow('tagSort');const x=create('tagSort',{windows:[w.win]});x.api.init();expect(x.columns.has('tmActionSort')).toBe(true);const before=x.columns.get('tmActionSort');expect(typeof before.sortCallback).toBe('function');
  x.instance.onShutdown(false);expect(x.columns.has('tmActionSort')).toBe(false);
 });
 it('tagSort leaves a pre-existing global column owned by another component intact',()=>{
  const w=populatedWindow('tagSort');
  const x=create('tagSort',{windows:[w.win]});
  const existing={name:'Other owner'};
  x.columns.set('tmActionSort',existing);
  x.api.init();
  x.instance.onShutdown(false);
  expect(x.columns.get('tmActionSort')).toBe(existing);
 });
 it('tagSort native callbacks and pending timers cannot recreate a column after shutdown',()=>{
  const w=populatedWindow('tagSort');
  const pending=new Map();let nextId=0;
  w.win.setTimeout=(fn,delay)=>{const id=++nextId;pending.set(id,{fn,delay});return id};
  w.win.clearTimeout=id=>pending.delete(id);
  const x=create('tagSort',{windows:[w.win]});
  x.api.init();
  expect(x.columns.size).toBe(1);
  [...x.mfn][0].msgsClassified();
  x.instance.onShutdown(false);
  expect(pending.size).toBe(0);
  w.tabContainer.dispatch('TabSelect');
  w.cw.dispatch('folderURIChanged');
  w.cw.dispatch('threadpane-loaded');
  while(pending.size){const [id,{fn}]=pending.entries().next().value;pending.delete(id);fn()}
  expect(x.columns.size).toBe(0);
  expect(pending.size).toBe(0);
 });
 it('tagSort releases the initialized native owner even when a later API context never initializes',()=>{
  const w=populatedWindow('tagSort');
  const x=create('tagSort',{windows:[w.win]});
  x.api.init();
  expect(x.columns.size).toBe(1);
  expect(x.windowListeners.size).toBe(1);
  x.instance.getAPI({ extension:x.context.extension }).tagSort.refreshImmediate();
  x.instance.onShutdown(false);
  expect(x.columns.size).toBe(0);
  expect(x.windowListeners.size).toBe(0);
  expect(x.observers.get('tabmail-sort-order-changed')?.size||0).toBe(0);
 });
 for (const n of ['tmTheme','tmPreviewGate','tmMessageHeaderChip','tmMultiMessageChip','tmMessageListCardView','staleRowFilter','tmMessageListTableView']) {
  it(`${n} keeps the initialized cleanup when another API context is only opened`,async()=>{
   const w=populatedWindow(n);
   const x=create(n,{windows:[w.win]});
   await x.api.init();
   expect(x.windowListeners.size).toBe(1);
   x.instance.getAPI(x.context);
   x.instance.onShutdown(false);
   expect(x.windowListeners.size).toBe(0);
   expect(x.sheets.size).toBe(0);
  });
 }
 for (const [n] of specs) {
  it(`${n} releases both initialized API contexts at true extension shutdown`,async()=>{
   const w=populatedWindow(n);
   const x=create(n,{windows:[w.win]});
   await x.api.init();
   const second=x.instance.getAPI(x.context)[n];
   await second.init();
   x.instance.onShutdown(false);
   expect(x.windowListeners.size).toBe(0);
   expect(x.sheets.size).toBe(0);
  });
 }
 for (const [n,elementName] of [['tmMessageListCardView','thread-card'],['tmMessageListTableView','thread-row']]) {
  it(`${n} patches its actual row renderer after an existing window finishes loading`,async()=>{
   const w=populatedWindow(n);
   class Row { fillRow() {} }
   Row.ROW_HEIGHT=46;
   const original=Row.prototype.fillRow;
   w.cw.customElements={get:name=>name===elementName?Row:undefined};
   let ready=false;const get=w.win.document.getElementById;
   w.win.document.getElementById=(...a)=>ready?get(...a):null;
   w.win.document.readyState='loading';
   const x=create(n,{windows:[w.win]});
   await x.api.init();
   expect(Row.prototype.fillRow).toBe(original);
   ready=true;w.win.document.readyState='complete';w.win.dispatch('load');
   expect(Row.prototype.fillRow).not.toBe(original);
   x.instance.onShutdown(false);
   expect(Row.prototype.fillRow).toBe(original);
  });
 }
 for(const [n,rel] of specs){
  it(`${n} control: delayed window load reaches real native setup`,async()=>{
   const w=populatedWindow(n);let ready=false;const get=w.win.document.getElementById;w.win.document.getElementById=(...a)=>ready?get(...a):null;
   w.win.document.readyState='loading';const x=experiment(rel,n,{windows:[w.win]});await x.api.init();expect(w.win.handlers.get('load')?.size).toBeGreaterThan(0);
   const before=nativeEffects(w);ready=true;w.win.document.readyState='complete';w.win.dispatch('load');
   if(n==='tmTheme'){
    expect(x.sheets.size).toBe(1);
    expect(w.media.handlers.get('change')?.size).toBe(1);
   }else expect(nativeEffects(w)).toBeGreaterThan(before);
   x.instance.onShutdown(false);
  });
  it(`${n}: delayed window load cannot restore native hooks or sorting after shutdown`,async()=>{
   const w=populatedWindow(n);let ready=false;const get=w.win.document.getElementById;w.win.document.getElementById=(...a)=>ready?get(...a):null;
   w.win.document.readyState='loading';const x=experiment(rel,n,{windows:[w.win]});await x.api.init();expect(w.win.handlers.get('load')?.size).toBeGreaterThan(0);
   x.instance.onShutdown(false);
   expect(w.win.handlers.get('load')?.size||0).toBe(0);
   expect(w.win.handlers.get('unload')?.size||0).toBe(0);
   const before=nativeEffects(w);ready=true;w.win.document.readyState='complete';w.win.dispatch('load');expect(nativeEffects(w)).toBe(before);
  });
  it(`${n}: closing a loading window cancels its deferred setup`,async()=>{
   const w=populatedWindow(n);let ready=false;const get=w.win.document.getElementById;w.win.document.getElementById=(...a)=>ready?get(...a):null;
   w.win.document.readyState='loading';const x=experiment(rel,n,{windows:[w.win]});await x.api.init();
   expect(w.win.handlers.get('load')?.size).toBeGreaterThan(0);
   w.win.dispatch('unload');
   expect(w.win.handlers.get('load')?.size||0).toBe(0);
   const before=nativeEffects(w);ready=true;w.win.document.readyState='complete';w.win.dispatch('load');
   expect(nativeEffects(w)).toBe(before);
   x.instance.onShutdown(false);
  });
 }
});
