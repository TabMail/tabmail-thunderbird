import { expect, it, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';

afterEach(() => vi.useRealTimers());
async function harness({ enabled = true, connectEarly = true, failFirstAdd = false, fullStartup = false, asyncDelivery = false } = {}) {
  vi.useFakeTimers();
  const listeners = new Set(), stored = { device_sync_auto_enabled: enabled }, sent = [];
  let adds = 0;
  const startupLogs = [], syncLogs = [];
  let finishStartup;
  const startupDone = new Promise(resolve => { finishStartup = resolve; });
  const onChanged = { addListener: fn => { if (failFirstAdd && ++adds === 1) throw new Error("synthetic registration failure"); listeners.add(fn); }, removeListener: fn => listeners.delete(fn) };
  const overrides = {
    'browser.runtime.getManifest': () => ({version: 'synthetic'}),
    'browser.storage.onChanged': onChanged,
    'browser.storage.local.get': async keys => typeof keys === 'string'
      ? { [keys]: stored[keys] } : Object.fromEntries((Array.isArray(keys) ? keys : Object.keys(keys)).map(k => [k, stored[k] ?? keys[k]])),
    'browser.storage.local.set': async values => {
      const changes = Object.fromEntries(Object.entries(values).map(([key,value]) => [key,{oldValue:stored[key],newValue:value}]));
      Object.assign(stored, values);
      if (fullStartup || asyncDelivery) setTimeout(() => { for (const listener of [...listeners]) listener(changes,'local'); }, 0);
    },
    'browser.tmDeviceSync.getState': async () => 'open',
    'browser.tmDeviceSync.send': async data => sent.push(JSON.parse(data)),
  };
  function api(path = 'browser') {
    return new Proxy(() => Promise.resolve({}), {get(_, key) {
      if (key === 'then') return undefined;
      const next = `${path}.${String(key)}`;
      return overrides[next] || api(next);
    }});
  }
  const browser = api();
  function evaluate(file, supplied = {}) {
    let source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    const scope = { console: {log(){},warn(){},error(){}}, Date, performance, browser, crypto: globalThis.crypto,
      dynamicImport: async path => {
        if (path === "./taskExecutionCache.js") return {getAllCachedResults: async () => ({})};
        if (path === "./bulletMerge.js") return import("../agent/modules/bulletMerge.js");
        throw new Error(`Unexpected fixture import: ${path}`);
      },
      window: {}, navigator: {}, setTimeout, clearTimeout, setInterval, clearInterval,
      log(message){ syncLogs.push(message); }, SETTINGS: {}, ...supplied };
    const ast = parse(source, {ecmaVersion:'latest',sourceType:'module'});
    const edits = [];
    for (const node of ast.body) {
      if (node.type === 'ImportDeclaration') {
        for (const spec of node.specifiers) {
          if (!(spec.local.name in scope)) scope[spec.local.name] = () => Promise.resolve({});
        }
        edits.push([node.start,node.end]);
      } else if (node.type === 'ExportNamedDeclaration') edits.push([node.start,node.declaration.start]);
    }
    for (const [start,end] of edits.reverse()) source=source.slice(0,start)+source.slice(start,end).replace(/[^\r\n]/g,' ')+source.slice(end);
    source = source.replace(/\bimport\(/g, "dynamicImport(");
    const context=vm.createContext(scope); vm.runInContext(source,context,{filename:file}); return context;
  }
  const sync=evaluate('agent/modules/deviceSync.js');
  if (connectEarly) await sync.connect(); // Parent socket may already be open before module reconnect.
  const prompts = fullStartup ? evaluate('agent/modules/promptGenerator.js', {
    normalizeUnicode: text => text,
    fetch: async () => ({ok:true,text:async () => 'Bundled default KB'}),
  }) : null;
  const reminders = fullStartup ? evaluate('agent/modules/kbReminderGenerator.js', {getUserKBPrompt:prompts.getUserKBPrompt}) : null;
  evaluate('agent/background.js', {
    setupStorageListener: sync.setupStorageListener,
    attachDeviceSyncTransportListener: sync.attachDeviceSyncTransportListener,
    setAICacheProbeHandler: sync.setAICacheProbeHandler,
    ensureActionTags: fullStartup ? async () => {} : () => new Promise(() => {}),
    ...(fullStartup ? {
      log: message => { startupLogs.push(message); if(message.includes('Auto-connected and storage listener started')) finishStartup(); },
      dynamicImport: async path => {
        if(path === './modules/deviceSync.js') return sync;
        if(path === './modules/kbReminderGenerator.js') return reminders;
        return new Proxy({}, {get: (_,key) => key === 'then' ? undefined : async () => {}});
      },
    } : {}),
    setTimeout: () => 1, setInterval: () => 1,
  });
  if(fullStartup) {
    await startupDone;
    await vi.advanceTimersByTimeAsync(1);
  }
  return {sync,stored,sent,listeners,evaluate,startupLogs,syncLogs,overrides,async writeKB(value) {
    stored["user_prompts:user_kb.md"] = value;
    for (const listener of [...listeners]) listener({"user_prompts:user_kb.md":{newValue:value}}, "local");
  },async edit() {
    const value=[{id:'synthetic-template',name:'Synthetic local edit'}];
    stored.user_templates=value;
    for (const listener of [...listeners]) await listener({user_templates:{newValue:value}},'local');
    await vi.advanceTimersByTimeAsync(500);
    return value;
  }};
}
it('timestamps and broadcasts the first local edit while startup is awaiting', async () => {
  const h=await harness(); const value=await h.edit();
  expect(h.stored['device_sync_ts:templates']).toEqual(expect.any(String));
  expect(h.sent).toHaveLength(1);
  expect(h.sent[0]).toMatchObject({type:'prompt_state',data:{templates:value,templates_updated_at:h.stored['device_sync_ts:templates']}});
  expect(h.listeners.size).toBe(1);
});
it('warm registration handles the same local edit as a positive control', async () => {
  const h=await harness(); h.sync.setupStorageListener(); h.sync.setupStorageListener();
  const value=await h.edit();
  expect(h.stored['device_sync_ts:templates']).toEqual(expect.any(String));
  expect(h.sent).toHaveLength(1);
  expect(h.sent[0]).toMatchObject({type:'prompt_state',data:{templates:value}});
  expect(h.listeners.size).toBe(1);
});

it('reconnects the module to its existing parent before the first broadcast', async () => {
  const h = await harness({ connectEarly: false });
  const value = await h.edit();
  expect(h.sent).toHaveLength(1);
  expect(h.sent[0]).toMatchObject({ type: 'prompt_state', data: { templates: value } });
});
it('timestamps local edits while auto-sync is disabled without sending', async () => {
  const h = await harness({ enabled: false });
  await h.edit();
  expect(h.stored['device_sync_ts:templates']).toEqual(expect.any(String));
  expect(h.sent).toEqual([]);
});
it('retries a failed registration without duplicating the successful owner', async () => {
  const h = await harness({ failFirstAdd: true });
  expect(h.listeners.size).toBe(0);
  h.sync.setupStorageListener(); h.sync.setupStorageListener();
  await h.edit();
  expect(h.listeners.size).toBe(1);
  expect(h.sent).toHaveLength(1);
});
it('ignores an event delivered while suppression is still active', async () => {
  const h = await harness();
  vm.runInContext('suppressBroadcast = true', h.sync);
  const work = h.edit();
  vm.runInContext('suppressBroadcast = false', h.sync);
  await work;
  expect(h.stored['device_sync_ts:templates']).toBeUndefined();
  expect(h.sent).toEqual([]);
});
it('preserves edit timestamps when disconnect occurs before the broadcast debounce', async () => {
  const h = await harness();
  const work = h.edit();
  await h.sync.disconnect();
  await work;
  expect(h.stored['device_sync_ts:templates']).toEqual(expect.any(String));
  expect(h.sent).toEqual([]);
});

it('timestamps and records paused edits, then sends the newer KB to a peer on resume', async () => {
  const local = await harness(), peer = await harness();
  const previous = '2020-01-01T00:00:00.000Z';
  peer.stored['user_prompts:user_kb.md'] = 'Old KB';
  peer.stored['device_sync_ts:kb'] = previous;
  peer.stored['device_peer_base:kb'] = 'Old KB';
  peer.stored['device_peer_base_ts:kb'] = previous;
  await local.sync.setAutoEnabled(false);
  await local.writeKB('New paused KB');
  await vi.advanceTimersByTimeAsync(2000);
  expect(local.sent).toEqual([]);
  expect(local.stored['device_sync_ts:kb'] > previous).toBe(true);
  expect(local.stored.prompt_history).toEqual(expect.arrayContaining([
    expect.objectContaining({source:'local_edit', fields:['kb'], kb:'New paused KB'}),
  ]));
  await local.sync.setAutoEnabled(true);
  await local.sync.handleMessage(JSON.stringify({type:'connected',userId:'synthetic'}));
  const message = local.sent.find(message => message.type === 'prompt_state');
  expect(message.data.kb).toBe('New paused KB');
  await peer.sync.handleMessage(JSON.stringify(message));
  expect(peer.stored['user_prompts:user_kb.md']).toBe('New paused KB');
});

it('keeps a never-synced newer paused edit when an older peer state arrives', async () => {
  const local = await harness({enabled:false});
  await local.writeKB('New unsynced KB');
  await vi.advanceTimersByTimeAsync(500);
  await local.sync.setAutoEnabled(true);
  await local.sync.handleMessage(JSON.stringify({type:'prompt_state',data:{kb:'Old peer KB',kb_updated_at:'2020-01-01T00:00:00.000Z'}}));
  expect(local.stored['user_prompts:user_kb.md']).toBe('New unsynced KB');
});

it('does not reconnect or send when paused during the edit debounce', async () => {
  const h = await harness();
  await h.writeKB('Pause before send');
  await h.sync.setAutoEnabled(false);
  const reconnect = vi.spyOn(h.sync, 'connect');
  await vi.advanceTimersByTimeAsync(500);
  expect(reconnect).not.toHaveBeenCalled();
  expect(h.sent).toEqual([]);
  expect(h.stored['device_sync_ts:kb']).toEqual(expect.any(String));
});

it('ignores other storage areas and unrelated keys', async () => {
  const h = await harness();
  for (const listener of h.listeners) {
    listener({'user_prompts:user_kb.md':{newValue:'Other area'}}, 'sync');
    listener({unrelated:{newValue:true}}, 'local');
  }
  await vi.advanceTimersByTimeAsync(2000);
  expect(h.stored['device_sync_ts:kb']).toBeUndefined();
  expect(h.stored.prompt_history).toBeUndefined();
  expect(h.sent).toEqual([]);
});

it('finishes real startup without turning a bundled KB default into a peer-overwriting edit', async () => {
  const local = await harness({fullStartup:true,connectEarly:false});
  expect(local.startupLogs).toContain('[Startup] KB reminder generation completed');
  expect(local.startupLogs).toContain('[DeviceSync] Auto-connected and storage listener started');
  expect(local.stored.reminder_kb_list).toBeDefined();
  expect(local.stored['user_prompts:user_kb.md']).toBeUndefined();
  expect(local.stored['device_sync_ts:kb']).toBeUndefined();
  const peer = await harness();
  peer.stored['user_prompts:user_kb.md'] = 'Customized peer KB';
  peer.stored['device_sync_ts:kb'] = '2020-01-01T00:00:00.000Z';
  peer.stored['device_peer_base:kb'] = 'Customized peer KB';
  peer.stored['device_peer_base_ts:kb'] = '2020-01-01T00:00:00.000Z';
  await local.sync.handleMessage(JSON.stringify({type:'connected',userId:'synthetic'}));
  expect(local.sent.map(message => message.type)).toEqual(['request_state']);
  await peer.sync.handleMessage(JSON.stringify(local.sent[0]));
  await local.sync.handleMessage(JSON.stringify(peer.sent.at(-1)));
  expect(peer.stored['user_prompts:user_kb.md']).toBe('Customized peer KB');
  expect(local.stored['user_prompts:user_kb.md']).toBe('Customized peer KB');
});

it('retries a failed early subscription through completed startup with one owner', async () => {
  const h = await harness({fullStartup:true,failFirstAdd:true});
  expect(h.listeners.size).toBe(1);
  await h.writeKB('Edit after startup retry');
  await vi.advanceTimersByTimeAsync(500);
  expect(h.sent).toHaveLength(1);
  expect(h.sent[0]).toMatchObject({type:'prompt_state',data:{kb:'Edit after startup retry'}});
});

it('keeps remote timestamps under asynchronous delivery and preserves a newer paused peer edit', async () => {
  const local = await harness({asyncDelivery:true});
  const peer = await harness({enabled:false});
  const now = Date.now();
  const incoming = new Date(now - 60000).toISOString();
  vi.setSystemTime(now + 10000);
  await peer.writeKB('Newer synthetic peer edit');
  await vi.advanceTimersByTimeAsync(600);
  vi.setSystemTime(now + 20000);
  await local.sync.handleMessage(JSON.stringify({type:'prompt_state',data:{kb:'Older synthetic peer edit',kb_updated_at:incoming}}));
  await vi.advanceTimersByTimeAsync(2500);
  expect(local.stored['device_sync_ts:kb']).toBe(incoming);
  expect(local.sent.filter(m=>m.type==='prompt_state')).toEqual([]);
  expect((local.stored.prompt_history || []).map(h=>h.source)).toEqual(['sync_receive']);
  await peer.sync.setAutoEnabled(true);
  await local.sync.handleMessage(JSON.stringify({type:'request_state',fields:['kb']}));
  const response=local.sent.filter(m=>m.type==='prompt_state').at(-1);
  expect(response).toBeDefined();
  await peer.sync.handleMessage(JSON.stringify(response));
  expect(peer.stored['user_prompts:user_kb.md']).toBe('Newer synthetic peer edit');
});

it('keeps reset at epoch zero without broadcasting defaults over peer customization', async () => {
  const local=await harness({asyncDelivery:true});
  const peer=await harness();
  const timestamp=new Date(Date.now()-3600000).toISOString();
  Object.assign(peer.stored,{'user_prompts:user_kb.md':'- Synthetic custom rule','device_sync_ts:kb':timestamp,'device_peer_base:kb':'- Synthetic custom rule','device_peer_base_ts:kb':timestamp});
  await local.sync.resetFieldToDefault('kb','Synthetic bundled default');
  await vi.advanceTimersByTimeAsync(2500);
  expect(local.stored['device_sync_ts:kb']).toBe(new Date(0).toISOString());
  expect(local.sent.map(m=>m.type)).toEqual(['request_state']);
  expect((local.stored.prompt_history || []).some(h=>h.source==='local_edit')).toBe(false);
  for(const message of local.sent.filter(m=>m.type==='prompt_state')) await peer.sync.handleMessage(JSON.stringify(message));
  expect(peer.stored['user_prompts:user_kb.md']).toBe('- Synthetic custom rule');
});

it('contains a first-wake reconnect failure and publishes the preserved edit after reconnect', async () => {
  const h=await harness({connectEarly:false});
  h.overrides['browser.tmDeviceSync.getState']=async()=>{throw new Error('synthetic transport failure');};
  const value=await h.edit();
  expect(h.stored['device_sync_ts:templates']).toEqual(expect.any(String));
  expect(h.sent).toEqual([]);
  expect(h.syncLogs.some(m=>m.includes('Debounced broadcast failed'))).toBe(true);
  h.overrides['browser.tmDeviceSync.getState']=async()=> 'open';
  await h.sync.connect();
  await h.sync.handleMessage(JSON.stringify({type:'connected',userId:'synthetic'}));
  expect(h.sent.find(m=>m.type==='prompt_state')?.data?.templates).toEqual(value);
});
