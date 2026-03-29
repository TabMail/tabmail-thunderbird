// staleRowFilter.test.js — Tests for stale row detection logic
//
// The actual functions live inside a privileged experiment closure
// (staleRowFilter.sys.mjs) and can't be imported directly.
// We replicate the detection logic here as specification tests
// to guard against regressions (e.g., cards view false positives).

import { describe, it, expect } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// Replicated detection logic (must stay in sync with staleRowFilter.sys.mjs)
// ═══════════════════════════════════════════════════════════════════════════

function isStaleRow(row) {
  if (!row) return false;
  try {
    const subjectCell = row.querySelector('[data-column-name="subjectcol"]');
    if (!subjectCell) return false;
    const subjectTitle = subjectCell.getAttribute("title") || "";

    const correspondentCell = row.querySelector('[data-column-name="correspondentcol"]');
    const correspondentTitle = correspondentCell?.getAttribute("title") || "";

    const senderCell = row.querySelector('[data-column-name="sendercol"]');
    const senderTitle = senderCell?.getAttribute("title") || "";

    return subjectTitle === "" && correspondentTitle === "" && senderTitle === "";
  } catch (_) {
    return false;
  }
}

function isStaleHeader(hdr) {
  if (!hdr) return false;
  try {
    const subject = (hdr.mime2DecodedSubject || hdr.subject || "").trim();
    const author = (hdr.mime2DecodedAuthor || hdr.author || "").trim();
    const date = hdr.date || 0;

    if (subject !== "" || author !== "") return false;
    if (date > 60000000) return false;

    return true;
  } catch (_) {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// DOM helpers — minimal querySelector/getAttribute stubs
// ═══════════════════════════════════════════════════════════════════════════

function makeTableRow({ subject = "", correspondent = "", sender = "" } = {}) {
  const cells = {
    subjectcol: { title: subject },
    correspondentcol: { title: correspondent },
    sendercol: { title: sender },
  };
  return {
    querySelector(sel) {
      const match = /data-column-name="(\w+)"/.exec(sel);
      const col = match?.[1];
      return cells[col] ? { getAttribute: (attr) => cells[col][attr] ?? null } : null;
    },
  };
}

function makeCardRow() {
  // Cards view rows have no data-column-name cells at all
  return {
    querySelector() { return null; },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// isStaleRow
// ═══════════════════════════════════════════════════════════════════════════

describe('isStaleRow', () => {
  it('returns false for null/undefined row', () => {
    expect(isStaleRow(null)).toBe(false);
    expect(isStaleRow(undefined)).toBe(false);
  });

  it('detects a truly stale table-view row (all titles empty)', () => {
    const row = makeTableRow({ subject: "", correspondent: "", sender: "" });
    expect(isStaleRow(row)).toBe(true);
  });

  it('returns false for normal table-view row with subject', () => {
    const row = makeTableRow({ subject: "Hello", correspondent: "Alice", sender: "Bob" });
    expect(isStaleRow(row)).toBe(false);
  });

  it('returns false when only subject is present', () => {
    const row = makeTableRow({ subject: "Test" });
    expect(isStaleRow(row)).toBe(false);
  });

  it('returns false when only correspondent is present', () => {
    const row = makeTableRow({ correspondent: "Alice" });
    expect(isStaleRow(row)).toBe(false);
  });

  it('returns false when only sender is present', () => {
    const row = makeTableRow({ sender: "Bob" });
    expect(isStaleRow(row)).toBe(false);
  });

  // *** THE REGRESSION TEST ***
  it('returns false for cards-view rows (no column cells)', () => {
    const row = makeCardRow();
    expect(isStaleRow(row)).toBe(false);
  });

  it('returns false when querySelector throws', () => {
    const row = { querySelector() { throw new Error("boom"); } };
    expect(isStaleRow(row)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// isStaleHeader
// ═══════════════════════════════════════════════════════════════════════════

describe('isStaleHeader', () => {
  it('returns false for null/undefined header', () => {
    expect(isStaleHeader(null)).toBe(false);
    expect(isStaleHeader(undefined)).toBe(false);
  });

  it('detects truly stale header (empty subject, author, epoch date)', () => {
    expect(isStaleHeader({ subject: "", author: "", date: 0 })).toBe(true);
  });

  it('detects stale header with date near epoch (< 60s)', () => {
    expect(isStaleHeader({ subject: "", author: "", date: 50000000 })).toBe(true);
  });

  it('returns false when subject is present', () => {
    expect(isStaleHeader({ subject: "Hello", author: "", date: 0 })).toBe(false);
  });

  it('returns false when author is present', () => {
    expect(isStaleHeader({ subject: "", author: "Alice", date: 0 })).toBe(false);
  });

  it('returns false when date is beyond epoch threshold', () => {
    // Real message date: well beyond 60s from epoch
    expect(isStaleHeader({ subject: "", author: "", date: 1700000000000000 })).toBe(false);
  });

  it('prefers mime2DecodedSubject over subject', () => {
    expect(isStaleHeader({ mime2DecodedSubject: "Decoded", subject: "", author: "", date: 0 })).toBe(false);
  });

  it('prefers mime2DecodedAuthor over author', () => {
    expect(isStaleHeader({ mime2DecodedAuthor: "Decoded", subject: "", author: "", date: 0 })).toBe(false);
  });

  it('returns false when header access throws', () => {
    const hdr = { get subject() { throw new Error("boom"); } };
    expect(isStaleHeader(hdr)).toBe(false);
  });
});
