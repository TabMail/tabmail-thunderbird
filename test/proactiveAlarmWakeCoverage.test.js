/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';

vi.mock('../agent/modules/config.js', () => ({ SETTINGS: { notifications: {} } }));
vi.mock('../agent/modules/utils.js', () => ({ log: vi.fn() }));
vi.mock('../agent/modules/reminderStateStore.js', () => ({ hashReminder: r => r.hash, getDisabledHashes: async () => new Set() }));
vi.mock('../agent/modules/reminderBuilder.js', () => ({ buildReminderList: vi.fn(async () => ({ reminders: [] })) }));
vi.mock('../chat/modules/helpers.js', () => ({ getUserName: async () => 'Reader' }));
vi.mock('../chat/modules/chatWindowUtils.js', () => ({ isChatWindowOpen: vi.fn(async () => false), openOrFocusChatWindow: vi.fn(async () => {}) }));
vi.mock('../agent/modules/promptGenerator.js', () => ({ getUserKBPrompt: vi.fn(async () => '') }));
vi.mock('../chat/modules/markdown.js', () => ({ renderMarkdown: async s => s }));
vi.mock('../agent/modules/llm.js', () => ({ sendChat: vi.fn(async () => { throw new Error('forbidden live or unexpected LLM call'); }) }));
vi.mock('../chat/tools/core.js', () => ({ executeToolsHeadless: vi.fn(async () => { throw new Error('forbidden tools'); }) }));

let data, listeners, alarms, get;
const clone = x => structuredClone(x);
const settle = async () => { for (let i=0;i<20;i++) await new Promise(r => setImmediate(r)); };
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  data = {}; listeners = new Set(); alarms = new Map();
  get=vi.fn(async key => {
    if (typeof key==='string') return key in data ? {[key]:clone(data[key])} : {};
    if (Array.isArray(key)) return Object.fromEntries(key.filter(k=>k in data).map(k=>[k,clone(data[k])]));
    return Object.fromEntries(Object.entries(key).map(([k,v])=>[k,clone(k in data?data[k]:v)]));
  });
  globalThis.browser={
    storage:{local:{get,set:vi.fn(async values=>Object.assign(data,clone(values))),remove:vi.fn(async keys=>{for(const k of [].concat(keys)) delete data[k];})}},
    alarms:{onAlarm:{addListener:vi.fn(fn=>listeners.add(fn)),removeListener:vi.fn(fn=>listeners.delete(fn))},create:vi.fn(async(name,spec)=>{alarms.set(name,clone(spec));}),clear:vi.fn(async name=>alarms.delete(name))},
    runtime:{sendMessage:vi.fn(async()=>{}),getManifest:()=>({version:'synthetic'})},
    notifications:{create:vi.fn(async()=>{})}
  };
});
afterEach(()=>vi.useRealTimers());
function due(minutes,hash='due') {
  const d=new Date(Date.now()+minutes*60000); const pad=n=>String(n).padStart(2,'0');
  return {source:'kb',hash,content:`Synthetic ${hash}`,dueDate:`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`,dueTime:`${pad(d.getHours())}:${pad(d.getMinutes())}`};
}
async function setDueTaskText() {
  const {getNowInTimezone,getExecutionState}=await import('../agent/modules/taskScheduler.js');
  const {parseTasksFromKB,getTaskHash}=await import('../agent/modules/kbTaskParser.js');
  const {getUserKBPrompt}=await import('../agent/modules/promptGenerator.js');
  const now=getNowInTimezone('UTC'); const pad=n=>String(n).padStart(2,'0');
  const text=`[Task] Schedule daily ${pad(now.hours===24?0:now.hours)}:${pad(now.minutes)} [UTC], Synthetic daily summary`;
  getUserKBPrompt.mockResolvedValue(text);
  const tasks=parseTasksFromKB(text);
  expect(tasks).toHaveLength(1);
  return {hash:getTaskHash(tasks[0]),date:now.dateStr,getExecutionState};
}
async function startCompletingBackground() {
  const proactive=await import('../agent/modules/proactiveCheckin.js');
  let source=readFileSync(new URL('../agent/background.js',import.meta.url),'utf8');
  const ast=parse(source,{ecmaVersion:'latest',sourceType:'module'});
  const globals={console:{log(){},warn(){},error(){}},Date,performance,window:{},navigator:{},setTimeout:()=>1,clearTimeout(){},setInterval:()=>1,clearInterval(){}};
  // Bind ONLY symbols the actual module imports; a missing import must not be supplied by the fixture.
  for(const entry of ast.body.filter(n=>n.type==='ImportDeclaration').reverse()) {
    for(const spec of entry.specifiers) {
      const name=spec.local.name;
      globals[name]=entry.source.value==='./modules/proactiveCheckin.js' ? proactive[spec.imported.name]
        : name==='ensureActionTags' ? ()=>Promise.resolve({})
        : name==='SETTINGS' ? {} : name==='idb' ? {} : ()=>Promise.resolve({});
    }
    source=source.slice(0,entry.start)+source.slice(entry.start,entry.end).replace(/[^\r\n]/g,' ')+source.slice(entry.end);
  }
  const dynamicImports=[];
  globals.__import=async path=>{dynamicImports.push(path);if(path==='./modules/proactiveCheckin.js')return proactive;return new Promise(()=>{});};
  source=source.replace(/\bimport\(/g,'__import(');
  const real=browser;
  function api(path='browser', object=real) { return new Proxy(()=>Promise.resolve({}),{get(_,key){
    if(key==='then')return undefined;
    if(key in object){ const value=object[key]; return value && typeof value==='object' ? api(`${path}.${String(key)}`, value) : value; }
    if(String(key).startsWith('on'))return {addListener(){},removeListener(){}};
    return api(`${path}.${String(key)}`, {});
  }});}
  globals.browser=api();
  vm.runInNewContext(source,globals,{filename:'agent/background.js'});
  await settle();return dynamicImports;
}

it('unrelated FTS wake cannot start task work; the owned alarm still delivers',async()=>{
 data['notifications.proactive_enabled']=false;data['task.enabled']=true;
 const {hash,date}=await setDueTaskText();
 const {sendChat}=await import('../agent/modules/llm.js');sendChat.mockResolvedValue({assistant:'Synthetic owned task result'});
 const mod=await import('../agent/modules/proactiveCheckin.js');mod.primeProactiveAlarmListener();
 expect(listeners.size).toBe(1);if(listeners.size!==1)return;
 const alarm=[...listeners][0],before=clone(data);
 await alarm({name:'tabmail-fts-helper-recheck'});await settle();
 expect(sendChat).not.toHaveBeenCalled();expect(data).toEqual(before);expect(alarms.size).toBe(0);
 await alarm({name:'tabmail-task-eval'});
 expect(sendChat).toHaveBeenCalledTimes(1);
 expect(data.task_execution_cache[`${hash}_${date}`].content).toBe('Synthetic owned task result');
 await vi.waitFor(()=>expect(data.chat_turns?.some(t=>t._type==='task_result'&&t.content.includes('Synthetic owned task result'))).toBe(true));
});
it('rejected initialization can be retried and deliver a reminder',async()=>{
 data['notifications.proactive_enabled']=true;
 const {buildReminderList}=await import('../agent/modules/reminderBuilder.js');buildReminderList.mockResolvedValue({reminders:[due(10)]});
 browser.alarms.onAlarm.addListener.mockImplementationOnce(()=>{throw new Error('Synthetic registration failure');});
 const mod=await import('../agent/modules/proactiveCheckin.js');
 await expect(mod.initProactiveCheckin()).rejects.toThrow('Synthetic registration failure');
 expect(listeners.size).toBe(0);expect(data.proactiveCheckin_pendingMessage).toBeUndefined();
 await mod.initProactiveCheckin();
 expect(listeners.size).toBe(1);if(listeners.size!==1)return;
 await [...listeners][0]({name:'tabmail-proactive-reachout'});
 expect(data.proactiveCheckin_pendingMessage?.message).toContain('Synthetic due');
});
it('a real cooldown write survives suspension and suppresses a different reminder until expiry',async()=>{
 vi.useFakeTimers({toFake:['Date']});const now=Date.now();vi.setSystemTime(now);
 data['notifications.proactive_enabled']=true;
 const {buildReminderList}=await import('../agent/modules/reminderBuilder.js');buildReminderList.mockResolvedValue({reminders:[due(10)]});
 let mod=await import('../agent/modules/proactiveCheckin.js');mod.primeProactiveAlarmListener();
 await [...listeners][0]({name:'tabmail-proactive-reachout'});
 expect(data.proactiveCheckin_pendingMessage?.message).toContain('Synthetic due');
 expect(data['notifications.last_reachout']).toEqual({time:now});
 await mod.consumePendingProactiveMessage();
 vi.setSystemTime(now+1000);listeners.clear();vi.resetModules();buildReminderList.mockResolvedValue({reminders:[due(10,'different')]});
 mod=await import('../agent/modules/proactiveCheckin.js');mod.primeProactiveAlarmListener();
 await [...listeners][0]({name:'tabmail-proactive-reachout'});
 expect(data.proactiveCheckin_pendingMessage).toBeUndefined();
 expect(data['notifications.reached_out_ids']?.different).toBeUndefined();
 expect(data['notifications.last_reachout']).toEqual({time:now});
 vi.setSystemTime(now+61000);
 await [...listeners][0]({name:'tabmail-proactive-reachout'});
 expect(data.proactiveCheckin_pendingMessage?.message).toContain('Synthetic different');
 expect(data['notifications.last_reachout']).toEqual({time:now+61000});
});
it('completing general startup creates both schedules without a synthetic alarm',async()=>{
 data['notifications.proactive_enabled']=true;
 const {buildReminderList}=await import('../agent/modules/reminderBuilder.js');const r=due(90);buildReminderList.mockResolvedValue({reminders:[r]});
 const imports=await startCompletingBackground();
 expect(imports).toContain('./modules/supabaseAuth.js');
 expect(listeners.size).toBe(1);
 expect(alarms.get('tabmail-task-eval')).toEqual({periodInMinutes:5});
 expect(alarms.get('tabmail-proactive-reachout')).toEqual({when:new Date(`${r.dueDate}T${r.dueTime}:00`).getTime()-30*60000});
 expect(data.proactiveCheckin_pendingMessage).toBeUndefined();
});
it('disabled task wake preserves state and later enabled wake executes',async()=>{
 data['notifications.proactive_enabled']=false;data['task.enabled']=false;
 const {hash,date}=await setDueTaskText();
 const {sendChat}=await import('../agent/modules/llm.js');sendChat.mockResolvedValue({assistant:'Synthetic enabled task result'});
 const mod=await import('../agent/modules/proactiveCheckin.js');mod.primeProactiveAlarmListener();
 await [...listeners][0]({name:'tabmail-task-eval'});
 expect(sendChat).not.toHaveBeenCalled();expect(data.task_execution_cache).toBeUndefined();expect(data.task_execution_state).toBeUndefined();expect(data.chat_turns).toBeUndefined();
 data['task.enabled']=true;await [...listeners][0]({name:'tabmail-task-eval'});
 expect(sendChat).toHaveBeenCalledTimes(1);expect(data.task_execution_cache[`${hash}_${date}`].content).toBe('Synthetic enabled task result');
 await vi.waitFor(()=>expect(data.chat_turns?.some(t=>t._type==='task_result')).toBe(true));
});
it.each(['reminder','task'])('an owned alarm delivers to an already open chat: %s',async kind=>{
 const {isChatWindowOpen,openOrFocusChatWindow}=await import('../chat/modules/chatWindowUtils.js');
 data['notifications.proactive_enabled']=kind==='reminder';data['task.enabled']=true;
 const {buildReminderList}=await import('../agent/modules/reminderBuilder.js');buildReminderList.mockResolvedValue({reminders:[due(10)]});
 if(kind==='task') {await setDueTaskText();const {sendChat}=await import('../agent/modules/llm.js');sendChat.mockResolvedValue({assistant:'Synthetic open chat task'});}
 const mod=await import('../agent/modules/proactiveCheckin.js');mod.primeProactiveAlarmListener();
 await mod.initProactiveCheckin();isChatWindowOpen.mockResolvedValue(true);
 await [...listeners][0]({name:kind==='reminder'?'tabmail-proactive-reachout':'tabmail-task-eval'});
 expect(browser.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({command:'proactive-checkin-message',message:expect.stringContaining(kind==='reminder'?'Synthetic due':'Synthetic open chat task'),...(kind==='task'?{isTaskResult:true}:{})}));
 expect(openOrFocusChatWindow).not.toHaveBeenCalled();expect(data.proactiveCheckin_pendingMessage).toBeUndefined();
 if(kind==='task')await vi.waitFor(()=>expect(data.chat_turns?.some(t=>t._type==='task_result')).toBe(true));
 else expect(data['notifications.reached_out_ids']?.due?.trigger).toBe('due_approaching');
 isChatWindowOpen.mockResolvedValue(false);
});
it('quota refusal preserves the existing retry record written by a failed task',async()=>{
 data['notifications.proactive_enabled']=false;data['task.enabled']=true;
 const {hash,date,getExecutionState}=await setDueTaskText();
 const {sendChat}=await import('../agent/modules/llm.js');sendChat.mockRejectedValueOnce(Object.assign(new Error('Synthetic transient service failure'),{status:503}));
 const mod=await import('../agent/modules/proactiveCheckin.js');mod.primeProactiveAlarmListener();const alarm=[...listeners][0];
 await alarm({name:'tabmail-task-eval'});
 const before=clone(await getExecutionState(hash));expect(before.consecutiveErrors).toBe(1);
 sendChat.mockRejectedValueOnce(Object.assign(new Error('Synthetic quota'),{status:402}));
 await alarm({name:'tabmail-task-eval'});
 expect(sendChat).toHaveBeenCalledTimes(2);expect(await getExecutionState(hash)).toEqual(before);
 expect(data.task_execution_cache?.[`${hash}_${date}`]).toBeUndefined();expect(data.chat_turns?.some(t=>t._type==='task_result')).toBeFalsy();
 sendChat.mockResolvedValue({assistant:'Synthetic retry success'});await alarm({name:'tabmail-task-eval'});
 expect((await getExecutionState(hash)).consecutiveErrors).toBe(0);expect(data.task_execution_cache[`${hash}_${date}`].content).toBe('Synthetic retry success');
 await vi.waitFor(()=>expect(data.chat_turns?.some(t=>t._type==='task_result'&&t.content.includes('Synthetic retry success'))).toBe(true));
});
it('task tool results feed the next request and a final answer is durably delivered',async()=>{
 data['notifications.proactive_enabled']=false;data['task.enabled']=true;
 const {hash,date,getExecutionState}=await setDueTaskText();
 const {sendChat}=await import('../agent/modules/llm.js');const {executeToolsHeadless}=await import('../chat/tools/core.js');
 sendChat.mockResolvedValueOnce({assistant:'',tool_calls:[{id:'synthetic-call',type:'function',function:{name:'email_search',arguments:'{"query":"synthetic"}'}}]}).mockResolvedValueOnce({assistant:'Synthetic tool-derived answer'});
 executeToolsHeadless.mockResolvedValue([{call_id:'synthetic-call',output:'Synthetic tool result'}]);
 const mod=await import('../agent/modules/proactiveCheckin.js');mod.primeProactiveAlarmListener();await [...listeners][0]({name:'tabmail-task-eval'});
 expect(executeToolsHeadless).toHaveBeenCalledTimes(1);expect(sendChat).toHaveBeenCalledTimes(2);
 expect(sendChat.mock.calls[1][0]).toContainEqual({role:'tool',tool_call_id:'synthetic-call',content:'Synthetic tool result'});
 expect(data.task_execution_cache[`${hash}_${date}`].content).toBe('Synthetic tool-derived answer');expect((await getExecutionState(hash)).lastFiredTs).toBeGreaterThan(0);
 await vi.waitFor(()=>expect(data.chat_turns?.some(t=>t._type==='task_result'&&t.content.includes('Synthetic tool-derived answer'))).toBe(true));
});
it('task execution terminates when every backend response requests another tool turn',async()=>{
 data['notifications.proactive_enabled']=false;data['task.enabled']=true;
 const {hash,date,getExecutionState}=await setDueTaskText();
 const {sendChat}=await import('../agent/modules/llm.js');const {executeToolsHeadless}=await import('../chat/tools/core.js');let requests=0;
 sendChat.mockImplementation(async()=>{if(++requests>10)throw new Error('Test harness bounds a mutant runaway');return {assistant:'',tool_calls:[{id:'synthetic-call',type:'function',function:{name:'email_search',arguments:'{"query":"synthetic"}'}}]};});
 executeToolsHeadless.mockResolvedValue([{call_id:'synthetic-call',output:'Synthetic tool result'}]);
 const mod=await import('../agent/modules/proactiveCheckin.js');mod.primeProactiveAlarmListener();await [...listeners][0]({name:'tabmail-task-eval'});
 expect(requests).toBe(10);expect(executeToolsHeadless).toHaveBeenCalledTimes(10);
 expect(sendChat.mock.calls[1][0]).toContainEqual({role:'tool',tool_call_id:'synthetic-call',content:'Synthetic tool result'});
 expect(data.task_execution_cache?.[`${hash}_${date}`]).toBeUndefined();expect(data.chat_turns?.some(t=>t._type==='task_result')).toBeFalsy();
 expect((await getExecutionState(hash)).consecutiveErrors).toBe(1);expect((await getExecutionState(hash)).lastFiredTs).toBeFalsy();
 expect(browser.notifications.create).not.toHaveBeenCalled();
});
it('an overdue reminder is absent from delivery and dedup while a due reminder delivers',async()=>{
 data['notifications.proactive_enabled']=true;
 const {buildReminderList}=await import('../agent/modules/reminderBuilder.js');buildReminderList.mockResolvedValue({reminders:[due(10),due(-10,'overdue')]});
 const mod=await import('../agent/modules/proactiveCheckin.js');mod.primeProactiveAlarmListener();await [...listeners][0]({name:'tabmail-proactive-reachout'});
 expect(data.proactiveCheckin_pendingMessage?.message).toContain('Synthetic due');expect(data.proactiveCheckin_pendingMessage?.message).not.toContain('Synthetic overdue');
 expect(Object.keys(data['notifications.reached_out_ids'])).toEqual(['due']);
});
it('an overlapping startup restore cannot overwrite cooldown established by the first alarm',async()=>{
 vi.useFakeTimers({toFake:['Date']});const now=Date.now();vi.setSystemTime(now);
 data['notifications.proactive_enabled']=true;data['notifications.last_reachout']={time:now-120000};
 const {buildReminderList}=await import('../agent/modules/reminderBuilder.js');buildReminderList.mockResolvedValue({reminders:[due(10)]});
 let release,entered,restores=0;const held=new Promise(r=>release=r),reached=new Promise(r=>entered=r),original=get.getMockImplementation();
 get.mockImplementation(async key=>{if(key==='notifications.last_reachout'&&++restores===1){const old=await original(key);entered();await held;return old;}return original(key);});
 const mod=await import('../agent/modules/proactiveCheckin.js');const init=mod.initProactiveCheckin();await reached;
 expect(listeners.size).toBe(1);if(listeners.size!==1)return;
 const wake=[...listeners][0]({name:'tabmail-proactive-reachout'});await settle();release();await Promise.all([init,wake]);
 expect((await mod.consumePendingProactiveMessage())?.message).toContain('Synthetic due');
 buildReminderList.mockResolvedValue({reminders:[due(10,'newer')]});await [...listeners][0]({name:'tabmail-proactive-reachout'});
 expect(data.proactiveCheckin_pendingMessage).toBeUndefined();expect(data['notifications.reached_out_ids']?.newer).toBeUndefined();
 vi.setSystemTime(now+61000);await [...listeners][0]({name:'tabmail-proactive-reachout'});
 expect(data.proactiveCheckin_pendingMessage?.message).toContain('Synthetic newer');
});
// Each probe starts with the intended dependency state even after another probe fails.
beforeEach(async()=>{
 const {isChatWindowOpen}=await import('../chat/modules/chatWindowUtils.js');isChatWindowOpen.mockReset().mockResolvedValue(false);
 const {sendChat}=await import('../agent/modules/llm.js');sendChat.mockReset().mockImplementation(async()=>{throw new Error('forbidden live or unexpected LLM call');});
 const {executeToolsHeadless}=await import('../chat/tools/core.js');executeToolsHeadless.mockReset().mockImplementation(async()=>{throw new Error('forbidden tools');});
});
