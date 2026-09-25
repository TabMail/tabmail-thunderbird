import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function recoveryHarness() {
  const source = readFileSync(new URL('../chat/background.js', import.meta.url), 'utf8');
  const start = source.indexOf('const FTS_RECHECK_ALARM =');
  const end = source.indexOf('// Initialize FTS engine FIRST', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);

  let available = false;
  let alarmListener;
  const initFtsEngine = vi.fn(async () => {});
  const recheckFtsHelperAvailable = vi.fn(async () => { available = true; return true; });
  const checkAndRunInitialFtsScan = vi.fn(async () => {});
  const alarms = {
    create: vi.fn(),
    clear: vi.fn(),
    onAlarm: { addListener: vi.fn(callback => { alarmListener = callback; }) },
  };
  const sandbox = {
    browser: { alarms },
    getFtsHelperAvailable: () => available,
    getFtsHelperStatus: () => ({ status: available ? 'available' : 'missing' }),
    recheckFtsHelperAvailable,
    initFtsEngine,
    checkAndRunInitialFtsScan,
    setWarning: vi.fn(async () => {}),
    log: vi.fn(),
  };
  vm.createContext(sandbox);
  vm.runInContext(`${source.slice(start, end)}\nthis.probe = probeFtsAvailability;`, sandbox);
  return { sandbox, alarms, initFtsEngine, recheckFtsHelperAvailable,
    checkAndRunInitialFtsScan, probe: sandbox.probe,
    fireAlarm: () => alarmListener({ name: 'tabmail-fts-helper-recheck' }) };
}

describe('FTS helper recovery', () => {
  it('starts the engine and incremental startup path after a missing helper returns', async () => {
    const app = recoveryHarness();
    const first = app.probe();
    const second = app.probe();
    await Promise.all([first, second]);

    expect(app.recheckFtsHelperAvailable).toHaveBeenCalledTimes(1);
    expect(app.initFtsEngine).toHaveBeenCalledTimes(1);
    expect(app.checkAndRunInitialFtsScan).toHaveBeenCalledTimes(1);
    expect(app.alarms.clear).toHaveBeenCalledWith('tabmail-fts-helper-recheck');
  });

  it('keeps the alarm armed and retries when engine initialization fails after native reconnect', async () => {
    const app = recoveryHarness();
    app.initFtsEngine.mockRejectedValueOnce(new Error('indexer failed'));

    await app.probe();
    expect(app.alarms.create).toHaveBeenCalledWith('tabmail-fts-helper-recheck', { periodInMinutes: 1 });
    expect(app.checkAndRunInitialFtsScan).not.toHaveBeenCalled();

    app.fireAlarm();
    await vi.waitFor(() => expect(app.initFtsEngine).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(app.checkAndRunInitialFtsScan).toHaveBeenCalledTimes(1));
    expect(app.alarms.clear).toHaveBeenCalledWith('tabmail-fts-helper-recheck');
  });
});
