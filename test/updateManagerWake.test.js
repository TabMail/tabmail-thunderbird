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
      showUpdateBar: vi.fn(async ({ version: next }) => { version = next; visible = true; }),
      getPendingUpdateVersion: vi.fn(async () => version),
      dismissUpdateBar: vi.fn(async () => { visible = false; }),
      hideUpdateBar: vi.fn(async () => { version = null; visible = false; }),
      restartThunderbird: vi.fn(async () => {}),
    };
    const first = startManager(parent);
    expect(Object.keys(first).sort()).toEqual(['action', 'message', 'update']);
    await first.message({ command: 'setPendingUpdate', version: '99.0.0' });
    expect(visible).toBe(true);

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
      showUpdateBar: vi.fn(async ({ version: next }) => { version = next; }),
      getPendingUpdateVersion: vi.fn(async () => version),
      dismissUpdateBar: vi.fn(async () => {}),
      hideUpdateBar: vi.fn(async () => {}),
      restartThunderbird: vi.fn(async () => {}),
    };
    const listeners = startManager(parent);
    await listeners.update({ version: '99.0.1' });
    expect(await listeners.message({ command: 'getUpdateState' })).toMatchObject({
      updateState: 'pending', pendingVersion: '99.0.1',
    });
    await listeners.action({ action: 'restart' });
    expect(parent.restartThunderbird).toHaveBeenCalledTimes(1);
  });
});
