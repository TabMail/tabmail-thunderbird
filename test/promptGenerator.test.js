// promptGenerator.test.js — Tests for agent/modules/promptGenerator.js

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
vi.mock('../agent/modules/templateManager.js', () => ({
  ensureMigration: vi.fn(async () => {}),
  getTemplatesAsPrimedPrompt: vi.fn(async () => ''),
}));

const storageData = {};
globalThis.browser = {
  storage: {
    local: {
      get: vi.fn(async (key) => {
        if (typeof key === 'string') {
          return { [key]: storageData[key] || undefined };
        }
        const result = {};
        for (const [k, def] of Object.entries(key)) {
          result[k] = storageData[k] !== undefined ? storageData[k] : def;
        }
        return result;
      }),
      set: vi.fn(async (obj) => {
        Object.assign(storageData, obj);
      }),
    },
    onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
  },
  runtime: {
    getURL: vi.fn((p) => `moz-extension://fake/${p}`),
  },
};

// Mock fetch for template file loading
globalThis.fetch = vi.fn(async () => ({
  ok: true,
  text: async () => 'Default prompt content\n====END USER INSTRUCTIONS====',
}));

const {
  getUserCompositionPrompt,
  getUserActionPrompt,
  getUserKBPrompt,
} = await import('../agent/modules/promptGenerator.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(storageData)) {
    delete storageData[key];
  }
});

describe('getUserCompositionPrompt', () => {
  it('returns stored prompt if available', async () => {
    storageData['user_prompts:user_composition.md'] = 'My custom prompt\n====END USER INSTRUCTIONS====';
    const result = await getUserCompositionPrompt();
    expect(result).toContain('My custom prompt');
  });

  it('falls back to bundled template when not in storage', async () => {
    const result = await getUserCompositionPrompt();
    expect(typeof result).toBe('string');
  });
});

describe('getUserActionPrompt', () => {
  it('returns stored prompt if available', async () => {
    storageData['user_prompts:user_action.md'] = 'Action prompt content';
    const result = await getUserActionPrompt();
    expect(result).toBe('Action prompt content');
  });

  it('falls back to bundled template', async () => {
    const result = await getUserActionPrompt();
    expect(typeof result).toBe('string');
  });
});

describe('getUserKBPrompt', () => {
  it('returns stored prompt if available', async () => {
    storageData['user_prompts:user_kb.md'] = 'KB prompt content';
    const result = await getUserKBPrompt();
    expect(result).toBe('KB prompt content');
  });

  it('falls back to bundled template', async () => {
    const result = await getUserKBPrompt();
    expect(typeof result).toBe('string');
  });
});
