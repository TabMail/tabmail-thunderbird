import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from 'acorn';
import { expect, it } from 'vitest';

const source = readFileSync(new URL('../agent/background.js', import.meta.url), 'utf8');
const functions = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }).body
  .filter(n => n.type === 'FunctionDeclaration' && ['cleanupRuntimeListeners', 'setupRuntimeMessageListener'].includes(n.id.name));
function fixture(state, cached = false) {
  let listener, reads = 0;
  runInNewContext('let agentRuntimeMessageListener=null;\n' + functions.map(n => source.slice(n.start, n.end)).join('\n')
    .replaceAll('await import(', 'await loadModule(') + '\nsetupRuntimeMessageListener();', {
    browser: {
      runtime: { onMessage: { addListener: fn => { listener = fn; }, removeListener() {} } },
      tmDeviceSync: { getState: async () => { reads++; if (state instanceof Error) throw state; return state; } },
    },
    log() {},
    loadModule: async path => { expect(path).toBe('./modules/deviceSync.js'); return { isConnected: () => cached }; },
  });
  return {
    request: () => new Promise(resolve => { expect(listener({ command: 'device-sync-status' }, {}, resolve)).toBe(true); }),
    reads: () => reads,
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
