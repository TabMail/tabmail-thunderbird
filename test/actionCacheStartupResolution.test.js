/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'acorn';
const state=vi.hoisted(()=>({values:{},events:[]}));
vi.mock('../agent/modules/idbStorage.js',()=>({
 get:async keys=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).filter(k=>k in state.values).map(k=>[k,state.values[k]])),
 set:async values=>Object.assign(state.values,values),remove:async keys=>{for(const k of keys)delete state.values[k];},getAllKeys:async()=>Object.keys(state.values),
}));
vi.mock('../agent/modules/utils.js',()=>({getUniqueMessageKey:async h=>`${h.folder.accountId}:${h.folder.path}:${h.headerMessageId}`,resolveUniqueMessageKey:vi.fn(),log:vi.fn()}));
vi.mock('../agent/modules/config.js',()=>({SETTINGS:{actionCache:{repairDebounceMs:100}}}));
vi.mock('../agent/modules/tagDefs.js',()=>({triggerSortRefresh:()=>state.events.push('delayed'),maxPriorityAction:vi.fn()}));
let owner,folder,headers,accountCreated,folderCreated;
const event=()=>({addListener:vi.fn(),removeListener:vi.fn()});
beforeEach(async()=>{
 vi.resetModules();vi.useFakeTimers();state.values={};state.events=[];
 folder={id:'nested-inbox',accountId:'account',path:'/Parent/Inbox:📨Café',specialUse:['inbox']};
 headers=[{id:1,headerMessageId:'sender@[IPv6:2001:db8::1]',folder},{id:2,headerMessageId:'orphan@example.test',folder}];
 accountCreated=event();folderCreated=event();
 globalThis.browser={accounts:{list:vi.fn(async()=>[{id:'account'}]),onCreated:accountCreated},folders:{query:vi.fn(async()=>[folder]),onCreated:folderCreated},messages:{list:vi.fn(async()=>({messages:headers})),query:vi.fn(async({headerMessageId})=>({messages:headers.filter(h=>h.headerMessageId===headerMessageId)}))},tmHdr:{setActionsBulk:vi.fn(async entries=>{state.events.push(entries);return entries.length;}),setAction:vi.fn(async()=>true)},tmMessageHeaderChip:{refreshAll:async()=>state.events.push('chips')},tagSort:{refreshImmediate:async()=>state.events.push('immediate')}};
 owner=await import('../agent/modules/actionCache.js');
});
afterEach(()=>{owner.cleanupActionCache();vi.useRealTimers();});
describe('symmetric inbox backfill',()=>{
 it('registers the real backfill owner before background startup and handles a first folder event once',async()=>{
  const source=readFileSync(new URL('../agent/background.js',import.meta.url),'utf8');
  const calls=parse(source,{ecmaVersion:'latest',sourceType:'module'}).body
   .filter(node=>node.type==='ExpressionStatement'&&node.expression?.type==='CallExpression')
   .map(node=>({name:node.expression.callee?.name,at:node.start}));
  expect(calls.find(call=>call.name==='attachActionCacheBackfillListeners')?.at)
   .toBeLessThan(calls.find(call=>call.name==='init')?.at);

  state.values[`action:account:${folder.path}:${headers[0].headerMessageId}`]='archive';
  owner.attachActionCacheBackfillListeners();
  owner.attachActionCacheBackfillListeners();
  expect(accountCreated.addListener).toHaveBeenCalledOnce();
  expect(folderCreated.addListener).toHaveBeenCalledOnce();

  await folderCreated.addListener.mock.calls[0][0]();
  expect(state.events).toEqual([[{weMsgId:1,action:'archive'},{weMsgId:2,action:''}],'chips','delayed']);
  await owner.pushAllActionsToExperimentsOnStartup();
  expect(accountCreated.addListener).toHaveBeenCalledOnce();
  expect(folderCreated.addListener).toHaveBeenCalledOnce();
  expect(browser.tmHdr.setActionsBulk).toHaveBeenCalledOnce();
 });
 it('repairs cached and orphan actions on the first account-created event',async()=>{
  state.values[`action:account:${folder.path}:${headers[0].headerMessageId}`]='archive';
  owner.attachActionCacheBackfillListeners();
  expect(browser.accounts.list).not.toHaveBeenCalled();
  await accountCreated.addListener.mock.calls[0][0]('account',{id:'account'});
  expect(browser.tmHdr.setActionsBulk).toHaveBeenCalledExactlyOnceWith([
   {weMsgId:1,action:'archive'},{weMsgId:2,action:''},
  ]);
  expect(state.events.slice(1)).toEqual(['chips','delayed']);
 });
 it('retries a failed folder registration through startup without duplicating the account listener',async()=>{
  state.values[`action:account:${folder.path}:${headers[0].headerMessageId}`]='archive';
  folderCreated.addListener.mockImplementationOnce(()=>{throw new Error('synthetic add failure');});
  owner.attachActionCacheBackfillListeners();
  expect(accountCreated.addListener).toHaveBeenCalledOnce();
  expect(folderCreated.addListener).toHaveBeenCalledOnce();
  browser.folders.query.mockResolvedValueOnce([]);
  await owner.pushAllActionsToExperimentsOnStartup();
  expect(accountCreated.addListener).toHaveBeenCalledOnce();
  expect(folderCreated.addListener).toHaveBeenCalledTimes(2);
  await folderCreated.addListener.mock.calls[1][0](folder);
  expect(browser.tmHdr.setActionsBulk).toHaveBeenCalledExactlyOnceWith([
   {weMsgId:1,action:'archive'},{weMsgId:2,action:''},
  ]);
 });
 it('retries a failed add without duplicating the other owner and retains failed removal ownership',async()=>{
  accountCreated.addListener.mockImplementationOnce(()=>{throw new Error('synthetic add failure');});
  owner.attachActionCacheBackfillListeners();
  expect(accountCreated.addListener).toHaveBeenCalledOnce();
  expect(folderCreated.addListener).toHaveBeenCalledOnce();
  owner.attachActionCacheBackfillListeners();
  expect(accountCreated.addListener).toHaveBeenCalledTimes(2);
  expect(folderCreated.addListener).toHaveBeenCalledOnce();

  folderCreated.removeListener.mockImplementationOnce(()=>{throw new Error('synthetic remove failure');});
  owner.cleanupActionCache();
  owner.attachActionCacheBackfillListeners();
  expect(accountCreated.addListener).toHaveBeenCalledTimes(3);
  expect(folderCreated.addListener).toHaveBeenCalledOnce();
 });
 it('preserves colon-bearing folder and Message-ID while clearing native orphans',async()=>{
  state.values[`action:account:${folder.path}:${headers[0].headerMessageId}`]='archive';
  await owner.pushAllActionsToExperimentsOnStartup();
  expect(state.events).toEqual([[{weMsgId:1,action:'archive'},{weMsgId:2,action:''}],'chips','immediate']);
  expect(browser.messages.list).toHaveBeenCalledWith(folder.id);
 });
 it('scans inboxes even when IDB is empty and never scans other folders',async()=>{
  browser.folders.query.mockResolvedValue([folder,{id:'sent',specialUse:['sent']}]);
  await owner.pushAllActionsToExperimentsOnStartup();
  expect(browser.messages.list).toHaveBeenCalledExactlyOnceWith(folder.id);
  expect(browser.tmHdr.setActionsBulk).toHaveBeenCalledWith([{weMsgId:1,action:''},{weMsgId:2,action:''}]);
 });
 it('registers creation listeners before inventory and retries an inbox arriving later',async()=>{
  browser.folders.query.mockResolvedValue([]);
  browser.accounts.list.mockImplementation(async()=>{expect(accountCreated.addListener).toHaveBeenCalled();expect(folderCreated.addListener).toHaveBeenCalled();return [{id:'account'}];});
  await owner.pushAllActionsToExperimentsOnStartup();
  expect(browser.messages.list).not.toHaveBeenCalled();
  browser.folders.query.mockResolvedValue([folder]);headers=[];
  await folderCreated.addListener.mock.calls[0][0]();
  expect(browser.messages.list).toHaveBeenCalledOnce();
  expect(state.events).toEqual(['chips','delayed']);
  await accountCreated.addListener.mock.calls[0][0]();
  expect(browser.messages.list).toHaveBeenCalledOnce();
 });
 it('does not turn persistent bulk failure into an autonomous retry loop',async()=>{
  browser.tmHdr.setActionsBulk.mockResolvedValue(0);
  await owner.pushAllActionsToExperimentsOnStartup();
  await vi.advanceTimersByTimeAsync(10000);
  expect(browser.tmHdr.setActionsBulk).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
 });
 it('removes creation listeners on suspend',async()=>{
  browser.tmHdr.setActionsBulk.mockResolvedValue(0);
  await owner.pushAllActionsToExperimentsOnStartup();owner.cleanupActionCache();
  await vi.advanceTimersByTimeAsync(1000);
  expect(browser.tmHdr.setActionsBulk).toHaveBeenCalledOnce();
  expect(folderCreated.removeListener).toHaveBeenCalledWith(folderCreated.addListener.mock.calls[0][0]);
 });
});
