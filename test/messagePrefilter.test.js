// messagePrefilter.test.js — Email pre-filtering tests
//
// Tests for TB-140 through TB-146 (TESTS.md §messagePrefilter).
// Tests isNoReplyAddress and hasUnsubscribeLink logic via the exported
// analyzeEmailForReplyFilter function.

import { describe, it, expect, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — messagePrefilter.js imports from utils.js
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

// ---------------------------------------------------------------------------
// Import module under test
// ---------------------------------------------------------------------------

const { analyzeEmailForReplyFilter } = await import('../agent/modules/messagePrefilter.js');

// ---------------------------------------------------------------------------
// Helper: create a minimal messageHeader
// ---------------------------------------------------------------------------
function makeHeader(author, id = 1) {
  return { id, author };
}

// ---------------------------------------------------------------------------
// TB-140: isNoReplyAddress: noreply@domain.com → true
// ---------------------------------------------------------------------------
describe('TB-140: isNoReplyAddress — noreply@domain.com', () => {
  it('detects noreply@domain.com as no-reply', async () => {
    const result = await analyzeEmailForReplyFilter(
      makeHeader('noreply@domain.com'),
      { headers: {} }, // fullMessage — no unsubscribe headers
      '',              // bodyText
    );
    expect(result.isNoReply).toBe(true);
    expect(result.skipCachedReply).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TB-141: isNoReplyAddress: no-reply@domain.com → true
// ---------------------------------------------------------------------------
describe('TB-141: isNoReplyAddress — no-reply@domain.com', () => {
  it('detects no-reply@domain.com as no-reply', async () => {
    const result = await analyzeEmailForReplyFilter(
      makeHeader('no-reply@domain.com'),
      { headers: {} },
      '',
    );
    expect(result.isNoReply).toBe(true);
    expect(result.skipCachedReply).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TB-142: isNoReplyAddress: donotreply@domain.com → true
// ---------------------------------------------------------------------------
describe('TB-142: isNoReplyAddress — donotreply@domain.com', () => {
  it('detects donotreply@domain.com as no-reply', async () => {
    const result = await analyzeEmailForReplyFilter(
      makeHeader('donotreply@domain.com'),
      { headers: {} },
      '',
    );
    expect(result.isNoReply).toBe(true);
    expect(result.skipCachedReply).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TB-143: isNoReplyAddress: support@domain.com → false
// ---------------------------------------------------------------------------
describe('TB-143: isNoReplyAddress — support@domain.com', () => {
  it('does NOT flag support@domain.com as no-reply', async () => {
    const result = await analyzeEmailForReplyFilter(
      makeHeader('support@domain.com'),
      { headers: {} },
      '',
    );
    expect(result.isNoReply).toBe(false);
    expect(result.skipCachedReply).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TB-144: isNoReplyAddress: "Name <noreply@x.com>" format → true
// ---------------------------------------------------------------------------
describe('TB-144: isNoReplyAddress — "Name <noreply@x.com>" format', () => {
  it('extracts email from angle brackets and detects no-reply', async () => {
    const result = await analyzeEmailForReplyFilter(
      makeHeader('Notifications <noreply@x.com>'),
      { headers: {} },
      '',
    );
    expect(result.isNoReply).toBe(true);
    expect(result.skipCachedReply).toBe(true);
  });

  it('handles quoted display name with angle bracket email', async () => {
    const result = await analyzeEmailForReplyFilter(
      makeHeader('"Company Name" <no-reply@company.com>'),
      { headers: {} },
      '',
    );
    expect(result.isNoReply).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TB-145: hasUnsubscribeLink: List-Unsubscribe header → true
// ---------------------------------------------------------------------------
describe('TB-145: hasUnsubscribeLink — List-Unsubscribe header', () => {
  it('detects List-Unsubscribe header in fullMessage.headers', async () => {
    const fullMessage = {
      headers: {
        'list-unsubscribe': ['<https://example.com/unsubscribe>'],
      },
    };
    const result = await analyzeEmailForReplyFilter(
      makeHeader('support@example.com'),
      fullMessage,
      '',
    );
    expect(result.hasUnsubscribe).toBe(true);
    // isNoReply should still be false for support@
    expect(result.isNoReply).toBe(false);
  });

  it('detects Precedence: bulk header', async () => {
    const fullMessage = {
      headers: {
        'precedence': ['bulk'],
      },
    };
    const result = await analyzeEmailForReplyFilter(
      makeHeader('info@example.com'),
      fullMessage,
      '',
    );
    expect(result.hasUnsubscribe).toBe(true);
  });

  it('detects List-Unsubscribe in nested parts', async () => {
    const fullMessage = {
      headers: {},
      parts: [
        {
          headers: {
            'list-unsubscribe': ['<mailto:unsubscribe@example.com>'],
          },
        },
      ],
    };
    const result = await analyzeEmailForReplyFilter(
      makeHeader('info@example.com'),
      fullMessage,
      '',
    );
    expect(result.hasUnsubscribe).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TB-146: hasUnsubscribeLink: "unsubscribe" in body → true
// ---------------------------------------------------------------------------
describe('TB-146: hasUnsubscribeLink — "unsubscribe" in body', () => {
  it('detects "unsubscribe" + "http" link in body text', async () => {
    const bodyText = 'To unsubscribe from this list, visit http://example.com/unsub';
    const result = await analyzeEmailForReplyFilter(
      makeHeader('news@example.com'),
      { headers: {} },
      bodyText,
    );
    expect(result.hasUnsubscribe).toBe(true);
  });

  it('detects "opt out" + "click" in body text', async () => {
    const bodyText = 'If you wish to opt out, click here to manage preferences.';
    const result = await analyzeEmailForReplyFilter(
      makeHeader('info@example.com'),
      { headers: {} },
      bodyText,
    );
    expect(result.hasUnsubscribe).toBe(true);
  });

  it('does NOT flag "unsubscribe" without a link/click keyword', async () => {
    // The body check requires both an unsubscribe pattern AND a link keyword
    const bodyText = 'You cannot unsubscribe from this mandatory notice.';
    const result = await analyzeEmailForReplyFilter(
      makeHeader('admin@example.com'),
      { headers: {} },
      bodyText,
    );
    expect(result.hasUnsubscribe).toBe(false);
  });

  it('returns hasUnsubscribe=false for plain body without patterns', async () => {
    const bodyText = 'Hello, this is a regular email with no special links.';
    const result = await analyzeEmailForReplyFilter(
      makeHeader('friend@example.com'),
      { headers: {} },
      bodyText,
    );
    expect(result.hasUnsubscribe).toBe(false);
  });
});
