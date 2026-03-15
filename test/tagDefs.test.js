// tagDefs.test.js — Tests for agent/modules/tagDefs.js

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
    actionTagging: {
      actionPriority: {
        reply: 40,
        delete: 30,
        archive: 20,
        none: 10,
      },
      debugTagRace: { enabled: false },
    },
  },
}));

vi.mock('../theme/palette/palette.js', () => ({
  getTAG_COLORS: vi.fn(async () => ({
    tm_reply: '#FF0000',
    tm_none: '#808080',
    tm_archive: '#00FF00',
    tm_delete: '#0000FF',
  })),
}));

globalThis.browser = {
  tagSort: {
    refresh: vi.fn(),
  },
  messages: {
    tags: {
      list: vi.fn(async () => []),
      create: vi.fn(async () => {}),
      update: vi.fn(async () => {}),
    },
  },
};

const {
  ACTION_TAG_IDS,
  actionFromLiveTagIds,
  reorderTagsToPreferTabMail,
  hasNonTabMailTags,
  triggerSortRefresh,
  isDebugTagRaceEnabled,
  maxPriorityAction,
  ensureActionTags,
} = await import('../agent/modules/tagDefs.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ACTION_TAG_IDS', () => {
  it('has expected tag IDs', () => {
    expect(ACTION_TAG_IDS.delete).toBe('tm_delete');
    expect(ACTION_TAG_IDS.archive).toBe('tm_archive');
    expect(ACTION_TAG_IDS.reply).toBe('tm_reply');
    expect(ACTION_TAG_IDS.none).toBe('tm_none');
  });
});

describe('actionFromLiveTagIds', () => {
  it('returns null for empty tags', () => {
    expect(actionFromLiveTagIds([])).toBe(null);
  });

  it('returns null for non-array', () => {
    expect(actionFromLiveTagIds(null)).toBe(null);
    expect(actionFromLiveTagIds(undefined)).toBe(null);
  });

  it('returns action for single tag', () => {
    expect(actionFromLiveTagIds(['tm_reply'])).toBe('reply');
    expect(actionFromLiveTagIds(['tm_delete'])).toBe('delete');
  });

  it('returns highest priority action for multiple tags', () => {
    expect(actionFromLiveTagIds(['tm_delete', 'tm_reply'])).toBe('reply');
    expect(actionFromLiveTagIds(['tm_archive', 'tm_delete'])).toBe('delete');
  });

  it('ignores non-TabMail tags', () => {
    expect(actionFromLiveTagIds(['custom_tag', 'tm_archive'])).toBe('archive');
  });

  it('returns null when no TabMail tags found', () => {
    expect(actionFromLiveTagIds(['custom_tag', 'other_tag'])).toBe(null);
  });
});

describe('maxPriorityAction', () => {
  it('returns null for empty array', () => {
    expect(maxPriorityAction([])).toBe(null);
  });

  it('returns highest priority action', () => {
    expect(maxPriorityAction(['archive', 'reply'])).toBe('reply');
    expect(maxPriorityAction(['none', 'delete'])).toBe('delete');
  });

  it('handles single action', () => {
    expect(maxPriorityAction(['archive'])).toBe('archive');
  });

  it('filters null/undefined values', () => {
    expect(maxPriorityAction([null, 'reply', undefined])).toBe('reply');
  });
});

describe('reorderTagsToPreferTabMail', () => {
  it('moves TabMail tags to front', () => {
    const result = reorderTagsToPreferTabMail(['custom1', 'tm_reply', 'custom2']);
    expect(result[0]).toBe('tm_reply');
    expect(result).toContain('custom1');
    expect(result).toContain('custom2');
  });

  it('returns original order when no TabMail tags', () => {
    const tags = ['a', 'b', 'c'];
    expect(reorderTagsToPreferTabMail(tags)).toEqual(['a', 'b', 'c']);
  });

  it('handles single element', () => {
    expect(reorderTagsToPreferTabMail(['tm_delete'])).toEqual(['tm_delete']);
  });

  it('handles empty/null', () => {
    expect(reorderTagsToPreferTabMail([])).toEqual([]);
    expect(reorderTagsToPreferTabMail(null)).toEqual([]);
  });
});

describe('hasNonTabMailTags', () => {
  it('returns false for empty tags', () => {
    expect(hasNonTabMailTags([])).toBe(false);
  });

  it('returns false for only TabMail tags', () => {
    expect(hasNonTabMailTags(['tm_reply', 'tm_delete'])).toBe(false);
  });

  it('returns true when non-TabMail tags present', () => {
    expect(hasNonTabMailTags(['tm_reply', 'custom_tag'])).toBe(true);
  });

  it('returns true for only non-TabMail tags', () => {
    expect(hasNonTabMailTags(['custom'])).toBe(true);
  });
});

describe('triggerSortRefresh', () => {
  it('calls browser.tagSort.refresh()', () => {
    triggerSortRefresh();
    expect(browser.tagSort.refresh).toHaveBeenCalled();
  });

  it('handles missing tagSort API', () => {
    const orig = browser.tagSort;
    browser.tagSort = undefined;
    expect(() => triggerSortRefresh()).not.toThrow();
    browser.tagSort = orig;
  });
});

describe('isDebugTagRaceEnabled', () => {
  it('returns false by default', () => {
    expect(isDebugTagRaceEnabled()).toBe(false);
  });
});

describe('ensureActionTags', () => {
  it('creates tags that do not exist', async () => {
    browser.messages.tags.list.mockResolvedValue([]);
    await ensureActionTags();
    expect(browser.messages.tags.create).toHaveBeenCalled();
  });
});
