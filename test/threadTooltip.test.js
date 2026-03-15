// threadTooltip.test.js — Tests for agent/modules/threadTooltip.js

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
    threadTooltipEnabled: false,
  },
}));
vi.mock('../agent/modules/thinkBuffer.js', () => ({
  getAndClearThink: vi.fn(() => null),
}));
vi.mock('../agent/modules/quoteAndSignature.js', () => ({}));
vi.mock('../agent/modules/folderResolver.js', () => ({
  resolveWeFolderFromXulUri: vi.fn(async () => null),
}));
vi.mock('../agent/modules/summaryGenerator.js', () => ({
  getSummaryWithHeaderId: vi.fn(async () => null),
}));

globalThis.browser = {
  threadTooltip: {
    onHover: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
    display: vi.fn(),
  },
  storage: {
    local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
    onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
  },
};

const {
  cleanupThreadTooltipHandlers,
  attachThreadTooltipHandlers,
} = await import('../agent/modules/threadTooltip.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

describe('cleanupThreadTooltipHandlers', () => {
  it('does not throw when no listeners registered', () => {
    expect(() => cleanupThreadTooltipHandlers()).not.toThrow();
  });
});

describe('attachThreadTooltipHandlers', () => {
  it('does not register when disabled by config', () => {
    attachThreadTooltipHandlers();
    // threadTooltipEnabled is false in our mock config
    expect(browser.threadTooltip.onHover.addListener).not.toHaveBeenCalled();
  });
});
