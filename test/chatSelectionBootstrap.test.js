import { expect, it, vi } from 'vitest';
import { experimentFunctions } from './helpers/experimentFunctions.js';

it('does not let an older startup reply replace a newer selection event', async () => {
  let resolveReply;
  let onMessage;
  const updates = [];
  const globals = {
    browser: { runtime: {
      onMessage: { addListener: fn => { onMessage = fn; } },
      sendMessage: () => new Promise(resolve => { resolveReply = resolve; }),
    } },
    messageSelectionListener: null,
    cleanupMessageSelectionListener: vi.fn(),
    updateSelectionFromMessage: message => updates.push(message.selectedMessageIds),
    log: vi.fn(),
    setTimeout: vi.fn(),
  };
  const { initMessageSelectionTracking } = experimentFunctions(
    new URL('../chat/chat.js', import.meta.url), ['initMessageSelectionTracking'], globals,
  );
  const startup = initMessageSelectionTracking();
  onMessage({ command: 'selection-changed', selectedMessageIds: ['new'], selectionCount: 1 });
  resolveReply({ ok: true, selectedMessageIds: ['old'], selectionCount: 1 });
  await startup;
  expect(updates).toEqual([['new']]);
});

it('rechecks an initially empty selection while the mail window finishes loading', async () => {
  const timers = [];
  const updates = [];
  const sendMessage = vi.fn()
    .mockResolvedValueOnce({ ok: true, selectedMessageIds: [], selectionCount: 0 })
    .mockResolvedValueOnce({ ok: true, selectedMessageIds: ['ready'], selectionCount: 1 });
  const globals = {
    browser: { runtime: { onMessage: { addListener: vi.fn() }, sendMessage } },
    messageSelectionListener: null,
    cleanupMessageSelectionListener: vi.fn(),
    updateSelectionFromMessage: message => updates.push(message.selectedMessageIds),
    log: vi.fn(),
    setTimeout: fn => { timers.push(fn); },
  };
  const { initMessageSelectionTracking } = experimentFunctions(
    new URL('../chat/chat.js', import.meta.url), ['initMessageSelectionTracking'], globals,
  );
  await initMessageSelectionTracking();
  expect(timers).toHaveLength(1);
  timers.shift()();
  await vi.waitFor(() => expect(updates.at(-1)).toEqual(['ready']));
  expect(sendMessage).toHaveBeenCalledTimes(2);
  expect(updates.at(-1)).toEqual(['ready']);
});

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
