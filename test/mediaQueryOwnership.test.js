import { it, expect } from 'vitest';
import { experiment, makeWindow } from './helpers/nativeLifecycleHarness.js';

it('native MediaQueryList identity stays bounded across context handoffs and shutdown', async () => {
  const w = makeWindow();
  const mediaLists = [];
  w.win.matchMedia = () => {
    const media = makeWindow().media;
    mediaLists.push(media);
    return media;
  };
  const live = () => mediaLists.reduce((n, media) => n + (media.handlers.get('change')?.size || 0), 0);
  const x = experiment('theme/experiments/tmTheme/tmTheme.sys.mjs', 'tmTheme', { windows: [w.win] });
  await x.api.init();
  expect(live()).toBe(1);
  for (let wake = 0; wake < 3; wake++) {
    await x.instance.getAPI({ extension: x.context.extension }).tmTheme.init();
  }
  console.log('live native media listeners after 3 handoffs:', live());
  expect.soft(live()).toBe(1);
  x.instance.onShutdown(false);
  console.log('live native media listeners after shutdown:', live());
  expect.soft(live()).toBe(0);
  expect(x.sheets.size).toBe(0);
  for (const media of mediaLists) media.dispatch('change', { matches: true });
  for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve));
  console.log('stylesheets after post-shutdown theme change:', x.sheets.size);
  expect(x.sheets.size).toBe(0);
});
