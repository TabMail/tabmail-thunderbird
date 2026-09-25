/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
const state=vi.hoisted(()=>({store:{},native:new Map(),effects:[]}));
vi.mock('../agent/modules/idbStorage.js',()=>({
 get:async keys=>Object.fromEntries([].concat(keys).filter(k=>k in state.store).map(k=>[k,state.store[k]])),
 set:async values=>Object.assign(state.store,values),
 remove:async keys=>{for(const k of [].concat(keys))delete state.store[k];},
 getAllKeys:async()=>Object.keys(state.store),
}));
vi.mock('../agent/modules/utils.js',()=>({
 getUniqueMessageKey:async h=>`${h.folder.accountId}:${h.folder.path}:${h.headerMessageId}`,
 resolveUniqueMessageKey:vi.fn(),log:vi.fn(),
}));
vi.mock('../agent/modules/tagDefs.js',()=>({triggerSortRefresh:()=>state.effects.push('delayed'),maxPriorityAction:vi.fn()}));
let owner, accountEvent, folderEvent, real, accounts, visible, folder, headers;
function event(){
 const listeners=new Set();
 return {listeners,addListener:vi.fn(cb=>listeners.add(cb)),removeListener:vi.fn(cb=>listeners.delete(cb)),
  emit:(...args)=>Promise.all([...listeners].map(cb=>cb(...args)))};
}
beforeEach(async()=>{
 vi.resetModules();state.store={};state.native=new Map();state.effects=[];
 folder={id:'inbox',accountId:'account',path:'/INBOX',specialUse:['inbox']};
 headers=[{id:1,headerMessageId:'cached@example.test',folder},{id:2,headerMessageId:'orphan@example.test',folder}];
 accounts=[];visible=true;accountEvent=event();folderEvent=event();
 real={
  accounts:{list:vi.fn(async()=>accounts),onCreated:accountEvent},
  folders:{query:vi.fn(async()=>visible?[folder]:[]),onCreated:folderEvent},
  messages:{list:vi.fn(async()=>({messages:headers})),query:vi.fn(async({headerMessageId})=>({messages:headers.filter(h=>h.headerMessageId===headerMessageId)}))},
  tmHdr:{setAction:vi.fn(async(id,a)=>{state.native.set(id,a);return true;}),setActionsBulk:vi.fn(async entries=>{for(const e of entries)state.native.set(e.weMsgId,e.action);state.effects.push('bulk');return entries.length;})},
  tmMessageHeaderChip:{refreshAll:async()=>state.effects.push('chips')},
  tagSort:{refreshImmediate:async()=>state.effects.push('immediate')},
  storage:{local:{get:async()=>({tabmailWelcomeCompleted:true,defaultCalendarId:'synthetic-calendar'})}},
  runtime:{getManifest:()=>({version:'synthetic'})},
 };
 globalThis.browser=real;
 owner=await import('../agent/modules/actionCache.js');
 await owner.setAction(headers[0],'archive');
 expect(state.store['action:account:/INBOX:cached@example.test']).toBe('archive');
 state.native.set(1,'delete');state.native.set(2,'reply');state.effects=[];
});
afterEach(()=>{owner.cleanupActionCache();delete globalThis.browser;});
function startBackground(){
 let source=readFileSync(new URL('../agent/background.js',import.meta.url),'utf8');
 const ast=parse(source,{ecmaVersion:'latest',sourceType:'module'});
 let releaseStartup;const heldStartup=new Promise(resolve=>releaseStartup=resolve);
 const globals={console:{log(){},warn(){},error(){}},Date,performance,window:{},navigator:{},setTimeout:()=>1,clearTimeout(){},setInterval:()=>1,clearInterval(){}};
 for(const entry of ast.body.filter(n=>n.type==='ImportDeclaration').reverse()){
  for(const spec of entry.specifiers){
   const local=spec.local.name;
   globals[local]=entry.source.value==='./modules/actionCache.js' ? owner[spec.imported.name]
    :local==='ensureActionTags'?()=>heldStartup
    :local==='SETTINGS'?{}:local==='idb'?{}:()=>Promise.resolve({});
  }
  source=source.slice(0,entry.start)+source.slice(entry.start,entry.end).replace(/[^\r\n]/g,' ')+source.slice(entry.end);
 }
 function proxy(object={}){return new Proxy(()=>Promise.resolve({}),{get(_target,key){
  if(key==='then')return undefined;
  if(key in object){const value=object[key];return value&&typeof value==='object'?proxy(value):value;}
  if(String(key).startsWith('on'))return {addListener(){},removeListener(){}};
  return proxy();
 }});}
 globals.browser=proxy(real);globalThis.browser=globals.browser;
 globals.__actionCacheInitPromise=null;
 source=source.replace('\ninit();','\n__actionCacheInitPromise = init();');
 vm.runInNewContext(source,globals,{filename:'agent/background.js'});
 return {releaseStartup,initDone:globals.__actionCacheInitPromise};
}
describe('action-cache backfill on real background startup',()=>{
 it.each(['account','folder'])('the first %s event paints cached and orphan actions while startup is held',async kind=>{
  if(kind==='folder')accounts=[{id:'account'}];
  startBackground();
  expect([...state.native]).toEqual([[1,'delete'],[2,'reply']]);
  expect(real.tmHdr.setActionsBulk).not.toHaveBeenCalled();
  accounts=[{id:'account'}];
  await (kind==='account'?accountEvent.emit('account',{id:'account'}):folderEvent.emit(folder));
  expect([...state.native]).toEqual([[1,'archive'],[2,'']]);
  expect(state.effects).toEqual(['bulk','chips','delayed']);
 });
 it('real background startup retries a failed folder add and its live callback repairs paint',async()=>{
  accounts=[{id:'account'}];visible=false;
  folderEvent.addListener.mockImplementationOnce(()=>{throw new Error('synthetic add failure');});
  const app=startBackground();
  // Action backfill and sender-address invalidation each own one early callback.
  expect(accountEvent.addListener).toHaveBeenCalledTimes(2);
  expect(folderEvent.addListener).toHaveBeenCalledOnce();
  expect(folderEvent.listeners.size).toBe(0);
  app.releaseStartup();
  await app.initDone;
  await new Promise(resolve=>setImmediate(resolve));
  expect(real.tmHdr.setActionsBulk).not.toHaveBeenCalled();
  expect([...state.native]).toEqual([[1,'delete'],[2,'reply']]);
  visible=true;
  await folderEvent.emit(folder);
  expect([...state.native]).toEqual([[1,'archive'],[2,'']]);
  expect(state.effects).toEqual(['bulk','chips','delayed']);
  expect(folderEvent.addListener).toHaveBeenCalledTimes(2);
  expect(folderEvent.listeners.size).toBe(1);
 });
});
