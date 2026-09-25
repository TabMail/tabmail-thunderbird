/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// summaryBannerDisplayPreference.test.js — "Show AI Summaries" is a DISPLAY-only
// preference (issue #34). With it off, agent/modules/summary.js must withhold the
// summary bubble (release the display gate instead) while still generating the
// summary, applying action tags and enqueueing the pipeline.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const showAiSummaries = { value: true };
const sendMessage = vi.fn(async () => undefined);
const getSummary = vi.fn(async () => ({ id: 'key-1', blurb: 'Vendor confirmed Friday.', todos: '' }));
const getAction = vi.fn(async () => 'tm_none');
const runThreadAggregation = vi.fn(async () => undefined);
const enqueueProcessMessage = vi.fn(async () => undefined);

vi.mock('../agent/modules/config.js', () => ({
  SETTINGS: {
    verboseLogging: false,
    debugLogging: false,
    debugMode: false,
    logTruncateLength: 100,
    summaryBanner: { bubbleReadyTimeoutMs: 1, sendRetryDelaysMs: [0, 0, 0] },
    summaryBubble: { defaultBaseFontSizePx: 50 },
    actionTagging: {},
  },
}));
vi.mock('../agent/modules/utils.js', () => ({
  log: vi.fn(),
  getUniqueMessageKey: vi.fn(async () => 'key-1'),
}));
vi.mock('../chat/modules/privacySettings.js', () => ({
  getPrivacyOptOutAllAiEnabled: vi.fn(async () => false),
}));
vi.mock('../agent/modules/deviceSync.js', () => ({ isAutoEnabled: vi.fn(async () => false) }));
vi.mock('../agent/modules/folderUtils.js', () => ({ isInboxFolder: vi.fn(() => true) }));
vi.mock('../agent/modules/senderFilter.js', () => ({ isInternalSender: vi.fn(async () => false) }));
vi.mock('../agent/modules/supabaseAuth.js', () => ({ getAccessToken: vi.fn(async () => 'token') }));
vi.mock('../agent/modules/summaryGenerator.js', () => ({ getSummary }));
vi.mock('../agent/modules/actionGenerator.js', () => ({ getAction }));
vi.mock('../agent/modules/tagHelper.js', () => ({ runThreadAggregation }));
vi.mock('../agent/modules/messageProcessorQueue.js', () => ({ enqueueProcessMessage }));
vi.mock('../agent/modules/summaryDisplaySettings.js', () => ({
  getShowAiSummariesEnabled: vi.fn(async () => showAiSummaries.value),
}));

let displayedListener = null;
globalThis.browser = {
  messageDisplay: {
    onMessagesDisplayed: { addListener: vi.fn((fn) => { displayedListener = fn; }) },
  },
  tabs: { sendMessage },
  tmPrefs: { getInt: vi.fn(async () => 0) },
};

const { initSummaryFeatures } = await import('../agent/modules/summary.js');
const displayedListenerAtImport = displayedListener;
const registrationCountAtImport = browser.messageDisplay.onMessagesDisplayed.addListener.mock.calls.length;
initSummaryFeatures();

const tab = { id: 7 };
const inboxMessage = {
  id: 1,
  subject: 'Delivery',
  author: 'sender@example.com',
  folder: { name: 'Inbox', type: 'inbox', path: '/Inbox' },
};

function sentCommands() {
  return sendMessage.mock.calls.map(([, payload]) => payload?.command);
}

beforeEach(() => {
  vi.clearAllMocks();
  showAiSummaries.value = true;
});

it('registers one summary display listener before asynchronous feature setup', async () => {
  expect(registrationCountAtImport).toBe(1);
  expect(displayedListenerAtImport).toBeTypeOf('function');
  initSummaryFeatures();
  expect(browser.messageDisplay.onMessagesDisplayed.addListener).not.toHaveBeenCalled();
  await displayedListenerAtImport(tab, { messages: [inboxMessage] });
  expect(sentCommands()).toContain('displaySummary');
  expect(getSummary).toHaveBeenCalled();
});

describe('Show AI Summaries preference on (default)', () => {
  it('renders the bubble for a single inbox message and keeps processing', async () => {
    await displayedListener(tab, { messages: [inboxMessage] });
    const cmds = sentCommands();
    expect(cmds).toContain('displaySummary');
    expect(cmds).not.toContain('tm-gate-summary-disabled');
    expect(getSummary).toHaveBeenCalled();
    expect(runThreadAggregation).toHaveBeenCalledTimes(1);
    expect(enqueueProcessMessage).toHaveBeenCalledTimes(1);
  });
});

describe('Show AI Summaries preference off', () => {
  it('releases the display gate instead of rendering any bubble state', async () => {
    showAiSummaries.value = false;
    await displayedListener(tab, { messages: [inboxMessage] });
    const cmds = sentCommands();
    expect(cmds).toContain('tm-gate-summary-disabled');
    expect(cmds).not.toContain('displaySummary');
    expect(cmds).not.toContain('summaryProcessing');
  });

  it('still generates the summary, applies action tags and enqueues the pipeline (display only)', async () => {
    showAiSummaries.value = false;
    await displayedListener(tab, { messages: [inboxMessage] });
    expect(getSummary).toHaveBeenCalledTimes(1);
    expect(getAction).toHaveBeenCalledTimes(1);
    expect(runThreadAggregation).toHaveBeenCalledTimes(1);
    expect(enqueueProcessMessage).toHaveBeenCalledTimes(1);
  });

  it('still releases the display gate when the first send lands before the content script exists', async () => {
    // Both onMessagesDisplayed listeners fire on one event; the agent can reach
    // this send before the theme side has injected messageDisplayGate.js.
    // Invariant: the gate is released anyway (the preview must not stay blank).
    showAiSummaries.value = false;
    sendMessage.mockRejectedValueOnce(
      new Error('Could not establish connection. Receiving end does not exist.'),
    );
    await displayedListener(tab, { messages: [inboxMessage] });
    const gateCalls = sendMessage.mock.calls.filter(
      ([, payload]) => payload?.command === 'tm-gate-summary-disabled',
    );
    expect(gateCalls.length).toBeGreaterThanOrEqual(2);
    // The last gate-release attempt resolved (only the first was rejected).
    const lastResult = sendMessage.mock.results[sendMessage.mock.results.length - 1];
    await expect(lastResult.value).resolves.toBeUndefined();
    expect(sentCommands()).not.toContain('displaySummary');
  });

  it('is read per display, so flipping the preference back on renders on the next message', async () => {
    showAiSummaries.value = false;
    await displayedListener(tab, { messages: [inboxMessage] });
    expect(sentCommands()).not.toContain('displaySummary');
    sendMessage.mockClear();
    showAiSummaries.value = true;
    await displayedListener(tab, { messages: [inboxMessage] });
    expect(sentCommands()).toContain('displaySummary');
  });
});

it('retries a failed early listener add without accumulating owners', async () => {
  const listeners = new Set();
  const addListener = vi.fn()
    .mockImplementationOnce(() => { throw new Error('synthetic registration failure'); })
    .mockImplementation((fn) => listeners.add(fn));
  browser.messageDisplay.onMessagesDisplayed.addListener = addListener;
  vi.resetModules();
  const fresh = await import('../agent/modules/summary.js');
  expect(addListener).toHaveBeenCalledTimes(1);
  expect(listeners.size).toBe(0);
  fresh.initSummaryFeatures();
  fresh.initSummaryFeatures();
  expect(addListener).toHaveBeenCalledTimes(2);
  expect(listeners.size).toBe(1);
});
