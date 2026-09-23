import { it, expect } from 'vitest';
import { experiment, makeWindow } from './helpers/nativeLifecycleHarness.js';

it('tagSort owns a pre-init refresh timer and cancels it on shutdown', () => {
  const w = makeWindow();
  const pending = new Map();
  let nextId = 0;
  w.win.setTimeout = fn => { const id = ++nextId; pending.set(id, fn); return id; };
  w.win.clearTimeout = id => pending.delete(id);
  const sorts = [];
  w.view.sort = (...args) => sorts.push(args);
  const x = experiment('theme/experiments/tagSort/tagSort.sys.mjs', 'tagSort', { windows: [w.win] });

  x.api.refresh();
  expect(pending.size).toBe(1);
  expect(x.columns.size).toBe(0);
  x.instance.onShutdown(false);
  expect(pending.size).toBe(0);
  const sortCount = sorts.length;
  x.api.refresh();
  x.api.refreshImmediate();
  expect(pending.size).toBe(0);
  expect(sorts.length).toBe(sortCount);
  expect(x.columns.size).toBe(0);
});

it('tagSort init still sorts existing windows after a pre-init refresh', () => {
  const w = makeWindow();
  const pending = new Map();
  w.win.setTimeout = fn => { pending.set(1, fn); return 1; };
  w.win.clearTimeout = id => pending.delete(id);
  const sorts = [];
  w.view.sort = (...args) => sorts.push(args);
  const x = experiment('theme/experiments/tagSort/tagSort.sys.mjs', 'tagSort', { windows: [w.win] });
  x.api.refresh();
  x.api.init();
  expect(x.columns.size).toBe(1);
  expect(sorts.length).toBeGreaterThan(0);
  x.instance.onShutdown(false);
  expect(pending.size).toBe(0);
});
