import {it,expect} from 'vitest';
import {experiment,makeWindow} from './helpers/nativeLifecycleHarness.js';
it('tag sort removes native pref observer before a later pref change',()=>{
  const w=makeWindow();
  const x=experiment('theme/experiments/tagSort/tagSort.sys.mjs','tagSort',{windows:[w.win]});
  const prefObservers=new Set();
  x.Services.prefs.addObserver=(_key,observer)=>prefObservers.add(observer);
  x.Services.prefs.removeObserver=(_key,observer)=>prefObservers.delete(observer);
  x.api.init();
  expect(prefObservers.size).toBe(1);
  expect(x.columns.size).toBe(1);
  x.instance.onShutdown(false);
  expect.soft(prefObservers.size).toBe(0);
  delete w.win.__tmTagSortLastSortTs;
  for(const observer of prefObservers) observer.observe(null,'nsPref:changed','extensions.tabmail.tagSortEnabled');
  expect(x.columns.size).toBe(0);
});
