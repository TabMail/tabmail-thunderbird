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
const { attachOnUpdatedListener, cleanupOnMovedListeners } = moved;
import { _testExports, disposeIncrementalIndexer } from '../fts/incrementalIndexer.js';
const settle=async()=>{for(let i=0;i<10;i++)await new Promise(resolve=>setImmediate(resolve));};
let listeners,stored,rows;
const folder={id:'inbox',accountId:'synthetic-account',path:'/INBOX'};
const virtual={id:'starred',accountId:'synthetic-account',path:'/[Gmail]/Starred',name:'Starred'};
const indexKey='synthetic-account:/[Gmail]/Starred:second@example.test';
beforeEach(()=>{
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});vi.clearAllMocks();
 listeners=new Set();stored={};rows=new Map([[41,{id:41,folder,headerMessageId:'first@example.test'}],[42,{id:42,folder,headerMessageId:'second@example.test'}]]);
 const folderRows=[...rows.values(),{id:142,folder:virtual,headerMessageId:'second@example.test'}];
 globalThis.browser={messages:{
  onUpdated:{addListener:vi.fn(fn=>listeners.add(fn)),removeListener:vi.fn(fn=>listeners.delete(fn))},
  get:vi.fn(async id=>structuredClone(rows.get(id))),
  query:vi.fn(async q=>({messages:folderRows.filter(msg=>
   msg.headerMessageId===q.headerMessageId && q.folderId?.includes(msg.folder.id))})),
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
function startActualAgent(){
 let releaseStartup;
 const startupGate=new Promise(resolve=>{releaseStartup=resolve;});
 const originalBrowser=globalThis.browser;
 const source=readFileSync(new URL('../agent/background.js',import.meta.url),'utf8');
 const ast=parse(source,{ecmaVersion:'latest',sourceType:'module'});
 let script=source;
 const globals={console:{log(){},warn(){},error(){}},Date,performance,window:{},navigator:{},setTimeout:()=>1,clearTimeout(){},setInterval:()=>1,clearInterval(){}};
 for(const entry of ast.body.filter(n=>n.type==='ImportDeclaration').reverse()){
  for(const specifier of entry.specifiers){
   const name=specifier.local.name;
   globals[name]=entry.source.value==='./modules/onMoved.js'?moved[name]:name==='SETTINGS'?{}:name==='idb'?{}:name==='ensureActionTags'?()=>startupGate:()=>Promise.resolve({});
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
 return {releaseStartup,originalBrowser};
}

it('primes the listener before agent startup and queues a Gmail member with ready FTS',async()=>{
 const app=startActualAgent();
 expect(listeners.size).toBe(1);
 await emit({id:41},{flagged:true});
 expect([..._testExports._getPendingUpdates().keys()]).toEqual([]);
 await emit({id:42},{flagged:true});
 expect([..._testExports._getPendingUpdates().keys()]).toEqual([indexKey]);
 await vi.advanceTimersByTimeAsync(2000);
 expect(stored.fts_pending_updates).toEqual([expect.objectContaining({
  uniqueKey:indexKey,type:'new',folderKey:'synthetic-account:/[Gmail]/Starred',
 })]);
 expect(app.originalBrowser.messages.get).toHaveBeenCalledWith(42);
 expect(app.originalBrowser.messages.update).not.toHaveBeenCalled();
 expect(app.originalBrowser.messages.move).not.toHaveBeenCalled();
 expect(app.originalBrowser.messages.delete).not.toHaveBeenCalled();
 globalThis.browser=app.originalBrowser;
});

it('real late initialization retries a failed primed registration', async () => {
  browser.messages.onUpdated.addListener.mockImplementationOnce(() => {
    throw new Error('synthetic registration failure');
  });
  const app=startActualAgent();
  expect(listeners.size).toBe(0);
  app.releaseStartup();
  await settle();
  expect(listeners.size).toBe(1);
  expect(app.originalBrowser.messages.onUpdated.addListener).toHaveBeenCalledTimes(2);
  await emit({ id: 42 }, { flagged: true });
  expect([..._testExports._getPendingUpdates().keys()]).toEqual([indexKey]);
  await vi.advanceTimersByTimeAsync(2000);
  expect(stored.fts_pending_updates).toEqual([expect.objectContaining({uniqueKey:indexKey,type:'new'})]);
  expect(app.originalBrowser.messages.update).not.toHaveBeenCalled();
  expect(app.originalBrowser.messages.move).not.toHaveBeenCalled();
  expect(app.originalBrowser.messages.delete).not.toHaveBeenCalled();
  globalThis.browser=app.originalBrowser;
});

it('retains failed indexing work when the same member is updated again',async()=>{
  attachOnUpdatedListener();
  await emit({id:42});
  const failed=_testExports._markResolveFailed(_testExports._getPendingUpdates().get(indexKey));
  expect(failed.hasFailed).toBe(true);
  await emit({id:42});
  expect(_testExports._getPendingUpdates().get(indexKey)).toMatchObject({
    type:'new',hasFailed:true,lastFailedAt:failed.lastFailedAt,
  });
  await disposeIncrementalIndexer();
  expect(stored.fts_pending_updates).toEqual([expect.objectContaining({
    uniqueKey:indexKey,type:'new',folderKey:'synthetic-account:/[Gmail]/Starred',
    hasFailed:true,lastFailedAt:failed.lastFailedAt,
  })]);
});
