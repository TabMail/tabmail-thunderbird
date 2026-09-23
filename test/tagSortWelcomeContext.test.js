import { it, expect, vi } from 'vitest';
import { experiment, makeWindow } from './helpers/nativeLifecycleHarness.js';
import { createAppearanceHandlers } from '../welcome/modules/appearanceHandlers.js';

it('welcome sort-order choice restores an existing inbox through its own API context', async () => {
  const w=makeWindow();
  const sorts=[];
  w.view.sort=(...args)=>sorts.push(args);
  const x=experiment('theme/experiments/tagSort/tagSort.sys.mjs','tagSort',{windows:[w.win]});
  x.api.init();
  expect(sorts.length).toBeGreaterThan(0);
  sorts.length=0;
  // After startup a native header click can choose a different sort; the
  // wizard's explicit Newest First action must reapply TabMail sorting.
  delete w.win.__tmTagSortLastSortTs;
  const wizard=x.instance.getAPI({extension:x.context.extension}).tagSort;
  const previous=globalThis.browser;
  globalThis.browser={tagSort:wizard,tmPrefs:{setInt:vi.fn(async()=>{})}};
  try {
    const handlers=createAppearanceHandlers({getFlattenedSteps:()=>[]});
    await handlers.applySortOrderImmediately('descending');
    expect(globalThis.browser.tmPrefs.setInt).toHaveBeenCalledWith('mailnews.default_sort_order',2);
    expect(sorts).toEqual([[18,2],[99,2]]);
  } finally {globalThis.browser=previous;x.instance.onShutdown(false);}
});

it('repeated settings-page refresh contexts share bounded shutdown ownership', () => {
  const w=makeWindow();
  const x=experiment('theme/experiments/tagSort/tagSort.sys.mjs','tagSort',{windows:[w.win]});
  x.api.init();
  for(let i=0;i<100;i++) {
    const context={extension:x.context.extension};
    x.instance.getAPI(context).tagSort.refreshImmediate();
  }
  expect(x.instance._cleanups.size).toBe(2);
  expect(x.columns.size).toBe(1);
  x.instance.onShutdown(false);
  expect(x.instance._cleanups.size).toBe(0);
  expect(x.columns.size).toBe(0);
});

it('repeated initialized contexts transfer the native sort owner', () => {
  const w=makeWindow();
  const x=experiment('theme/experiments/tagSort/tagSort.sys.mjs','tagSort',{windows:[w.win]});
  x.api.init();
  for(let i=0;i<100;i++) {
    x.instance.getAPI({extension:x.context.extension}).tagSort.init();
    expect(x.instance._cleanups.size).toBe(1);
    expect(x.observers.get('tabmail-sort-order-changed')?.size).toBe(1);
    expect(x.windowListeners.size).toBe(1);
    expect(x.columns.size).toBe(1);
  }
  x.instance.onShutdown(false);
  expect(x.windowListeners.size).toBe(0);
  expect(x.columns.size).toBe(0);
  expect(x.observers.get('tabmail-sort-order-changed')?.size).toBe(0);
});
