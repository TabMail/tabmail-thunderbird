/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {beforeEach,it,expect,vi} from 'vitest';
const h=vi.hoisted(()=>({store:{}}));
vi.mock('../agent/modules/idbStorage.js',()=>({get:async keys=>Object.fromEntries([].concat(keys).filter(k=>k in h.store).map(k=>[k,h.store[k]])),set:async values=>Object.assign(h.store,values),remove:async keys=>{for(const k of [].concat(keys))delete h.store[k];},getAllKeys:async()=>Object.keys(h.store)}));
vi.mock('../agent/modules/config.js',()=>({SETTINGS:{actionTTLSeconds:604800,verboseLogging:false}}));
vi.mock('../agent/modules/tagDefs.js',()=>({triggerSortRefresh:vi.fn(),maxPriorityAction:vi.fn()}));
vi.mock('../chat/modules/helpers.js',()=>({getUserName:async()=> 'Example User'}));
vi.mock('../agent/modules/quoteAndSignature.js',()=>({}));
vi.mock('../agent/modules/llm.js',()=>({sendChat:vi.fn(),processJSONResponse:JSON.parse}));
vi.mock('../agent/modules/summaryGenerator.js',()=>({getSummary:vi.fn()}));
vi.mock('../agent/modules/messagePrefilter.js',()=>({analyzeEmailForReplyFilter:vi.fn()}));
vi.mock('../agent/modules/promptGenerator.js',()=>({getUserActionPrompt:vi.fn()}));
vi.mock('../agent/modules/senderFilter.js',()=>({isInternalSender:vi.fn()}));
vi.mock('../agent/modules/tagHelper.js',()=>({isMessageInInboxByUniqueKey:async()=>false}));
beforeEach(()=>{h.store={};globalThis.browser={folders:{query:vi.fn(async()=>[])},messages:{query:async()=>({messages:[]})},tmHdr:{setAction:async()=>true}};});
it('expired actions from removed accounts expire independently of folder inventory',async()=>{
 const owner=await import('../agent/modules/actionCache.js');
 const {purgeExpiredActionEntries}=await import('../agent/modules/actionGenerator.js');
 const key='account:/INBOX:retention@example.test';
 const now=Date.now;let taskTime=now();Date.now=()=>taskTime;
 try{
  await owner.setAction({id:1,headerMessageId:'retention@example.test',folder:{id:'folder',accountId:'account',path:'/INBOX'}},'archive');
  expect(h.store['action:'+key]).toBe('archive');
  taskTime+=30*86400000;
  await owner.setAction({id:2,headerMessageId:'fresh@example.test',folder:{id:'folder',accountId:'account',path:'/INBOX'}},'reply');
  await purgeExpiredActionEntries();
  expect(h.store['action:'+key]).toBeUndefined();
  expect(h.store['action:ts:'+key]).toBeUndefined();
  expect(h.store['action:account:/INBOX:fresh@example.test']).toBe('reply');
  expect(h.store['action:ts:account:/INBOX:fresh@example.test'].ts).toBe(taskTime);
 } finally {Date.now=now;}
});
