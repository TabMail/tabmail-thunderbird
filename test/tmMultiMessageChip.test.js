// tmMultiMessageChip.test.js — Tests for multi-message-view chip helpers.
//
// The actual functions live inside a privileged experiment closure
// (theme/experiments/tmMultiMessageChip/tmMultiMessageChip.sys.mjs) and
// can't be imported directly. Per the established pattern (see
// staleRowFilter.test.js, tmMessageHeaderChip.test.js), we replicate the
// pure-JS helpers here so any drift surfaces in CI. The painter / DOM
// mutation / lifecycle code is exercised through manual QA per
// PLAN_MULTI_MESSAGE_CHIP.md §8.
//
// NOTE: there is intentionally NO `_actionFromKeywords_MMC` to test —
// the multi-msg chip skips the legacy IMAP-keyword fallback that older
// experiments still carry (header chip, card view, table view, tagSort).
// See tmMultiMessageChip.sys.mjs file header for the rationale.

import { describe, it, expect } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════
// Constants — must match tmMultiMessageChip.sys.mjs.
// ═══════════════════════════════════════════════════════════════════════════

const _ACTION_LABELS_MMC = {
  reply: "Reply",
  archive: "Archive",
  delete: "Delete",
  none: "None",
};

const CHIP_BASE_CLASS_MMC = "tm-action-chip";
const MULTI_MSG_CHIP_MARKER_CLASS_MMC = "tm-multi-action-chip";

// ═══════════════════════════════════════════════════════════════════════════
// Replicated helpers
// ═══════════════════════════════════════════════════════════════════════════

function _classNameForAction_MMC(action) {
  if (!action || !Object.hasOwn(_ACTION_LABELS_MMC, action)) return "";
  return `${CHIP_BASE_CLASS_MMC} ${MULTI_MSG_CHIP_MARKER_CLASS_MMC} tm-action-${action}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('_classNameForAction_MMC', () => {
  it('returns empty string for null / undefined / empty action', () => {
    expect(_classNameForAction_MMC(null)).toBe("");
    expect(_classNameForAction_MMC(undefined)).toBe("");
    expect(_classNameForAction_MMC("")).toBe("");
  });

  it('returns empty string for unknown actions (sanitization guard)', () => {
    expect(_classNameForAction_MMC("bogus")).toBe("");
    expect(_classNameForAction_MMC("Reply")).toBe("");        // case-sensitive
    expect(_classNameForAction_MMC("__proto__")).toBe("");    // Object.hasOwn defends prototype chain
  });

  it('returns base + multi-msg marker + per-action class for valid actions', () => {
    expect(_classNameForAction_MMC("reply"))
      .toBe("tm-action-chip tm-multi-action-chip tm-action-reply");
    expect(_classNameForAction_MMC("archive"))
      .toBe("tm-action-chip tm-multi-action-chip tm-action-archive");
    expect(_classNameForAction_MMC("delete"))
      .toBe("tm-action-chip tm-multi-action-chip tm-action-delete");
    expect(_classNameForAction_MMC("none"))
      .toBe("tm-action-chip tm-multi-action-chip tm-action-none");
  });

  it('marker class distinguishes multi-msg chip from header chip and card chip', () => {
    // The card painter uses just `tm-action-chip tm-action-X` (no marker).
    // The header painter uses `tm-action-chip tm-header-action-chip tm-action-X`.
    // The multi-msg painter uses `tm-action-chip tm-multi-action-chip tm-action-X`.
    // Click delegation in the multi-msg experiment scopes to its marker so
    // it can never accidentally fire on a card or header chip event.
    const cls = _classNameForAction_MMC("reply");
    expect(cls).toContain(MULTI_MSG_CHIP_MARKER_CLASS_MMC);
    expect(cls).not.toContain("tm-header-action-chip");
  });
});
