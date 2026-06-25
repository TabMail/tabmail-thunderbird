/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// tmMessageHeaderChip.test.js — Tests for header-chip helper logic.
//
// The actual functions live inside a privileged experiment closure
// (theme/experiments/tmMessageHeaderChip/tmMessageHeaderChip.sys.mjs) and
// can't be imported directly. Per the established pattern (see
// staleRowFilter.test.js), we replicate the pure-JS helpers here so any
// drift surfaces in CI. The painter / DOM mutation / lifecycle code is
// exercised through manual QA per PLAN_HEADER_CHIP.md §8.

import { describe, it, expect } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// Constants — must match tmMessageHeaderChip.sys.mjs (which itself mirrors
// tmMessageListCardView.sys.mjs:517-541). Card-view parity is the contract.
// ═══════════════════════════════════════════════════════════════════════════

const _ACTION_TO_KEYWORD_MHC = {
  reply: "tm_reply",
  archive: "tm_archive",
  delete: "tm_delete",
  none: "tm_none",
};
const _ACTION_LABELS_MHC = {
  reply: "Reply",
  archive: "Archive",
  delete: "Delete",
  none: "None",
};
const TM_ACTION_PRIORITY_MHC = ["reply", "none", "archive", "delete"];

const CHIP_BASE_CLASS_MHC = "tm-action-chip";
const HEADER_CHIP_MARKER_CLASS_MHC = "tm-header-action-chip";

// ═══════════════════════════════════════════════════════════════════════════
// Replicated helpers
// ═══════════════════════════════════════════════════════════════════════════

function _actionFromKeywords_MHC(hdr) {
  try {
    const kw = hdr?.getStringProperty?.("keywords") || "";
    if (!kw) return null;
    const keys = kw.split(/\s+/).filter(Boolean);
    for (const a of TM_ACTION_PRIORITY_MHC) {
      const k = _ACTION_TO_KEYWORD_MHC[a];
      if (k && keys.includes(k)) return a;
    }
    return null;
  } catch (_) {
    return null;
  }
}

function _classNameForAction_MHC(action) {
  if (!action || !Object.hasOwn(_ACTION_LABELS_MHC, action)) return "";
  return `${CHIP_BASE_CLASS_MHC} ${HEADER_CHIP_MARKER_CLASS_MHC} tm-action-${action}`;
}

// Tiny hdr stub used by the keyword tests.
function makeHdr(keywordsString) {
  return {
    getStringProperty(name) {
      return name === "keywords" ? keywordsString : "";
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('_actionFromKeywords_MHC', () => {
  it('returns null when no header is provided', () => {
    expect(_actionFromKeywords_MHC(null)).toBe(null);
    expect(_actionFromKeywords_MHC(undefined)).toBe(null);
  });

  it('returns null when the keywords prop is empty', () => {
    expect(_actionFromKeywords_MHC(makeHdr(""))).toBe(null);
  });

  it('returns null when getStringProperty throws', () => {
    const throwingHdr = {
      getStringProperty() { throw new Error("boom"); },
    };
    expect(_actionFromKeywords_MHC(throwingHdr)).toBe(null);
  });

  it('resolves each single tm_* keyword to its action', () => {
    expect(_actionFromKeywords_MHC(makeHdr("tm_reply"))).toBe("reply");
    expect(_actionFromKeywords_MHC(makeHdr("tm_archive"))).toBe("archive");
    expect(_actionFromKeywords_MHC(makeHdr("tm_delete"))).toBe("delete");
    expect(_actionFromKeywords_MHC(makeHdr("tm_none"))).toBe("none");
  });

  it('ignores non-tm keywords and surrounding whitespace', () => {
    expect(_actionFromKeywords_MHC(makeHdr("  $label1   tm_reply  other "))).toBe("reply");
    expect(_actionFromKeywords_MHC(makeHdr("$label1 $label2"))).toBe(null);
  });

  it('resolves multiple keywords using TM_ACTION_PRIORITY_MHC: reply > none > archive > delete', () => {
    expect(_actionFromKeywords_MHC(makeHdr("tm_archive tm_reply"))).toBe("reply");
    expect(_actionFromKeywords_MHC(makeHdr("tm_delete tm_archive"))).toBe("archive");
    expect(_actionFromKeywords_MHC(makeHdr("tm_delete tm_none"))).toBe("none");
    expect(_actionFromKeywords_MHC(makeHdr("tm_reply tm_none tm_archive tm_delete"))).toBe("reply");
  });
});

describe('_classNameForAction_MHC', () => {
  it('returns empty string for null / undefined / empty action', () => {
    expect(_classNameForAction_MHC(null)).toBe("");
    expect(_classNameForAction_MHC(undefined)).toBe("");
    expect(_classNameForAction_MHC("")).toBe("");
  });

  it('returns empty string for unknown actions (sanitization guard)', () => {
    expect(_classNameForAction_MHC("bogus")).toBe("");
    expect(_classNameForAction_MHC("Reply")).toBe("");        // case-sensitive
    expect(_classNameForAction_MHC("__proto__")).toBe("");
  });

  it('returns base + marker + per-action class for valid actions', () => {
    expect(_classNameForAction_MHC("reply"))
      .toBe("tm-action-chip tm-header-action-chip tm-action-reply");
    expect(_classNameForAction_MHC("archive"))
      .toBe("tm-action-chip tm-header-action-chip tm-action-archive");
    expect(_classNameForAction_MHC("delete"))
      .toBe("tm-action-chip tm-header-action-chip tm-action-delete");
    expect(_classNameForAction_MHC("none"))
      .toBe("tm-action-chip tm-header-action-chip tm-action-none");
  });

  it('marker class distinguishes header chip from card chip', () => {
    // The card painter uses just `tm-action-chip tm-action-X` (no marker).
    // The header painter uses `tm-action-chip tm-header-action-chip tm-action-X`.
    // Click delegation in the header experiment scopes to the marker so
    // it can never accidentally fire on a card chip event.
    const cls = _classNameForAction_MHC("reply");
    expect(cls).toContain(HEADER_CHIP_MARKER_CLASS_MHC);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Chip-reuse tooltip contract (regression)
//
// `about:message` is cached, so the header chip <span> is REUSED across
// message displays via the painter's `if (existing)` idempotent-update
// branch. That branch must refresh ALL action-derived attributes — class,
// text, AND title — or the tooltip freezes at the first-painted action
// (the visible "always shows Reply regardless of tag" bug). The painter
// lives in a privileged experiment closure, so we replicate its update
// branch here (same pattern as the helpers above) to guard the contract.
// ═══════════════════════════════════════════════════════════════════════════

function _titleForLabel_MHC(label) {
  return `${label} — click to apply`;
}

// Faithful replica of paintHeaderChip's `if (existing)` branch.
function _updateExistingChip_MHC(existing, action) {
  const label = _ACTION_LABELS_MHC[action];
  const expectedCls = _classNameForAction_MHC(action);
  const titleText = _titleForLabel_MHC(label);
  if (existing.className !== expectedCls) existing.className = expectedCls;
  if (existing.textContent !== label) existing.textContent = label;
  if (existing.getAttribute("title") !== titleText) existing.setAttribute("title", titleText);
  return existing;
}

// Minimal element stub: only what the update branch touches.
function makeChipEl() {
  const attrs = Object.create(null);
  return {
    className: "",
    textContent: "",
    getAttribute(name) { return name in attrs ? attrs[name] : null; },
    setAttribute(name, value) { attrs[name] = String(value); },
  };
}

describe('header chip reuse refreshes the tooltip', () => {
  it('updates title when a reused chip switches action (reply → delete)', () => {
    const chip = makeChipEl();

    _updateExistingChip_MHC(chip, "reply");
    expect(chip.textContent).toBe("Reply");
    expect(chip.getAttribute("title")).toBe("Reply — click to apply");

    // Same element reused for the next displayed message — a delete-tagged one.
    _updateExistingChip_MHC(chip, "delete");
    expect(chip.textContent).toBe("Delete");
    // Regression guard: before the fix the title stayed "Reply — click to apply".
    expect(chip.getAttribute("title")).toBe("Delete — click to apply");
    expect(chip.className).toBe("tm-action-chip tm-header-action-chip tm-action-delete");
  });

  it('keeps title in sync for every action', () => {
    const chip = makeChipEl();
    for (const action of ["reply", "archive", "delete", "none"]) {
      _updateExistingChip_MHC(chip, action);
      expect(chip.getAttribute("title")).toBe(`${_ACTION_LABELS_MHC[action]} — click to apply`);
    }
  });
});
