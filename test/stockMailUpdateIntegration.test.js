import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../agent/modules/actionCache.js', () => ({clearActions:vi.fn()}));
vi.mock('../agent/modules/autoUpdateUserPrompt.js', () => ({autoUpdateUserPromptOnMove:vi.fn()}));
vi.mock('../agent/modules/config.js', () => ({SETTINGS:{agentQueues:{ftsIncremental:{}}}}));
vi.mock('../agent/modules/eventLogger.js', () => ({logMessageEvent:vi.fn(),logMoveEvent:vi.fn(),logMessageEventBatch:vi.fn(),logFtsBatchOperation:vi.fn(),logFtsOperation:vi.fn()}));
vi.mock('../agent/modules/folderUtils.js', () => ({getAllFoldersForAccount:vi.fn(),isInboxFolder:vi.fn()}));
vi.mock('../agent/modules/gmailLabelSync.js', () => ({removeTmLabelsFromGmailMessage:vi.fn()}));
vi.mock('../agent/modules/idbStorage.js', () => ({}));
vi.mock('../agent/modules/inboxContext.js', () => ({getInboxForAccount:vi.fn()}));
vi.mock('../agent/modules/tagHelper.js', () => ({ACTION_TAG_IDS:{},recomputeThreadForInboxMessage:vi.fn()}));
vi.mock('../agent/modules/utils.js', () => ({
 clearAlarm:vi.fn(async()=>{}),ensureAlarm:vi.fn(),getArchiveFolderForHeader:vi.fn(),getTrashFolderForHeader:vi.fn(),
 getUniqueMessageKey:vi.fn(async m=>`${m.folder.accountId}:${m.folder.path}:${m.headerMessageId}`),
 indexHeader:vi.fn(),log:vi.fn(),removeHeaderIndexForDeletedMessage:vi.fn(),updateHeaderIndexForMovedMessage:vi.fn(),
 getForegroundFetchPressure:vi.fn(()=>({active:0,waiting:0,chatTyping:false})),getUniqueMessageKeyCandidates:vi.fn(),headerIDToWeID:vi.fn(),parseUniqueId:vi.fn(),recheckMessageInFolder:vi.fn(),resolveUniqueMessageKey:vi.fn()
}));
vi.mock('../fts/indexer.js', () => ({buildBatchHeader:vi.fn(),populateBatchBody:vi.fn()}));
import * as moved from '../agent/modules/onMoved.js';
const { attachOnUpdatedListener, attachOnMovedListeners, cleanupOnMovedListeners } = moved;
import { _testExports } from '../fts/incrementalIndexer.js';
import { log } from '../agent/modules/utils.js';
const settle=async()=>{for(let i=0;i<10;i++)await new Promise(resolve=>setImmediate(resolve));};
let listeners,stored,rows;
const folder={id:'inbox',accountId:'synthetic-account',path:'/INBOX'};
const virtual={id:'starred',accountId:'synthetic-account',path:'/[Gmail]/Starred',name:'Starred'};
beforeEach(()=>{
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});vi.clearAllMocks();
 listeners=new Set();stored={};rows=new Map([[41,{id:41,folder,headerMessageId:'first@example.test'}],[42,{id:42,folder,headerMessageId:'second@example.test'}]]);
 globalThis.browser={messages:{
  onUpdated:{addListener:vi.fn(fn=>listeners.add(fn)),removeListener:vi.fn(fn=>listeners.delete(fn))},
  get:vi.fn(async id=>structuredClone(rows.get(id))),
  query:vi.fn(async q=>({messages:[{id:q.headerMessageId==='first@example.test'?141:142,folder:virtual,headerMessageId:q.headerMessageId}]})),
  update:vi.fn(),move:vi.fn(),delete:vi.fn()
 },accounts:{list:vi.fn(async()=>[{id:folder.accountId,rootFolder:{id:'root'}}])},
 folders:{getSubFolders:vi.fn(async id=>id==='root'?[{id:'gmail',name:'[Gmail]'}]:[virtual])},
 storage:{local:{get:vi.fn(async key=>typeof key==='string'?{[key]:stored[key]}:{...key,...stored}),set:vi.fn(async val=>Object.assign(stored,structuredClone(val)))}}};
 _testExports._setIsEnabled(true);_testExports._setFtsSearch({});_testExports._getPendingUpdates().clear();
});
afterEach(()=>{cleanupOnMovedListeners();_testExports._getPendingUpdates().clear();vi.clearAllTimers();vi.useRealTimers();delete globalThis.browser;});
async function emit(value={id:41},changed={flagged:true}){for(const fn of listeners)fn(value,changed);await settle();}

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
it('a message update is subscribed before startup resolves and reaches durable FTS work',async()=>{
 const originalBrowser=globalThis.browser;
 const source=readFileSync(new URL('../agent/background.js',import.meta.url),'utf8');
 const ast=parse(source,{ecmaVersion:'latest',sourceType:'module'});
 let script=source;
 const globals={console:{log(){},warn(){},error(){}},Date,performance,window:{},navigator:{},setTimeout:()=>1,clearTimeout(){},setInterval:()=>1,clearInterval(){}};
 for(const entry of ast.body.filter(n=>n.type==='ImportDeclaration').reverse()){
  for(const specifier of entry.specifiers){
   const name=specifier.local.name;
   globals[name]=entry.source.value==='./modules/onMoved.js'?moved[name]:name==='SETTINGS'?{}:name==='idb'?{}:name==='ensureActionTags'?()=>new Promise(()=>{}):()=>Promise.resolve({});
  }
  script=script.slice(0,entry.start)+script.slice(entry.start,entry.end).replace(/[^\r\n]/g,' ')+script.slice(entry.end);
 }
 const events=new Map();
 function api(path='browser',concrete=originalBrowser){
  return new Proxy(()=>Promise.resolve({}),{get(_t,key){
   if(key==='then')return undefined;
   if(concrete?.[key]!==undefined){const value=concrete[key];return typeof value==='object'?api(path+'.'+key,value):value;}
   if(String(key).startsWith('on')){const id=path+'.'+key;if(!events.has(id))events.set(id,{addListener(){},removeListener(){}});return events.get(id);}
   if(key==='getManifest')return()=>({version:'synthetic'});
   return api(path+'.'+String(key),null);
  }});
 }
 globals.browser=api();globalThis.browser=globals.browser;
 vm.runInNewContext(script,globals,{filename:'review-agent-startup.js'});
 expect(listeners.size).toBe(1);
 await emit({id:41},{flagged:true});
 expect([..._testExports._getPendingUpdates().keys()]).toEqual(['synthetic-account:/[Gmail]/Starred:first@example.test']);
 await vi.advanceTimersByTimeAsync(2000);
 expect(stored.fts_pending_updates.map(x=>x.uniqueKey)).toEqual(['synthetic-account:/[Gmail]/Starred:first@example.test']);
 expect(originalBrowser.messages.update).not.toHaveBeenCalled();
 expect(originalBrowser.messages.move).not.toHaveBeenCalled();
 expect(originalBrowser.messages.delete).not.toHaveBeenCalled();
 globalThis.browser=originalBrowser;
});

it('late initialization retries a failed primed registration and processes the next update', async () => {
  browser.messages.onUpdated.addListener.mockImplementationOnce(() => {
    throw new Error('synthetic registration failure');
  });
  attachOnUpdatedListener();
  expect(listeners.size).toBe(0);

  attachOnMovedListeners();
  expect(listeners.size).toBe(1);
  await emit({ id: 41 }, { flagged: true });
  expect([..._testExports._getPendingUpdates().keys()]).toEqual([
    'synthetic-account:/[Gmail]/Starred:first@example.test',
  ]);
  await vi.advanceTimersByTimeAsync(2000);
  expect(stored.fts_pending_updates.map(item => item.uniqueKey)).toEqual([
    'synthetic-account:/[Gmail]/Starred:first@example.test',
  ]);
  expect(browser.messages.update).not.toHaveBeenCalled();
  expect(browser.messages.move).not.toHaveBeenCalled();
  expect(browser.messages.delete).not.toHaveBeenCalled();
});
