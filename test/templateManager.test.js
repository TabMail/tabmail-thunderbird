// templateManager.test.js — Tests for agent/modules/templateManager.js

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
    onChanged: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
  },
  runtime: {
    getURL: vi.fn((path) => `moz-extension://fake/${path}`),
  },
};

const {
  createTemplate,
  loadTemplates,
  saveTemplates,
  getTemplate,
  addTemplate,
  updateTemplate,
  deleteTemplate,
  toggleTemplate,
  getEnabledTemplates,
  getVisibleTemplates,
  mergeTemplates,
  gcDeletedTemplates,
  reorderTemplates,
  exportTemplates,
  importTemplates,
  getTemplatesAsPrimedPrompt,
  getCategories,
  hasMigratedTemplates,
  markTemplatesMigrated,
} = await import('../agent/modules/templateManager.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(storageData)) {
    delete storageData[key];
  }
});

describe('createTemplate', () => {
  it('creates template with defaults', () => {
    const t = createTemplate();
    expect(t.name).toBe('New Template');
    expect(t.enabled).toBe(true);
    expect(Array.isArray(t.instructions)).toBe(true);
    expect(t.instructions).toHaveLength(0);
    expect(t.exampleReply).toBe('');
    expect(t.deleted).toBe(false);
    expect(t.deletedAt).toBe(null);
    expect(t.id).toBeDefined();
    expect(t.createdAt).toBeDefined();
    expect(t.updatedAt).toBeDefined();
  });

  it('creates template with partial data', () => {
    const t = createTemplate({
      name: 'My Template',
      enabled: false,
      instructions: ['Be concise'],
      exampleReply: 'Thanks!',
    });
    expect(t.name).toBe('My Template');
    expect(t.enabled).toBe(false);
    expect(t.instructions).toEqual(['Be concise']);
    expect(t.exampleReply).toBe('Thanks!');
  });

  it('uses provided id', () => {
    const t = createTemplate({ id: 'custom-id' });
    expect(t.id).toBe('custom-id');
  });

  it('generates UUID-like id when not provided', () => {
    const t = createTemplate();
    expect(t.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('loadTemplates', () => {
  it('returns empty array when no templates stored', async () => {
    const result = await loadTemplates();
    expect(result).toEqual([]);
  });

  it('returns stored templates', async () => {
    const templates = [
      createTemplate({ name: 'T1' }),
      createTemplate({ name: 'T2' }),
    ];
    storageData.user_templates = templates;
    const result = await loadTemplates();
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('T1');
  });

  it('handles storage errors', async () => {
    browser.storage.local.get.mockRejectedValueOnce(new Error('fail'));
    const result = await loadTemplates();
    expect(result).toEqual([]);
  });
});

describe('saveTemplates', () => {
  it('saves templates to storage', async () => {
    const templates = [createTemplate({ name: 'Test' })];
    const result = await saveTemplates(templates);
    expect(result).toBe(true);
    expect(browser.storage.local.set).toHaveBeenCalled();
  });

  it('handles storage errors', async () => {
    browser.storage.local.set.mockRejectedValueOnce(new Error('fail'));
    const result = await saveTemplates([]);
    expect(result).toBe(false);
  });
});

describe('getTemplate', () => {
  it('returns template by id', async () => {
    const t = createTemplate({ id: 'abc', name: 'Find Me' });
    storageData.user_templates = [t];
    const result = await getTemplate('abc');
    expect(result.name).toBe('Find Me');
  });

  it('returns null for unknown id', async () => {
    storageData.user_templates = [createTemplate({ id: 'xyz' })];
    const result = await getTemplate('nonexistent');
    expect(result).toBe(null);
  });
});

describe('addTemplate', () => {
  it('adds a new template', async () => {
    storageData.user_templates = [];
    const result = await addTemplate({ name: 'New' });
    expect(result).toBeDefined();
    expect(result.name).toBe('New');
  });
});

describe('updateTemplate', () => {
  it('updates an existing template', async () => {
    const t = createTemplate({ id: 'upd1', name: 'Old Name' });
    storageData.user_templates = [t];
    const result = await updateTemplate('upd1', { name: 'New Name' });
    expect(result.name).toBe('New Name');
    expect(result.id).toBe('upd1');
    expect(result.createdAt).toBe(t.createdAt);
  });

  it('returns null for unknown id', async () => {
    storageData.user_templates = [];
    const result = await updateTemplate('nonexistent', { name: 'X' });
    expect(result).toBe(null);
  });
});

describe('deleteTemplate', () => {
  it('soft-deletes a template', async () => {
    const t = createTemplate({ id: 'del1', name: 'Delete Me' });
    storageData.user_templates = [t];
    const result = await deleteTemplate('del1');
    expect(result).toBe(true);
  });

  it('returns false for unknown id', async () => {
    storageData.user_templates = [];
    const result = await deleteTemplate('nonexistent');
    expect(result).toBe(false);
  });
});

describe('toggleTemplate', () => {
  it('toggles enabled state', async () => {
    const t = createTemplate({ id: 'tog1', name: 'Toggle', enabled: true });
    storageData.user_templates = [t];
    const result = await toggleTemplate('tog1');
    expect(result).toBe(false);
  });

  it('returns null for unknown id', async () => {
    storageData.user_templates = [];
    const result = await toggleTemplate('nonexistent');
    expect(result).toBe(null);
  });
});

describe('getEnabledTemplates', () => {
  it('returns only enabled non-deleted templates', async () => {
    storageData.user_templates = [
      createTemplate({ id: '1', name: 'Enabled', enabled: true }),
      createTemplate({ id: '2', name: 'Disabled', enabled: false }),
      createTemplate({ id: '3', name: 'Deleted', enabled: true, deleted: true }),
    ];
    const result = await getEnabledTemplates();
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Enabled');
  });
});

describe('getVisibleTemplates', () => {
  it('returns non-deleted templates', async () => {
    storageData.user_templates = [
      createTemplate({ id: '1', name: 'Visible', deleted: false }),
      createTemplate({ id: '2', name: 'Deleted', deleted: true }),
    ];
    const result = await getVisibleTemplates();
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Visible');
  });
});

describe('mergeTemplates', () => {
  it('adopts new templates from peer', async () => {
    storageData.user_templates = [];
    await mergeTemplates([createTemplate({ id: 'peer1', name: 'From Peer' })]);
    // Should have saved
    expect(browser.storage.local.set).toHaveBeenCalled();
  });

  it('adopts newer version of existing template', async () => {
    const old = createTemplate({ id: 'merge1', name: 'Old', updatedAt: '2020-01-01T00:00:00.000Z' });
    storageData.user_templates = [old];
    const newer = createTemplate({ id: 'merge1', name: 'Newer', updatedAt: '2030-01-01T00:00:00.000Z' });
    await mergeTemplates([newer]);
    expect(browser.storage.local.set).toHaveBeenCalled();
  });

  it('does nothing for empty input', async () => {
    await mergeTemplates([]);
    // Should not call set
  });
});

describe('gcDeletedTemplates', () => {
  it('removes old deleted templates', async () => {
    const oldDate = new Date(Date.now() - 100 * 86400 * 1000).toISOString();
    storageData.user_templates = [
      createTemplate({ id: '1', name: 'Active' }),
      createTemplate({ id: '2', name: 'Old Deleted', deleted: true, deletedAt: oldDate }),
    ];
    await gcDeletedTemplates();
    expect(browser.storage.local.set).toHaveBeenCalled();
  });

  it('keeps recent deleted templates', async () => {
    const recentDate = new Date().toISOString();
    storageData.user_templates = [
      createTemplate({ id: '1', name: 'Recent Deleted', deleted: true, deletedAt: recentDate }),
    ];
    await gcDeletedTemplates();
    // Should not remove
  });
});

describe('reorderTemplates', () => {
  it('reorders templates by ID list', async () => {
    storageData.user_templates = [
      createTemplate({ id: 'a', name: 'A' }),
      createTemplate({ id: 'b', name: 'B' }),
      createTemplate({ id: 'c', name: 'C' }),
    ];
    const result = await reorderTemplates(['c', 'a', 'b']);
    expect(result).toBe(true);
  });
});

describe('exportTemplates', () => {
  it('exports all templates as JSON string', async () => {
    storageData.user_templates = [createTemplate({ id: 'exp1', name: 'Export' })];
    const result = await exportTemplates();
    const parsed = JSON.parse(result);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe('Export');
  });

  it('exports specific templates by ID', async () => {
    storageData.user_templates = [
      createTemplate({ id: 'a', name: 'A' }),
      createTemplate({ id: 'b', name: 'B' }),
    ];
    const result = await exportTemplates(['a']);
    const parsed = JSON.parse(result);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe('A');
  });
});

describe('importTemplates', () => {
  it('imports templates from JSON', async () => {
    storageData.user_templates = [];
    const json = JSON.stringify([createTemplate({ id: 'imp1', name: 'Imported' })]);
    const result = await importTemplates(json);
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it('skips templates without name or id', async () => {
    storageData.user_templates = [];
    const json = JSON.stringify([{ foo: 'bar' }]);
    const result = await importTemplates(json);
    expect(result.skipped).toBe(1);
  });

  it('throws on invalid JSON', async () => {
    await expect(importTemplates('not-json')).rejects.toThrow();
  });
});

describe('getTemplatesAsPrimedPrompt', () => {
  it('returns empty string when no enabled templates', async () => {
    storageData.user_templates = [];
    const result = await getTemplatesAsPrimedPrompt();
    expect(result).toBe('');
  });

  it('returns markdown-formatted prompt', async () => {
    storageData.user_templates = [
      createTemplate({ id: '1', name: 'Formal Reply', enabled: true, instructions: ['Be formal', 'Use proper greeting'], exampleReply: 'Dear Sir,' }),
    ];
    const result = await getTemplatesAsPrimedPrompt();
    expect(result).toContain('Formal Reply');
    expect(result).toContain('Be formal');
    expect(result).toContain('Example reply');
    expect(result).toContain('Dear Sir,');
  });
});

describe('getCategories', () => {
  it('returns array of category strings', () => {
    const cats = getCategories();
    expect(Array.isArray(cats)).toBe(true);
    expect(cats.length).toBeGreaterThan(0);
    expect(cats).toContain('custom');
  });
});

describe('hasMigratedTemplates', () => {
  it('returns false when not migrated', async () => {
    const result = await hasMigratedTemplates();
    expect(result).toBe(false);
  });

  it('returns true when migrated', async () => {
    storageData.templates_migrated = true;
    const result = await hasMigratedTemplates();
    expect(result).toBe(true);
  });
});

describe('markTemplatesMigrated', () => {
  it('sets migration flag', async () => {
    await markTemplatesMigrated();
    expect(browser.storage.local.set).toHaveBeenCalledWith({ templates_migrated: true });
  });
});
