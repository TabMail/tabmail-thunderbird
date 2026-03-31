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
    const text = 'My reply\n\nKwang Moo Yi <kmyi@cs.ubc.ca> \u4E8E2026\u5E743\u670817\u65E5\u5468\u4E8C 01:16\u5199\u9053\uFF1A\n> text';
    const result = QD.findBoundaryInPlainText(text);
    expect(result).toBeDefined();
    expect(result.type).toBe('attribution');
  });

  it('detects Chinese Gmail attribution with half-width colon', () => {
    const text = 'My reply\n\nKwang Moo Yi <kmyi@cs.ubc.ca> \u4E8E2026\u5E743\u670817\u65E5\u5468\u4E8C 01:16\u5199\u9053:\n> text';
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
    const text = 'My reply\n\nKwang Moo Yi <kmyi@cs.ubc.ca> \u4E8E\n2026\u5E743\u670817\u65E5\u5468\u4E8C 01:16\u5199\u9053\uFF1A\n> quoted';
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
    const text = 'Thanks!\nKwang Moo Yi <kmyi@cs.ubc.ca> \u4E8E2026\u5E743\u670830\u65E5\u5468\u4E00 17:38\u5199\u9053\uFF1A\nHello Alex,';
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
    const text = 'Thanks!\n\nKwang Moo Yi <kmyi@cs.ubc.ca> \u4E8E2026\u5E743\u670830\u65E5\u5468\u4E00 17:38\u5199\u9053\uFF1A\nHello,';
    const result = QD.findBoundaryInPlainText(text);
    expect(result).toBeDefined();
    expect(result.type).toBe('attribution');
    // Must be line 2 (the attribution), not line 0 ("Thanks!")
    expect(result.lineIndex).toBe(2);
  });

  it('still detects genuinely split attribution across two lines', () => {
    // "于" on line i, rest on line i+1 — neither line alone matches, only joined
    const text = 'My reply\n\nKwang Moo Yi <kmyi@cs.ubc.ca> \u4E8E\n2026\u5E743\u670817\u65E5\u5468\u4E8C 01:16\u5199\u9053\uFF1A\n> quoted';
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
