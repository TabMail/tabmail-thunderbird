// patchApplier.test.js — Patch application tests
//
// patchApplier.js imports { log, normalizeUnicode } from "./utils.js".
// We mock utils.js to provide these without browser dependencies.

import { describe, it, expect, vi } from 'vitest';

// Mock utils.js — provide log (no-op) and a real normalizeUnicode implementation
vi.mock('../agent/modules/utils.js', () => ({
  log: vi.fn(),
  normalizeUnicode: (text) => {
    if (!text || typeof text !== 'string') return text;
    return text
      .normalize('NFKC')
      .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')
      .replace(/[\u2018\u2019\u201B]/g, "'")
      .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
      .replace(/[\u2032\u2035]/g, "'")
      .replace(/\u3010/g, '[')
      .replace(/\u3011/g, ']')
      .replace(/[\u00A0\u202F\u2007\u2008\u2009\u200A\u200B\u2028\u2029\u205F\u3000]/g, ' ')
      .replace(/\u2026/g, '...');
  },
}));

const { applyActionPatch, applyKBPatch } = await import('../agent/modules/patchApplier.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal action rules document with the 4 standard sections. */
function buildActionContent(sections) {
  const types = ['delete', 'archive', 'reply', 'none'];
  return types
    .map((t) => {
      const header = `# Emails to be marked as \`${t}\` (DO NOT EDIT/DELETE THIS SECTION HEADER)`;
      const bullets = (sections[t] || []).map((b) => `- ${b}`).join('\n');
      return bullets ? `${header}\n${bullets}` : header;
    })
    .join('\n\n');
}

// ---------------------------------------------------------------------------
// TB-040: Add lines patch
// ---------------------------------------------------------------------------
describe('applyKBPatch', () => {
  it('TB-040: ADD appends a new bullet to KB', () => {
    const content = '- User likes coffee\n- User works remotely';
    const patch = 'ADD\nUser prefers dark mode';

    const result = applyKBPatch(content, patch);

    expect(result).not.toBeNull();
    expect(result).toContain('- User likes coffee');
    expect(result).toContain('- User works remotely');
    expect(result).toContain('- User prefers dark mode.');
  });

  // TB-041: Remove lines patch
  it('TB-041: DEL removes a bullet from KB', () => {
    const content = '- User likes coffee.\n- User works remotely.\n- User prefers dark mode.';
    const patch = 'DEL\nUser works remotely';

    const result = applyKBPatch(content, patch);

    expect(result).not.toBeNull();
    expect(result).toContain('- User likes coffee.');
    expect(result).not.toContain('- User works remotely');
    expect(result).toContain('- User prefers dark mode.');
  });

  // TB-042: Patch to empty document
  it('TB-042: ADD to empty document creates single bullet', () => {
    const content = '';
    const patch = 'ADD\nFirst KB entry';

    const result = applyKBPatch(content, patch);

    expect(result).not.toBeNull();
    expect(result).toContain('- First KB entry.');
  });

  // TB-043: Conflicting patch (DEL for content that doesn't exist)
  it('TB-043: DEL for non-existent content returns null', () => {
    const content = '- User likes coffee.\n- User works remotely.';
    const patch = 'DEL\nUser likes tea';

    const result = applyKBPatch(content, patch);

    // applySingleOperation returns null when content not found for deletion
    expect(result).toBeNull();
  });

  it('multiple ADD operations in one patch', () => {
    const content = '- Existing entry.';
    const patch = 'ADD\nNew entry one\nADD\nNew entry two';

    const result = applyKBPatch(content, patch);

    expect(result).not.toBeNull();
    expect(result).toContain('- Existing entry.');
    expect(result).toContain('- New entry one.');
    expect(result).toContain('- New entry two.');
  });

  it('ADD then DEL in one patch', () => {
    const content = '- Keep this.\n- Remove this.';
    const patch = 'ADD\nNew item\nDEL\nRemove this';

    const result = applyKBPatch(content, patch);

    expect(result).not.toBeNull();
    expect(result).toContain('- Keep this.');
    expect(result).toContain('- New item.');
    expect(result).not.toContain('- Remove this.');
  });

  it('ADD deduplicates — skips if already present', () => {
    const content = '- User likes coffee.';
    const patch = 'ADD\nUser likes coffee';

    const result = applyKBPatch(content, patch);

    // Should return content unchanged (duplicate detected, not an error)
    expect(result).not.toBeNull();
    const matches = result.match(/coffee/g);
    expect(matches).toHaveLength(1);
  });

  it('normalizes content: adds period and bullet prefix', () => {
    const content = '';
    const patch = 'ADD\nNo period here';

    const result = applyKBPatch(content, patch);

    expect(result).toContain('- No period here.');
  });

  it('returns null for empty/invalid patch', () => {
    const content = '- something';
    const patch = 'not a valid operation';

    const result = applyKBPatch(content, patch);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Action patches (applyActionPatch)
// ---------------------------------------------------------------------------
describe('applyActionPatch', () => {
  it('ADD inserts rule into correct section', () => {
    const content = buildActionContent({
      delete: ['spam newsletters'],
      archive: [],
      reply: [],
      none: [],
    });

    const patch = 'ADD\narchive\nOrder confirmations from Amazon';

    const result = applyActionPatch(content, patch);

    expect(result).not.toBeNull();
    expect(result).toContain('- Order confirmations from Amazon.');
    // Should still have the original delete rule
    expect(result).toContain('- spam newsletters');
  });

  it('DEL removes rule from correct section', () => {
    const content = buildActionContent({
      delete: ['spam newsletters', 'phishing emails'],
      archive: [],
      reply: [],
      none: [],
    });

    const patch = 'DEL\ndelete\nspam newsletters';

    const result = applyActionPatch(content, patch);

    expect(result).not.toBeNull();
    expect(result).not.toContain('- spam newsletters');
    expect(result).toContain('- phishing emails');
  });

  it('rejects invalid action type', () => {
    const content = buildActionContent({
      delete: [],
      archive: [],
      reply: [],
      none: [],
    });

    const patch = 'ADD\ninvalid_type\nSome rule';

    const result = applyActionPatch(content, patch);
    expect(result).toBeNull();
  });

  it('multiple action operations in one patch', () => {
    const content = buildActionContent({
      delete: ['old rule'],
      archive: [],
      reply: [],
      none: [],
    });

    const patch = 'ADD\narchive\nNew archive rule\nDEL\ndelete\nold rule';

    const result = applyActionPatch(content, patch);

    expect(result).not.toBeNull();
    expect(result).toContain('- New archive rule.');
    expect(result).not.toContain('- old rule');
  });
});
