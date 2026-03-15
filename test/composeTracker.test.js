// composeTracker.test.js — Tests for agent/modules/composeTracker.js

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../agent/modules/config.js', () => ({
  SETTINGS: {
    verboseLogging: false,
    debugLogging: false,
    debugMode: false,
    logTruncateLength: 100,
    getFullDiag: {},
  },
}));
vi.mock('../agent/modules/thinkBuffer.js', () => ({
  getAndClearThink: vi.fn(() => null),
}));
vi.mock('../agent/modules/quoteAndSignature.js', () => ({}));
vi.mock('../agent/modules/idbStorage.js', () => ({
  get: vi.fn(async () => ({})),
  set: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
}));
vi.mock('../agent/modules/replyGenerator.js', () => ({
  createReply: vi.fn(),
  STORAGE_PREFIX: 'reply:',
}));
vi.mock('../agent/modules/tagHelper.js', () => ({
  ACTION_TAG_IDS: { delete: 'tm_delete', archive: 'tm_archive', reply: 'tm_reply', none: 'tm_none' },
  applyPriorityTag: vi.fn(async () => {}),
}));

globalThis.browser = {
  tabs: {
    onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
  },
  compose: {
    onBeforeSend: { addListener: vi.fn(), removeListener: vi.fn() },
    onAfterSend: { addListener: vi.fn(), removeListener: vi.fn() },
    onCreated: { addListener: vi.fn(), removeListener: vi.fn() },
    getComposeDetails: vi.fn(async () => ({})),
  },
  messages: {
    tags: { update: vi.fn(async () => {}) },
    get: vi.fn(async () => null),
  },
  storage: {
    local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
    onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
  },
  accounts: {
    list: vi.fn(async () => []),
  },
  folders: {
    getSubFolders: vi.fn(async () => []),
  },
};

const {
  trackComposeWindow,
  isAnyComposeOpen,
  trackSendInitiated,
  consumeSendInitiated,
} = await import('../agent/modules/composeTracker.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

describe('trackComposeWindow / isAnyComposeOpen', () => {
  it('starts with no compose windows open', () => {
    // Note: module state persists, so this depends on initial state
    // The module auto-registers listeners, so we're just testing the API
  });

  it('tracks a compose window', () => {
    trackComposeWindow(100);
    expect(isAnyComposeOpen()).toBe(true);
  });
});

describe('trackSendInitiated / consumeSendInitiated', () => {
  it('tracks and consumes send flag', () => {
    trackSendInitiated(200);
    expect(consumeSendInitiated(200)).toBe(true);
    // Second consume should return false
    expect(consumeSendInitiated(200)).toBe(false);
  });

  it('returns false for untracked tab', () => {
    expect(consumeSendInitiated(999)).toBe(false);
  });
});
