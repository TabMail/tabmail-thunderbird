/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it, vi } from 'vitest';
import { experimentFunctions } from './helpers/experimentFunctions.js';
const source = path => new URL(`../${path}`, import.meta.url);
const noop = () => {};

describe('action mutation entry routes',()=>{
 it('awaits the owner before acknowledging clear-action-cache and exposes failures',async()=>{
  let listener,release;
  const clearAllActions=vi.fn(()=>new Promise(r=>{release=r;}));
  const {setupRuntimeMessageListener}=experimentFunctions(source('agent/background.js'),['setupRuntimeMessageListener'],{
   agentRuntimeMessageListener:null,cleanupRuntimeListeners:noop,log:noop,clearAllActions,
   browser:{runtime:{onMessage:{addListener:fn=>{listener=fn;}}}},
  });
  setupRuntimeMessageListener();
  let settled=false;const pending=listener({command:'clear-action-cache'},{}).then(value=>{settled=true;return value;});
  await Promise.resolve();expect(settled).toBe(false);release();
  expect(await pending).toEqual({ok:true});
  clearAllActions.mockRejectedValueOnce(new Error('synthetic removal failure'));
  await expect(listener({command:'clear-action-cache'},{})).rejects.toThrow('synthetic removal failure');
 });
 it('recompute removes all action metadata through the owner',async()=>{
  const clearActions=vi.fn();
  const {clearActionCache}=experimentFunctions(source('agent/modules/contextMenus.js'),['clearActionCache'],{clearActions});
  const header={id:1};await clearActionCache([header,null,{}]);
  expect(clearActions).toHaveBeenCalledExactlyOnceWith([{header}],{metadata:'all'});
 });
 it('a leave-inbox event clears the old inbox identity before deferred cleanup',async()=>{
  const before={id:1,folder:{type:'inbox'},headerMessageId:'synthetic@example.test'};
  const after={...before,id:2,folder:{type:'archive'}};
  let listener;const clearActions=vi.fn();
  const {attachOnMovedListeners}=experimentFunctions(source('agent/modules/onMoved.js'),['attachOnMovedListeners'],{
   _onMovedHandler:null,log:noop,logMoveEvent:noop,logMessageEvent:noop,_warmIndex:noop,
   _extractListsFromArgs:()=>({details:{},items:[],hasTwoLists:true,beforeList:[before],afterList:[after]}),
   updateHeaderIndexForMovedMessage:async()=>{},isInboxFolder:f=>f.type==='inbox',
   getUniqueMessageKey:async h=>h===before?'account:/INBOX:synthetic@example.test':'account:/Archive:synthetic@example.test',
   clearActions,recomputeThreadForInboxMessage:async()=>{},
   browser:{messages:{onMoved:{addListener:fn=>{listener=fn;}}}},
  });
  attachOnMovedListeners();await listener();
  expect(clearActions).toHaveBeenCalledWith([{uniqueKey:'account:/INBOX:synthetic@example.test'}]);
 });
});
