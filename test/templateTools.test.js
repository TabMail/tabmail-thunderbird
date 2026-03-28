// templateTools.test.js — Tests for template_create, template_edit, template_delete,
// template_share, template_search tools and idTranslator template support.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// globalThis.browser mock
// ---------------------------------------------------------------------------
const storageData = {};

globalThis.browser = {
  storage: {
    local: {
      get: vi.fn(async (keysOrDefault) => {
        if (typeof keysOrDefault === 'string') {
          return { [keysOrDefault]: storageData[keysOrDefault] ?? undefined };
        }
        const result = {};
        for (const [k, def] of Object.entries(keysOrDefault)) {
          result[k] = storageData[k] !== undefined ? storageData[k] : def;
        }
        return result;
      }),
      set: vi.fn(async (obj) => {
        for (const [k, v] of Object.entries(obj)) {
          storageData[k] = v;
        }
      }),
    },
  },
  runtime: {
    sendMessage: vi.fn(async () => undefined),
    getURL: vi.fn((path) => `moz-extension://fake/${path}`),
  },
};

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock('../agent/modules/utils.js', () => ({
  log: vi.fn(),
  normalizeUnicode: vi.fn((text) => text),
}));

vi.mock('../agent/modules/config.js', () => ({
  SETTINGS: {},
  getTemplateWorkerUrl: vi.fn(async () => 'https://templates.tabmail.ai'),
}));

// Mock supabaseAuth.js — getAccessToken returns token or null
vi.mock('../agent/modules/supabaseAuth.js', () => ({
  getAccessToken: vi.fn(async () => {
    const session = storageData['supabaseSession'];
    return session?.access_token || null;
  }),
  getSession: vi.fn(async () => storageData['supabaseSession'] || null),
}));

// Mock templateManager.js with real-ish CRUD backed by storageData
const TEMPLATE_KEY = 'user_templates';

function getTemplatesFromStorage() {
  return storageData[TEMPLATE_KEY] || [];
}
function saveTemplatesToStorage(templates) {
  storageData[TEMPLATE_KEY] = templates;
}

vi.mock('../agent/modules/templateManager.js', () => ({
  ensureMigration: vi.fn(async () => {}),
  getTemplatesAsPrimedPrompt: vi.fn(async () => ''),
  loadTemplates: vi.fn(async () => getTemplatesFromStorage()),
  saveTemplates: vi.fn(async (t) => { saveTemplatesToStorage(t); return true; }),
  getTemplate: vi.fn(async (id) => {
    const templates = getTemplatesFromStorage();
    return templates.find(t => t.id === id) || null;
  }),
  addTemplate: vi.fn(async (data) => {
    const templates = getTemplatesFromStorage();
    const now = new Date().toISOString();
    const t = {
      id: data.id || `uuid-${Date.now()}`,
      name: data.name || 'New Template',
      enabled: data.enabled !== undefined ? data.enabled : true,
      instructions: data.instructions || [],
      exampleReply: data.exampleReply || '',
      deleted: false,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    templates.push(t);
    saveTemplatesToStorage(templates);
    return t;
  }),
  updateTemplate: vi.fn(async (id, updates) => {
    const templates = getTemplatesFromStorage();
    const idx = templates.findIndex(t => t.id === id);
    if (idx === -1) return null;
    templates[idx] = { ...templates[idx], ...updates, updatedAt: new Date().toISOString() };
    saveTemplatesToStorage(templates);
    return templates[idx];
  }),
  deleteTemplate: vi.fn(async (id) => {
    const templates = getTemplatesFromStorage();
    const idx = templates.findIndex(t => t.id === id);
    if (idx === -1) return false;
    const now = new Date().toISOString();
    templates[idx] = { ...templates[idx], deleted: true, deletedAt: now, updatedAt: now };
    saveTemplatesToStorage(templates);
    return true;
  }),
  getVisibleTemplates: vi.fn(async () => getTemplatesFromStorage().filter(t => !t.deleted)),
  createTemplate: vi.fn((partial) => ({
    id: partial?.id || `uuid-${Date.now()}`,
    name: partial?.name || 'New Template',
    enabled: true,
    instructions: partial?.instructions || [],
    exampleReply: partial?.exampleReply || '',
    deleted: false,
    deletedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })),
}));

vi.mock('../chat/chat.js', () => ({
  createNewAgentBubble: vi.fn(async () => ({
    classList: { remove: vi.fn() },
  })),
}));

vi.mock('../chat/modules/context.js', () => ({
  ctx: {
    rawUserTexts: [],
    fsmSessions: {},
    state: '',
    activePid: 0,
    awaitingPid: 0,
    activeToolCallId: null,
    toolExecutionMode: null,
  },
  initFsmSession: vi.fn((pid, toolName) => {
    const { ctx } = require('../chat/modules/context.js');
    ctx.fsmSessions[pid] = {
      toolName,
      startedAt: Date.now(),
      fsmPrevState: ctx.state || null,
      fsmUserInput: null,
    };
    return ctx.fsmSessions[pid];
  }),
}));

vi.mock('../chat/modules/converse.js', () => ({
  awaitUserInput: vi.fn(),
}));

vi.mock('../chat/modules/helpers.js', () => ({
  streamText: vi.fn(),
  formatTimestampForAgent: vi.fn(() => '2026-03-27'),
}));

vi.mock('../../chatlink/modules/fsm.js', () => ({
  relayFsmConfirmation: vi.fn(async () => {}),
}));

// Mock chatlink FSM (relative path from chat/fsm/)
vi.mock('../chatlink/modules/fsm.js', () => ({
  relayFsmConfirmation: vi.fn(async () => {}),
}));

// Mock llm.js (imported by fsm/core.js)
vi.mock('../agent/modules/llm.js', () => ({
  processJSONResponse: vi.fn(),
  sendChat: vi.fn(async () => ({})),
}));

// Mock idbStorage.js (imported transitively by some modules)
vi.mock('../agent/modules/idbStorage.js', () => ({
  idbGet: vi.fn(async () => null),
  idbSet: vi.fn(async () => {}),
  idbDelete: vi.fn(async () => {}),
}));

vi.mock('../chat/modules/entityResolver.js', () => ({
  resolveEmailSubject: vi.fn(async () => null),
  resolveEventDetails: vi.fn(async () => null),
}));

// ---------------------------------------------------------------------------
// Helper: clear storage between tests
// ---------------------------------------------------------------------------
function clearStorage() {
  for (const key of Object.keys(storageData)) {
    delete storageData[key];
  }
}

function seedTemplate(overrides = {}) {
  const t = {
    id: overrides.id || 'tpl-1',
    name: overrides.name || 'Test Template',
    enabled: true,
    instructions: overrides.instructions || ['Be concise', 'Use formal tone'],
    exampleReply: overrides.exampleReply || 'Thank you for your email.',
    deleted: false,
    deletedAt: null,
    createdAt: '2026-03-01T00:00:00.000Z',
    updatedAt: '2026-03-01T00:00:00.000Z',
    ...overrides,
  };
  const templates = getTemplatesFromStorage();
  templates.push(t);
  saveTemplatesToStorage(templates);
  return t;
}

// ---------------------------------------------------------------------------
// Import tools AFTER mocks are set up
// ---------------------------------------------------------------------------
const templateSearch = await import('../chat/tools/template_search.js');
const templateRead = await import('../chat/tools/template_read.js');

// ---------------------------------------------------------------------------
// Tests: template_search (non-FSM)
// ---------------------------------------------------------------------------
describe('template_search tool', () => {
  beforeEach(() => {
    clearStorage();
    vi.clearAllMocks();
    globalThis.fetch = vi.fn();
  });

  it('exports run as a function', () => {
    expect(typeof templateSearch.run).toBe('function');
  });

  it('returns local results even without auth token', async () => {
    seedTemplate({ id: 'local-1', name: 'My Local Template' });
    const result = await templateSearch.run({ query: 'local' });
    expect(result.ok).toBe(true);
    expect(result.templates.length).toBeGreaterThanOrEqual(1);
    expect(result.templates[0].source).toBe('local');
    expect(result.templates[0].name).toBe('My Local Template');
  });

  it('returns "No templates found" when no local or marketplace matches', async () => {
    const result = await templateSearch.run({ query: 'nonexistent-xyz' });
    expect(result.ok).toBe(true);
    expect(result.result).toContain('No templates found');
  });

  it('includes source field for local and marketplace results', async () => {
    seedTemplate({ id: 'local-2', name: 'Local Reply' });
    storageData['supabaseSession'] = { access_token: 'valid-token', refresh_token: 'rt', expires_at: Math.floor(Date.now() / 1000) + 3600 };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        templates: [
          { id: 'mkt-1', name: 'Marketplace Reply', instructions: ['Be brief'], download_count: 42 },
        ],
        pagination: { total: 1, has_more: false },
      }),
    });
    const result = await templateSearch.run({ query: 'reply' });
    expect(result.ok).toBe(true);
    const local = result.templates.filter(t => t.source === 'local');
    const marketplace = result.templates.filter(t => t.source === 'marketplace');
    expect(local.length).toBe(1);
    expect(marketplace.length).toBe(1);
    expect(result.local_count).toBe(1);
    expect(result.marketplace_count).toBe(1);
  });

  it('gracefully degrades when marketplace fails', async () => {
    seedTemplate({ id: 'local-3', name: 'Fallback Template' });
    storageData['supabaseSession'] = { access_token: 'valid-token', refresh_token: 'rt', expires_at: Math.floor(Date.now() / 1000) + 3600 };
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network'));
    const result = await templateSearch.run({ query: 'fallback' });
    expect(result.ok).toBe(true);
    expect(result.templates.length).toBe(1);
    expect(result.templates[0].source).toBe('local');
  });

  it('passes query, category, sort as URL params to marketplace', async () => {
    storageData['supabaseSession'] = { access_token: 'valid-token', refresh_token: 'rt', expires_at: Math.floor(Date.now() / 1000) + 3600 };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ templates: [], pagination: { total: 0, has_more: false } }),
    });
    await templateSearch.run({ query: 'formal', category: 'business', sort: 'recent' });
    const fetchUrl = globalThis.fetch.mock.calls[0][0];
    expect(fetchUrl).toContain('search=formal');
    expect(fetchUrl).toContain('category=business');
    expect(fetchUrl).toContain('sort=recent');
    expect(fetchUrl).toContain('limit=10');
  });

  it('shows all local templates when query is empty', async () => {
    seedTemplate({ id: 'all-1', name: 'Template A' });
    seedTemplate({ id: 'all-2', name: 'Template B' });
    const result = await templateSearch.run({});
    expect(result.ok).toBe(true);
    const local = result.templates.filter(t => t.source === 'local');
    expect(local.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Tests: idTranslator template_* support
// ---------------------------------------------------------------------------
const ctxModule = await import('../chat/modules/context.js');
const idTranslatorModule = await import('../chat/modules/idTranslator.js');

describe('idTranslator processToolCallLLMtoTB — template tools', () => {
  beforeEach(() => {
    // Initialize idTranslation context with Map objects (matching real context.js)
    ctxModule.ctx.idTranslation = {
      idMap: new Map(),        // numericId -> realId
      nextNumericId: 1,
      lastAccessed: Date.now(),
    };
  });

  it('translates numeric template_id in processToolCallLLMtoTB', () => {
    // Register a mapping using toNumericId (which updates the Map internally)
    const numId = idTranslatorModule.toNumericId('uuid-tpl-abc');
    expect(typeof numId).toBe('number');

    const args = { template_id: numId, name: 'Updated Name' };
    const translated = idTranslatorModule.processToolCallLLMtoTB('template_edit', args);
    expect(translated.template_id).toBe('uuid-tpl-abc');
    expect(translated.name).toBe('Updated Name');
  });

  it('translates UUID template_id to numeric in processToolResultTBtoLLM', () => {
    // toNumericId auto-registers new IDs
    const result = idTranslatorModule.processToolResultTBtoLLM({
      result: "Template created.",
      template_id: "uuid-new-template-xyz",
      template_name: "My Template",
    });
    expect(typeof result.template_id).toBe('number');
    expect(result.template_name).toBe('My Template');

    // Verify the registered mapping works in reverse
    const realId = idTranslatorModule.toRealId(result.template_id);
    expect(realId).toBe('uuid-new-template-xyz');
  });

  it('translates template_id inside nested arrays (search results)', () => {
    const result = idTranslatorModule.processToolResultTBtoLLM({
      ok: true,
      templates: [
        { template_id: "uuid-search-1", name: "Template A" },
        { template_id: "uuid-search-2", name: "Template B" },
      ],
    });
    expect(typeof result.templates[0].template_id).toBe('number');
    expect(typeof result.templates[1].template_id).toBe('number');
    expect(result.templates[0].template_id).not.toBe(result.templates[1].template_id);

    // Verify reverse lookup
    expect(idTranslatorModule.toRealId(result.templates[0].template_id)).toBe('uuid-search-1');
    expect(idTranslatorModule.toRealId(result.templates[1].template_id)).toBe('uuid-search-2');
  });

  it('passes through string template_id unchanged for template_create', () => {
    const args = { name: 'New Template' };
    const translated = idTranslatorModule.processToolCallLLMtoTB('template_create', args);
    expect(translated.name).toBe('New Template');
  });

  it('leaves template_id unchanged if no mapping exists', () => {
    const args = { template_id: 999 };
    const translated = idTranslatorModule.processToolCallLLMtoTB('template_edit', args);
    expect(translated.template_id).toBe(999);
  });
});

// ---------------------------------------------------------------------------
// Tests: core.js tool registration
// ---------------------------------------------------------------------------
describe('core.js template tool registration', () => {
  let core;

  beforeEach(async () => {
    // Need extra mocks for core.js imports
    core = await import('../chat/tools/core.js');
  });

  it('getToolActivityLabel returns correct labels for template tools', async () => {
    expect(await core.getToolActivityLabel('template_create')).toBe('Creating template…');
    expect(await core.getToolActivityLabel('template_edit')).toBe('Editing template…');
    expect(await core.getToolActivityLabel('template_delete')).toBe('Deleting template…');
    expect(await core.getToolActivityLabel('template_share')).toBe('Sharing template…');
  });

  it('getToolActivityLabel includes query for template_search', async () => {
    const label = await core.getToolActivityLabel('template_search', { query: 'formal' });
    expect(label).toBe('Searching templates: formal');
  });

  it('getToolActivityLabel returns generic for template_search without query', async () => {
    const label = await core.getToolActivityLabel('template_search', {});
    expect(label).toBe('Searching templates…');
  });

  it('isFsmTool detects FSM tools by export const fsm = true', () => {
    // FSM tools (export fsm = true)
    expect(core.isFsmTool('template_create')).toBe(true);
    expect(core.isFsmTool('template_edit')).toBe(true);
    expect(core.isFsmTool('template_delete')).toBe(true);
    expect(core.isFsmTool('template_share')).toBe(true);
    expect(core.isFsmTool('template_download')).toBe(true);
    // Non-FSM tools (no fsm export)
    expect(core.isFsmTool('template_search')).toBe(false);
    expect(core.isFsmTool('template_read')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: FSM state registration in fsm/core.js
// ---------------------------------------------------------------------------
describe('template FSM state handler exports', () => {
  it('templateCreate exports list and exec handlers', async () => {
    const tc = await import('../chat/fsm/templateCreate.js');
    expect(typeof tc.runStateCreateTemplateList).toBe('function');
    expect(typeof tc.runStateCreateTemplateExec).toBe('function');
  });

  it('templateEdit exports list and exec handlers', async () => {
    const te = await import('../chat/fsm/templateEdit.js');
    expect(typeof te.runStateEditTemplateList).toBe('function');
    expect(typeof te.runStateEditTemplateExec).toBe('function');
  });

  it('templateDelete exports list and exec handlers', async () => {
    const td = await import('../chat/fsm/templateDelete.js');
    expect(typeof td.runStateDeleteTemplateList).toBe('function');
    expect(typeof td.runStateDeleteTemplateExec).toBe('function');
  });

  it('templateShare exports list and exec handlers', async () => {
    const ts = await import('../chat/fsm/templateShare.js');
    expect(typeof ts.runStateShareTemplateList).toBe('function');
    expect(typeof ts.runStateShareTemplateExec).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Tests: template tool exports
// ---------------------------------------------------------------------------
describe('template tool exports', () => {
  it('template_create exports run, completeExecution, resetPaginationSessions', async () => {
    const mod = await import('../chat/tools/template_create.js');
    expect(typeof mod.run).toBe('function');
    expect(typeof mod.completeExecution).toBe('function');
    expect(typeof mod.resetPaginationSessions).toBe('function');
  });

  it('template_edit exports run, completeExecution, resetPaginationSessions', async () => {
    const mod = await import('../chat/tools/template_edit.js');
    expect(typeof mod.run).toBe('function');
    expect(typeof mod.completeExecution).toBe('function');
    expect(typeof mod.resetPaginationSessions).toBe('function');
  });

  it('template_delete exports run, completeExecution, resetPaginationSessions', async () => {
    const mod = await import('../chat/tools/template_delete.js');
    expect(typeof mod.run).toBe('function');
    expect(typeof mod.completeExecution).toBe('function');
    expect(typeof mod.resetPaginationSessions).toBe('function');
  });

  it('template_share exports run, completeExecution, resetPaginationSessions', async () => {
    const mod = await import('../chat/tools/template_share.js');
    expect(typeof mod.run).toBe('function');
    expect(typeof mod.completeExecution).toBe('function');
    expect(typeof mod.resetPaginationSessions).toBe('function');
  });

  it('template_search exports run, resetPaginationSessions (no completeExecution — non-FSM)', async () => {
    const mod = await import('../chat/tools/template_search.js');
    expect(typeof mod.run).toBe('function');
    expect(typeof mod.resetPaginationSessions).toBe('function');
    expect(mod.completeExecution).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: FSM tool run() returns correct marker
// ---------------------------------------------------------------------------
describe('template FSM tools return correct marker', () => {
  beforeEach(() => {
    clearStorage();
    vi.clearAllMocks();
    // Prevent requestAnimationFrame from actually running
    globalThis.requestAnimationFrame = vi.fn((cb) => {});
  });

  it('template_create run() returns { fsm: true, tool: "template_create" }', async () => {
    const mod = await import('../chat/tools/template_create.js');
    const result = await mod.run({ name: 'Test' }, { callId: 'tc-1' });
    expect(result.fsm).toBe(true);
    expect(result.tool).toBe('template_create');
    expect(result.pid).toBe('tc-1');
    expect(typeof result.startedAt).toBe('number');
  });

  it('template_edit run() returns { fsm: true, tool: "template_edit" }', async () => {
    const mod = await import('../chat/tools/template_edit.js');
    const result = await mod.run({ template_id: 'tpl-1', name: 'Updated' }, { callId: 'te-1' });
    expect(result.fsm).toBe(true);
    expect(result.tool).toBe('template_edit');
    expect(result.pid).toBe('te-1');
  });

  it('template_delete run() returns { fsm: true, tool: "template_delete" }', async () => {
    const mod = await import('../chat/tools/template_delete.js');
    const result = await mod.run({ template_id: 'tpl-1' }, { callId: 'td-1' });
    expect(result.fsm).toBe(true);
    expect(result.tool).toBe('template_delete');
    expect(result.pid).toBe('td-1');
  });

  it('template_share run() returns { fsm: true, tool: "template_share" }', async () => {
    const mod = await import('../chat/tools/template_share.js');
    const result = await mod.run({ template_id: 'tpl-1' }, { callId: 'ts-1' });
    expect(result.fsm).toBe(true);
    expect(result.tool).toBe('template_share');
    expect(result.pid).toBe('ts-1');
  });
});

// ---------------------------------------------------------------------------
// Tests: completeExecution returns correct results
// ---------------------------------------------------------------------------
describe('template tool completeExecution', () => {
  beforeEach(() => {
    clearStorage();
    vi.clearAllMocks();
    ctxModule.ctx.fsmSessions = {};
    ctxModule.ctx.activePid = 0;
    ctxModule.ctx.activeToolCallId = null;
  });

  it('template_create.completeExecution returns success when createResult exists', async () => {
    ctxModule.ctx.activePid = 'pid-1';
    ctxModule.ctx.fsmSessions['pid-1'] = { createResult: { id: 'tpl-new', name: 'My Template' } };

    const mod = await import('../chat/tools/template_create.js');
    const result = await mod.completeExecution('exec_success', 'template_create_exec');
    expect(result.result).toContain('successfully');
    expect(result.template_id).toBe('tpl-new');
    expect(result.template_name).toBe('My Template');
  });

  it('template_create.completeExecution returns error when failReason set', async () => {
    ctxModule.ctx.activePid = 'pid-1';
    ctxModule.ctx.fsmSessions['pid-1'] = { failReason: 'Template name is required.' };

    const mod = await import('../chat/tools/template_create.js');
    const result = await mod.completeExecution('exec_fail', 'template_create_list');
    expect(result.error).toBe('Template name is required.');
  });

  it('template_edit.completeExecution returns success when editResult exists', async () => {
    ctxModule.ctx.activePid = 'pid-2';
    ctxModule.ctx.fsmSessions['pid-2'] = { editResult: { id: 'tpl-1', name: 'Updated Name' } };

    const mod = await import('../chat/tools/template_edit.js');
    const result = await mod.completeExecution('exec_success', 'template_edit_exec');
    expect(result.result).toContain('successfully');
    expect(result.template_name).toBe('Updated Name');
  });

  it('template_delete.completeExecution returns success when deleteResult exists', async () => {
    ctxModule.ctx.activePid = 'pid-3';
    ctxModule.ctx.fsmSessions['pid-3'] = { deleteResult: { name: 'Old Template' } };

    const mod = await import('../chat/tools/template_delete.js');
    const result = await mod.completeExecution('exec_success', 'template_delete_exec');
    expect(result.result).toContain('successfully');
    expect(result.template_name).toBe('Old Template');
  });

  it('template_create.completeExecution returns generic message when no createResult', async () => {
    ctxModule.ctx.activePid = 'pid-g';
    ctxModule.ctx.fsmSessions['pid-g'] = {};

    const mod = await import('../chat/tools/template_create.js');
    const result = await mod.completeExecution('exec_success', 'some_other_state');
    expect(result.result).toContain('workflow completed');
    expect(result.template_id).toBeUndefined();
  });

  it('template_share.completeExecution returns success when shareResult exists', async () => {
    ctxModule.ctx.activePid = 'pid-4';
    ctxModule.ctx.fsmSessions['pid-4'] = {
      shareResult: {
        template_id: 'tpl-1',
        status: 'pending_review',
        message: 'Template submitted for review.',
      },
    };

    const mod = await import('../chat/tools/template_share.js');
    const result = await mod.completeExecution('exec_success', 'template_share_exec');
    expect(result.result).toContain('submitted');
    expect(result.status).toBe('pending_review');
  });
});

// ---------------------------------------------------------------------------
// Tests: idTranslator processStringTBtoLLM — template_id in text
// ---------------------------------------------------------------------------
describe('idTranslator processStringTBtoLLM — template_id in text', () => {
  beforeEach(() => {
    ctxModule.ctx.idTranslation = {
      idMap: new Map(),
      nextNumericId: 1,
      lastAccessed: Date.now(),
    };
  });

  it('translates template_id: UUID in text to numeric ID', () => {
    // Register a template
    const numId = idTranslatorModule.toNumericId('uuid-tpl-text-1');
    // processToolResultTBtoLLM handles string results
    const result = idTranslatorModule.processToolResultTBtoLLM(
      `Template created.\ntemplate_id: uuid-tpl-text-1\ntemplate_name: My Template`
    );
    expect(result).toContain(`template_id: ${numId}`);
    expect(result).toContain('template_name: My Template');
  });
});

// ---------------------------------------------------------------------------
// Tests: TB markdown renderer recognizes [Template](N)
// ---------------------------------------------------------------------------
describe('TB markdown renderer [Template](N) recognition', () => {
  it('markdown.js regex includes Template in special link pattern', async () => {
    // Read the actual source file to verify the regex includes Template
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.resolve(import.meta.dirname, '../chat/modules/markdown.js'),
      'utf-8'
    );
    // Check that the special link regex includes Template
    expect(src).toContain('Email|Contact|Event|Template');
    // Check that the Template handler exists
    expect(src).toContain('type === "Template"');
    expect(src).toContain('tm-template-link');
  });
});

// ---------------------------------------------------------------------------
// Tests: Backend FSM state transition prompts exist
// ---------------------------------------------------------------------------
describe('Backend FSM state transition prompt files exist', () => {
  it('curr_state prompt files exist for all template FSM states', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const backendDir = path.resolve(import.meta.dirname, '../../tabmail-backend/src/prompts/common');

    const currStates = [
      'template_create_list-v1.0.0.md',
      'template_edit_list-v1.0.0.md',
      'template_delete_list-v1.0.0.md',
      'template_share_list-v1.0.0.md',
    ];
    for (const file of currStates) {
      const fullPath = path.join(backendDir, 'curr_state', file);
      expect(fs.existsSync(fullPath), `Missing curr_state prompt: ${file}`).toBe(true);
    }
  });

  it('next_state prompt files exist for all template FSM states', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const backendDir = path.resolve(import.meta.dirname, '../../tabmail-backend/src/prompts/common');

    const nextStates = [
      'template_create_exec-v1.0.0.md',
      'template_edit_exec-v1.0.0.md',
      'template_delete_exec-v1.0.0.md',
      'template_share_exec-v1.0.0.md',
    ];
    for (const file of nextStates) {
      const fullPath = path.join(backendDir, 'next_state', file);
      expect(fs.existsSync(fullPath), `Missing next_state prompt: ${file}`).toBe(true);
    }
  });

  it('promptGenerator.ts stateTransitions includes template states', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.resolve(import.meta.dirname, '../../tabmail-backend/src/helpers/promptGenerator.ts'),
      'utf-8'
    );
    expect(src).toContain("'template_create_list'");
    expect(src).toContain("'template_create_exec'");
    expect(src).toContain("'template_edit_list'");
    expect(src).toContain("'template_edit_exec'");
    expect(src).toContain("'template_delete_list'");
    expect(src).toContain("'template_delete_exec'");
    expect(src).toContain("'template_share_list'");
    expect(src).toContain("'template_share_exec'");
  });
});

// ---------------------------------------------------------------------------
// Tests: System prompt template guidance
// ---------------------------------------------------------------------------
describe('System prompt template tool guidance', () => {
  it('iOS system prompt mentions template tools', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.resolve(import.meta.dirname, '../../tabmail-backend/src/prompts/ios/system_prompt_agent-v1.5.0.md'),
      'utf-8'
    );
    expect(src).toContain('template_create');
    expect(src).toContain('template_edit');
    expect(src).toContain('template_delete');
    expect(src).toContain('template_share');
    expect(src).toContain('template_search');
    expect(src).toContain('[Template](N)');
  });

  it('TB system prompt includes [Template](N) pill format', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.resolve(import.meta.dirname, '../../tabmail-backend/src/prompts/thunderbird/system_prompt_agent-v1.5.0.md'),
      'utf-8'
    );
    // Verify the exact pill format is documented
    expect(src).toContain('[Template](N)');
  });

  it('TB system prompt mentions template tools', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.resolve(import.meta.dirname, '../../tabmail-backend/src/prompts/thunderbird/system_prompt_agent-v1.5.0.md'),
      'utf-8'
    );
    expect(src).toContain('template_create');
    expect(src).toContain('template_edit');
    expect(src).toContain('template_delete');
    expect(src).toContain('template_share');
    expect(src).toContain('template_search');
    expect(src).toContain('[Template](N)');
  });
});

// ---------------------------------------------------------------------------
// Tests: @ mention autocomplete template support
// ---------------------------------------------------------------------------
describe('@ mention autocomplete — template support', () => {
  it('mentionAutocomplete.js exports refreshTemplateCache', async () => {
    const mod = await import('../chat/modules/mentionAutocomplete.js');
    expect(typeof mod.refreshTemplateCache).toBe('function');
  });

  it('mentionAutocomplete.js includes template type in selectMatch handling', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.resolve(import.meta.dirname, '../chat/modules/mentionAutocomplete.js'),
      'utf-8'
    );
    // Verify template type is handled in selectMatch
    expect(src).toContain('match.type === "template"');
    expect(src).toContain('markdownType = "Template"');
    expect(src).toContain('chipEmoji = "📝"');
    // Verify template matching function exists
    expect(src).toContain('function fuzzyMatchTemplates');
    // Verify templates appear in empty-query dropdown
    expect(src).toContain('templateCache');
    // Verify chip comment documents Template type
    expect(src).toContain('"Template"');
  });

  it('mentionAutocomplete.js chip-to-markdown handles Template type generically', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.resolve(import.meta.dirname, '../chat/modules/mentionAutocomplete.js'),
      'utf-8'
    );
    // The chip extraction uses dataset.markdownType generically (no hardcoded type list)
    expect(src).toContain('chip.dataset.markdownType || "Email"');
    // Verify it creates [markdownType](numericId) format
    expect(src).toContain('`[${markdownType}](${numericId})`');
  });
});

// ---------------------------------------------------------------------------
// Tests: template_read (local + marketplace fallback)
// ---------------------------------------------------------------------------
describe('template_read tool', () => {
  beforeEach(() => {
    clearStorage();
    vi.clearAllMocks();
    globalThis.fetch = vi.fn();
  });

  it('exports run as a function', () => {
    expect(typeof templateRead.run).toBe('function');
  });

  it('returns local template when found', async () => {
    seedTemplate({ id: 'local-read-1', name: 'My Local', instructions: ['Be brief'], exampleReply: 'Thanks!' });
    const result = await templateRead.run({ template_id: 'local-read-1' });
    expect(result.ok).toBe(true);
    expect(result.source).toBe('local');
    expect(result.name).toBe('My Local');
    expect(result.instructions).toEqual(['Be brief']);
    expect(result.example_reply).toBe('Thanks!');
    expect(result.enabled).toBe(true);
  });

  it('returns error when template_id is missing', async () => {
    const result = await templateRead.run({});
    expect(result.error).toContain('required');
  });

  it('falls back to marketplace when not found locally', async () => {
    storageData['supabaseSession'] = { access_token: 'tok', refresh_token: 'rt', expires_at: Math.floor(Date.now() / 1000) + 3600 };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        template: {
          id: 'mkt-read-1',
          name: 'Marketplace Template',
          instructions: ['Rule 1'],
          example_reply: 'Example text',
          download_count: 99,
          category: 'business',
        },
      }),
    });

    const result = await templateRead.run({ template_id: 'mkt-read-1' });
    expect(result.ok).toBe(true);
    expect(result.source).toBe('marketplace');
    expect(result.name).toBe('Marketplace Template');
    expect(result.download_count).toBe(99);
  });

  it('returns error when not found locally or in marketplace', async () => {
    storageData['supabaseSession'] = { access_token: 'tok', refresh_token: 'rt', expires_at: Math.floor(Date.now() / 1000) + 3600 };
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });

    const result = await templateRead.run({ template_id: 'nonexistent' });
    expect(result.error).toContain('not found');
  });

  it('skips marketplace when no auth token', async () => {
    // No supabaseSession in storage
    const result = await templateRead.run({ template_id: 'unknown-id' });
    expect(result.error).toContain('not found');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('skips deleted local templates and falls back to marketplace', async () => {
    seedTemplate({ id: 'del-1', name: 'Deleted', deleted: true });
    // No auth → marketplace also skipped → error
    const result = await templateRead.run({ template_id: 'del-1' });
    expect(result.error).toContain('not found');
  });
});

// ---------------------------------------------------------------------------
// Tests: template_download tool
// ---------------------------------------------------------------------------
describe('template_download tool', () => {
  beforeEach(() => {
    clearStorage();
    vi.clearAllMocks();
    globalThis.requestAnimationFrame = vi.fn();
  });

  it('exports run, completeExecution, resetPaginationSessions', async () => {
    const mod = await import('../chat/tools/template_download.js');
    expect(typeof mod.run).toBe('function');
    expect(typeof mod.completeExecution).toBe('function');
    expect(typeof mod.resetPaginationSessions).toBe('function');
  });

  it('run() returns { fsm: true, tool: "template_download" }', async () => {
    const mod = await import('../chat/tools/template_download.js');
    const result = await mod.run({ template_id: 'tpl-1' }, { callId: 'tdl-1' });
    expect(result.fsm).toBe(true);
    expect(result.tool).toBe('template_download');
    expect(result.pid).toBe('tdl-1');
  });

  it('completeExecution returns success when downloadResult exists', async () => {
    ctxModule.ctx.activePid = 'pid-dl';
    ctxModule.ctx.fsmSessions['pid-dl'] = { downloadResult: { id: 'new-tpl', name: 'Downloaded Template' } };

    const mod = await import('../chat/tools/template_download.js');
    const result = await mod.completeExecution('exec_success', 'template_download_exec');
    expect(result.result).toContain('downloaded');
    expect(result.template_name).toBe('Downloaded Template');
  });

  it('completeExecution returns error when failReason set', async () => {
    ctxModule.ctx.activePid = 'pid-dl2';
    ctxModule.ctx.fsmSessions['pid-dl2'] = { failReason: 'Auth failed' };

    const mod = await import('../chat/tools/template_download.js');
    const result = await mod.completeExecution('exec_fail', 'template_download_list');
    expect(result.error).toBe('Auth failed');
  });
});

// ---------------------------------------------------------------------------
// Tests: Word-based OR search scoring
// ---------------------------------------------------------------------------
describe('template_search word-based OR matching', () => {
  beforeEach(() => {
    clearStorage();
    vi.clearAllMocks();
    globalThis.fetch = vi.fn();
  });

  it('single word matches template name', async () => {
    seedTemplate({ id: 'w1', name: 'Professional Decline' });
    seedTemplate({ id: 'w2', name: 'Casual Reply' });
    const result = await templateSearch.run({ query: 'professional' });
    expect(result.ok).toBe(true);
    const local = result.templates.filter(t => t.source === 'local');
    expect(local.length).toBe(1);
    expect(local[0].name).toBe('Professional Decline');
  });

  it('multi-word OR matches across different templates', async () => {
    seedTemplate({ id: 'w3', name: 'Formal Reply', instructions: ['Use formal tone'] });
    seedTemplate({ id: 'w4', name: 'Short Answer', instructions: ['Keep it brief'] });
    seedTemplate({ id: 'w5', name: 'Unrelated Template', instructions: ['No match here'] });
    const result = await templateSearch.run({ query: 'formal brief' });
    expect(result.ok).toBe(true);
    const local = result.templates.filter(t => t.source === 'local');
    // Both 'Formal Reply' and 'Short Answer' match (OR logic)
    expect(local.length).toBe(2);
  });

  it('name matches score higher than instruction-only matches', async () => {
    seedTemplate({ id: 'w6', name: 'Brief Note', instructions: ['Be thorough'] });
    seedTemplate({ id: 'w7', name: 'Long Form', instructions: ['Be brief and concise'] });
    const result = await templateSearch.run({ query: 'brief' });
    const local = result.templates.filter(t => t.source === 'local');
    expect(local.length).toBe(2);
    // 'Brief Note' should rank first (name match = 2 points vs instruction match = 1)
    expect(local[0].name).toBe('Brief Note');
  });

  it('word in both name and instructions gets cumulative score', async () => {
    seedTemplate({ id: 'w8', name: 'Formal Letter', instructions: ['Use formal language'] });
    seedTemplate({ id: 'w9', name: 'Informal Chat', instructions: ['Use formal grammar'] }); // "formal" only in instructions
    const result = await templateSearch.run({ query: 'formal' });
    const local = result.templates.filter(t => t.source === 'local');
    expect(local.length).toBe(2);
    // 'Formal Letter' has "formal" in name (2) + instructions (1) = 3
    // 'Informal Chat' has "formal" in instructions only (1)
    expect(local[0].name).toBe('Formal Letter');
  });

  it('case-insensitive matching', async () => {
    seedTemplate({ id: 'w10', name: 'URGENT Reply' });
    const result = await templateSearch.run({ query: 'urgent' });
    const local = result.templates.filter(t => t.source === 'local');
    expect(local.length).toBe(1);
  });

  it('matches in exampleReply field', async () => {
    seedTemplate({ id: 'w11', name: 'Generic', exampleReply: 'Thank you for your patience.' });
    const result = await templateSearch.run({ query: 'patience' });
    const local = result.templates.filter(t => t.source === 'local');
    expect(local.length).toBe(1);
  });

  it('empty query returns all local templates', async () => {
    seedTemplate({ id: 'w12', name: 'Template A' });
    seedTemplate({ id: 'w13', name: 'Template B' });
    seedTemplate({ id: 'w14', name: 'Template C' });
    const result = await templateSearch.run({});
    const local = result.templates.filter(t => t.source === 'local');
    expect(local.length).toBe(3);
  });

  it('no match returns no local results', async () => {
    seedTemplate({ id: 'w15', name: 'Something Else' });
    const result = await templateSearch.run({ query: 'xyznonexistent' });
    // Only marketplace results (or none if no auth)
    const local = (result.templates || []).filter(t => t.source === 'local');
    expect(local.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: template_read marketplace fallback coverage
// ---------------------------------------------------------------------------
describe('template_read marketplace paths', () => {
  beforeEach(() => {
    clearStorage();
    vi.clearAllMocks();
    globalThis.fetch = vi.fn();
  });

  it('handles marketplace fetch network error gracefully', async () => {
    storageData['supabaseSession'] = { access_token: 'tok', refresh_token: 'rt', expires_at: Math.floor(Date.now() / 1000) + 3600 };
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('timeout'));
    const result = await templateRead.run({ template_id: 'unknown-uuid' });
    expect(result.error).toContain('not found');
  });

  it('handles marketplace returning invalid JSON', async () => {
    storageData['supabaseSession'] = { access_token: 'tok', refresh_token: 'rt', expires_at: Math.floor(Date.now() / 1000) + 3600 };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ noTemplateKey: true }),
    });
    const result = await templateRead.run({ template_id: 'unknown-uuid' });
    expect(result.error).toContain('not found');
  });
});

// ---------------------------------------------------------------------------
// Tests: template_search marketplace integration
// ---------------------------------------------------------------------------
describe('template_search marketplace integration', () => {
  beforeEach(() => {
    clearStorage();
    vi.clearAllMocks();
    globalThis.fetch = vi.fn();
  });

  it('returns marketplace results with download_count', async () => {
    storageData['supabaseSession'] = { access_token: 'tok', refresh_token: 'rt', expires_at: Math.floor(Date.now() / 1000) + 3600 };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        templates: [
          { id: 'mkt-1', name: 'Popular', instructions: ['rule'], download_count: 100, category: 'business' },
        ],
        pagination: { total: 1, has_more: false },
      }),
    });
    const result = await templateSearch.run({ query: 'popular' });
    expect(result.ok).toBe(true);
    const mkt = result.templates.filter(t => t.source === 'marketplace');
    expect(mkt.length).toBe(1);
    expect(mkt[0].download_count).toBe(100);
    expect(result.marketplace_count).toBe(1);
    expect(result.marketplace_total).toBe(1);
  });

  it('handles marketplace non-200 without crashing', async () => {
    storageData['supabaseSession'] = { access_token: 'tok', refresh_token: 'rt', expires_at: Math.floor(Date.now() / 1000) + 3600 };
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const result = await templateSearch.run({ query: 'test' });
    // Should still return ok (marketplace failure is non-fatal)
    expect(result.ok || result.result).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Tests: FSM tool export const fsm = true
// ---------------------------------------------------------------------------
describe('FSM tools declare export const fsm = true', () => {
  const fsmToolFiles = [
    'template_create', 'template_edit', 'template_delete',
    'template_share', 'template_download',
  ];

  for (const toolName of fsmToolFiles) {
    it(`${toolName}.js exports fsm = true`, async () => {
      const mod = await import(`../chat/tools/${toolName}.js`);
      expect(mod.fsm).toBe(true);
    });
  }

  const nonFsmToolFiles = ['template_read', 'template_search'];

  for (const toolName of nonFsmToolFiles) {
    it(`${toolName}.js does NOT export fsm = true`, async () => {
      const mod = await import(`../chat/tools/${toolName}.js`);
      expect(mod.fsm).not.toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Tests: template_read error edge cases (improve branch coverage)
// ---------------------------------------------------------------------------
describe('template_read edge cases', () => {
  beforeEach(() => {
    clearStorage();
    vi.clearAllMocks();
    globalThis.fetch = vi.fn();
  });

  it('handles numeric template_id (idTranslator already converted)', async () => {
    seedTemplate({ id: 'uuid-numeric-test', name: 'Numeric Test' });
    // After idTranslator, template_id arrives as string UUID
    const result = await templateRead.run({ template_id: 'uuid-numeric-test' });
    expect(result.ok).toBe(true);
    expect(result.name).toBe('Numeric Test');
  });

  it('returns source: local for local templates', async () => {
    seedTemplate({ id: 'src-local', name: 'Local Source' });
    const result = await templateRead.run({ template_id: 'src-local' });
    expect(result.source).toBe('local');
  });

  it('returns source: marketplace for marketplace templates', async () => {
    storageData['supabaseSession'] = { access_token: 'tok', refresh_token: 'rt', expires_at: Math.floor(Date.now() / 1000) + 3600 };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        template: { id: 'mkt-src', name: 'Market Source', instructions: [], example_reply: 'hi', download_count: 5, category: 'test' },
      }),
    });
    const result = await templateRead.run({ template_id: 'mkt-src' });
    expect(result.source).toBe('marketplace');
  });

  it('includes all expected fields for local template', async () => {
    seedTemplate({ id: 'fields-test', name: 'Fields', instructions: ['a', 'b'], exampleReply: 'reply text' });
    const result = await templateRead.run({ template_id: 'fields-test' });
    expect(result.template_id).toBe('fields-test');
    expect(result.name).toBe('Fields');
    expect(result.instructions).toEqual(['a', 'b']);
    expect(result.example_reply).toBe('reply text');
    expect(result.enabled).toBe(true);
    expect(result.source).toBe('local');
  });

  it('includes marketplace-specific fields for marketplace template', async () => {
    storageData['supabaseSession'] = { access_token: 'tok', refresh_token: 'rt', expires_at: Math.floor(Date.now() / 1000) + 3600 };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        template: {
          id: 'mkt-fields', name: 'Market Fields', instructions: ['x'],
          example_reply: 'ex', download_count: 42, category: 'biz',
          tags: ['formal'], is_featured: true, is_official: false,
        },
      }),
    });
    const result = await templateRead.run({ template_id: 'mkt-fields' });
    expect(result.download_count).toBe(42);
    expect(result.category).toBe('biz');
  });
});

// ---------------------------------------------------------------------------
// Tests: template_search edge cases
// ---------------------------------------------------------------------------
describe('template_search edge cases', () => {
  beforeEach(() => {
    clearStorage();
    vi.clearAllMocks();
    globalThis.fetch = vi.fn();
  });

  it('returns local_count and marketplace_count correctly', async () => {
    seedTemplate({ id: 'lc-1', name: 'Local One' });
    seedTemplate({ id: 'lc-2', name: 'Local Two' });
    storageData['supabaseSession'] = { access_token: 'tok', refresh_token: 'rt', expires_at: Math.floor(Date.now() / 1000) + 3600 };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({
        templates: [{ id: 'mkt-c1', name: 'Market One', instructions: [] }],
        pagination: { total: 1, has_more: false },
      }),
    });
    const result = await templateSearch.run({});
    expect(result.local_count).toBe(2);
    expect(result.marketplace_count).toBe(1);
    expect(result.templates.length).toBe(3);
  });

  it('filters deleted templates from local results', async () => {
    seedTemplate({ id: 'del-local', name: 'Deleted One', deleted: true });
    seedTemplate({ id: 'vis-local', name: 'Visible One' });
    const result = await templateSearch.run({});
    const local = result.templates.filter(t => t.source === 'local');
    expect(local.length).toBe(1);
    expect(local[0].name).toBe('Visible One');
  });

  it('returns enabled status for local templates', async () => {
    seedTemplate({ id: 'en-1', name: 'Enabled', enabled: true });
    const result = await templateSearch.run({});
    const local = result.templates.filter(t => t.source === 'local');
    expect(local[0].enabled).toBe(true);
  });

  it('returns instructions_count for local templates', async () => {
    seedTemplate({ id: 'ic-1', name: 'With Rules', instructions: ['r1', 'r2', 'r3'] });
    const result = await templateSearch.run({});
    const local = result.templates.filter(t => t.source === 'local');
    expect(local[0].instructions_count).toBe(3);
  });

  it('multi-word query with partial matches still ranks', async () => {
    seedTemplate({ id: 'mw-1', name: 'Professional Reply', instructions: ['Be formal'], exampleReply: 'Dear Sir' });
    seedTemplate({ id: 'mw-2', name: 'Casual Chat', instructions: ['Be relaxed and fun'] });
    // "professional formal" — mw-1 has both words, mw-2 has neither
    const result = await templateSearch.run({ query: 'professional formal' });
    const local = result.templates.filter(t => t.source === 'local');
    expect(local.length).toBe(1);
    expect(local[0].name).toBe('Professional Reply');
  });
});
