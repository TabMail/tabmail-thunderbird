import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../updates/background.js', import.meta.url), 'utf8');

function startManager(parent) {
  const listeners = {};
  const browser = {
    tmUpdates: parent,
    runtime: {
      getManifest: () => ({ version: '1.8.3' }),
      onUpdateAvailable: { addListener: callback => { listeners.update = callback; } },
      onMessage: { addListener: callback => { listeners.message = callback; } },
    },
  };
  parent.onNotificationAction = { addListener: callback => { listeners.action = callback; } };
  vm.runInNewContext(source, { browser, console }, { filename: 'updates/background.js' });
  return listeners;
}

describe('update manager across suspended background generations', () => {
  it('registers wake listeners synchronously and recovers a pending version from the parent', async () => {
    let version = null;
    let visible = false;
    const parent = {
      showUpdateBar: vi.fn(async () => { visible = true; }),
      setPendingUpdateVersion: vi.fn(async next => { version = next; }),
      getPendingUpdateVersion: vi.fn(async () => version),
      dismissUpdateBar: vi.fn(async () => { visible = false; }),
      hideUpdateBar: vi.fn(async () => { visible = false; }),
      clearPendingUpdateVersion: vi.fn(async () => { version = null; }),
      restartThunderbird: vi.fn(async () => {}),
    };
    const first = startManager(parent);
    expect(Object.keys(first).sort()).toEqual(['action', 'message', 'update']);
    await first.message({ command: 'setPendingUpdate', version: '99.0.0' });
    expect(visible).toBe(true);
    expect(parent.setPendingUpdateVersion).toHaveBeenCalledExactlyOnceWith('99.0.0');

    // A new module instance models a fresh background after suspension while
    // the Thunderbird parent and its pending-update state remain alive.
    const second = startManager(parent);
    expect(await second.message({ command: 'getUpdateState' })).toEqual({
      updateState: 'pending', pendingVersion: '99.0.0', currentVersion: '1.8.3',
    });
    await second.action({ action: 'dismiss' });
    expect(visible).toBe(false);
    expect(await second.message({ command: 'getUpdateState' })).toMatchObject({
      updateState: 'pending', pendingVersion: '99.0.0',
    });
    await second.message({ command: 'clearPendingUpdate' });
    expect(await second.message({ command: 'getUpdateState' })).toMatchObject({
      updateState: null, pendingVersion: null,
    });
    expect(parent.restartThunderbird).not.toHaveBeenCalled();
  });

  it('shows a runtime update after wake and restarts only for the restart action', async () => {
    let version = null;
    const parent = {
      showUpdateBar: vi.fn(async () => {}),
      setPendingUpdateVersion: vi.fn(async next => { version = next; }),
      getPendingUpdateVersion: vi.fn(async () => version),
      dismissUpdateBar: vi.fn(async () => {}),
      hideUpdateBar: vi.fn(async () => {}),
      clearPendingUpdateVersion: vi.fn(async () => { version = null; }),
      restartThunderbird: vi.fn(async () => {}),
    };
    const listeners = startManager(parent);
    await listeners.update({ version: '99.0.1' });
    expect(await listeners.message({ command: 'getUpdateState' })).toMatchObject({
      updateState: 'pending', pendingVersion: '99.0.1',
    });
    await listeners.action({ action: 'restart' });
    expect(parent.restartThunderbird).toHaveBeenCalledTimes(1);
    expect(listeners.message({ command: 'restartForUpdate' })).toBe(false);
    await new Promise(resolve => setImmediate(resolve));
    expect(parent.restartThunderbird).toHaveBeenCalledTimes(2);
  });

  it('answers safely when the experiment is unavailable and ignores unrelated messages', async () => {
    const listeners = startManager({});
    expect(await listeners.message({ command: 'getUpdateState' })).toEqual({
      updateState: null, pendingVersion: null, currentVersion: '1.8.3',
    });
    expect(listeners.message({ command: 'clearPendingUpdate' })).toBe(false);
    expect(listeners.message({ command: 'unrelated' })).toBe(false);
  });

  it('reports a failed bar render to the manual caller while retaining the pending version', async () => {
    let version = null;
    const parent = {
      setPendingUpdateVersion: vi.fn(async next => { version = next; }),
      getPendingUpdateVersion: vi.fn(async () => version),
      showUpdateBar: vi.fn(async () => { throw Error('synthetic bar failure'); }),
      onNotificationAction: { addListener: () => {} },
    };
    const listeners = startManager(parent);
    await expect(listeners.message({ command: 'setPendingUpdate', version: '99.0.0' }))
      .rejects.toThrow('synthetic bar failure');
    expect(await listeners.message({ command: 'getUpdateState' })).toMatchObject({
      updateState: 'pending', pendingVersion: '99.0.0',
    });
  });
});
