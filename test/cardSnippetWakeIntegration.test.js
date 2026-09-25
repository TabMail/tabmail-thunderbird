import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {parse} from 'acorn';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { experiment, makeWindow } from './helpers/nativeLifecycleHarness.js';
const deps = vi.hoisted(() => ({key:vi.fn(),full:vi.fn(),text:vi.fn(),cached:vi.fn(),set:vi.fn()}));
vi.mock('../agent/modules/utils.js',()=>({getUniqueMessageKey:deps.key,safeGetFull:deps.full}));
vi.mock('../fts/bodyExtract.js',()=>({extractPlainText:deps.text}));
vi.mock('../theme/modules/snippetCache.js',()=>({getSnippetsBatch:deps.cached,setSnippet:deps.set,getStats:()=>({})}));
import {createCardSnippetProvider} from '../theme/modules/cardSnippetProvider.js';
const cleanups=[];
beforeEach(()=>{
 vi.resetAllMocks();
 deps.key.mockImplementation(async id=>'synthetic:/Inbox:'+id);
 deps.full.mockImplementation(async id=>({body:'message-'+id}));
 deps.text.mockImplementation(async full=>full.body);
 deps.cached.mockResolvedValue(new Map());deps.set.mockResolvedValue(true);
});
afterEach(()=>{for(const f of cleanups.splice(0).reverse())f();vi.unstubAllGlobals();});
function setup(){
 const w=makeWindow(), dom=new JSDOM('<div id="threadTree"></div><table><tbody></tbody></table>',{url:'https://example.test/'});
 const doc=dom.window.document,tree=doc.getElementById('threadTree');
 const messages=[1,2].map(id=>({...w.hdr,messageKey:id,messageId:'synthetic-'+id+'@example.test',
 getStringProperty:()=>'',folder:{...w.hdr.folder,flags:1}}));
 let current=messages[0];tree.view={getMsgHdrAt:()=>current};
 const tabmail=w.win.document.getElementById('tabmail');tabmail.currentAbout3Pane=dom.window;
 tabmail.tabInfo[0].chromeBrowser={contentDocument:doc,contentWindow:dom.window};
 class Row { fillRow(){if(!this.querySelector('.card-container'))this.innerHTML='<td class="card-container"><span class="sender">Synthetic</span><span class="subject">Synthetic</span><div class="thread-card-dynamic-row"></div></td>';} }
 Row.ROW_HEIGHT=46;Object.defineProperty(dom.window,'customElements',{value:{get:n=>n==='thread-card'?Row:undefined}});
 const x=experiment('theme/experiments/tmMessageListCardView/tmMessageListCardView.sys.mjs','tmMessageListCardView',{windows:[w.win]});
 x.context.extension.messageManager.convert=hdr=>({id:hdr.messageKey});
 const row=doc.createElement('tr');row.id='threadTree-row0';row.setAttribute('is','thread-card');
 cleanups.push(()=>dom.window.close(),()=>x.instance.onShutdown(false));
 return {x,doc,row,append:()=>doc.querySelector('tbody').appendChild(row),
 fill:()=>Row.prototype.fillRow.call(row,0,null,{},tree.view),swap:()=>{current=messages[1];},
 snippet:()=>row.querySelector('.tm-card-snippet')?.textContent??''};
}
function provider(f,event=f.x.api.onSnippetsNeeded){
 vi.stubGlobal('browser',{tmMessageListCardView:{onSnippetsNeeded:event}});
 const getNeeds=vi.fn(opts=>f.x.api.getCardSnippetNeeds(opts));
 const provide=vi.fn(payload=>f.x.api.provideCardSnippets(payload));
 const p=createCardSnippetProvider({getNeeds,provideSnippets:provide});
 cleanups.push(()=>p.stop());return {p,getNeeds,provide};
}
describe('independent rendered snippet contracts',()=>{
 it('renders an uncached native need after priming, conversion and native painting',async()=>{
  const f=setup();await f.x.api.init();f.append();const queue=[];
  const r=f.x.api.onSnippetsNeeded.testPersistentRegistration().prime({async:info=>new Promise(resolve=>queue.push({info,resolve}))});
  f.fill();f.x.timers.at(-1).notify();
  expect(queue.map(x=>x.info)).toEqual([{count:1}]);expect(f.snippet()).toBe('');expect(deps.full).not.toHaveBeenCalled();
  const event={addListener(cb){const fire={async:info=>Promise.resolve(cb(info))};r.convert(fire);
    for(const item of queue.splice(0))item.resolve(fire.async(item.info));},removeListener(){r.unregister();}};
  const {p,getNeeds,provide}=provider(f,event);p.start();
  await vi.waitFor(()=>expect(f.snippet()).toBe('message-1'));
  expect(getNeeds).toHaveBeenCalled();expect(provide).toHaveBeenCalled();
  expect(deps.full).toHaveBeenCalledExactlyOnceWith(1);
  expect(deps.set).toHaveBeenCalledExactlyOnceWith('synthetic:/Inbox:1','message-1');
  expect(f.doc.__tmMsgList.__tmCardSnippetPending.size).toBe(0);
  const snippetNode=f.row.querySelector('.tm-card-snippet');
  p.stop();f.swap();f.fill();f.x.timers.at(-1).notify();
  expect(f.row.querySelector('.tm-card-snippet')).toBe(snippetNode);
  expect(snippetNode.getAttribute('data-tm-hdr-key')).toContain('::2');
  expect(f.snippet()).toBe('');expect(deps.full).toHaveBeenCalledTimes(1);
 });
 it('does not paint a recycled row with the old message after a slow fetch',async()=>{
  const f=setup();await f.x.api.init();f.append();f.fill();let finish;
  deps.full.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  const {p}=provider(f);p.start();await vi.waitFor(()=>expect(deps.full).toHaveBeenCalledWith(1));
  f.swap();f.fill();finish({body:'message-1'});
  await vi.waitFor(()=>expect(deps.set).toHaveBeenCalledWith('synthetic:/Inbox:1','message-1'));
  expect(f.snippet()).toBe('');f.x.timers.at(-1).notify();
  await vi.waitFor(()=>expect(f.snippet()).toBe('message-2'));expect(deps.full).toHaveBeenCalledTimes(2);
 });
 it('clears a failed fetch pending marker and retries on the next native render',async()=>{
  const f=setup();await f.x.api.init();f.append();f.fill();
  deps.full.mockRejectedValueOnce(new Error('synthetic fetch refusal'));
  const {p,provide}=provider(f);p.start();
  await vi.waitFor(()=>expect(provide).toHaveBeenCalledWith(expect.objectContaining({source:'mv3-empty'})));
  expect(f.snippet()).toBe('');expect(deps.set).not.toHaveBeenCalled();
  expect(f.doc.__tmMsgList.__tmCardSnippetPending.size).toBe(0);
  f.fill();f.x.timers.at(-1).notify();
  await vi.waitFor(()=>expect(f.snippet()).toBe('message-1'));expect(deps.full).toHaveBeenCalledTimes(2);
 });
 it.each(['throw','reject'])('isolates subscriber %s and permits a later delivery',async mode=>{
  const f=setup();await f.x.api.init();f.append();f.fill();const failure=new Error('synthetic receiver refusal');
  const fire={async:mode==='throw'?()=>{throw failure;}:()=>Promise.reject(failure)};
  const r=f.x.api.onSnippetsNeeded.testPersistentRegistration().prime(fire),success=vi.fn();
  const other=f.x.instance.primeListener('onSnippetsNeeded',{async:success});
  f.x.timers.at(-1).notify();await Promise.resolve();await Promise.resolve();
  expect(success).toHaveBeenCalledExactlyOnceWith({count:1});
  await vi.waitFor(()=>expect(f.x.logs.some(a=>String(a[0]).includes('snippet need subscriber failed'))).toBe(true));
  const recovered=vi.fn();r.convert({async:recovered});
  f.x.context.extension.emit('onSnippetsNeeded',{count:2});
  expect(recovered).toHaveBeenCalledExactlyOnceWith({count:2});r.unregister();other.unregister();
  expect((await f.x.api.getCardSnippetNeeds({max:24})).map(n=>n.weId)).toEqual([1]);
 });
 it('cancels a pending debounce and detaches the receiver at shutdown',async()=>{
  const f=setup();await f.x.api.init();f.append();const cancel=vi.fn(),notify=[];
  f.x.sandbox.Cc=new Proxy({},{get:()=>({createInstance:()=>({initWithCallback:cb=>notify.push(cb),cancel})})});
  const seen=vi.fn();f.x.api.onSnippetsNeeded.addListener(seen);f.fill();
  expect(notify).toHaveLength(1);f.x.instance.onShutdown(false);
  expect(cancel).toHaveBeenCalledTimes(1);notify[0].notify();expect(seen).not.toHaveBeenCalled();
 });
});


it('registers the real consumer before awaits and fills rows created during startup',async()=>{
 const f=setup();let release;const validation=new Promise(resolve=>{release=resolve;});const calls=[],events=new Map();
 function fallback(path='browser'){
  return new Proxy(()=>{calls.push(path);return Promise.resolve({});},{get(_t,k){
   if(k==='then')return undefined;if(k==='tmMessageListCardView')return f.x.api;
   const next=path+'.'+String(k);
   if(String(k).startsWith('on')){if(!events.has(next))events.set(next,{addListener(){},removeListener(){}});return events.get(next);}
   return fallback(next);
  }});
 }
 const browser=fallback();vi.stubGlobal('browser',browser);
 let source=readFileSync(new URL('../theme/background.js',import.meta.url),'utf8');
 const ast=parse(source,{ecmaVersion:'latest',sourceType:'module'});
 const globals={browser,console:{log(){},warn(){},error(){}},Date,URL,performance,setTimeout:()=>1,clearTimeout(){}};
 for(const entry of ast.body.filter(n=>n.type==='ImportDeclaration').reverse()){
  for(const specifier of entry.specifiers)globals[specifier.local.name]=()=>Promise.resolve({});
  source=source.slice(0,entry.start)+source.slice(entry.start,entry.end).replace(/[^\r\n]/g,' ')+source.slice(entry.end);
 }
 globals.SETTINGS={};globals.createCardSnippetProvider=createCardSnippetProvider;
 globals.validateThunderbirdThemeIds=()=>validation;
 source=source.replace('// Immediate init for hot-reloads\ninitTheme();','// Immediate init for hot-reloads\nglobalThis.initPromise = initTheme();');
 vm.runInNewContext(source,globals,{filename:'review-startup-background.js'});
 expect(f.x.instance._snippetNeedSubscriptions.size).toBe(1);
 await Promise.resolve();await Promise.resolve();expect(deps.full).not.toHaveBeenCalled();
 f.append();f.fill();expect(f.snippet()).toBe('');
 release();await globals.initPromise;
 await vi.waitFor(()=>expect(f.snippet()).toBe('message-1'));
 expect(deps.full).toHaveBeenCalledExactlyOnceWith(1);
 expect(calls).toContain('browser.tmTheme.refreshOpenFolders');
});
