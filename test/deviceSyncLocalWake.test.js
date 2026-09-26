import { expect, it, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';

afterEach(() => vi.useRealTimers());
async function harness({ enabled = true, connectEarly = true, failFirstAdd = false } = {}) {
  vi.useFakeTimers();
  const listeners = new Set(), stored = { device_sync_auto_enabled: enabled }, sent = [];
  let adds = 0;
  const onChanged = { addListener: fn => { if (failFirstAdd && ++adds === 1) throw new Error("synthetic registration failure"); listeners.add(fn); }, removeListener: fn => listeners.delete(fn) };
  const overrides = {
    'browser.runtime.getManifest': () => ({version: 'synthetic'}),
    'browser.storage.onChanged': onChanged,
    'browser.storage.local.get': async keys => typeof keys === 'string'
      ? { [keys]: stored[keys] } : Object.fromEntries((Array.isArray(keys) ? keys : Object.keys(keys)).map(k => [k, stored[k] ?? keys[k]])),
    'browser.storage.local.set': async values => Object.assign(stored, values),
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
    const scope = { console: {log(){},warn(){},error(){}}, Date, performance, browser,
      window: {}, navigator: {}, setTimeout, clearTimeout, setInterval, clearInterval,
      log(){}, SETTINGS: {}, ...supplied };
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
    const context=vm.createContext(scope); vm.runInContext(source,context,{filename:file}); return context;
  }
  const sync=evaluate('agent/modules/deviceSync.js');
  if (connectEarly) await sync.connect(); // Parent socket may already be open before module reconnect.
  evaluate('agent/background.js', {
    setupStorageListener: sync.setupStorageListener,
    attachDeviceSyncTransportListener: sync.attachDeviceSyncTransportListener,
    setAICacheProbeHandler: sync.setAICacheProbeHandler,
    ensureActionTags: () => new Promise(() => {}),
    setTimeout: () => 1, setInterval: () => 1,
  });
  return {sync,stored,sent,listeners,async edit() {
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
it('does not timestamp or broadcast edits while auto-sync is disabled', async () => {
  const h = await harness({ enabled: false });
  await h.edit();
  expect(h.stored['device_sync_ts:templates']).toBeUndefined();
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
it('does not echo a remotely applied storage event after suppression is released', async () => {
  const h = await harness();
  vm.runInContext('suppressBroadcast = true', h.sync);
  const work = h.edit();
  vm.runInContext('suppressBroadcast = false', h.sync);
  await work;
  expect(h.stored['device_sync_ts:templates']).toBeUndefined();
  expect(h.sent).toEqual([]);
});
it('drops an edit whose enabled check overlaps explicit disconnect', async () => {
  const h = await harness();
  const work = h.edit();
  await h.sync.disconnect();
  await work;
  expect(h.stored['device_sync_ts:templates']).toBeUndefined();
  expect(h.sent).toEqual([]);
});
