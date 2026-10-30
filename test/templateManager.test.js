/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

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

// The prompt store's template ops over this file's storage: a hold reads and saves the whole list, and a
// save after `refuseSaves` is set is refused as the background refuses one whose hold ended.
const hold = { refuseSaves: false };
const promptStore = {
  templates: async () => ({ templates: storageData.user_templates ?? [], migrated: storageData.templates_migrated === true }),
  saveTemplates: vi.fn(async (templates, { migrated = false } = {}) => {
    if (hold.refuseSaves) throw Object.assign(new Error('the templates changed while this was worked on, so nothing was saved'), { changed: true });
    await browser.storage.local.set(migrated ? { user_templates: templates, templates_migrated: true } : { user_templates: templates });
  }),
};
vi.mock('../agent/modules/promptStore.js', () => ({
  withPromptStore: vi.fn(async (body) => body(promptStore)),
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
  getTemplate,
  addTemplate,
  updateTemplate,
  deleteTemplate,
  dedupeTemplates,
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
  initializeDefaultTemplates,
} = await import('../agent/modules/templateManager.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const stored = () => storageData.user_templates ?? [];

beforeEach(() => {
  vi.clearAllMocks();
  hold.refuseSaves = false;
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

describe('a writer whose hold ended before its save', () => {
  it('saves nothing and reports failure', async () => {
    const t = createTemplate({ id: 'kept', name: 'Kept' });
    storageData.user_templates = [t];
    hold.refuseSaves = true;
    expect(await addTemplate({ name: 'New' })).toBe(null);
    expect(await updateTemplate('kept', { name: 'Changed' })).toBe(null);
    expect(await deleteTemplate('kept')).toBe(false);
    expect(await reorderTemplates(['kept'])).toBe(false);
    await expect(importTemplates(JSON.stringify([{ id: 'imp', name: 'Imported' }]))).rejects.toMatchObject({ changed: true });
    expect(browser.storage.local.set).not.toHaveBeenCalled();
    expect(stored()).toEqual([t]);
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
    expect(stored()).toEqual([result]);
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
    expect(stored()).toEqual([result]);
  });

  it('returns null for unknown id', async () => {
    storageData.user_templates = [];
    const result = await updateTemplate('nonexistent', { name: 'X' });
    expect(result).toBe(null);
    expect(promptStore.saveTemplates).not.toHaveBeenCalled();
  });
});

describe('deleteTemplate', () => {
  it('soft-deletes a template', async () => {
    const t = createTemplate({ id: 'del1', name: 'Delete Me' });
    storageData.user_templates = [t];
    const result = await deleteTemplate('del1');
    expect(result).toBe(true);
    expect(stored()).toHaveLength(1);
    expect(stored()[0]).toMatchObject({ id: 'del1', deleted: true });
    expect(stored()[0].deletedAt).toBe(stored()[0].updatedAt);
  });

  it('returns false for unknown id', async () => {
    storageData.user_templates = [];
    const result = await deleteTemplate('nonexistent');
    expect(result).toBe(false);
    expect(promptStore.saveTemplates).not.toHaveBeenCalled();
  });
});

describe('dedupeTemplates', () => {
  it('removes visible templates repeating an earlier id, keeps the first and every tombstone after them', async () => {
    const tombstone = createTemplate({ id: 'dup', name: 'Deleted', deleted: true, deletedAt: new Date().toISOString() });
    storageData.user_templates = [
      createTemplate({ id: 'dup', name: 'First' }),
      tombstone,
      createTemplate({ id: 'other', name: 'Other' }),
      createTemplate({ id: 'dup', name: 'Second' }),
    ];
    const result = await dedupeTemplates();
    expect(result.removed).toBe(1);
    expect(result.templates.map((t) => t.name)).toEqual(['First', 'Other']);
    expect(stored().map((t) => t.name)).toEqual(['First', 'Other', 'Deleted']);
  });

  it('saves nothing when no id repeats', async () => {
    storageData.user_templates = [createTemplate({ id: 'a', name: 'A' })];
    expect((await dedupeTemplates()).removed).toBe(0);
    expect(promptStore.saveTemplates).not.toHaveBeenCalled();
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
    await mergeTemplates([createTemplate({ id: 'peer1', name: 'From Peer' })], promptStore);
    expect(stored().map((t) => t.name)).toEqual(['From Peer']);
  });

  it('adopts newer version of existing template', async () => {
    const old = createTemplate({ id: 'merge1', name: 'Old', updatedAt: '2020-01-01T00:00:00.000Z' });
    storageData.user_templates = [old];
    const newer = createTemplate({ id: 'merge1', name: 'Newer', updatedAt: '2030-01-01T00:00:00.000Z' });
    await mergeTemplates([newer], promptStore);
    expect(stored().map((t) => t.name)).toEqual(['Newer']);
  });

  it('keeps a local template newer than the incoming one, saving nothing', async () => {
    const local = createTemplate({ id: 'merge1', name: 'Local', updatedAt: new Date().toISOString() });
    storageData.user_templates = [local];
    await mergeTemplates([createTemplate({ id: 'merge1', name: 'Older', updatedAt: new Date(Date.now() - 86400 * 1000).toISOString() })], promptStore);
    expect(stored()).toEqual([local]);
    expect(promptStore.saveTemplates).not.toHaveBeenCalled();
  });

  it('does nothing for empty input', async () => {
    await mergeTemplates([], promptStore);
    expect(promptStore.saveTemplates).not.toHaveBeenCalled();
  });

  it('throws the refusal when its hold ended before the save', async () => {
    hold.refuseSaves = true;
    await expect(mergeTemplates([createTemplate({ id: 'peer1', name: 'From Peer' })], promptStore)).rejects.toMatchObject({ changed: true });
  });
});

describe('gcDeletedTemplates', () => {
  it('removes old deleted templates', async () => {
    const oldDate = new Date(Date.now() - 100 * 86400 * 1000).toISOString();
    storageData.user_templates = [
      createTemplate({ id: '1', name: 'Active' }),
      createTemplate({ id: '2', name: 'Old Deleted', deleted: true, deletedAt: oldDate }),
    ];
    await gcDeletedTemplates(promptStore);
    expect(stored().map((t) => t.name)).toEqual(['Active']);
  });

  it('keeps recent deleted templates', async () => {
    const recentDate = new Date().toISOString();
    storageData.user_templates = [
      createTemplate({ id: '1', name: 'Recent Deleted', deleted: true, deletedAt: recentDate }),
    ];
    await gcDeletedTemplates(promptStore);
    expect(stored()).toHaveLength(1);
    expect(promptStore.saveTemplates).not.toHaveBeenCalled();
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
    expect(stored().map((t) => t.id)).toEqual(['c', 'a', 'b']);
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
    expect(stored().map((t) => t.id)).toEqual(['imp1']);
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

describe('initializeDefaultTemplates', () => {
  const defaults = [createTemplate({ id: 'default-1', name: 'Default one' }), createTemplate({ id: 'default-2', name: 'Default two' })];

  beforeEach(() => {
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => structuredClone(defaults) }));
  });

  it('adds the defaults and the flag in one save', async () => {
    expect(await initializeDefaultTemplates()).toEqual({ initialized: 2 });
    expect(stored().map((t) => t.id)).toEqual(['default-1', 'default-2']);
    expect(storageData.templates_migrated).toBe(true);
    expect(browser.storage.local.set).toHaveBeenCalledTimes(1);
  });

  it('keeps a template saved before it ran, adding only the defaults it lacks', async () => {
    const own = createTemplate({ id: 'own', name: 'Own' });
    const editedDefault = createTemplate({ id: 'default-2', name: 'Edited default' });
    storageData.user_templates = [own, editedDefault];
    expect(await initializeDefaultTemplates()).toEqual({ initialized: 1 });
    expect(stored().map((t) => t.name)).toEqual(['Own', 'Edited default', 'Default one']);
  });

  it('saves nothing once the defaults were added', async () => {
    storageData.templates_migrated = true;
    expect(await initializeDefaultTemplates()).toEqual({ initialized: 0 });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(browser.storage.local.set).not.toHaveBeenCalled();
  });
});

describe('markTemplatesMigrated', () => {
  it('sets migration flag', async () => {
    await markTemplatesMigrated();
    expect(browser.storage.local.set).toHaveBeenCalledWith({ templates_migrated: true });
  });
});
