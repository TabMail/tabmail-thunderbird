import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
import { SYNC_FIELDS } from '../agent/modules/bullets.js';
import { BulletDevice, BulletRelay, DeviceStore, storeStates } from './support/bulletDevices.js';

afterEach(() => vi.useRealTimers());
async function harness({ enabled = true, connectEarly = true, failFirstAdd = false, fullStartup = false, asyncDelivery = false } = {}) {
  vi.useFakeTimers();
  const listeners = new Set(), stored = { device_sync_auto_enabled: enabled }, sent = [];
  let adds = 0;
  const startupLogs = [], syncLogs = [], bulletCalls = [];
  // The bullet fields' engine (promptStore.js), recorded: what this file checks is the wake and
  // registration of the storage listener, which carries the other fields.
  const promptStore = {
    outgoingBulletState: async (field) => { bulletCalls.push(['outgoing', field]); return { kind: 'messages', messages: [] }; },
    receiveLegacyPromptState: async () => [],
    receiveBulletState: async () => ({ kind: 'ignored' }),
    bulletSyncDisconnected: () => bulletCalls.push(['disconnected']),
    // The connect send, through one hold, and the storage listener's history record, in a hold of its own.
    sendBulletState: async (fields) => { for (const field of fields) await promptStore.outgoingBulletState(field); },
    withPromptStore: async (body) => body({ recordHistory: async () => {} }),
  };
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
    const scope = { console: {log(){},warn(){},error(){}}, Date, performance, browser, crypto: globalThis.crypto, SYNC_FIELDS,
      dynamicImport: async path => {
        if (path === "./taskExecutionCache.js") return {getAllCachedResults: async () => stored.task_execution_cache ?? {}};
        if (path === "./promptStore.js") return promptStore;
        throw new Error(`Unexpected fixture import: ${path}`);
      },
      window: {}, navigator: {}, setTimeout, clearTimeout, setInterval, clearInterval,
      log(message){ syncLogs.push(message); }, SETTINGS: { deviceSync: { broadcastDebounceMs: 500, busyReapplyMs: 2000, maxWaitingReceives: 256, historyDebounceMs: 2000 } }, ...supplied };
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
  // A local edit of the task cache, the one field still written outside a hold of the prompt store,
  // which the storage listener stamps and sends.
  return {sync,stored,sent,listeners,evaluate,startupLogs,syncLogs,overrides,bulletCalls,async edit() {
    const value={'synthetic-key':{result:'Synthetic local edit',ts:new Date().toISOString()}};
    stored.task_execution_cache=value;
    for (const listener of [...listeners]) await listener({task_execution_cache:{newValue:value}},'local');
    await vi.advanceTimersByTimeAsync(500);
    return value;
  }};
}
it('timestamps and broadcasts the first local edit while startup is awaiting', async () => {
  const h=await harness(); const value=await h.edit();
  expect(h.stored['device_sync_ts:taskCache']).toEqual(expect.any(String));
  expect(h.sent).toHaveLength(1);
  expect(h.sent[0]).toMatchObject({type:'prompt_state',data:{taskCache:value,taskCache_updated_at:h.stored['device_sync_ts:taskCache']}});
  expect(h.listeners.size).toBe(1);
});
it('warm registration handles the same local edit as a positive control', async () => {
  const h=await harness(); h.sync.setupStorageListener(); h.sync.setupStorageListener();
  const value=await h.edit();
  expect(h.stored['device_sync_ts:taskCache']).toEqual(expect.any(String));
  expect(h.sent).toHaveLength(1);
  expect(h.sent[0]).toMatchObject({type:'prompt_state',data:{taskCache:value}});
  expect(h.listeners.size).toBe(1);
});

it('reconnects the module to its existing parent before the first broadcast', async () => {
  const h = await harness({ connectEarly: false });
  const value = await h.edit();
  expect(h.sent).toHaveLength(1);
  expect(h.sent[0]).toMatchObject({ type: 'prompt_state', data: { taskCache: value } });
});
// A field edited in a hold of the prompt store is stamped in its own write and sent the same way.
it.each([true, false])('stamps and sends a held local edit made right after a wake (module connected first: %s)', async (connectEarly) => {
  const h = await harness({ connectEarly });
  const value = [{ id: 'synthetic-template', name: 'Synthetic held edit' }];
  expect(await h.sync.writeField('templates', value, () => true, { edit: true })).toBe(true);
  await vi.advanceTimersByTimeAsync(500);
  expect(h.stored['device_sync_ts:templates']).toEqual(expect.any(String));
  expect(h.sent).toHaveLength(1);
  expect(h.sent[0]).toMatchObject({ type: 'prompt_state', data: { templates: value, templates_updated_at: h.stored['device_sync_ts:templates'] } });
});
it('timestamps local edits while auto-sync is disabled without sending', async () => {
  const h = await harness({ enabled: false });
  await h.edit();
  expect(h.stored['device_sync_ts:taskCache']).toEqual(expect.any(String));
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
  expect(h.stored['device_sync_ts:taskCache']).toBeUndefined();
  expect(h.sent).toEqual([]);
});
it('preserves edit timestamps when disconnect occurs before the broadcast debounce', async () => {
  const h = await harness();
  const work = h.edit();
  await h.sync.disconnect();
  await work;
  expect(h.stored['device_sync_ts:taskCache']).toEqual(expect.any(String));
  expect(h.sent).toEqual([]);
});

it('never timestamps, records or sends a change of the bullet fields\' own keys, another area or an unrelated key', async () => {
  const h = await harness();
  for (const listener of h.listeners) {
    listener({'user_prompts:user_kb.md':{newValue:'Local markdown'}, 'bullet_state:kb':{newValue:{bullets:[],seen:{}}}}, 'local');
    listener({'user_prompts:user_composition.md':{newValue:'Local markdown'}}, 'local');
    listener({'user_prompts:user_kb.md':{newValue:'Other area'}}, 'sync');
    listener({unrelated:{newValue:true}}, 'local');
  }
  await vi.advanceTimersByTimeAsync(2000);
  expect(Object.keys(h.stored).filter(key => key.startsWith('device_sync_ts:'))).toEqual([]);
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
  await local.sync.handleMessage(JSON.stringify({type:'connected',userId:'synthetic'}));
  // The other fields are asked for; the bullet fields are sent as labelled bullets, never asked for.
  expect(local.sent.map(message => message.type)).toEqual(['request_state']);
  expect(local.sent[0].fields.filter(field => SYNC_FIELDS.includes(field))).toEqual([]);
  expect(local.bulletCalls.filter(([call]) => call === 'outgoing').map(([, field]) => field)).toEqual(SYNC_FIELDS);
});

it('retries a failed early subscription through completed startup with one owner', async () => {
  const h = await harness({fullStartup:true,failFirstAdd:true});
  expect(h.listeners.size).toBe(1);
  const value = await h.edit();
  expect(h.sent).toHaveLength(1);
  expect(h.sent[0]).toMatchObject({type:'prompt_state',data:{taskCache:value}});
});

it('contains a first-wake reconnect failure and publishes the preserved edit after reconnect', async () => {
  const h=await harness({connectEarly:false});
  h.overrides['browser.tmDeviceSync.getState']=async()=>{throw new Error('synthetic transport failure');};
  const value=await h.edit();
  expect(h.stored['device_sync_ts:taskCache']).toEqual(expect.any(String));
  expect(h.sent).toEqual([]);
  expect(h.syncLogs.some(m=>m.includes('Debounced broadcast failed'))).toBe(true);
  h.overrides['browser.tmDeviceSync.getState']=async()=> 'open';
  await h.sync.connect();
  await h.sync.handleMessage(JSON.stringify({type:'connected',userId:'synthetic'}));
  expect(h.sent.find(m=>m.type==='prompt_state')?.data?.taskCache).toEqual(value);
});

// The bullet fields (knowledge base, composition, action) on simulated devices: the real deviceSync.js,
// promptStore.js and the engine, in a process each.
describe('the bullet fields while sync is off, at startup and on reset', () => {
  const OLDER = '2020-01-01T00:00:00.000Z';

  async function devices(...ids) {
    vi.useFakeTimers();
    const relay = new BulletRelay();
    const started = [];
    for (const id of ids) started.push(await new BulletDevice(id, new DeviceStore(), relay).start());
    return { relay, devices: started };
  }

  async function quiesce(relay) {
    while (await relay.deliverOldest());
  }

  async function texts(device, field = 'kb') {
    return (await device.state(field)).bullets.map((bullet) => bullet.text);
  }

  const wakeCommits = [
    ['an add', (device, text) => device.add('kb', '', text)],
    ['a save of the prompts page', async (device, text) => {
      // The page shows the field read in one hold, and saves against the labels it showed (DS-DISPLAYED).
      const page = device.page(['prompts/modules/markdown.js', 'prompts/modules/storage.js']);
      const view = await page.require('agent/modules/promptStore.js').readView('kb');
      await page.require('prompts/modules/storage.js').editShown('kb', view, (content) => `${content}\n- ${text}`);
    }],
  ];

  /** DS-SEND: the parent keeps the socket while the background page sleeps, and a woken background
   * commits before its startup re-attaches to it. The commit is sent, once. */
  it.each(wakeCommits)('sends %s made right after the background wakes, before startup reconnects it', async (_, commit) => {
    const { relay, devices: [a, b] } = await devices('A', 'B');
    await a.connect();
    await b.connect();
    await quiesce(relay);
    await a.start();
    const before = relay.sent('A', 'kb');
    await commit(a, 'Typed right after the wake');
    await quiesce(relay);
    expect(relay.sent('A', 'kb')).toBe(before + 1);
    expect(await texts(b)).toContain('Typed right after the wake');
  });

  /** ...and with the parent's socket closed, a woken background's commit is kept and no send is tried. */
  it.each(wakeCommits)('tries no send of %s made right after a wake while the socket is closed', async (_, commit) => {
    const { relay, devices: [a, b] } = await devices('A', 'B');
    await a.connect();
    await b.connect();
    await quiesce(relay);
    relay.leave('A');
    await a.start();
    const before = relay.sent('A', 'kb');
    const logged = a.logs.length;
    await commit(a, 'Typed right after the wake');
    await quiesce(relay);
    expect(relay.sent('A', 'kb')).toBe(before);
    expect(a.logs.slice(logged).filter((entry) => entry.message.includes('could not be sent'))).toEqual([]);
    expect(await texts(a)).toContain('Typed right after the wake');
    expect(await texts(b)).not.toContain('Typed right after the wake');
  });

  /** The parent's answer is not kept: sync turned off while a woken background waits for it stays off,
   * and nothing is sent or tried. */
  it('sends nothing, and stays disconnected, when sync is turned off while a woken background asks the parent', async () => {
    const { relay, devices: [a, b] } = await devices('A', 'B');
    await a.connect();
    await b.connect();
    await quiesce(relay);
    await a.start();
    const transport = a.realm.context.browser.tmDeviceSync;
    const getState = transport.getState;
    let release;
    let asked;
    const askedOnce = new Promise((resolve) => { asked = resolve; });
    transport.getState = () => {
      transport.getState = getState;
      asked();
      return new Promise((resolve) => { release = () => resolve('open'); });
    };
    const before = relay.sent('A', 'kb');
    const adding = a.add('kb', '', 'Typed while sync goes off');
    await askedOnce;
    await a.sync.setAutoEnabled(false);
    release();
    await adding;
    await quiesce(relay);
    expect(relay.sent('A', 'kb')).toBe(before);
    expect(relay.closedSends.filter(({ from }) => from === 'A')).toEqual([]);
    expect(a.sync.isConnected()).toBe(false);
    expect(await texts(a)).toContain('Typed while sync goes off');
  });

  /** Only an open socket is sent on: a parent still connecting or retrying gets nothing. */
  it.each(['connecting', 'retrying'])('a woken background whose parent answers %s tries no send', async (state) => {
    const { relay, devices: [a, b] } = await devices('A', 'B');
    await a.connect();
    await b.connect();
    await quiesce(relay);
    await a.start();
    const transport = a.realm.context.browser.tmDeviceSync;
    const getState = transport.getState;
    transport.getState = async () => state;
    try {
      const before = relay.sent('A', 'kb');
      await a.add('kb', '', 'Typed while it connects');
      await quiesce(relay);
      expect(relay.sent('A', 'kb')).toBe(before);
      expect(relay.closedSends.filter(({ from }) => from === 'A')).toEqual([]);
      expect(await texts(b)).not.toContain('Typed while it connects');
    } finally {
      transport.getState = getState;
    }
  });

  it('keeps an edit made while sync is off, records it, sends nothing, and sends it as labelled bullets once sync is back on', async () => {
    const { relay, devices: [a, b] } = await devices('A', 'B');
    await b.connect();
    await a.sync.setAutoEnabled(false);
    await a.add('kb', '', 'Paused fact');
    await vi.advanceTimersByTimeAsync(2500);
    expect(relay.isConnected('A')).toBe(false);
    expect(relay.sent('A', 'kb')).toBe(0);
    expect(a.store.values.prompt_history).toEqual([expect.objectContaining({ source: 'local_edit', fields: ['kb'] })]);

    await a.sync.setAutoEnabled(true);
    expect(relay.isConnected('A')).toBe(true);
    await a.receive({ type: 'connected', userId: 'synthetic-user' });
    await quiesce(relay);
    expect(await texts(b)).toContain('Paused fact');
  });

  it('turning sync off sends nothing for a later edit and does not reconnect', async () => {
    const { relay, devices: [a, b] } = await devices('A', 'B');
    await a.connect();
    await b.connect();
    await quiesce(relay);
    const before = relay.sent('A', 'kb');
    await a.sync.setAutoEnabled(false);
    await a.add('kb', '', 'Edit after pausing');
    await vi.advanceTimersByTimeAsync(2500);
    expect(relay.isConnected('A')).toBe(false);
    expect(relay.sent('A', 'kb')).toBe(before);
    expect(await texts(b)).not.toContain('Edit after pausing');
  });

  it('a released device\'s older knowledge base arriving after an unsynced edit only adds its bullets', async () => {
    const { devices: [a] } = await devices('A');
    await a.sync.setAutoEnabled(false);
    await a.add('kb', '', 'Unsynced fact');
    await a.receive({ type: 'prompt_state', data: { kb: '- Older peer fact', kb_updated_at: OLDER } });
    expect(await texts(a)).toEqual(expect.arrayContaining(['Unsynced fact', 'Older peer fact']));
  });

  it('a new install\'s defaults never overwrite a peer\'s customized knowledge base', async () => {
    const relay = new BulletRelay();
    vi.useFakeTimers();
    const store = new DeviceStore();
    // The peer deleted every default and wrote its own.
    storeStates(store, { kb: { bullets: [['', 'Customized peer fact', 'aaaaaaaaaaaaaaaa', 1]], seen: { aaaaaaaaaaaaaaaa: 1, 'default:kb-1': 1, 'default:kb-2': 1, 'default:kb-3': 1 } } });
    const peer = await new BulletDevice('P', store, relay).start();
    const fresh = await new BulletDevice('N', new DeviceStore(), relay).start();
    await peer.connect();
    await fresh.connect();
    await quiesce(relay);
    expect(await texts(peer)).toEqual(['Customized peer fact']);
    expect(await texts(fresh)).toEqual(['Customized peer fact']);
    // Nothing went out in the released format but the bullet fields empty at epoch zero.
    for (const { message } of relay.legacy.filter(({ message }) => message.type === 'prompt_state')) {
      for (const field of SYNC_FIELDS) expect(message.data[field] ?? '').toBe('');
    }
  });

  it('a reset sends the defaults, records the state it replaced, and a peer\'s own bullets stay on both devices', async () => {
    const { relay, devices: [a, b] } = await devices('A', 'B');
    await a.connect();
    await b.connect();
    await b.add('kb', '', 'Synthetic custom rule');
    await quiesce(relay);
    expect(await texts(a)).toContain('Synthetic custom rule');
    await a.reset('kb');
    await quiesce(relay);
    expect(a.store.values.prompt_history.map((entry) => entry.source)).toContain('reset');
    for (const device of [a, b]) expect(await texts(device)).toContain('Synthetic custom rule');
    for (const { message } of relay.legacy.filter(({ from, message }) => from === 'A' && message.type === 'prompt_state')) expect(message.data.kb ?? '').toBe('');
  });
});
