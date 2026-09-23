import { expect, it, vi } from 'vitest';
import { experimentFunctions } from './helpers/experimentFunctions.js';

it('retries an unanswered startup request and applies the selected identity from the response', async () => {
  const response = {
    ok: true,
    selectedMessageIds: ['synthetic-account:/Inbox:message-7'],
    selectionCount: 1,
  };
  const timers = [];
  const updates = [];
  const sendMessage = vi.fn()
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce(response);
  const globals = {
    browser: {
      runtime: {
        onMessage: { addListener: vi.fn() },
        sendMessage,
      },
    },
    messageSelectionListener: null,
    cleanupMessageSelectionListener: vi.fn(),
    updateSelectionFromMessage: message => updates.push(message),
    updateSelectionIndicator: vi.fn(),
    log: vi.fn(),
    setTimeout: fn => { timers.push(fn); return timers.length; },
  };
  const { initMessageSelectionTracking } = experimentFunctions(
    new URL('../chat/chat.js', import.meta.url), ['initMessageSelectionTracking'], globals,
  );

  await initMessageSelectionTracking();
  expect(sendMessage).toHaveBeenCalledTimes(1);
  expect(timers).toHaveLength(1);
  timers.shift()();
  await vi.waitFor(() => expect(updates).toHaveLength(1));
  expect(sendMessage).toHaveBeenCalledTimes(2);
  expect(updates).toEqual([response]);
});
