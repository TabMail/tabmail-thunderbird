// bulletMerge.test.js — 3-way bullet merge algorithm tests
//
// bulletMerge.js imports { log } from "./utils.js" which has heavy browser
// dependencies. We mock the entire utils module to isolate pure logic.

import { describe, it, expect, vi } from 'vitest';

// Mock utils.js — only `log` is used by bulletMerge.js
vi.mock('../agent/modules/utils.js', () => ({
  log: vi.fn(),
}));

const { mergeFlatField, mergeSectionedField, COMPOSITION_SECTIONS, ACTION_SECTIONS } =
  await import('../agent/modules/bulletMerge.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a sectioned markdown document for action rules. */
function buildActionDoc(sections) {
  // sections: { delete: string[], archive: string[], reply: string[], none: string[] }
  const types = ['delete', 'archive', 'reply', 'none'];
  return types
    .map((t) => {
      const header = `# Emails to be marked as \`${t}\` (DO NOT EDIT/DELETE THIS SECTION HEADER)`;
      const bullets = (sections[t] || []).map((b) => `- ${b}`).join('\n');
      return `${header}\n${bullets}`;
    })
    .join('\n\n');
}

/** Build a composition-style sectioned doc. */
function buildCompositionDoc(sections) {
  // sections: { "General writing style": string[], "Language": string[], ... }
  return COMPOSITION_SECTIONS.map((header) => {
    const bullets = (sections[header] || []).map((b) => `- ${b}`).join('\n');
    return `# ${header} (DO NOT EDIT/DELETE THIS SECTION HEADER)\n${bullets}`;
  }).join('\n\n');
}

// ---------------------------------------------------------------------------
// TB-001: base + local add + remote add -> both present
// ---------------------------------------------------------------------------
describe('mergeFlatField', () => {
  it('TB-001: merges local addition and remote addition', () => {
    const base = '- alpha\n- beta';
    const local = '- alpha\n- beta\n- gamma';        // local added gamma
    const remote = '- alpha\n- beta\n- delta';       // remote added delta

    const result = mergeFlatField(base, local, remote);

    expect(result).toContain('- gamma');
    expect(result).toContain('- delta');
    expect(result).toContain('- alpha');
    expect(result).toContain('- beta');
  });

  // TB-002: local removal + remote addition
  it('TB-002: keeps remote addition and applies local removal', () => {
    const base = '- alpha\n- beta\n- gamma';
    const local = '- alpha\n- gamma';                 // local removed beta
    const remote = '- alpha\n- beta\n- gamma\n- delta'; // remote added delta

    const result = mergeFlatField(base, local, remote);

    expect(result).toContain('- alpha');
    expect(result).toContain('- gamma');
    expect(result).toContain('- delta');
    // beta was NOT removed by remote, only local removed it — local ordering preserved
    // remote didn't remove beta, so remote's removal set is empty.
    // local already removed beta, so it stays removed.
    expect(result).not.toContain('- beta');
  });

  // TB-003: both sides remove same bullet -> removed once
  it('TB-003: both sides remove same bullet — removed once', () => {
    const base = '- alpha\n- beta\n- gamma';
    const local = '- alpha\n- gamma';                  // removed beta
    const remote = '- alpha\n- gamma';                 // also removed beta

    const result = mergeFlatField(base, local, remote);

    expect(result).toContain('- alpha');
    expect(result).toContain('- gamma');
    expect(result).not.toContain('- beta');
  });

  // TB-004: both sides add same bullet -> no duplicate
  it('TB-004: both sides add same bullet — no duplicate', () => {
    const base = '- alpha';
    const local = '- alpha\n- beta';
    const remote = '- alpha\n- beta';

    const result = mergeFlatField(base, local, remote);

    const matches = result.match(/- beta/g);
    expect(matches).toHaveLength(1);
  });

  // TB-005: empty base -> all additions from both sides
  it('TB-005: empty base — all additions from both sides', () => {
    const base = '';
    const local = '- alpha\n- beta';
    const remote = '- gamma\n- delta';

    const result = mergeFlatField(base, local, remote);

    expect(result).toContain('- alpha');
    expect(result).toContain('- beta');
    expect(result).toContain('- gamma');
    expect(result).toContain('- delta');
  });

  // TB-006: empty local and remote -> base returned
  it('TB-006: empty local and remote — returns local (empty)', () => {
    const base = '- alpha\n- beta';
    const local = '';
    const remote = '';

    // Both removed everything that was in base. local is empty, remote is empty.
    // remoteRemoved = base - remote = {alpha, beta}
    // local bullets = [] after filtering remote removals = []
    // remoteAdded = remote - base = {} (empty)
    // result = []
    const result = mergeFlatField(base, local, remote);
    // When merged === localBullets (both empty), returns local unchanged
    expect(result).toBe('');
  });

  // TB-008: flat merge (no headers) — already covered by the tests above
  it('TB-008: flat merge preserves local ordering', () => {
    const base = '- a\n- b\n- c';
    const local = '- c\n- b\n- a';   // reordered
    const remote = '- a\n- b\n- c\n- d'; // added d

    const result = mergeFlatField(base, local, remote);

    // Local ordering preserved: c, b, a, then remote addition d appended
    const lines = result.split('\n').filter((l) => l.startsWith('- '));
    expect(lines[0]).toBe('- c');
    expect(lines[1]).toBe('- b');
    expect(lines[2]).toBe('- a');
    expect(lines[3]).toBe('- d');
  });

  // TB-009: whitespace variations (leading/trailing spaces in bullets)
  it('TB-009: handles whitespace in bullet text', () => {
    // extractBullets trims lines, so "  - foo  " becomes "foo  " after slice(2)
    // The set comparison is exact on the trimmed content
    const base = '- alpha\n- beta';
    const local = '- alpha\n- beta\n- gamma with spaces';
    const remote = '- alpha\n- beta\n- delta with spaces';

    const result = mergeFlatField(base, local, remote);
    expect(result).toContain('- gamma with spaces');
    expect(result).toContain('- delta with spaces');
  });

  // TB-010: large input (1000+ bullets) performance
  it('TB-010: handles 1000+ bullets without hanging', () => {
    const bullets = Array.from({ length: 1200 }, (_, i) => `- bullet ${i}`);
    const base = bullets.join('\n');

    // Local adds 100 new bullets
    const localExtra = Array.from({ length: 100 }, (_, i) => `- local new ${i}`);
    const local = [...bullets, ...localExtra].join('\n');

    // Remote adds 100 different bullets and removes first 50
    const remoteExtra = Array.from({ length: 100 }, (_, i) => `- remote new ${i}`);
    const remote = [...bullets.slice(50), ...remoteExtra].join('\n');

    const start = performance.now();
    const result = mergeFlatField(base, local, remote);
    const elapsed = performance.now() - start;

    // Should complete in well under 1 second
    expect(elapsed).toBeLessThan(1000);

    // Verify correctness: local additions present, remote additions present, remote removals applied
    expect(result).toContain('- local new 0');
    expect(result).toContain('- remote new 0');
    // First 50 bullets were removed by remote
    const resultLines = result.split('\n');
    expect(resultLines).not.toContain('- bullet 0');
    expect(resultLines).not.toContain('- bullet 49');
    // bullet 50+ should still be present
    expect(resultLines).toContain('- bullet 50');
  });
});

// ---------------------------------------------------------------------------
// TB-007: sectioned merge with headers
// ---------------------------------------------------------------------------
describe('mergeSectionedField', () => {
  it('TB-007: merges per-section independently (action rules)', () => {
    const base = buildActionDoc({
      delete: ['spam newsletters'],
      archive: ['order confirmations'],
      reply: [],
      none: [],
    });

    const local = buildActionDoc({
      delete: ['spam newsletters', 'phishing emails'],   // local added
      archive: ['order confirmations'],
      reply: [],
      none: [],
    });

    const remote = buildActionDoc({
      delete: ['spam newsletters'],
      archive: ['order confirmations', 'shipping notifications'], // remote added
      reply: ['urgent requests'],                                  // remote added
      none: [],
    });

    const result = mergeSectionedField(base, local, remote, ACTION_SECTIONS);

    expect(result).toContain('- phishing emails');
    expect(result).toContain('- shipping notifications');
    expect(result).toContain('- urgent requests');
    expect(result).toContain('- spam newsletters');
  });

  it('sectioned merge: both sides remove from same section', () => {
    const base = buildActionDoc({
      delete: ['rule A', 'rule B', 'rule C'],
      archive: [],
      reply: [],
      none: [],
    });

    const local = buildActionDoc({
      delete: ['rule A', 'rule C'],  // removed rule B
      archive: [],
      reply: [],
      none: [],
    });

    const remote = buildActionDoc({
      delete: ['rule A', 'rule B'],  // removed rule C
      archive: [],
      reply: [],
      none: [],
    });

    const result = mergeSectionedField(base, local, remote, ACTION_SECTIONS);

    expect(result).toContain('- rule A');
    expect(result).not.toContain('- rule B');
    expect(result).not.toContain('- rule C');
  });

  it('sectioned merge with composition sections', () => {
    const base = buildCompositionDoc({
      'General writing style': ['Be concise'],
      'Language': ['English'],
      'Useful links to personal website and other resources': [],
    });

    const local = buildCompositionDoc({
      'General writing style': ['Be concise', 'Use active voice'],
      'Language': ['English'],
      'Useful links to personal website and other resources': [],
    });

    const remote = buildCompositionDoc({
      'General writing style': ['Be concise'],
      'Language': ['English', 'French'],
      'Useful links to personal website and other resources': ['https://example.com'],
    });

    const result = mergeSectionedField(base, local, remote, COMPOSITION_SECTIONS);

    expect(result).toContain('- Use active voice');
    expect(result).toContain('- French');
    expect(result).toContain('- https://example.com');
  });
});
