/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// quoteAndSignature.test.js — Tests for agent/modules/quoteAndSignature.js
//
// The module is an IIFE that attaches globalThis.TabMailQuoteDetection.
// It's a classic script, so we load via vm.runInNewContext.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runInNewContext } from 'vm';

let QD;

beforeAll(() => {
  const code = readFileSync(resolve(__dirname, '../agent/modules/quoteAndSignature.js'), 'utf8');
  const sandbox = { globalThis: {}, console };
  runInNewContext(code, sandbox);
  QD = sandbox.globalThis.TabMailQuoteDetection;
});

// ---------------------------------------------------------------------------
// TabMailQuoteDetection existence and structure
// ---------------------------------------------------------------------------
describe('TabMailQuoteDetection', () => {
  it('is defined after loading the module', () => {
    expect(QD).toBeDefined();
    expect(typeof QD).toBe('object');
  });

  it('exposes splitPlainTextForQuote function', () => {
    expect(typeof QD.splitPlainTextForQuote).toBe('function');
  });

  it('exposes findBoundaryInPlainText function', () => {
    expect(typeof QD.findBoundaryInPlainText).toBe('function');
  });

  it('exposes findLastSignatureFromBottom function', () => {
    expect(typeof QD.findLastSignatureFromBottom).toBe('function');
  });

  it('exposes isSignatureDelimiterLine function', () => {
    expect(typeof QD.isSignatureDelimiterLine).toBe('function');
  });

  it('exposes patterns object', () => {
    expect(QD.patterns).toBeDefined();
    expect(Array.isArray(QD.patterns.replyBoundaryPatterns)).toBe(true);
  });

  it('exposes config object', () => {
    expect(QD.config).toBeDefined();
    expect(typeof QD.config.lookaheadLines).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// splitPlainTextForQuote
// ---------------------------------------------------------------------------
describe('splitPlainTextForQuote', () => {
  it('returns full text as main when no boundary exists', () => {
    const result = QD.splitPlainTextForQuote('Hello world');
    expect(result.main).toBe('Hello world');
    expect(result.quote).toBe('');
    expect(result.signature).toBe('');
  });

  it('returns empty main for empty input', () => {
    const result = QD.splitPlainTextForQuote('');
    expect(result.main).toBe('');
  });

  it('detects "On ... wrote:" attribution', () => {
    const text = 'My reply\n\nOn Mon, Jan 1, 2024 at 10:00 AM John wrote:\n> Original message';
    const result = QD.splitPlainTextForQuote(text);
    expect(result.main).toBe('My reply');
    expect(result.quote).toContain('On Mon');
    expect(result.boundaryType).toBe('attribution');
  });

  it('detects -----Original Message----- boundary', () => {
    const text = 'My reply\n\n-----Original Message-----\nFrom: someone';
    const result = QD.splitPlainTextForQuote(text);
    expect(result.main).toBe('My reply');
    expect(result.quote).toContain('Original Message');
    expect(result.boundaryType).toBe('original-message');
  });

  it('detects signature delimiter "-- " via findLastSignatureFromBottom', () => {
    const text = 'My message\n-- \nJohn Doe\nCEO, Company';
    // splitPlainTextForQuote doesn't separate signatures from main;
    // signature detection is via findLastSignatureFromBottom
    const sig = QD.findLastSignatureFromBottom(text);
    expect(sig).toBeDefined();
    expect(sig.lineIndex).toBe(1); // "-- " is on line 1
    expect(sig.charIndex).toBe(11); // After "My message\n"
  });

  it('handles forwarded message delimiter', () => {
    const text = 'See below\n\n-------- Forwarded Message --------\nSubject: test';
    const result = QD.splitPlainTextForQuote(text);
    expect(result.main).toBe('See below');
    expect(result.quote).toContain('Forwarded Message');
  });

  it('detects German attribution', () => {
    const text = 'Meine Antwort\n\nAm 1. Januar 2024 schrieb Max:\n> Original';
    const result = QD.splitPlainTextForQuote(text);
    expect(result.main).toBe('Meine Antwort');
    expect(result.boundaryType).toBe('attribution');
  });

  it('detects French attribution', () => {
    const text = 'Ma réponse\n\nLe 1 janvier 2024, Jean a écrit :\n> Original';
    const result = QD.splitPlainTextForQuote(text);
    expect(result.main).toBe('Ma réponse');
    expect(result.boundaryType).toBe('attribution');
  });

  it('detects Spanish attribution', () => {
    const text = 'Mi respuesta\n\nEl 1 de enero de 2024, Juan escribió:\n> Original';
    const result = QD.splitPlainTextForQuote(text);
    expect(result.main).toBe('Mi respuesta');
    expect(result.boundaryType).toBe('attribution');
  });

  it('detects Italian attribution', () => {
    const text = 'La mia risposta\n\nIl 1 gennaio 2024, Giovanni ha scritto:\n> Original';
    const result = QD.splitPlainTextForQuote(text);
    expect(result.main).toBe('La mia risposta');
    expect(result.boundaryType).toBe('attribution');
  });

  it('does not split on > that appears mid-text (not at line start)', () => {
    const text = 'Math: 5 > 3 and 10 > 7';
    const result = QD.splitPlainTextForQuote(text);
    expect(result.main).toBe('Math: 5 > 3 and 10 > 7');
  });

  it('handles null/undefined input gracefully', () => {
    const result = QD.splitPlainTextForQuote(null);
    expect(result.main).toBe('');
    expect(result.quote).toBe('');
  });
});

// ---------------------------------------------------------------------------
// findBoundaryInPlainText
// ---------------------------------------------------------------------------
describe('findBoundaryInPlainText', () => {
  it('returns null when no boundary is found', () => {
    const result = QD.findBoundaryInPlainText('Hello world');
    expect(result).toBeNull();
  });

  it('returns null for empty text', () => {
    const result = QD.findBoundaryInPlainText('');
    expect(result).toBeNull();
  });

  it('finds attribution line boundary', () => {
    const text = 'Reply\n\nOn Mon, Jan 1 at 10:00 AM John wrote:\n> text';
    const result = QD.findBoundaryInPlainText(text);
    expect(result).toBeDefined();
    expect(result.type).toBe('attribution');
    expect(typeof result.lineIndex).toBe('number');
    expect(typeof result.charIndex).toBe('number');
  });

  it('finds original-message boundary', () => {
    const text = 'Reply\n\n-----Original Message-----\nFrom: x';
    const result = QD.findBoundaryInPlainText(text);
    expect(result).toBeDefined();
    expect(result.type).toBe('original-message');
  });

  it('finds forwarded-message boundary when includeForward is true', () => {
    const text = 'FYI\n\n-------- Forwarded Message --------\nSubject: x';
    const result = QD.findBoundaryInPlainText(text, { includeForward: true });
    expect(result).toBeDefined();
    expect(result.type).toBe('forwarded-message');
  });

  it('skips forwarded-message boundary when includeForward is false', () => {
    const text = 'FYI\n\n-------- Forwarded Message --------\nSubject: x';
    const result = QD.findBoundaryInPlainText(text, { includeForward: false });
    // Should not find the forward boundary
    if (result) {
      expect(result.type).not.toBe('forwarded-message');
    }
  });

  it('finds Outlook header block boundary', () => {
    const text = 'Reply\n\nFrom: john@example.com\nSent: Jan 1 2024\nTo: jane@example.com\nSubject: Test';
    const result = QD.findBoundaryInPlainText(text);
    expect(result).toBeDefined();
    expect(result.type).toBe('outlook-headers');
  });
});

// ---------------------------------------------------------------------------
// isSignatureDelimiterLine
// ---------------------------------------------------------------------------
describe('isSignatureDelimiterLine', () => {
  it('matches "-- " (RFC signature)', () => {
    expect(QD.isSignatureDelimiterLine('-- ')).toBe(true);
  });

  it('matches "--" (bare dashes)', () => {
    expect(QD.isSignatureDelimiterLine('--')).toBe(true);
  });

  it('does not match long dashes', () => {
    expect(QD.isSignatureDelimiterLine('--------')).toBe(false);
  });

  it('does not match regular text', () => {
    expect(QD.isSignatureDelimiterLine('Hello world')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// findLastSignatureFromBottom
// ---------------------------------------------------------------------------
describe('findLastSignatureFromBottom', () => {
  it('finds signature at the bottom of text', () => {
    const text = 'Message content\n-- \nJohn Doe';
    const result = QD.findLastSignatureFromBottom(text);
    expect(result).toBeDefined();
    expect(result.lineIndex).toBeGreaterThan(0);
  });

  it('returns null when no signature exists', () => {
    const text = 'Just a message with no signature';
    const result = QD.findLastSignatureFromBottom(text);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Pattern matching
// ---------------------------------------------------------------------------
describe('reply boundary patterns', () => {
  const types = () => QD.patterns.replyBoundaryPatterns.map(p => p.type);

  it('includes forwarded-message type', () => {
    expect(types()).toContain('forwarded-message');
  });

  it('includes original-message type', () => {
    expect(types()).toContain('original-message');
  });

  it('includes attribution type', () => {
    expect(types()).toContain('attribution');
  });

  it('includes dash-separator type', () => {
    expect(types()).toContain('dash-separator');
  });

  it('includes outlook-headers type', () => {
    expect(types()).toContain('outlook-headers');
  });

  it('includes quoted type', () => {
    expect(types()).toContain('quoted');
  });

  it('includes localized-sender type', () => {
    expect(types()).toContain('localized-sender');
  });

  it('all patterns have a pattern regex', () => {
    for (const entry of QD.patterns.replyBoundaryPatterns) {
      // instanceof RegExp fails across vm contexts; check by duck-typing
      expect(typeof entry.pattern.test).toBe('function');
    }
  });

  it('all patterns have a type string', () => {
    for (const entry of QD.patterns.replyBoundaryPatterns) {
      expect(typeof entry.type).toBe('string');
    }
  });
});

// ---------------------------------------------------------------------------
// textContainsSignatureDelimiter
// ---------------------------------------------------------------------------
describe('textContainsSignatureDelimiter', () => {
  it('returns true when text contains "-- " on its own line', () => {
    expect(QD.textContainsSignatureDelimiter('Hello\n-- \nSig')).toBe(true);
  });

  it('returns false when text has no signature delimiter', () => {
    expect(QD.textContainsSignatureDelimiter('Hello world')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Korean localized patterns
// ---------------------------------------------------------------------------
describe('Korean localized sender patterns', () => {
  it('detects Korean sender header (보낸 사람:)', () => {
    const text = 'My reply\n\n보낸 사람: someone@example.com\n보낸 날짜: 2024-01-01';
    const result = QD.findBoundaryInPlainText(text);
    expect(result).toBeDefined();
    expect(result.type).toBe('localized-sender');
  });
});

// ---------------------------------------------------------------------------
// Korean attribution pattern
// ---------------------------------------------------------------------------
describe('Korean attribution pattern', () => {
  it('detects Korean Gmail attribution', () => {
    const text = 'My reply\n\n2026년 1월 22일 (목) AM 4:23, Name <email>님이 작성:\n> text';
    const result = QD.findBoundaryInPlainText(text);
    expect(result).toBeDefined();
    expect(result.type).toBe('attribution');
  });
});

// ---------------------------------------------------------------------------
// Chinese attribution pattern
// ---------------------------------------------------------------------------
describe('Chinese attribution pattern', () => {
  it('detects Chinese Gmail attribution with full-width colon', () => {
    const text = 'My reply\n\nJane Doe <jane@example.com> \u4E8E2026\u5E743\u670817\u65E5\u5468\u4E8C 01:16\u5199\u9053\uFF1A\n> text';
    const result = QD.findBoundaryInPlainText(text);
    expect(result).toBeDefined();
    expect(result.type).toBe('attribution');
  });

  it('detects Chinese Gmail attribution with half-width colon', () => {
    const text = 'My reply\n\nJane Doe <jane@example.com> \u4E8E2026\u5E743\u670817\u65E5\u5468\u4E8C 01:16\u5199\u9053:\n> text';
    const result = QD.findBoundaryInPlainText(text);
    expect(result).toBeDefined();
    expect(result.type).toBe('attribution');
  });
});

// ---------------------------------------------------------------------------
// Multi-line attribution fallback (line wrapping on narrow screens)
// ---------------------------------------------------------------------------
describe('Multi-line attribution fallback', () => {
  it('detects Chinese attribution split across two lines', () => {
    // Simulates narrow screen wrapping: "于" on line 1, "2026年...写道：" on line 2
    const text = 'My reply\n\nJane Doe <jane@example.com> \u4E8E\n2026\u5E743\u670817\u65E5\u5468\u4E8C 01:16\u5199\u9053\uFF1A\n> quoted';
    const result = QD.findBoundaryInPlainText(text);
    expect(result).toBeDefined();
    expect(result.type).toBe('attribution');
  });

  it('detects Korean attribution split across two lines', () => {
    // "님이" on line 1, "작성:" on line 2
    const text = 'My reply\n\nUser <user@test.com>\uB2D8\uC774\n\uC791\uC131:\n> quoted';
    const result = QD.findBoundaryInPlainText(text);
    expect(result).toBeDefined();
    expect(result.type).toBe('attribution');
  });

  it('detects English "wrote:" split across two lines', () => {
    const text = 'My reply\n\nOn Mon, Mar 17, 2026 at 10:00 AM John Smith\n<john@example.com> wrote:\n> quoted';
    const result = QD.findBoundaryInPlainText(text);
    expect(result).toBeDefined();
    expect(result.type).toBe('attribution');
  });

  it('detects German attribution split across two lines', () => {
    const text = 'My reply\n\nAm 17. M\u00E4rz 2026 schrieb\nMax Mustermann:\n> quoted';
    const result = QD.findBoundaryInPlainText(text);
    expect(result).toBeDefined();
    expect(result.type).toBe('attribution');
  });

  it('single-line patterns still work (no regression)', () => {
    const text = 'My reply\n\nOn Mon, Mar 17, 2026 at 10:00 AM John Smith <john@example.com> wrote:\n> quoted';
    const result = QD.findBoundaryInPlainText(text);
    expect(result).toBeDefined();
    expect(result.type).toBe('attribution');
  });

  // -------------------------------------------------------------------------
  // Regression: multi-line fallback must NOT steal boundary from the next
  // line when that line alone matches a single-line attribution pattern.
  // Bug: "Thanks!" + "Name 于...写道：" joined matched Chinese pattern,
  // setting boundary to the "Thanks!" line instead of the attribution line.
  // -------------------------------------------------------------------------

  it('does NOT steal boundary from Chinese attribution on next line', () => {
    const text = 'Thanks!\nJane Doe <jane@example.com> \u4E8E2026\u5E743\u670830\u65E5\u5468\u4E00 17:38\u5199\u9053\uFF1A\nHello Alex,';
    const result = QD.findBoundaryInPlainText(text);
    expect(result).toBeDefined();
    expect(result.type).toBe('attribution');
    expect(result.lineIndex).toBe(1);
  });

  it('does NOT steal boundary from Chinese attribution (half-width colon)', () => {
    const text = 'Got it.\nUser <u@test.com> \u4E8E2026\u5E741\u670810\u65E5\u5468\u4E09 09:00\u5199\u9053:\nHi,';
    const result = QD.findBoundaryInPlainText(text);
    expect(result).toBeDefined();
    expect(result.type).toBe('attribution');
    expect(result.lineIndex).toBe(1);
  });

  it('does NOT steal boundary from English wrote: on next line', () => {
    const text = 'Thanks!\nOn Mon, Mar 17, 2026 at 10:00 AM John Smith <john@example.com> wrote:\n> quoted';
    const result = QD.findBoundaryInPlainText(text);
    expect(result).toBeDefined();
    expect(result.type).toBe('attribution');
    expect(result.lineIndex).toBe(1);
  });

  it('does NOT steal boundary from Korean attribution on next line', () => {
    const text = '\uAC10\uC0AC\uD569\uB2C8\uB2E4!\nUser <u@test.com>\uB2D8\uC774 \uC791\uC131:\n> quoted';
    const result = QD.findBoundaryInPlainText(text);
    expect(result).toBeDefined();
    expect(result.type).toBe('attribution');
    expect(result.lineIndex).toBe(1);
  });

  it('does NOT steal boundary from German attribution on next line', () => {
    const text = 'Danke!\nAm 17. M\u00E4rz 2026 schrieb Max Mustermann:\n> quoted';
    const result = QD.findBoundaryInPlainText(text);
    expect(result).toBeDefined();
    expect(result.type).toBe('attribution');
    expect(result.lineIndex).toBe(1);
  });

  it('does NOT steal boundary from French attribution on next line', () => {
    const text = 'Merci!\nLe 17 mars 2026, Jean Dupont a \u00E9crit :\n> quoted';
    const result = QD.findBoundaryInPlainText(text);
    expect(result).toBeDefined();
    expect(result.type).toBe('attribution');
    expect(result.lineIndex).toBe(1);
  });

  it('does NOT steal boundary from Spanish attribution on next line', () => {
    const text = 'Gracias!\nEl 17 de marzo de 2026, Juan escribi\u00F3:\n> quoted';
    const result = QD.findBoundaryInPlainText(text);
    expect(result).toBeDefined();
    expect(result.type).toBe('attribution');
    expect(result.lineIndex).toBe(1);
  });

  it('does NOT steal boundary from Portuguese attribution on next line', () => {
    const text = 'Obrigado!\nEm 17 de mar\u00E7o de 2026, Jo\u00E3o escreveu:\n> quoted';
    const result = QD.findBoundaryInPlainText(text);
    expect(result).toBeDefined();
    expect(result.type).toBe('attribution');
    expect(result.lineIndex).toBe(1);
  });

  it('does NOT steal boundary with blank line before attribution', () => {
    // Common case: reply text, blank line, then attribution
    const text = 'Thanks!\n\nJane Doe <jane@example.com> \u4E8E2026\u5E743\u670830\u65E5\u5468\u4E00 17:38\u5199\u9053\uFF1A\nHello,';
    const result = QD.findBoundaryInPlainText(text);
    expect(result).toBeDefined();
    expect(result.type).toBe('attribution');
    // Must be line 2 (the attribution), not line 0 ("Thanks!")
    expect(result.lineIndex).toBe(2);
  });

  it('still detects genuinely split attribution across two lines', () => {
    // "于" on line i, rest on line i+1 — neither line alone matches, only joined
    const text = 'My reply\n\nJane Doe <jane@example.com> \u4E8E\n2026\u5E743\u670817\u65E5\u5468\u4E8C 01:16\u5199\u9053\uFF1A\n> quoted';
    const result = QD.findBoundaryInPlainText(text);
    expect(result).toBeDefined();
    expect(result.type).toBe('attribution');
    // Should match on the first part of the split (line 2)
    expect(result.lineIndex).toBe(2);
  });

  it('still detects genuinely split English wrote: across two lines', () => {
    const text = 'My reply\n\nOn Mon, Mar 17, 2026 at 10:00 AM John Smith\n<john@example.com> wrote:\n> quoted';
    const result = QD.findBoundaryInPlainText(text);
    expect(result).toBeDefined();
    expect(result.type).toBe('attribution');
    expect(result.lineIndex).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Apple Mail / iOS "Begin forwarded message:" pattern
// ---------------------------------------------------------------------------
describe('Apple Mail forward pattern', () => {
  it('detects "Begin forwarded message:" when includeForward is true', () => {
    const text = 'FYI see below\n\nBegin forwarded message:\n\nFrom: Alice <alice@example.com>\nDate: March 15, 2026\nTo: Bob <bob@example.com>\nSubject: Project update\n\nHere is the update.';
    const result = QD.findBoundaryInPlainText(text, { includeForward: true });
    expect(result).toBeDefined();
    expect(result.type).toBe('forwarded-message');
  });

  it('skips "Begin forwarded message:" when includeForward is false', () => {
    const text = 'FYI see below\n\nBegin forwarded message:\n\nFrom: Alice <alice@example.com>\nDate: March 15, 2026\nTo: Bob <bob@example.com>\nSubject: Project update\n\nHere is the update.';
    const result = QD.findBoundaryInPlainText(text, { includeForward: false });
    // Should fall through to outlook-headers (From/Date/To/Subject), not forwarded-message
    if (result) {
      expect(result.type).not.toBe('forwarded-message');
    }
  });

  it('detects "Begin forwarded message:" with trailing whitespace', () => {
    const text = 'Please review\n\nBegin forwarded message:  \n\nFrom: Carol <carol@example.com>';
    const result = QD.findBoundaryInPlainText(text, { includeForward: true });
    expect(result).toBeDefined();
    expect(result.type).toBe('forwarded-message');
  });

  it('is case-insensitive for "begin forwarded message:"', () => {
    const text = 'Note\n\nbegin forwarded message:\n\nFrom: Dave <dave@example.com>';
    const result = QD.findBoundaryInPlainText(text, { includeForward: true });
    expect(result).toBeDefined();
    expect(result.type).toBe('forwarded-message');
  });

  it('prefers Apple forward over Outlook headers when includeForward is true', () => {
    // "Begin forwarded message:" appears before the From/Date/To/Subject block
    const text = 'Passing this along\n\nBegin forwarded message:\n\nFrom: Eve <eve@example.com>\nDate: April 1, 2026\nTo: Frank <frank@example.com>\nSubject: Budget review\n\nPlease see attached.';
    const result = QD.findBoundaryInPlainText(text, { includeForward: true });
    expect(result).toBeDefined();
    expect(result.type).toBe('forwarded-message');
    // The forward line should be the earliest boundary
    const lines = text.split('\n');
    expect(lines[result.lineIndex]).toMatch(/Begin forwarded message/i);
  });
});

// ---------------------------------------------------------------------------
// Bare ">" quote fallback — must require a RUN of consecutive ">"-prefixed lines
// (regression: Vancouver Sun newsletter ">> Read the full story" links were
// falsely detected as a quote boundary, collapsing nearly the whole email).
// Mirrors the iOS collapseQuotesJS fallback (2 consecutive ">" lines).
// ---------------------------------------------------------------------------
describe('quoted fallback requires consecutive ">" lines', () => {
  it('does NOT treat a lone ">> ..." newsletter link as a quote', () => {
    // A single ">>"-prefixed line surrounded by ordinary content.
    const text = [
      'Number of patients waiting to see a specialist climbs 10%',
      '',
      '>> Read the full story',
      '',
      'British Columbia',
    ].join('\n');
    const result = QD.findBoundaryInPlainText(text);
    expect(result).toBeNull();
  });

  it('does NOT treat several scattered ">> ..." links as a quote', () => {
    // Multiple ">>"-prefixed links, but each isolated by non-quoted content.
    const text = [
      'Story one summary',
      '>> Read the full story',
      'Story two summary',
      '>> Subscriber only',
      'Story three summary',
      '>> Try Puzzmo!',
    ].join('\n');
    const result = QD.findBoundaryInPlainText(text);
    expect(result).toBeNull();
  });

  it('still detects a genuine multi-line ">" quoted reply', () => {
    const text = [
      'Sure, sounds good.',
      '',
      '> Can we meet on Tuesday?',
      '> Let me know what works.',
    ].join('\n');
    const result = QD.findBoundaryInPlainText(text);
    expect(result).toBeDefined();
    expect(result).not.toBeNull();
    expect(result.type).toBe('quoted');
    expect(result.lineIndex).toBe(2);
  });

  it('honors config.quotedFallbackMinConsecutiveLines', () => {
    expect(QD.config.quotedFallbackMinConsecutiveLines).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Bare ">" quote fallback — the run must be TRAILING. Invariant: a ">" run
// followed by substantial non-quoted content is embedded content, never a
// collapse boundary (regression: a Reddit digest whose second post quoted a
// notice with three ">" lines collapsed the remaining posts and the footer on
// both TB and iOS). Mirrors the iOS collapseQuotesJS fallback.
// ---------------------------------------------------------------------------
describe('quoted fallback requires a TRAILING ">" run', () => {
  const digestTail = [];
  for (let n = 1; n <= 12; n++) digestTail.push(`Post ${n} title`, `${n} upvotes`, `${n} comments`);

  it('does NOT collapse a digest that embeds a ">" excerpt followed by more content', () => {
    const text = [
      'r/example',
      'Some notice about a data breach',
      '> Dear Customer,',
      '>',
      '> We are writing to inform you of a recent data s...',
      'Read More',
      ...digestTail,
      'Unsubscribe from daily digest messages.',
    ].join('\n');
    expect(QD.findBoundaryInPlainText(text)).toBeNull();
  });

  it('does NOT collapse a bottom-posted reply (quote first, answer below)', () => {
    const answer = [];
    for (let n = 1; n <= 12; n++) answer.push(`Answer paragraph ${n}.`);
    const text = ['> Can we meet on Tuesday?', '> Let me know what works.', '', ...answer].join('\n');
    expect(QD.findBoundaryInPlainText(text)).toBeNull();
  });

  it('still collapses a trailing quote followed by a short sign-off and undelimited signature', () => {
    const text = [
      'Sure, sounds good.',
      '',
      '> Can we meet on Tuesday?',
      '> Let me know what works.',
      '',
      'Thanks,',
      'Name',
      'Title, Company',
      '+1 555 0100',
    ].join('\n');
    const result = QD.findBoundaryInPlainText(text);
    expect(result).not.toBeNull();
    expect(result.type).toBe('quoted');
    expect(result.lineIndex).toBe(2);
  });

  it('ignores a long tail that sits under a non-quoted "-- " signature delimiter', () => {
    const sig = [];
    for (let n = 1; n <= 12; n++) sig.push(`Signature line ${n}`);
    const text = ['> Quoted one', '> Quoted two', '-- ', ...sig].join('\n');
    const result = QD.findBoundaryInPlainText(text);
    expect(result).not.toBeNull();
    expect(result.type).toBe('quoted');
    expect(result.lineIndex).toBe(0);
  });

  it('honors config.quotedFallbackMaxTrailingLines', () => {
    expect(QD.config.quotedFallbackMaxTrailingLines).toBe(10);
  });

  const tail = (n, prefix = 'Tail') => Array.from({ length: n }, (_, k) => `${prefix} ${k + 1}`);
  const run = ['> Quoted one', '> Quoted two'];

  it('threshold is exact on both sides: max trailing lines collapse, one more does not', () => {
    const max = QD.config.quotedFallbackMaxTrailingLines;
    const atMax = QD.findBoundaryInPlainText([...run, ...tail(max)].join('\n'));
    expect(atMax).not.toBeNull();
    expect(atMax.lineIndex).toBe(0);
    expect(QD.findBoundaryInPlainText([...run, ...tail(max + 1)].join('\n'))).toBeNull();
  });

  it('blank tail lines are not counted', () => {
    const max = QD.config.quotedFallbackMaxTrailingLines;
    const text = [...run, ...tail(max).flatMap((l) => [l, '', '   '])].join('\n');
    const result = QD.findBoundaryInPlainText(text);
    expect(result).not.toBeNull();
    expect(result.lineIndex).toBe(0);
  });

  it('an interleaved (inline) reply keeps its FIRST run as the boundary and its final answer visible, however long the answers', () => {
    // Invariant: the trailing-run rule never changes how an inline reply splits.
    // Pre-round-2 candidate moved the boundary to the LAST run once the answers
    // exceeded the threshold, and the final answer silently fell into `quote`.
    const text = [
      'Hi,',
      '> Question one?',
      '> More of question one.',
      ...tail(12, 'Answer one line'),
      '> Question two?',
      '> More of question two.',
      ...tail(4, 'Answer two line'),
    ].join('\n');
    const result = QD.findBoundaryInPlainText(text);
    expect(result).not.toBeNull();
    expect(result.type).toBe('quoted');
    expect(result.lineIndex).toBe(1);
    expect(result.hasInlineAnswers).toBe(true);
    const split = QD.splitPlainTextForQuote(text);
    expect(split.main).toContain('Answer two line 4');
    expect(split.quote).toBe('');
  });

  it('an interleaved reply whose LATER run is indented keeps its first run and its final answer visible', () => {
    // The tail walk must recognise an indented later ">" line as a run; an
    // untrimmed test would move the boundary to that run and drop the final
    // answer into `quote`.
    const text = [
      'Hi,',
      '> Question one?',
      '> More of question one.',
      ...tail(12, 'Answer one line'),
      '  > Question two?',
      '  > More of question two.',
      'Answer two.',
    ].join('\n');
    const result = QD.findBoundaryInPlainText(text);
    expect(result).not.toBeNull();
    expect(result.type).toBe('quoted');
    expect(result.lineIndex).toBe(1);
    expect(result.hasInlineAnswers).toBe(true);
    const split = QD.splitPlainTextForQuote(text);
    expect(split.main).toContain('Answer two.');
    expect(split.quote).toBe('');
  });

  it('accepts an indented ">" run', () => {
    const text = ['Reply.', '', '  > Quoted one', '  > Quoted two'].join('\n');
    const result = QD.findBoundaryInPlainText(text);
    expect(result).not.toBeNull();
    expect(result.type).toBe('quoted');
    expect(result.lineIndex).toBe(2);
  });

  it('a stronger boundary is preserved even when the ">" run is not trailing', () => {
    const text = ['Reply.', 'On Mon, Jan 1, 2026, Someone <s@example.com> wrote:', ...run, ...tail(20)].join('\n');
    const result = QD.findBoundaryInPlainText(text);
    expect(result).not.toBeNull();
    expect(result.type).toBe('attribution');
    expect(result.lineIndex).toBe(1);
  });

  it('an embedded run followed by a later run is an inline reply, not a boundary at the later run', () => {
    const text = ['Intro.', ...run, ...tail(20), '> Trailing one', '> Trailing two'].join('\n');
    const result = QD.findBoundaryInPlainText(text);
    expect(result).not.toBeNull();
    expect(result.lineIndex).toBe(1);
    expect(result.hasInlineAnswers).toBe(true);
    expect(QD.findQuoteRegion(text)).toBeNull();
  });

  it('an INDENTED embedded run with a long tail is not a boundary (run detection ignores leading whitespace)', () => {
    const text = ['Intro.', '  > Quoted one', '  > Quoted two', ...tail(20)].join('\n');
    expect(QD.findBoundaryInPlainText(text)).toBeNull();
  });

  it('a "-- " delimiter after a long answer does not rescue a bottom-posted reply', () => {
    const text = [...run, ...tail(12, 'Answer line'), '-- ', 'Name', 'Title'].join('\n');
    expect(QD.findBoundaryInPlainText(text)).toBeNull();
  });

  it('config.quotedFallbackMaxTrailingLines is the live threshold, not a default', () => {
    const saved = QD.config.quotedFallbackMaxTrailingLines;
    try {
      QD.config.quotedFallbackMaxTrailingLines = 3;
      expect(QD.findBoundaryInPlainText([...run, ...tail(4)].join('\n'))).toBeNull();
      const ok = QD.findBoundaryInPlainText([...run, ...tail(3)].join('\n'));
      expect(ok).not.toBeNull();
      expect(ok.lineIndex).toBe(0);
    } finally {
      QD.config.quotedFallbackMaxTrailingLines = saved;
    }
  });

  it('processes many short ">" runs separated by blank lines in bounded time', () => {
    const lines = ['Reply.'];
    for (let n = 0; n < 16000; n++) lines.push('> a', '> b', '');
    const text = lines.join('\n');
    const start = performance.now();
    const result = QD.findBoundaryInPlainText(text);
    const elapsed = performance.now() - start;
    expect(result).not.toBeNull();
    expect(result.lineIndex).toBe(1);
    expect(elapsed).toBeLessThan(2000);
  });

  it('processes a long ">" body in bounded time (no per-line suffix rescans)', () => {
    const lines = ['Reply.', ...tail(32000, '> quoted line')];
    const text = lines.join('\n');
    const start = performance.now();
    const result = QD.findBoundaryInPlainText(text);
    const elapsed = performance.now() - start;
    expect(result).not.toBeNull();
    expect(result.lineIndex).toBe(1);
    // Pre-fix candidate measured 17 s here; base 133 ms. Generous bound.
    expect(elapsed).toBeLessThan(2000);
  });
});
