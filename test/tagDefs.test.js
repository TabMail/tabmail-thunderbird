// tagDefs.test.js — Tag definitions and priority logic tests
//
// Tests for TB-130 through TB-134 (TESTS.md §tagDefs).
// Mocks browser-dependent modules (config.js, palette.js).

import { describe, it, expect, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — tagDefs.js imports config.js (SETTINGS) and palette.js (getTAG_COLORS)
// ---------------------------------------------------------------------------

vi.mock('../agent/modules/config.js', () => ({
  SETTINGS: {
    actionTagging: {
      actionPriority: {
        delete: 0,
        archive: 1,
        none: 2,
        reply: 3,
      },
      debugTagRace: { enabled: false },
    },
  },
}));

vi.mock('../theme/palette/palette.js', () => ({
  getTAG_COLORS: vi.fn(async () => ({
    tm_reply: '#00FF00',
    tm_none: '#808080',
    tm_archive: '#0000FF',
    tm_delete: '#FF0000',
  })),
}));

// ---------------------------------------------------------------------------
// Import functions under test
// ---------------------------------------------------------------------------

const {
  ACTION_TAG_IDS,
  ACTION_TAG_KEYS,
  maxPriorityAction,
  actionFromLiveTagIds,
  reorderTagsToPreferTabMail,
  hasNonTabMailTags,
} = await import('../agent/modules/tagDefs.js');

// ---------------------------------------------------------------------------
// TB-130: maxPriorityAction selects highest priority action
// ---------------------------------------------------------------------------
describe('TB-130: maxPriorityAction', () => {
  it('selects the highest priority action from a list', () => {
    // reply=3 > none=2 > archive=1 > delete=0
    expect(maxPriorityAction(['delete', 'reply'])).toBe('reply');
    expect(maxPriorityAction(['delete', 'archive', 'none', 'reply'])).toBe('reply');
    expect(maxPriorityAction(['delete', 'archive'])).toBe('archive');
  });

  it('returns the single action when given one', () => {
    expect(maxPriorityAction(['none'])).toBe('none');
    expect(maxPriorityAction(['delete'])).toBe('delete');
  });

  it('handles unknown actions (priority -1) — known action wins', () => {
    expect(maxPriorityAction(['unknown', 'delete'])).toBe('delete');
  });

  it('returns null if all actions are unknown (priority -1 never beats initial -1)', () => {
    // Unknown actions get priority -1, which never satisfies p > bestP (-1)
    expect(maxPriorityAction(['foo', 'bar'])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TB-131: actionFromLiveTagIds — reverse lookup (tag IDs → action names)
// ---------------------------------------------------------------------------
describe('TB-131: actionFromLiveTagIds', () => {
  it('maps tm_reply tag ID to "reply" action', () => {
    expect(actionFromLiveTagIds(['tm_reply'])).toBe('reply');
  });

  it('maps tm_delete tag ID to "delete" action', () => {
    expect(actionFromLiveTagIds(['tm_delete'])).toBe('delete');
  });

  it('returns highest priority when multiple TM tags present', () => {
    // reply=3 > delete=0
    expect(actionFromLiveTagIds(['tm_delete', 'tm_reply'])).toBe('reply');
  });

  it('ignores non-TabMail tag IDs', () => {
    expect(actionFromLiveTagIds(['$label1', 'tm_archive'])).toBe('archive');
  });

  it('returns null when no TabMail tag IDs present', () => {
    expect(actionFromLiveTagIds(['$label1', '$label2'])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TB-132: reorderTagsToPreferTabMail puts TabMail tags first
// ---------------------------------------------------------------------------
describe('TB-132: reorderTagsToPreferTabMail', () => {
  it('moves TabMail action tags to the front', () => {
    const result = reorderTagsToPreferTabMail(['$label1', 'tm_reply', '$label2']);
    expect(result[0]).toBe('tm_reply');
    expect(result).toEqual(['tm_reply', '$label1', '$label2']);
  });

  it('preserves relative order of non-TabMail tags', () => {
    const result = reorderTagsToPreferTabMail(['$label3', '$label1', 'tm_none', '$label2']);
    expect(result).toEqual(['tm_none', '$label3', '$label1', '$label2']);
  });

  it('returns original order when no TabMail tags present', () => {
    const input = ['$label1', '$label2', '$label3'];
    const result = reorderTagsToPreferTabMail(input);
    expect(result).toEqual(['$label1', '$label2', '$label3']);
  });

  it('handles single-element arrays unchanged', () => {
    expect(reorderTagsToPreferTabMail(['tm_delete'])).toEqual(['tm_delete']);
    expect(reorderTagsToPreferTabMail(['$label1'])).toEqual(['$label1']);
  });

  it('returns empty array for empty input', () => {
    expect(reorderTagsToPreferTabMail([])).toEqual([]);
  });

  it('handles multiple TabMail tags at front', () => {
    const result = reorderTagsToPreferTabMail(['$label1', 'tm_reply', 'tm_archive']);
    expect(result).toEqual(['tm_reply', 'tm_archive', '$label1']);
  });
});

// ---------------------------------------------------------------------------
// TB-133: hasNonTabMailTags detects non-TabMail action tags
// ---------------------------------------------------------------------------
describe('TB-133: hasNonTabMailTags', () => {
  it('returns true when non-TabMail tags are present', () => {
    expect(hasNonTabMailTags(['tm_reply', '$label1'])).toBe(true);
  });

  it('returns false when only TabMail tags are present', () => {
    expect(hasNonTabMailTags(['tm_reply', 'tm_delete', 'tm_archive', 'tm_none'])).toBe(false);
  });

  it('returns true for only non-TabMail tags', () => {
    expect(hasNonTabMailTags(['$label1', '$label2'])).toBe(true);
  });

  it('returns false for empty array', () => {
    expect(hasNonTabMailTags([])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TB-134: Empty/null input handling — no crash
// ---------------------------------------------------------------------------
describe('TB-134: Empty/null input handling', () => {
  it('maxPriorityAction returns null for empty array', () => {
    expect(maxPriorityAction([])).toBeNull();
  });

  it('maxPriorityAction returns null for null/undefined', () => {
    expect(maxPriorityAction(null)).toBeNull();
    expect(maxPriorityAction(undefined)).toBeNull();
  });

  it('maxPriorityAction returns null for non-array', () => {
    expect(maxPriorityAction('reply')).toBeNull();
    expect(maxPriorityAction(42)).toBeNull();
  });

  it('maxPriorityAction filters out falsy values from array', () => {
    expect(maxPriorityAction([null, undefined, '', 'reply'])).toBe('reply');
  });

  it('actionFromLiveTagIds returns null for empty array', () => {
    expect(actionFromLiveTagIds([])).toBeNull();
  });

  it('actionFromLiveTagIds returns null for null/undefined', () => {
    expect(actionFromLiveTagIds(null)).toBeNull();
    expect(actionFromLiveTagIds(undefined)).toBeNull();
  });

  it('actionFromLiveTagIds returns null for non-array', () => {
    expect(actionFromLiveTagIds('tm_reply')).toBeNull();
  });

  it('reorderTagsToPreferTabMail handles null/undefined gracefully', () => {
    expect(reorderTagsToPreferTabMail(null)).toEqual([]);
    expect(reorderTagsToPreferTabMail(undefined)).toEqual([]);
  });

  it('reorderTagsToPreferTabMail filters out falsy elements', () => {
    expect(reorderTagsToPreferTabMail([null, 'tm_reply', undefined, '$label1'])).toEqual(['tm_reply', '$label1']);
  });

  it('hasNonTabMailTags handles null/undefined gracefully', () => {
    expect(hasNonTabMailTags(null)).toBe(false);
    expect(hasNonTabMailTags(undefined)).toBe(false);
  });

  it('ACTION_TAG_IDS and ACTION_TAG_KEYS are defined correctly', () => {
    expect(ACTION_TAG_IDS.reply).toBe('tm_reply');
    expect(ACTION_TAG_IDS.delete).toBe('tm_delete');
    expect(ACTION_TAG_IDS.archive).toBe('tm_archive');
    expect(ACTION_TAG_IDS.none).toBe('tm_none');
    expect(ACTION_TAG_KEYS.has('tm_reply')).toBe(true);
    expect(ACTION_TAG_KEYS.has('tm_delete')).toBe(true);
    expect(ACTION_TAG_KEYS.size).toBe(4);
  });
});
