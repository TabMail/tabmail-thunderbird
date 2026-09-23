import { it, expect } from 'vitest';
import { experiment, makeWindow } from './helpers/nativeLifecycleHarness.js';

async function drain(x, turns = 12) {
  for (let i = 0; i < turns; i++) {
    for (const finish of x.queued.splice(0)) finish();
    await new Promise(resolve => setImmediate(resolve));
  }
}

it('retired theme observer cannot register a sheet after handoff and true shutdown', async () => {
  const w = makeWindow();
  const x = experiment('theme/experiments/tmTheme/tmTheme.sys.mjs', 'tmTheme', { windows: [w.win], holdFetch: true });
  const first = x.api.init();
  await drain(x); await first;
  expect(x.sheets.size).toBe(1);
  expect(x.observers.get('look-and-feel-changed').size).toBe(1);
  const next = x.instance.getAPI({ extension: x.context.extension }).tmTheme;
  const replacement = next.init();
  await new Promise(resolve => setImmediate(resolve));
  expect(x.queued.length).toBe(3);
  x.Services.obs.notifyObservers(null, 'look-and-feel-changed');
  // Complete the replacement read. The retired callback now starts its own
  // privileged reads while the extension is still enabled.
  for (const finish of x.queued.splice(0)) finish();
  await new Promise(resolve => setImmediate(resolve));
  expect(x.queued.length).toBe(0);
  await replacement;
  x.instance.onShutdown(false);
  expect(x.sheets.size).toBe(0);
  await drain(x); await replacement;
  expect(x.sheets.size).toBe(0);
});

it('retired theme media callback cannot register a sheet after handoff and true shutdown', async () => {
  const w = makeWindow();
  const x = experiment('theme/experiments/tmTheme/tmTheme.sys.mjs', 'tmTheme', { windows: [w.win], holdFetch: true });
  const first = x.api.init();
  await drain(x); await first;
  const replacement = x.instance.getAPI({ extension: x.context.extension }).tmTheme.init();
  await new Promise(resolve => setImmediate(resolve));
  w.media.dispatch('change', { matches: true });
  for (const finish of x.queued.splice(0)) finish();
  await new Promise(resolve => setImmediate(resolve));
  expect(x.queued.length).toBe(0);
  await replacement;
  x.instance.onShutdown(false);
  await drain(x); await replacement;
  expect(x.sheets.size).toBe(0);
});

for (const name of ['tmTheme', 'tmPreviewGate']) {
  it(`${name}: shutdown with the first context still reading cannot resurrect any owner`, async () => {
    const w = makeWindow();
    const x = experiment(`theme/experiments/${name}/${name}.sys.mjs`, name, { windows: [w.win], holdFetch: true });
    const first = x.api.init();
    await new Promise(resolve => setImmediate(resolve));
    expect(x.queued.length).toBeGreaterThan(0);
    const replacement = x.instance.getAPI({ extension: x.context.extension })[name].init();
    x.instance.onShutdown(false);
    await drain(x);
    await Promise.all([first, replacement]);
    expect(x.sheets.size).toBe(0);
    expect(x.windowListeners.size).toBe(0);
    expect(w.media.handlers.get('change')?.size || 0).toBe(0);
    expect(w.tree.handlers.get('select')?.size || 0).toBe(0);
  });
}

it('preview attribute and beforeunload callbacks use the new context enablement', async () => {
  const w = makeWindow();
  const classes = new Set();
  w.doc.documentElement.classList = { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c) };
  const get = w.doc.getElementById;
  w.doc.getElementById = id => id === 'messagepane' ? w.pane : get(id);
  const x = experiment('theme/experiments/tmPreviewGate/tmPreviewGate.sys.mjs', 'tmPreviewGate', { windows: [w.win] });
  await x.api.init();
  const next = x.instance.getAPI({ extension: x.context.extension }).tmPreviewGate;
  await next.init();
  const observer = w.doc.__tmPreviewGateAuto.paneMO;
  expect(observer).toBeTruthy();
  for (const enabled of [true, false]) {
    await next.setPreviewAutoGateEnabled({ enabled });
    classes.clear();
    observer.callback([{ type: 'attributes', attributeName: 'src' }]);
    expect(classes.has('tm-message-preview-gated')).toBe(enabled);
    classes.clear();
    w.cw.dispatch('beforeunload');
    expect(classes.has('tm-message-preview-gated')).toBe(enabled);
  }
  x.instance.onShutdown(false);
});
