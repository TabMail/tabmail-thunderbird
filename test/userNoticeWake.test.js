import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, it } from 'vitest';

const source = readFileSync(new URL('../agent/modules/userNotice.js', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '').replace('export async function notifyCannotTagSelf', 'async function notifyCannotTagSelf');
const url = 'moz-extension://synthetic/agent/cannot-tag-self.html';
function fixture(initial = []) {
  const windows = new Map(initial.map(w => [w.id, w]));
  const created = [], focused = [], errors = [];
  let next = 100, failCreate = false, pendingUrl = false;
  const browser = {
    runtime: { getURL: p => `moz-extension://synthetic/${p}` },
    windows: {
      getAll: async options => [...windows.values()]
        .filter(w => !options?.windowTypes || options.windowTypes.includes(w.type))
        .map(w => options?.populate ? w : { id: w.id, type: w.type }),
      get: async id => { if (!windows.has(id)) throw Error('closed'); return windows.get(id); },
      update: async id => { if (!windows.has(id)) throw Error('closed'); focused.push(id); },
      create: async options => {
        if (failCreate) { failCreate = false; throw Error('temporary failure'); }
        const w = { id: next++, type: options.type, tabs: [{ url: pendingUrl ? undefined : options.url }] };
        windows.set(w.id, w); created.push(w); return w;
      },
    },
    notifications: { create: async () => {} },
  };
  function wake() {
    const context = vm.createContext({ browser, SETTINGS: {}, log: (message, level) => { if (level === 'warn') errors.push(message); } });
    vm.runInContext(source, context);
    return context.notifyCannotTagSelf;
  }
  return { windows, created, focused, errors, wake, failNextCreate() { failCreate = true; }, delayUrl() { pendingUrl = true; } };
}
it('rediscovers a retained notice after each fresh background generation', async () => {
  const h = fixture([{ id: 1, type: 'popup', tabs: [{ url: `${url}?count=3` }] }]);
  await h.wake()(); await h.wake()();
  expect(h.created).toEqual([]); expect(h.focused).toEqual([1, 1]); expect(h.errors).toEqual([]);
});
it('coalesces simultaneous first requests and creates again after the notice closes', async () => {
  const h = fixture(), notify = h.wake();
  await Promise.all([notify(), notify(), notify()]);
  expect(h.created).toHaveLength(1);
  h.windows.clear(); await notify();
  expect(h.created).toHaveLength(2); expect(h.errors).toEqual([]);
});
it('does not reuse another popup or a similarly prefixed page', async () => {
  const h = fixture([{ id: 1, type: 'popup', tabs: [{ url: `${url}.other` }] },
    { id: 2, type: 'popup', tabs: [{ url: 'moz-extension://other/agent/cannot-tag-self.html' }] }]);
  await h.wake()(); expect(h.created).toHaveLength(1); expect(h.focused).toEqual([]);
});
it('releases the in-flight owner after creation failure so the next request retries', async () => {
  const h = fixture(), notify = h.wake(); h.failNextCreate();
  await notify(); expect(h.created).toHaveLength(0); expect(h.errors).toHaveLength(1);
  await notify(); expect(h.created).toHaveLength(1);
});

it('reuses a just-created notice before its tab URL becomes available', async () => {
  const h = fixture(), notify = h.wake(); h.delayUrl();
  await notify(); await notify();
  expect(h.created).toHaveLength(1); expect(h.focused).toEqual([100]);
});
