/*
 * TabMail Multi-Message Chip Experiment
 *
 * Paints the iOS-style action chip on each <li> row of
 * multimessageview.xhtml (collapsed-thread / multi-select summary), and
 * emits an event when a chip is clicked. Passive painter — never writes
 * action state. Reads `tm-action` mork string property per row's hdr.
 *
 * NOTE: there is intentionally NO `tm_*` keyword fallback here. Since
 * Phase 0 (see agent/modules/tagHelper.js header) TabMail no longer
 * writes IMAP keywords / Gmail labels / Exchange categories — action
 * state lives in IDB and is mirrored to the local mork `tm-action` prop
 * via tmHdr.setAction. The keyword-fallback pattern survives in older
 * experiments (tmMessageListCardView, tmMessageListTableView,
 * tmMessageHeaderChip, tagSort) for legacy messages tagged before the
 * migration; it's marked deprecated there. New surfaces (this one) skip
 * it outright. See ../../PROJECT_MEMORY.md "Multi-message-view chip".
 *
 * Differs from tmMessageHeaderChip in three structural ways:
 *   1. multimessageview is a TRANSIENT document (loaded only when user
 *      views collapsed-thread/multi-select). attachToWindow may run with
 *      no doc to attach to; later, when the doc appears via
 *      onMessagesDisplayed, _attachAndPaintDoc is the workhorse that
 *      idempotently attaches delegation+MO and paints. See
 *      PLAN_MULTI_MESSAGE_CHIP.md §4.1 + §4.4.
 *   2. N chips per surface (one per <li>), not one. Per-row hdr resolved
 *      from gMessageSummary._msgNodes reverse-mapping. See §4.3.1.
 *   3. MutationObserver target is `#content` (parent of `#messageList`)
 *      to catch list-rebuild on selection change. See §4.4 trigger 3.
 */

const { ExtensionSupport: ExtensionSupport_MMC } = ChromeUtils.importESModule(
  "resource:///modules/ExtensionSupport.sys.mjs"
);
const { ExtensionCommon: ExtensionCommon_MMC } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
);
const { MailServices: MailServices_MMC } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);
const { MailUtils: MailUtils_MMC } = ChromeUtils.importESModule(
  "resource:///modules/MailUtils.sys.mjs"
);

var ServicesMMC = globalThis.Services;

const LOG_PREFIX_MMC = "[TabMail MultiMsgChip]";

console.log(`${LOG_PREFIX_MMC} experiment parent script loaded. Services present?`, typeof ServicesMMC !== "undefined");

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

// Native mork string property carrying the AI action.
const TM_ACTION_PROP_NAME_MMC = "tm-action";

// Marker class on the chip element. The card-view chip uses just
// `.tm-action-chip`; the header chip uses `.tm-action-chip.tm-header-action-chip`;
// this surface uses `.tm-action-chip.tm-multi-action-chip`. Click delegation
// scopes to the marker so events never leak across surfaces.
const MULTI_MSG_CHIP_MARKER_CLASS_MMC = "tm-multi-action-chip";
const CHIP_BASE_CLASS_MMC = "tm-action-chip";

// Selector used by the document-level click delegation.
const MULTI_MSG_CHIP_SELECTOR_MMC = `.${CHIP_BASE_CLASS_MMC}.${MULTI_MSG_CHIP_MARKER_CLASS_MMC}`;

// Per-doc primitive properties stashed for hot-reload-safe handler/observer
// handoff. Distinct from tmMessageHeaderChip's prop names so the two
// experiments can defensively coexist on the same chrome doc.
const PROP_CLICK_MMC     = "__tmMultiMsgChipDelegationClick";
const PROP_KEYDOWN_MMC   = "__tmMultiMsgChipDelegationKeydown";
const PROP_MOUSEDOWN_MMC = "__tmMultiMsgChipDelegationMousedown";
const PROP_MO_MMC        = "__tmMultiMsgChipMO";
const PROP_MO_TIMER_MMC  = "__tmMultiMsgChipMOTimer";

// Multi-message-view DOM landmarks (TB 145, see PLAN_MULTI_MESSAGE_CHIP.md
// §2 / innernhtml.log:1-92 / multimessageview.js).
const MESSAGE_LIST_ID_MMC      = "messageList";
const CONTENT_PARENT_ID_MMC    = "content";              // MO target (parent of messageList)
const ITEM_HEADER_SELECTOR_MMC = ".item-header";         // chip anchor inside each <li>

// In TB 145 about:3pane there are TWO separate <browser> elements: one loads
// about:message (single-msg view), the other loads multimessageview.xhtml.
// Our enumerator dives into both — only the second's contentDocument has
// `#messageList`, so case B's feature-detect on `#messageList` filters
// correctly. Looking only inside `messageBrowser` was the original bug
// (multimessageview lives in `multiMessageBrowser`).
// Source: chrome/messenger/content/messenger/about3Pane.xhtml in omni.ja.
const NESTED_BROWSER_IDS_MMC = ["multiMessageBrowser", "messageBrowser"];

// MutationObserver debounce.
const MO_DEBOUNCE_MS_MMC = 50;

// Chrome URLs we attach to.
const CHROME_URLS_MMC = [
  "chrome://messenger/content/messenger.xhtml",      // 3-pane: preview pane (nested) + messageDisplay tabs
  "chrome://messenger/content/messageWindow.xhtml",  // standalone window (when it hosts multi-msg)
];

// Action constants. DUPLICATED from tmMessageListCardView.sys.mjs:517-541
// by design — experiments don't reliably share module state across .sys.mjs
// files (PLAN_TB_LABEL_V2.md §5a "Why three local maps"). Values must match
// the card-view AND header-chip experiments.
//
// _ACTION_TO_KEYWORD_MMC is used by _colorForAction_MMC to look up the
// registered TB tag color via MailServices.tags.getColorForKey — the keyword
// IS the registered tag KEY (TabMail Reply / Archive / Delete / None tags
// from tagDefs.js). It is NOT used for any IMAP-keyword fallback path
// (see file header — none here by design).
const _ACTION_TO_KEYWORD_MMC = {
  reply: "tm_reply",
  archive: "tm_archive",
  delete: "tm_delete",
  none: "tm_none",
};
const _ACTION_LABELS_MMC = {
  reply: "Reply",
  archive: "Archive",
  delete: "Delete",
  none: "None",
};

// ═══════════════════════════════════════════════════════════════════════════
// PURE HELPERS (no DOM, no Services — testable)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Resolve a header's action by reading the native mork `tm-action` string
 * property (written by actionCache → tmHdr.setAction). No legacy
 * `_actionFromKeywords` fallback — see file header.
 */
function _lookupActionForHdr_MMC(hdr) {
  if (!hdr) return null;
  try {
    const prop = hdr?.getStringProperty?.(TM_ACTION_PROP_NAME_MMC) || "";
    if (prop) return String(prop);
  } catch (_) {}
  return null;
}

/**
 * Build the chip className for a given action. Returns "" for invalid.
 * Uses Object.hasOwn so prototype-chain names like "__proto__" don't leak
 * through (the same gap the header chip plan caught at test-time).
 */
function _classNameForAction_MMC(action) {
  if (!action || !Object.hasOwn(_ACTION_LABELS_MMC, action)) return "";
  return `${CHIP_BASE_CLASS_MMC} ${MULTI_MSG_CHIP_MARKER_CLASS_MMC} tm-action-${action}`;
}

/**
 * Look up the registered TB tag color for an action via MailServices.tags.
 * Verbatim port of tmMessageListCardView.sys.mjs:689-697.
 */
function _colorForAction_MMC(action) {
  const key = _ACTION_TO_KEYWORD_MMC[action];
  if (!key) return null;
  try { return MailServices_MMC?.tags?.getColorForKey?.(key) || null; }
  catch (_) { return null; }
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN CLASS
// ═══════════════════════════════════════════════════════════════════════════

var tmMultiMessageChip = class extends ExtensionCommon_MMC.ExtensionAPI {
  onShutdown(isAppShutdown) {
    console.log(`${LOG_PREFIX_MMC} onShutdown() called by Thunderbird, isAppShutdown:`, isAppShutdown);
    try {
      if (this._tmCleanup) {
        this._tmCleanup();
        console.log(`${LOG_PREFIX_MMC} ✓ Cleanup completed via onShutdown`);
      }
    } catch (e) {
      console.error(`${LOG_PREFIX_MMC} onShutdown cleanup failed:`, e);
    }
  }

  getAPI(context) {
    const mm = context?.extension?.messageManager;
    let windowListenerId = null;
    let isInitialized = false;

    // Set by the schema's EventManager.register; fires the
    // `onActionChipClick` event with `{source, weMsgId}` to MV3.
    let _actionChipClickEventFire = null;
    function _fireActionChipClick(info) {
      try {
        if (typeof _actionChipClickEventFire === "function") {
          _actionChipClickEventFire(info);
        }
      } catch (_) {}
    }

    // ───── DOM enumeration ─────

    /**
     * Yield every doc inside `win` that hosts `#messageList`
     * (multimessageview.xhtml). Three cases (PLAN_MULTI_MESSAGE_CHIP.md
     * §4.2):
     *   A: messageDisplay tab whose content IS multimessageview.
     *   B: 3-pane preview — about:3pane → nested messageBrowser →
     *      multimessageview lives where about:message normally would.
     *   C: standalone window (rare) where the top doc IS multimessageview.
     * Always feature-detects on `#messageList` rather than URL.
     */
    function enumerateMultiMessageViewDocs(win) {
      const out = [];
      try {
        // Case C: standalone window where top doc is multimessageview.
        if (win?.document?.getElementById?.(MESSAGE_LIST_ID_MMC)) {
          out.push(win.document);
        }
        // Cases A/B live inside <tabmail>; standalone has no tabmail.
        const tabmail = win?.document?.getElementById?.("tabmail");
        const tabs = tabmail?.tabInfo;
        if (Array.isArray(tabs)) {
          for (const tab of tabs) {
            const contentDoc = tab?.chromeBrowser?.contentDocument
              || tab?.browser?.contentDocument
              || null;
            if (!contentDoc) continue;
            // Case A: messageDisplay tab → contentDoc is multimessageview directly.
            if (contentDoc.getElementById?.(MESSAGE_LIST_ID_MMC)) {
              if (!out.includes(contentDoc)) out.push(contentDoc);
              continue;
            }
            // Case B: 3-pane → nested <browser> → multimessageview. Try
            // both candidate browser ids since TB 145 uses
            // `multiMessageBrowser` for the multi-msg view and
            // `messageBrowser` for the single-msg view; the
            // `#messageList` feature-detect filters to the right one.
            for (const browserId of NESTED_BROWSER_IDS_MMC) {
              const browserEl = contentDoc.getElementById?.(browserId);
              const innerDoc = browserEl?.contentDocument || null;
              if (innerDoc?.getElementById?.(MESSAGE_LIST_ID_MMC)) {
                if (!out.includes(innerDoc)) out.push(innerDoc);
              }
            }
          }
        }
      } catch (e) {
        console.warn(`${LOG_PREFIX_MMC} enumerateMultiMessageViewDocs failed:`, e);
      }
      return out;
    }

    // ───── Per-row hdr resolution ─────

    /**
     * Resolve { li, hdr } pairs by reverse-mapping `gMessageSummary._msgNodes`.
     * See PLAN_MULTI_MESSAGE_CHIP.md §4.3.1 for the strategy.
     *
     * `_msgNodes` is a dict where keys = `messageKey + folder.URI` (string
     * concat with NO separator — see TB multimessageview.js:122-130) and
     * values = <li> DOM nodes. For multi-selection summarizer rows, the
     * SAME <li> appears under MULTIPLE keys (one per msg in the thread
     * group); we collect all and disambiguate by the <li>'s data-message-id
     * (the thread-head's RFC Message-ID per multimessageview.js:259).
     *
     * Returns [] if gMessageSummary isn't reachable (doc not ready).
     */
    function _resolveLiHdrPairs(doc) {
      try {
        const summary = doc?.defaultView?.gMessageSummary || null;
        const msgNodesDict = summary?._msgNodes;
        if (!msgNodesDict) return [];

        const nodeToHdrs = new Map();
        for (const [key, node] of Object.entries(msgNodesDict)) {
          if (!node?.tagName) continue;
          // Regex /^(\d+)(\D.*)$/ unambiguously splits leading digits
          // (messageKey, uint32) from the rest (folder.URI starts with a
          // non-digit scheme letter: imap://, mailbox://, news://, etc.).
          const m = String(key).match(/^(\d+)(\D.*)$/);
          if (!m) continue;
          const messageKey = parseInt(m[1], 10);
          const folderURI = m[2];
          let hdr = null;
          try {
            const folder = MailUtils_MMC?.getExistingFolder?.(folderURI);
            if (folder) hdr = folder.GetMessageHeader(messageKey);
          } catch (_) {}
          if (!hdr) continue;
          let arr = nodeToHdrs.get(node);
          if (!arr) { arr = []; nodeToHdrs.set(node, arr); }
          arr.push(hdr);
        }

        const listEl = doc.getElementById?.(MESSAGE_LIST_ID_MMC);
        if (!listEl) return [];
        const out = [];
        for (const li of listEl.children) {
          const hdrs = nodeToHdrs.get(li) || [];
          if (!hdrs.length) continue;
          // Prefer hdr whose RFC Message-ID matches data-message-id (the
          // thread head per multimessageview.js:259). Fall back to first.
          const wanted = String(li.dataset?.messageId || "");
          let chosen = null;
          if (wanted) {
            for (const h of hdrs) {
              if (String(h.messageId || "") === wanted) { chosen = h; break; }
            }
          }
          if (!chosen) chosen = hdrs[0];
          out.push({ li, hdr: chosen });
        }
        return out;
      } catch (e) {
        console.warn(`${LOG_PREFIX_MMC} _resolveLiHdrPairs failed:`, e);
        return [];
      }
    }

    // ───── Painter ─────

    /**
     * Paint or update the chip on a single <li> for `hdr`. Idempotent: no
     * DOM mutation when (action, label, weMsgId, color) are unchanged.
     * Removes any existing chip when hdr has no valid action OR weMsgId
     * couldn't be resolved.
     */
    function paintChipOnRow(li, hdr, weMsgId, doc) {
      try {
        const anchor = li?.querySelector?.(ITEM_HEADER_SELECTOR_MMC);
        if (!anchor) return;

        const existing = anchor.querySelector(MULTI_MSG_CHIP_SELECTOR_MMC) || null;

        const action = _lookupActionForHdr_MMC(hdr);
        if (!action || !Object.hasOwn(_ACTION_LABELS_MMC, action)) {
          if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
          return;
        }

        // weMsgId guard — a chip without a click target is worse than no
        // chip. The next refresh trigger will retry.
        if (!weMsgId) {
          if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
          return;
        }

        const label = _ACTION_LABELS_MMC[action];
        const expectedCls = _classNameForAction_MMC(action);
        const color = _colorForAction_MMC(action);
        const weIdAttr = String(weMsgId | 0);

        if (existing) {
          if (existing.className !== expectedCls)   existing.className   = expectedCls;
          if (existing.textContent !== label)       existing.textContent = label;
          if (existing.dataset.tmWeMsgId !== weIdAttr) existing.dataset.tmWeMsgId = weIdAttr;
          const currentColor = existing.style?.getPropertyValue?.("--tag-color") || "";
          if (color) {
            if (currentColor !== color) existing.style.setProperty("--tag-color", color);
          } else if (currentColor) {
            existing.style.removeProperty("--tag-color");
          }
          return;
        }

        const chip = doc.createElement("span");
        chip.className = expectedCls;
        chip.textContent = label;
        try { chip.setAttribute("role", "button"); } catch (_) {}
        try { chip.setAttribute("tabindex", "0"); } catch (_) {}
        try { chip.setAttribute("title", `${label} — click to apply`); } catch (_) {}
        try { chip.dataset.tmWeMsgId = weIdAttr; } catch (_) {}
        if (color) {
          try { chip.style.setProperty("--tag-color", color); } catch (_) {}
        }
        anchor.appendChild(chip);   // last child of .item-header → right edge
      } catch (e) {
        console.warn(`${LOG_PREFIX_MMC} paintChipOnRow failed:`, e);
      }
    }

    /**
     * Iterate every <li> in `#messageList`, paint chips per row.
     */
    let _paintDiagLogCount = 0;
    const _PAINT_DIAG_LOG_MAX = 10;
    function paintMessageListChips(doc) {
      try {
        const pairs = _resolveLiHdrPairs(doc);
        if (_paintDiagLogCount < _PAINT_DIAG_LOG_MAX) {
          _paintDiagLogCount++;
          console.log(`${LOG_PREFIX_MMC} paintMessageListChips: pairs=${pairs.length} doc=${doc?.location?.href || "?"}`);
        }
        for (const { li, hdr } of pairs) {
          const weMsgId = mm?.convert?.(hdr)?.id ?? 0;
          paintChipOnRow(li, hdr, weMsgId, doc);
        }
      } catch (e) {
        console.warn(`${LOG_PREFIX_MMC} paintMessageListChips failed:`, e);
      }
    }

    // ───── Click delegation (capture-phase, hot-reload-safe) ─────

    function _activateChipFromEvent_MMC(e, source) {
      try {
        const chip = e.target?.closest?.(MULTI_MSG_CHIP_SELECTOR_MMC);
        if (!chip) return false;
        try { e.stopPropagation(); } catch (_) {}
        try { e.preventDefault(); } catch (_) {}
        const weMsgId = parseInt(chip.dataset?.tmWeMsgId || "0", 10);
        if (!weMsgId) return false;
        _fireActionChipClick({ source, weMsgId });
        return true;
      } catch (_) {
        return false;
      }
    }

    function attachChipDelegation_MMC(doc) {
      try {
        if (!doc) return;
        // Detach-before-attach (idempotent attach for hot-reload safety).
        detachChipDelegation_MMC(doc);

        const onMousedown = (e) => {
          try {
            const chip = e.target?.closest?.(MULTI_MSG_CHIP_SELECTOR_MMC);
            if (chip) e.stopPropagation();
          } catch (_) {}
        };
        const onClick = (e) => { _activateChipFromEvent_MMC(e, "click"); };
        const onKeydown = (e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          _activateChipFromEvent_MMC(e, "keydown");
        };

        doc.addEventListener("mousedown", onMousedown, true);
        doc.addEventListener("click", onClick, true);
        doc.addEventListener("keydown", onKeydown, true);
        doc[PROP_MOUSEDOWN_MMC] = onMousedown;
        doc[PROP_CLICK_MMC] = onClick;
        doc[PROP_KEYDOWN_MMC] = onKeydown;
      } catch (e) {
        console.error(`${LOG_PREFIX_MMC} attachChipDelegation failed:`, e);
      }
    }

    function detachChipDelegation_MMC(doc) {
      try {
        if (!doc) return;
        const prevMousedown = doc[PROP_MOUSEDOWN_MMC];
        const prevClick = doc[PROP_CLICK_MMC];
        const prevKeydown = doc[PROP_KEYDOWN_MMC];
        if (prevMousedown) {
          try { doc.removeEventListener("mousedown", prevMousedown, true); } catch (_) {}
        }
        if (prevClick) {
          try { doc.removeEventListener("click", prevClick, true); } catch (_) {}
        }
        if (prevKeydown) {
          try { doc.removeEventListener("keydown", prevKeydown, true); } catch (_) {}
        }
        try { delete doc[PROP_MOUSEDOWN_MMC]; } catch (_) {}
        try { delete doc[PROP_CLICK_MMC]; } catch (_) {}
        try { delete doc[PROP_KEYDOWN_MMC]; } catch (_) {}
      } catch (e) {
        console.error(`${LOG_PREFIX_MMC} detachChipDelegation failed:`, e);
      }
    }

    // ───── List-rebuild observer (MutationObserver on #content) ─────
    //
    // multimessageview.js calls `messageList.replaceChildren()` in its
    // clear() (line 137) on every selection change, then `appendChild`s
    // new rows. Observing `#content` (parent of `#messageList`) catches
    // both <li> insertion AND any future restructuring (e.g., if TB ever
    // replaces the <ul> itself). 50 ms debounce coalesces the bursts of
    // mutations during a single rebuild into one repaint.

    function _attachMessageListMO_MMC(doc) {
      try {
        if (!doc) return;
        _detachMessageListMO_MMC(doc);
        const win = doc.defaultView;
        if (!win || typeof win.MutationObserver !== "function") return;
        const target = doc.getElementById?.(CONTENT_PARENT_ID_MMC);
        if (!target) return;
        const mo = new win.MutationObserver(() => {
          try { win.clearTimeout?.(doc[PROP_MO_TIMER_MMC]); } catch (_) {}
          try {
            doc[PROP_MO_TIMER_MMC] = win.setTimeout(() => {
              try { doc[PROP_MO_TIMER_MMC] = 0; } catch (_) {}
              // Re-attach + re-paint, idempotent. We use the workhorse
              // (not just paint) so a list-rebuild gets the same
              // attach-then-paint code path as initial display.
              _attachAndPaintDoc(doc);
            }, MO_DEBOUNCE_MS_MMC);
          } catch (_) {}
        });
        mo.observe(target, { childList: true, subtree: true });
        doc[PROP_MO_MMC] = mo;
      } catch (e) {
        console.warn(`${LOG_PREFIX_MMC} _attachMessageListMO failed:`, e);
      }
    }

    function _detachMessageListMO_MMC(doc) {
      try {
        if (!doc) return;
        const prevMO = doc[PROP_MO_MMC];
        if (prevMO) {
          try { prevMO.disconnect(); } catch (_) {}
          try { delete doc[PROP_MO_MMC]; } catch (_) {}
        }
        const prevTimer = doc[PROP_MO_TIMER_MMC];
        if (prevTimer) {
          try { doc.defaultView?.clearTimeout?.(prevTimer); } catch (_) {}
          try { doc[PROP_MO_TIMER_MMC] = 0; } catch (_) {}
        }
      } catch (_) {}
    }

    // ───── Per-doc workhorse ─────

    /**
     * The single per-doc workhorse. All three calls are idempotent
     * (each attachX_MMC calls detachX_MMC first). Used by BOTH
     * `attachToWindow` (initial pass) AND `_repaintAll` (refresh trigger),
     * so a transient multimessageview doc gets attached on first
     * appearance via onMessagesDisplayed.
     */
    function _attachAndPaintDoc(doc) {
      try {
        if (!doc) return;
        attachChipDelegation_MMC(doc);
        _attachMessageListMO_MMC(doc);
        paintMessageListChips(doc);
      } catch (e) {
        console.error(`${LOG_PREFIX_MMC} _attachAndPaintDoc failed:`, e);
      }
    }

    /**
     * Repaint every multimessageview surface across every matching window.
     * Cheap (idempotent attach + idempotent paint per surface). Only
     * "go look at everything" operation.
     */
    function _repaintAll() {
      try {
        if (!ServicesMMC?.wm) return;
        const seen = new Set();
        for (const url of CHROME_URLS_MMC) {
          const enumWin = ServicesMMC.wm.getEnumerator(null);
          while (enumWin.hasMoreElements()) {
            const win = enumWin.getNext();
            try {
              if (win?.location?.href !== url) continue;
              if (seen.has(win)) continue;
              seen.add(win);
              for (const doc of enumerateMultiMessageViewDocs(win)) {
                _attachAndPaintDoc(doc);
              }
            } catch (_) {}
          }
        }
      } catch (e) {
        console.warn(`${LOG_PREFIX_MMC} _repaintAll failed:`, e);
      }
    }

    // ───── Per-window cleanup ─────

    /**
     * Remove any multi-message chips painted in `win`. Used during
     * shutdown so disabling/uninstalling the experiment leaves no stale
     * UI behind.
     */
    function removeAllChipsInWindow(win) {
      try {
        for (const doc of enumerateMultiMessageViewDocs(win)) {
          try {
            const chips = doc.querySelectorAll?.(MULTI_MSG_CHIP_SELECTOR_MMC) || [];
            for (const chip of chips) {
              if (chip.parentNode) chip.parentNode.removeChild(chip);
            }
          } catch (_) {}
        }
      } catch (_) {}
    }

    // ───── Window attach / detach ─────

    function attachToWindow(win) {
      try {
        if (!win) return;
        // Initial pass: handles the rare case where multimessageview is
        // ALREADY loaded when the experiment initializes (e.g., extension
        // hot-reload while the user is viewing a collapsed thread). The
        // common case (multimessageview appears LATER) is covered by
        // onMessagesDisplayed → refreshAll → _attachAndPaintDoc.
        for (const doc of enumerateMultiMessageViewDocs(win)) {
          _attachAndPaintDoc(doc);
        }
      } catch (e) {
        console.error(`${LOG_PREFIX_MMC} attachToWindow failed:`, e);
      }
    }

    function detachFromWindow(win) {
      try {
        for (const doc of enumerateMultiMessageViewDocs(win)) {
          try { detachChipDelegation_MMC(doc); } catch (_) {}
          try { _detachMessageListMO_MMC(doc); } catch (_) {}
        }
        removeAllChipsInWindow(win);
      } catch (e) {
        console.error(`${LOG_PREFIX_MMC} detachFromWindow failed:`, e);
      }
    }

    // ───── Lifecycle ─────

    async function init(_opts = {}) {
      console.log(`${LOG_PREFIX_MMC} ═══ init() called ═══`);
      if (!ServicesMMC || !ServicesMMC.wm) {
        console.error(`${LOG_PREFIX_MMC} Services.wm not available!`);
        return;
      }
      if (isInitialized) {
        console.log(`${LOG_PREFIX_MMC} Already initialized, skipping`);
        return;
      }
      isInitialized = true;

      // Attach to existing matching windows (multimessageview may or may
      // not be loaded in any of them yet; either case is handled).
      const seen = new Set();
      const enumWin = ServicesMMC.wm.getEnumerator(null);
      while (enumWin.hasMoreElements()) {
        const win = enumWin.getNext();
        try {
          if (!CHROME_URLS_MMC.includes(win?.location?.href)) continue;
          if (seen.has(win)) continue;
          seen.add(win);
          if (win.document?.readyState === "complete") {
            attachToWindow(win);
          } else {
            win.addEventListener("load", () => attachToWindow(win), { once: true });
          }
        } catch (_) {}
      }

      // Future windows.
      windowListenerId = context.extension.id + "-tmMultiMessageChip";
      try { ExtensionSupport_MMC.unregisterWindowListener(windowListenerId); } catch (_) {}
      ExtensionSupport_MMC.registerWindowListener(windowListenerId, {
        chromeURLs: CHROME_URLS_MMC,
        onLoadWindow: (win) => attachToWindow(win),
      });
      context.__tmMultiMsgChipWindowListenerRegistered = true;
      console.log(`${LOG_PREFIX_MMC} ✓ Initialization complete`);
    }

    function cleanup() {
      console.log(`${LOG_PREFIX_MMC} cleanup() called`);
      try {
        if (windowListenerId && context.__tmMultiMsgChipWindowListenerRegistered) {
          try { ExtensionSupport_MMC.unregisterWindowListener(windowListenerId); } catch (_) {}
          windowListenerId = null;
          context.__tmMultiMsgChipWindowListenerRegistered = false;
        }
      } catch (_) {}
      try {
        if (ServicesMMC?.wm) {
          const seen = new Set();
          for (const url of CHROME_URLS_MMC) {
            const enumWin = ServicesMMC.wm.getEnumerator(null);
            while (enumWin.hasMoreElements()) {
              const win = enumWin.getNext();
              try {
                if (win?.location?.href !== url) continue;
                if (seen.has(win)) continue;
                seen.add(win);
                detachFromWindow(win);
              } catch (_) {}
            }
          }
        }
      } catch (e) {
        console.error(`${LOG_PREFIX_MMC} Error during cleanup:`, e);
      }
      isInitialized = false;
      console.log(`${LOG_PREFIX_MMC} cleanup() complete`);
    }

    this._tmCleanup = cleanup;

    async function shutdown() {
      console.log(`${LOG_PREFIX_MMC} shutdown() called from WebExtension API`);
      cleanup();
    }

    async function refreshAll() {
      _repaintAll();
    }

    return {
      tmMultiMessageChip: {
        init,
        shutdown,
        refreshAll,
        onActionChipClick: new ExtensionCommon_MMC.EventManager({
          context,
          name: "tmMultiMessageChip.onActionChipClick",
          register: (fire) => {
            _actionChipClickEventFire = (info) => {
              try { fire.async(info); } catch (_) {}
            };
            return () => {
              _actionChipClickEventFire = null;
            };
          },
        }).api(),
      },
    };
  }
};
