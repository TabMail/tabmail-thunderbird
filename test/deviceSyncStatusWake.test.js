import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from 'acorn';
import { expect, it } from 'vitest';

const syncSource = readFileSync(new URL('../agent/modules/deviceSync.js', import.meta.url), 'utf8');
const addStatusNode = parse(syncSource, { ecmaVersion: 'latest', sourceType: 'module' }).body.find(n => n.type === 'ExportNamedDeclaration' && n.declaration?.id?.name === 'addStatusListener').declaration;
const source = readFileSync(new URL('../agent/background.js', import.meta.url), 'utf8');
const functions = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }).body
  .filter(n => n.type === 'FunctionDeclaration' && ['cleanupRuntimeListeners', 'setupRuntimeMessageListener'].includes(n.id.name));
function fixture(state, cached = false) {
  let listener, reads = 0;
  const writes = [], callbacks = new Set();
  const addStatusListener = runInNewContext(syncSource.slice(addStatusNode.start, addStatusNode.end) + ';addStatusListener', { statusListeners: callbacks, connected: cached });
  runInNewContext('let agentRuntimeMessageListener=null;\n' + functions.map(n => source.slice(n.start, n.end)).join('\n')
    .replaceAll('await import(', 'await loadModule(') + '\nsetupRuntimeMessageListener();', {
    browser: {
      storage: { local: { set: async value => { writes.push(value); } } },
      runtime: { onMessage: { addListener: fn => { listener = fn; }, removeListener() {} } },
      tmDeviceSync: { getState: async () => { reads++; if (state instanceof Error) throw state; return state; } },
    },
    log() {},
    loadModule: async path => { expect(path).toBe('./modules/deviceSync.js'); return { isConnected: () => cached, addStatusListener }; },
  });
  return {
    request: (command = 'device-sync-status') => new Promise(resolve => { expect(listener({ command }, {}, resolve)).toBe(true); }),
    reads: () => reads, writes, callbacks,
  };
}
it('reports the retained open parent socket before fresh background initialization', async () => {
  const h = fixture('open', false);
  expect(await h.request()).toEqual({ ok: true, connected: true }); expect(h.reads()).toBe(1);
});
it.each(['closed', 'connecting', 'retrying'])('reports parent %s despite a stale cached connected flag', async state => {
  const h = fixture(state, true);
  expect(await h.request()).toEqual({ ok: true, connected: false }); expect(h.reads()).toBe(1);
});
it('returns the existing safe response when parent status lookup fails', async () => {
  const h = fixture(new Error('synthetic unavailable'), true);
  expect(await h.request()).toEqual({ ok: true, connected: false }); expect(h.reads()).toBe(1);
});

it('registers once after wake without publishing the reset module mirror', async () => {
  const h = fixture('open', false);
  expect(await h.request()).toEqual({ ok: true, connected: true });
  expect(await h.request('device-sync-add-listener')).toEqual({ ok: true, connected: true });
  expect(await h.request('device-sync-add-listener')).toEqual({ ok: true, connected: true });
  expect(h.writes).toEqual([]);
  expect(h.callbacks.size).toBe(1);
  for (const callback of h.callbacks) callback(false);
  expect(h.writes).toEqual([{ _deviceSyncConnected: false }]);
});
it.each(['closed', 'connecting', 'retrying'])('registers with parent %s instead of the stale connected mirror', async state => {
  const h = fixture(state, true);
  expect(await h.request('device-sync-add-listener')).toEqual({ ok: true, connected: false });
  expect(h.reads()).toBe(1);
  expect(h.writes).toEqual([]);
});
it('keeps registration safe when the parent lookup fails', async () => {
  const h = fixture(new Error('synthetic unavailable'), true);
  expect(await h.request('device-sync-add-listener')).toEqual({ ok: true, connected: false });
  expect(h.writes).toEqual([]);
  expect(h.callbacks.size).toBe(1);
});
