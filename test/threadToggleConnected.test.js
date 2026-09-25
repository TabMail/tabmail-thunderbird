/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ store: {}, native: new Map(), events: [], query: vi.fn(), resolve: vi.fn(), remove: vi.fn(), sort: vi.fn() }));
vi.mock('../agent/modules/idbStorage.js', () => ({
 get: async keys => Object.fromEntries((Array.isArray(keys)?keys:[keys]).filter(k=>k in h.store).map(k=>[k,h.store[k]])),
 set: async values => { h.events.push('commit'); Object.assign(h.store, values); },
 remove: async keys => { await h.remove(); h.events.push('commit'); for(const k of keys) delete h.store[k]; },
 clear: async () => { h.store={}; }, getAllKeys: async()=>Object.keys(h.store),
 purgeOlderThanByPrefixes: vi.fn(),
}));
vi.mock('../agent/modules/utils.js', () => ({
 getUniqueMessageKey: async m => { if (typeof m === 'number') m = await browser.messages.get(m); return m?.folder ? `${m.folder.accountId}:${m.folder.path}:${m.headerMessageId}` : null; },
 resolveUniqueMessageKey: (...args)=>h.resolve(...args), log: vi.fn(), indexHeader: vi.fn(), extractBodyFromParts:async()=>'', stripHtml:x=>x, safeGetFull:async()=>({body:'synthetic body'}), saveChatLog:vi.fn(), getRealSubject:async()=> 'Synthetic subject', getUniqueMessageKeyCandidates:()=>[],
}));
vi.mock('../agent/modules/config.js', () => ({ SETTINGS: { actionTagging:{actionPriority:{reply:3,archive:2,delete:1,none:0}} } }));
vi.mock('../agent/modules/tagDefs.js', () => ({triggerSortRefresh:()=>{h.events.push('sort');h.sort();},ACTION_TAG_IDS:{},isDebugTagRaceEnabled:()=>false,maxPriorityAction: actions=>['reply','archive','delete','none'].find(a=>actions.includes(a))}));
const folder={id:'inbox',accountId:'acc',path:'/INBOX',specialUse:['inbox']};
const header={id:1,headerMessageId:'synthetic@example.test',folder};
const key='acc:/INBOX:synthetic@example.test';
let owner;
beforeEach(async()=>{
 vi.resetModules(); vi.useFakeTimers(); h.store={};h.native=new Map();h.events=[];h.sort.mockClear();h.remove.mockReset();h.query.mockReset();h.resolve.mockReset();
 h.query.mockResolvedValue({messages:[header,{...header,id:2}]});
 h.resolve.mockResolvedValue({status:'resolved',weIds:[1,2],folder});
 globalThis.browser={messages:{query:h.query,get:async()=>header},tmHdr:{setAction:async(id,a)=>{h.events.push(`paint:${id}:${a}`);h.native.set(id,a);return true;}},tmMessageHeaderChip:{refreshAll:async()=>h.events.push('chips')},tmMultiMessageChip:{refreshAll:async()=>{}},folders:{query:async()=>[folder]},accounts:{list:async()=>[]}};
 owner=await import('../agent/modules/actionCache.js');
});
afterEach(()=>{owner.cleanupActionCache?.();vi.clearAllTimers();vi.useRealTimers();});

const dependencies=vi.hoisted(()=>({reply:vi.fn(),chat:vi.fn(),peer:vi.fn(),summary:vi.fn(),internal:vi.fn()}));
vi.mock('../chat/modules/helpers.js',()=>({getUserName:async()=> 'Example User'}));
vi.mock('../agent/modules/summaryGenerator.js',()=>({getSummary:(...a)=>dependencies.summary(...a),purgeExpiredSummaryEntries:async()=>{}}));
vi.mock('../agent/modules/messagePrefilter.js',()=>({analyzeEmailForReplyFilter:async()=>({skipCachedReply:false})}));
vi.mock('../agent/modules/senderFilter.js',()=>({isInternalSender:(...a)=>dependencies.internal(...a)}));
vi.mock('../agent/modules/replyGenerator.js',()=>({createReply:(...args)=>dependencies.reply(...args),purgeExpiredReplyEntries:async()=>{}}));
const thread=vi.hoisted(()=>({ids:[],headers:new Map()}));
vi.mock('../agent/modules/promptGenerator.js',()=>({getUserActionPrompt:async()=>''}));
vi.mock('../agent/modules/deviceSync.js',()=>({probeAICache:(...a)=>dependencies.peer(...a)}));
vi.mock('../agent/modules/llm.js',()=>({sendChat:(...args)=>dependencies.chat(...args),processJSONResponse:JSON.parse}));
vi.mock('../agent/modules/proactiveCheckin.js',()=>({onInboxUpdated:async()=>{}}));

beforeEach(async()=>{
 dependencies.reply.mockReset().mockResolvedValue({});
 dependencies.chat.mockReset().mockResolvedValue({assistant:'{"action":"archive"}'});
 dependencies.peer.mockReset().mockResolvedValue(null);
 dependencies.summary.mockReset().mockResolvedValue({id:key,blurb:'Synthetic summary',todos:''});
 dependencies.internal.mockReset().mockResolvedValue(false);
 const {SETTINGS}=await import('../agent/modules/config.js');
 SETTINGS.actionGenerationParallelCalls=1;
 SETTINGS.agentQueues={processMessage:{watchIntervalMs:0,kickDelayMs:-1,persistDebounceMs:0,batchSize:100,retryDelayMs:10000,itemTimeoutMs:120000}};
 browser.storage={local:{get:async()=>({}),set:async()=>{}}};
});
const waitStarted=async f=>{for(let n=0;n<250&&!f();n++)await Promise.resolve();expect(f()).toBeTruthy();};

const actionFor=m=>'action:'+`${m.folder.accountId}:${m.folder.path}:${m.headerMessageId}`;
beforeEach(()=>{
 thread.ids=[];thread.headers=new Map();
 browser.messages.get=async id=>thread.headers.get(id);
 h.query.mockImplementation(async q=>({messages:[...thread.headers.values()].filter(x=>x.folder.id===(Array.isArray(q.folderId)?q.folderId[0]:q.folderId)&&x.headerMessageId===q.headerMessageId)}));
});

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
const settle=async()=>{await vi.advanceTimersByTimeAsync(0);for(let i=0;i<100;i++)await Promise.resolve();};
async function startConnectedAgent() {
 const tagHelper=await import('../agent/modules/tagHelper.js');
 let releaseStartup;
 const gate=new Promise(resolve=>{releaseStartup=resolve;});
 const originalBrowser=globalThis.browser;
 const source=readFileSync(new URL('../agent/background.js',import.meta.url),'utf8');
 const ast=parse(source,{ecmaVersion:'latest',sourceType:'module'});
 let script=source;
 const globals={console:{log(){},warn(){},error(){}},Date,performance,window:{},navigator:{},setTimeout:()=>1,clearTimeout(){},setInterval:()=>1,clearInterval(){}};
 for(const entry of ast.body.filter(n=>n.type==='ImportDeclaration').reverse()) {
  for(const specifier of entry.specifiers) {
   const name=specifier.local.name;
   globals[name]=name==='ensureActionTags'?()=>gate
    :entry.source.value==='./modules/tagHelper.js'?tagHelper[specifier.imported.name]
    :name==='SETTINGS'?{}:name==='idb'?{}:()=>Promise.resolve({});
  }
  script=script.slice(0,entry.start)+script.slice(entry.start,entry.end).replace(/[^\r\n]/g,' ')+script.slice(entry.end);
 }
 function api(path='browser',concrete=originalBrowser) {
  return new Proxy(()=>Promise.resolve({}),{get(_t,key){
   if(key==='then')return undefined;
   if(concrete?.[key]!==undefined){const value=concrete[key];return typeof value==='object'?api(path+'.'+String(key),value):value;}
   if(String(key).startsWith('on'))return {addListener(){},removeListener(){}};
   if(key==='getManifest')return()=>({version:'synthetic'});
   return api(path+'.'+String(key),null);
  }});
 }
 globals.browser=api();globalThis.browser=globals.browser;
 vm.runInNewContext(script,globals,{filename:'review-thread-toggle-connected-background.js'});
 return {releaseStartup,originalBrowser};
}

it.each([true,false])('first setting event before startup completion changes real durable/native effects (%s)',async enabled=>{
 await exerciseFirstToggle(enabled,false);
});
it.each([true,false])('failed early attachment retries and then changes real durable/native effects (%s)',async enabled=>{
 await exerciseFirstToggle(enabled,true);
});
async function exerciseFirstToggle(enabled,failFirst) {
 const one={...header,id:1,headerMessageId:'one@example.test'},two={...header,id:2,headerMessageId:'two@example.test'},unrelated={...header,id:9,headerMessageId:'unrelated@example.test'};
 for(const x of [one,two,unrelated])thread.headers.set(x.id,x);
 browser.accounts.list=async()=>[{id:'acc',rootFolder:{id:'root',accountId:'acc',path:'/'}}];
 browser.folders.getSubFolders=async()=>[folder];
 browser.messages.list=vi.fn(async()=>({messages:[one,two]}));
 browser.messages.update=vi.fn();browser.messages.move=vi.fn();browser.messages.delete=vi.fn();
 browser.glodaSearch={getConversationMessages:vi.fn(async()=>({success:true,conversationId:'synthetic-thread',messages:[one,two]}))};
 let stored=!enabled;
 browser.storage.local.get=async()=>({tagByThreadEnabled:stored});
 const listeners=new Set();
 browser.storage.onChanged={addListener:vi.fn(fn=>listeners.add(fn)),removeListener:vi.fn(fn=>listeners.delete(fn))};
 if(failFirst)browser.storage.onChanged.addListener.mockImplementationOnce(()=>{throw new Error('synthetic first registration failure');});
 await owner.setAction(one,'none');await owner.setAction(two,'reply');await owner.setAction(unrelated,'delete');
 expect([h.store[actionFor(one)],h.store[actionFor(two)],h.native.get(1),h.native.get(2)]).toEqual(['none','reply','none','reply']);
 expect(h.store['threadTags:acc:/INBOX:glodaConv:synthetic-thread']).toBeUndefined();
 const app=await startConnectedAgent();
 if(failFirst){expect(listeners.size).toBe(0);app.releaseStartup();await settle();}
 stored=enabled;
 for(const fn of listeners)fn({tagByThreadEnabled:{oldValue:!enabled,newValue:enabled}},'local');
 await settle();
 expect(h.store['threadTags:acc:/INBOX:glodaConv:synthetic-thread']?.weIds).toEqual([1,2]);
 expect([h.store[actionFor(one)],h.store[actionFor(two)]]).toEqual([enabled?'reply':'none','reply']);
 expect([h.native.get(1),h.native.get(2)]).toEqual([enabled?'reply':'none','reply']);
 expect(h.store[actionFor(unrelated)]).toBe('delete');expect(h.native.get(9)).toBe('delete');
 expect(app.originalBrowser.messages.update).not.toHaveBeenCalled();expect(app.originalBrowser.messages.move).not.toHaveBeenCalled();expect(app.originalBrowser.messages.delete).not.toHaveBeenCalled();
 expect(listeners.size).toBe(1);
 expect(app.originalBrowser.storage.onChanged.addListener).toHaveBeenCalledTimes(failFirst?2:1);
 const before=JSON.stringify(h.store);app.releaseStartup();await settle();
 expect(listeners.size).toBe(1);expect(JSON.stringify(h.store)).toBe(before);
 globalThis.browser=app.originalBrowser;
}
