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
async function startRealBackground() {
  const proactive=await import('../agent/modules/proactiveCheckin.js');
  let source=readFileSync(new URL('../agent/background.js',import.meta.url),'utf8');
  const ast=parse(source,{ecmaVersion:'latest',sourceType:'module'});
  const globals={console:{log(){},warn(){},error(){}},Date,performance,window:{},navigator:{},setTimeout:()=>1,clearTimeout(){},setInterval:()=>1,clearInterval(){}};
  // Bind ONLY symbols the actual module imports; a missing import must not be supplied by the fixture.
  for(const entry of ast.body.filter(n=>n.type==='ImportDeclaration').reverse()) {
    for(const spec of entry.specifiers) {
      const name=spec.local.name;
      globals[name]=entry.source.value==='./modules/proactiveCheckin.js' ? proactive[spec.imported.name]
        : name==='ensureActionTags' ? ()=>new Promise(()=>{})
        : name==='SETTINGS' ? {} : name==='idb' ? {} : ()=>Promise.resolve({});
    }
    source=source.slice(0,entry.start)+source.slice(entry.start,entry.end).replace(/[^\r\n]/g,' ')+source.slice(entry.end);
  }
  const real=browser;
  function api(path='browser', object=real) { return new Proxy(()=>Promise.resolve({}),{get(_,key){
    if(key==='then')return undefined;
    if(key in object){ const value=object[key]; return value && typeof value==='object' ? api(`${path}.${String(key)}`, value) : value; }
    if(String(key).startsWith('on'))return {addListener(){},removeListener(){}};
    return api(`${path}.${String(key)}`, {});
  }});}
  globals.browser=api();
  vm.runInNewContext(source,globals,{filename:'agent/background.js'});
}
it('connected startup delivers the first due wake before general startup resumes',async()=>{
  data['notifications.proactive_enabled']=true;
  const {buildReminderList}=await import('../agent/modules/reminderBuilder.js');
  buildReminderList.mockResolvedValue({reminders:[due(10)]});
  await startRealBackground();
  await Promise.all([...listeners].map(fn=>fn({name:'tabmail-proactive-reachout'})));
  expect(data.proactiveCheckin_pendingMessage?.message ?? '').toContain('Synthetic due');
  expect(data['notifications.reached_out_ids']?.due?.trigger).toBe('due_approaching');
  const {openOrFocusChatWindow}=await import('../chat/modules/chatWindowUtils.js');
  expect(openOrFocusChatWindow).toHaveBeenCalledTimes(1);
});
it.each(['recent','expired'])('held restoration blocks effects until released: %s',async age=>{
  data['notifications.proactive_enabled']=true;
  const stored=Date.now()-(age==='recent'?0:120000);
  data['notifications.last_reachout']={time:stored};
  const {buildReminderList}=await import('../agent/modules/reminderBuilder.js');
  buildReminderList.mockResolvedValue({reminders:[due(10)]});
  let release,entered;
  const held=new Promise(r=>release=r), reached=new Promise(r=>entered=r);
  const original=get.getMockImplementation();
  get.mockImplementation(async key=>{if(key==='notifications.last_reachout'){entered();await held;}return original(key);});
  const mod=await import('../agent/modules/proactiveCheckin.js');
  const init=mod.initProactiveCheckin(); await reached;
  expect(listeners.size).toBe(1); if(listeners.size!==1)return;
  const wake=[...listeners][0]({name:'tabmail-proactive-reachout'});
  await settle(); // allow the handler to run if the restore barrier is missing
  const before=clone(data);
  release(); await Promise.all([init,wake]);
  expect(before.proactiveCheckin_pendingMessage).toBeUndefined();
  expect(before['notifications.last_reachout'].time).toBe(stored);
  expect(buildReminderList).toHaveBeenCalled();
  if(age==='recent') expect(data.proactiveCheckin_pendingMessage).toBeUndefined();
  else expect(data.proactiveCheckin_pendingMessage?.message ?? '').toContain('Synthetic due');
});
it('task wake with proactive off consumes cached task and persists a chat result',async()=>{
  data['notifications.proactive_enabled']=false; data['task.enabled']=true;
  const {getNowInTimezone,shouldFire,getExecutionState}=await import('../agent/modules/taskScheduler.js');
  const {parseTasksFromKB,getTaskHash}=await import('../agent/modules/kbTaskParser.js');
  const {setCachedResult}=await import('../agent/modules/taskExecutionCache.js');
  const {getUserKBPrompt}=await import('../agent/modules/promptGenerator.js');
  const now=getNowInTimezone('UTC'); const pad=n=>String(n).padStart(2,'0');
  const text=`[Task] Schedule daily ${pad(now.hours===24?0:now.hours)}:${pad(now.minutes)} [UTC], Synthetic daily summary`;
  getUserKBPrompt.mockResolvedValue(text);
  const tasks=parseTasksFromKB(text); expect(tasks).toHaveLength(1); if(tasks.length!==1)return;
  const task=tasks[0], hash=getTaskHash(task);
  expect((await shouldFire(task,hash,true,null)).shouldFire).toBe(true);
  await setCachedResult(hash,now.dateStr,'Synthetic cached result',`task:${hash}`);
  expect(data.task_execution_cache[`${hash}_${now.dateStr}`].content).toBe('Synthetic cached result');
  await startRealBackground();
  await Promise.all([...listeners].map(fn=>fn({name:'tabmail-task-eval'})));
  await vi.waitFor(()=>expect(data.chat_turns?.some(t=>t._type==='task_result'&&t.content.includes('Synthetic cached result'))).toBe(true),{timeout:2000});
  expect((await getExecutionState(hash))?.lastFiredTs).toBeGreaterThan(0);
  expect(browser.notifications.create).toHaveBeenCalledTimes(1);
  expect(data.proactiveCheckin_pendingMessage).toBeUndefined();
  const {sendChat}=await import('../agent/modules/llm.js'); expect(sendChat).not.toHaveBeenCalled();
  await [...listeners][0]({name:'tabmail-task-eval'}); await settle();
  expect(browser.notifications.create).toHaveBeenCalledTimes(1);
  expect(data.chat_turns.filter(t=>t._type==='task_result')).toHaveLength(1);
});
it('task wake executes an uncached task and durably delivers its result',async()=>{
  data['notifications.proactive_enabled']=false; data['task.enabled']=true;
  const {hash,date,getExecutionState}=await setDueTaskText();
  const {sendChat}=await import('../agent/modules/llm.js');
  sendChat.mockResolvedValue({assistant:'Synthetic uncached result'});
  await startRealBackground();
  await Promise.all([...listeners].map(fn=>fn({name:'tabmail-task-eval'})));
  expect(sendChat).toHaveBeenCalledTimes(1);
  expect(sendChat.mock.calls[0][0][0].content).toBe('system_prompt_task_eval');
  expect(data.task_execution_cache[`${hash}_${date}`].content).toBe('Synthetic uncached result');
  await vi.waitFor(()=>expect(data.chat_turns?.some(t=>t._type==='task_result'&&t.content.includes('Synthetic uncached result'))).toBe(true),{timeout:2000});
  expect((await getExecutionState(hash))?.lastFiredTs).toBeGreaterThan(0);
  expect(browser.notifications.create).toHaveBeenCalledTimes(1);
  expect(data.proactiveCheckin_pendingMessage).toBeUndefined();
});
it('task quota refusal preserves retry state until a later alarm succeeds',async()=>{
  data['notifications.proactive_enabled']=false; data['task.enabled']=true;
  const {hash,date,getExecutionState}=await setDueTaskText();
  const {sendChat}=await import('../agent/modules/llm.js');
  sendChat.mockRejectedValueOnce(Object.assign(new Error('Synthetic quota'),{status:402}));
  await startRealBackground();
  const alarm=[...listeners][0];
  await alarm({name:'tabmail-task-eval'});
  expect(sendChat).toHaveBeenCalledTimes(1);
  expect(data.task_execution_cache?.[`${hash}_${date}`]).toBeUndefined();
  expect((await getExecutionState(hash))?.lastFiredTs).toBeFalsy();
  expect(data.chat_turns?.some(t=>t._type==='task_result')).toBeFalsy();
  expect(browser.notifications.create).not.toHaveBeenCalled();

  sendChat.mockResolvedValue({assistant:'Synthetic retry result'});
  await alarm({name:'tabmail-task-eval'});
  expect(sendChat).toHaveBeenCalledTimes(2);
  expect(data.task_execution_cache[`${hash}_${date}`].content).toBe('Synthetic retry result');
  expect((await getExecutionState(hash))?.lastFiredTs).toBeGreaterThan(0);
  await vi.waitFor(()=>expect(data.chat_turns?.some(t=>t._type==='task_result'&&t.content.includes('Synthetic retry result'))).toBe(true),{timeout:2000});
  expect(browser.notifications.create).toHaveBeenCalledTimes(1);
});
it('restored dedup survives a new background generation after cooldown expires',async()=>{
  vi.useFakeTimers({toFake:['Date']});const now=Date.now(); vi.setSystemTime(now);
  data['notifications.proactive_enabled']=true;
  const {buildReminderList}=await import('../agent/modules/reminderBuilder.js');
  buildReminderList.mockResolvedValue({reminders:[due(10)]});
  let mod=await import('../agent/modules/proactiveCheckin.js');mod.primeProactiveAlarmListener();
  await [...listeners][0]({name:'tabmail-proactive-reachout'});
  expect(data['notifications.reached_out_ids']?.due?.trigger).toBe('due_approaching');
  expect((await mod.consumePendingProactiveMessage())?.message).toContain('Synthetic due');
  const saved=clone(data['notifications.reached_out_ids']);
  vi.setSystemTime(now+61000);listeners.clear();vi.resetModules();
  mod=await import('../agent/modules/proactiveCheckin.js');mod.primeProactiveAlarmListener();
  await [...listeners][0]({name:'tabmail-proactive-reachout'});
  expect(data.proactiveCheckin_pendingMessage).toBeUndefined();
  expect(data['notifications.reached_out_ids']).toEqual(saved);
  buildReminderList.mockResolvedValue({reminders:[due(10),due(12,'new-due')]});
  await [...listeners][0]({name:'tabmail-proactive-reachout'});
  expect(data.proactiveCheckin_pendingMessage?.message ?? '').toContain('Synthetic new-due');
  expect(data.proactiveCheckin_pendingMessage?.message ?? '').not.toContain('Synthetic due');
});
it.each([false,true])('ordinary init preserves future schedule policy enabled=%s',async enabled=>{
  data['notifications.proactive_enabled']=enabled;
  const {buildReminderList}=await import('../agent/modules/reminderBuilder.js');
  buildReminderList.mockResolvedValue({reminders:[due(90)]});
  const mod=await import('../agent/modules/proactiveCheckin.js');await mod.initProactiveCheckin();
  expect(alarms.has('tabmail-task-eval')).toBe(true);
  expect(alarms.has('tabmail-proactive-reachout')).toBe(enabled);
  expect(data.proactiveCheckin_pendingMessage).toBeUndefined();
});

it('future reminders are absent from both delivery and dedup writes',async()=>{
 data['notifications.proactive_enabled']=true;
 const {buildReminderList}=await import('../agent/modules/reminderBuilder.js');
 buildReminderList.mockResolvedValue({reminders:[due(10),due(90,'future')]});
 const mod=await import('../agent/modules/proactiveCheckin.js');mod.primeProactiveAlarmListener();
 await [...listeners][0]({name:'tabmail-proactive-reachout'});
 expect(data.proactiveCheckin_pendingMessage?.message ?? '').toContain('Synthetic due');
 expect(data.proactiveCheckin_pendingMessage?.message ?? '').not.toContain('Synthetic future');
 expect(Object.keys(data['notifications.reached_out_ids'])).toEqual(['due']);
});
it('a queued due alarm respects a disabled preference and delivers when enabled',async()=>{
 data['notifications.proactive_enabled']=false;
 const {buildReminderList}=await import('../agent/modules/reminderBuilder.js');
 buildReminderList.mockResolvedValue({reminders:[due(10)]});
 const mod=await import('../agent/modules/proactiveCheckin.js');mod.primeProactiveAlarmListener();
 await [...listeners][0]({name:'tabmail-proactive-reachout'});
 expect(data.proactiveCheckin_pendingMessage).toBeUndefined();
 expect(data['notifications.reached_out_ids']).toBeUndefined();
 expect(data['notifications.last_reachout']).toBeUndefined();
 data['notifications.proactive_enabled']=true;
 await [...listeners][0]({name:'tabmail-proactive-reachout'});
 expect(data.proactiveCheckin_pendingMessage?.message ?? '').toContain('Synthetic due');
 expect(Object.keys(data['notifications.reached_out_ids'])).toEqual(['due']);
});
it('message reminders require reply classification before durable delivery',async()=>{
 data['notifications.proactive_enabled']=true;
 const {buildReminderList}=await import('../agent/modules/reminderBuilder.js');
 buildReminderList.mockResolvedValue({reminders:[{...due(10),source:'message',action:'reply'},{...due(10,'archive'),source:'message',action:'archive'}]});
 const mod=await import('../agent/modules/proactiveCheckin.js');mod.primeProactiveAlarmListener();
 await [...listeners][0]({name:'tabmail-proactive-reachout'});
 expect(data.proactiveCheckin_pendingMessage?.message ?? '').toContain('Synthetic due');
 expect(data.proactiveCheckin_pendingMessage?.message ?? '').not.toContain('Synthetic archive');
 expect(Object.keys(data['notifications.reached_out_ids'])).toEqual(['due']);
});
