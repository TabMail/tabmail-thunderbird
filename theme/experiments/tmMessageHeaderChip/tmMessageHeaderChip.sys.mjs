/*
 * TabMail Message Header Chip Experiment
 *
 * Paints the iOS-style action chip into the message preview-pane header
 * (#expandedButtonsBox), and (Phase 2) emits an event when the chip is
 * clicked. Passive painter — never writes action state. Reads `tm-action`
 * mork string property (with `_actionFromKeywords_MHC` legacy fallback).
 *
 * Mirrors the action-painter portion of tmMessageListCardView.sys.mjs but
 * targets the message header DOM (about:message / messageWindow.xhtml)
 * instead of the thread-card row.
 */

const { ExtensionSupport: ExtensionSupport_MHC } = ChromeUtils.importESModule(
  "resource:///modules/ExtensionSupport.sys.mjs"
);
const { ExtensionCommon: ExtensionCommon_MHC } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
);
const { MailServices: MailServices_MHC } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);

var ServicesMHC = globalThis.Services;

const LOG_PREFIX_MHC = "[TabMail MessageHeaderChip]";

console.log(`${LOG_PREFIX_MHC} experiment parent script loaded. Services present?`, typeof ServicesMHC !== "undefined");

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

// Native mork string property carrying the AI action — written by
// actionCache → tmHdr.setAction. Painter reads synchronously.
const TM_ACTION_PROP_NAME_MHC = "tm-action";

// Marker class on the chip element. The card-view chip uses just
// `.tm-action-chip`; we ALSO add `.tm-header-action-chip` so the click
// delegation (Phase 2) can scope to header chips and never accidentally
// fire on a card chip if the two ever end up in the same document.
const HEADER_CHIP_MARKER_CLASS_MHC = "tm-header-action-chip";
const CHIP_BASE_CLASS_MHC = "tm-action-chip";

// Selector used by the (Phase 2) document-level click delegation.
const HEADER_CHIP_SELECTOR_MHC = `.${CHIP_BASE_CLASS_MHC}.${HEADER_CHIP_MARKER_CLASS_MHC}`;

// Per-doc primitive properties stashed for hot-reload-safe handler handoff.
// (Phase 2 / Phase 3.) Defined here so cleanup can find old-instance
// handlers/observers even after a hot reload.
const PROP_CLICK_MHC     = "__tmHeaderChipDelegationClick";
const PROP_KEYDOWN_MHC   = "__tmHeaderChipDelegationKeydown";
const PROP_MOUSEDOWN_MHC = "__tmHeaderChipDelegationMousedown";
const PROP_MO_MHC        = "__tmHeaderChipMO";
const PROP_MO_TIMER_MHC  = "__tmHeaderChipMOTimer";

// Header-DOM landmarks (TB 145, see PLAN_HEADER_CHIP.md §2 / innernhtml.log:621-643).
const ANCHOR_ID_MHC                  = "expandedButtonsBox";
const HEADER_RE_RENDER_PARENT_ID_MHC = "headerSubjectSecurityContainer";
const MESSAGE_HEADER_ID_MHC          = "messageHeader";
const MESSAGE_BROWSER_ID_MHC         = "messageBrowser";

// MutationObserver debounce.
const MO_DEBOUNCE_MS_MHC = 50;

// Chrome URLs we attach to.
const CHROME_URLS_MHC = [
  "chrome://messenger/content/messenger.xhtml",      // 3-pane: preview pane + messageDisplay tabs
  "chrome://messenger/content/messageWindow.xhtml",  // standalone message window
];

// Action constants. DUPLICATED from tmMessageListCardView.sys.mjs:517-558 by
// design — experiments don't reliably share module state across .sys.mjs
// files (PLAN_TB_LABEL_V2.md §5a "Why three local maps"). Values must match.
// (TM_ACTION_CLASSES_MLCV intentionally NOT copied — drives row-level class
// swap which has no analogue in the header.)
const _ACTION_TO_KEYWORD_MHC = {
  reply: "tm_reply",
  archive: "tm_archive",
  delete: "tm_delete",
  none: "tm_none",
};
const _KEYWORD_TO_ACTION_MHC = {
  tm_reply: "reply",
  tm_archive: "archive",
  tm_delete: "delete",
  tm_none: "none",
};
const _ACTION_LABELS_MHC = {
  reply: "Reply",
  archive: "Archive",
  delete: "Delete",
  none: "None",
};
// Priority order — keep consistent with tagSort / tmMessageListTableView.
const TM_ACTION_PRIORITY_MHC = ["reply", "none", "archive", "delete"];

// ═══════════════════════════════════════════════════════════════════════════
// PURE HELPERS (no DOM, no Services — testable)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * @deprecated The IMAP-keyword (`tm_*`) representation of action state is
 * no longer written by TabMail (Phase 0; see `agent/modules/tagHelper.js`
 * file header). New code paths read `tm-action` mork prop only — see
 * `tmMultiMessageChip.sys.mjs` for the cleaner shape. This fallback
 * survives for legacy messages tagged before Phase 0; remove once those
 * have decayed out of users' inboxes.
 *
 * Read AI action from a header. Returns "reply" | "archive" | "delete" |
 * "none" or null. Verbatim port of tmMessageListCardView.sys.mjs:545-558.
 */
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

/**
 * Resolve a header's action from native mork `tm-action` prop. Falls back
 * to the deprecated `_actionFromKeywords_MHC` legacy reader for messages
 * tagged before Phase 0 (see that function's @deprecated note).
 */
function _lookupActionForHdr_MHC(hdr) {
  if (!hdr) return null;
  try {
    const prop = hdr?.getStringProperty?.(TM_ACTION_PROP_NAME_MHC) || "";
    if (prop) return String(prop);
  } catch (_) {}
  return _actionFromKeywords_MHC(hdr);
}

/**
 * Build the chip className for a given action. Returns "" for invalid.
 * Uses Object.hasOwn so prototype-chain names like "__proto__" don't leak
 * through. Exported-shape-only via the test file; not part of the schema.
 */
function _classNameForAction_MHC(action) {
  if (!action || !Object.hasOwn(_ACTION_LABELS_MHC, action)) return "";
  return `${CHIP_BASE_CLASS_MHC} ${HEADER_CHIP_MARKER_CLASS_MHC} tm-action-${action}`;
}

/**
 * Look up the registered TB tag color for an action via MailServices.tags.
 * Verbatim port of tmMessageListCardView.sys.mjs:689-697.
 */
function _colorForAction_MHC(action) {
  const key = _ACTION_TO_KEYWORD_MHC[action];
  if (!key) return null;
  try { return MailServices_MHC?.tags?.getColorForKey?.(key) || null; }
  catch (_) { return null; }
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN CLASS
// ═══════════════════════════════════════════════════════════════════════════

var tmMessageHeaderChip = class extends ExtensionCommon_MHC.ExtensionAPI {
  onShutdown(isAppShutdown) {
    console.log(`${LOG_PREFIX_MHC} onShutdown() called by Thunderbird, isAppShutdown:`, isAppShutdown);
    try {
      if (this._tmCleanup) {
        this._tmCleanup();
        console.log(`${LOG_PREFIX_MHC} ✓ Cleanup completed via onShutdown`);
      }
    } catch (e) {
      console.error(`${LOG_PREFIX_MHC} onShutdown cleanup failed:`, e);
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
     * Yield every doc inside `win` that hosts a `#messageHeader` element.
     * Three cases (PLAN_HEADER_CHIP.md §4.2):
     *   A: messageDisplay tab — chromeBrowser.contentDocument is about:message
     *   B: 3-pane preview — chromeBrowser.contentDocument is about:3pane,
     *      with a nested `#messageBrowser` whose contentDocument is about:message
     *   C: standalone message window — win.document IS about:message
     * Always feature-detects on `#messageHeader` rather than URL.
     */
    function enumerateMessageHeaderDocs(win) {
      const out = [];
      try {
        // Case C: standalone message window — win.document is about:message.
        if (win?.document?.getElementById?.(MESSAGE_HEADER_ID_MHC)) {
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
            if (contentDoc.getElementById?.(MESSAGE_HEADER_ID_MHC)) {
              if (!out.includes(contentDoc)) out.push(contentDoc); // case A
              continue;
            }
            const msgBrowserEl = contentDoc.getElementById?.(MESSAGE_BROWSER_ID_MHC);
            const innerDoc = msgBrowserEl?.contentDocument || null;
            if (innerDoc?.getElementById?.(MESSAGE_HEADER_ID_MHC)) {
              if (!out.includes(innerDoc)) out.push(innerDoc); // case B
            }
          }
        }
      } catch (e) {
        console.warn(`${LOG_PREFIX_MHC} enumerateMessageHeaderDocs failed:`, e);
      }
      return out;
    }

    /**
     * Read the displayed nsIMsgDBHdr from an about:message contentWindow.
     * TB convention: the `gMessage` global on about:message points at the
     * currently-displayed hdr. Returns null if the surface isn't ready.
     */
    function readDisplayedHdr(doc) {
      try {
        return doc?.defaultView?.gMessage || null;
      } catch (_) {
        return null;
      }
    }

    // ───── Painter ─────

    /**
     * Paint or update the header chip for `hdr` in `doc`. Idempotent: no DOM
     * mutation when (action, label, weMsgId, color) are unchanged.
     * Removes any existing chip when hdr is null OR has no valid action.
     */
    function paintHeaderChip(doc, hdr, weMsgId) {
      try {
        const anchor = doc?.getElementById?.(ANCHOR_ID_MHC);
        if (!anchor) return; // header not rendered yet

        const existing = anchor.querySelector(HEADER_CHIP_SELECTOR_MHC) || null;

        const action = _lookupActionForHdr_MHC(hdr);
        if (!action || !Object.hasOwn(_ACTION_LABELS_MHC, action)) {
          if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
          return;
        }

        const label = _ACTION_LABELS_MHC[action];
        const expectedCls = _classNameForAction_MHC(action);
        const color = _colorForAction_MHC(action);
        const weIdAttr = String(weMsgId | 0);

        if (existing) {
          if (existing.className !== expectedCls)   existing.className = expectedCls;
          if (existing.textContent !== label)       existing.textContent = label;
          if (existing.dataset.tmWeMsgId !== weIdAttr) existing.dataset.tmWeMsgId = weIdAttr;
          // --tag-color: set when present, remove when absent (mirror card painter).
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
        anchor.appendChild(chip);
      } catch (e) {
        console.warn(`${LOG_PREFIX_MHC} paintHeaderChip failed:`, e);
      }
    }

    /**
     * Repaint a single doc's chip from its currently-displayed hdr.
     * Idempotent. Safe to call repeatedly. If we have an hdr but can't
     * resolve a weMsgId, paint NOTHING (a chip without a click target is
     * worse than no chip — the next refresh trigger will retry).
     */
    function _repaintDoc(doc) {
      try {
        const hdr = readDisplayedHdr(doc);
        const weMsgId = hdr ? (mm?.convert?.(hdr)?.id ?? 0) : 0;
        if (hdr && !weMsgId) {
          paintHeaderChip(doc, null, 0);
          return;
        }
        paintHeaderChip(doc, hdr, weMsgId);
      } catch (e) {
        console.warn(`${LOG_PREFIX_MHC} _repaintDoc failed:`, e);
      }
    }

    /**
     * Repaint every header surface across every matching window.
     * Cheap (one DOM read + at most one node update per surface, all
     * idempotent). Only "go look at everything" operation.
     */
    function _repaintAll() {
      try {
        if (!ServicesMHC?.wm) return;
        for (const url of CHROME_URLS_MHC) {
          const enumWin = ServicesMHC.wm.getEnumerator(null);
          while (enumWin.hasMoreElements()) {
            const win = enumWin.getNext();
            try {
              if (win?.location?.href !== url) continue;
              for (const doc of enumerateMessageHeaderDocs(win)) {
                _repaintDoc(doc);
              }
            } catch (_) {}
          }
        }
      } catch (e) {
        console.warn(`${LOG_PREFIX_MHC} _repaintAll failed:`, e);
      }
    }

    // ───── Click delegation (capture-phase, hot-reload-safe) ─────
    //
    // One handler at the document level catches every chip click regardless
    // of when the chip was painted. Capture-phase + stopPropagation means
    // the new module's handler runs first and short-circuits the event,
    // even after a hot reload where an OLD module's stale per-chip listener
    // would otherwise compete. Storing the handler reference as a primitive
    // function on the doc itself means a NEW module instance can find and
    // detach the OLD one's handler even after the OLD module's JS scope is
    // gone. Mirror of tmMessageListCardView.sys.mjs:842-895.

    function _activateChipFromEvent_MHC(e, source) {
      try {
        const chip = e.target?.closest?.(HEADER_CHIP_SELECTOR_MHC);
        if (!chip) return false;
        try { e.stopPropagation(); } catch (_) {}
        try { e.preventDefault(); } catch (_) {}
        const weMsgId = parseInt(chip.dataset?.tmWeMsgId || "0", 10);
        if (!weMsgId) return false; // chip without weMsgId — safety no-op
        _fireActionChipClick({ source, weMsgId });
        return true;
      } catch (_) {
        return false;
      }
    }

    function attachChipDelegation_MHC(doc) {
      try {
        if (!doc) return;
        // Detach any existing delegation (e.g. from a previous module
        // instance after hot reload) so we don't double-fire.
        detachChipDelegation_MHC(doc);

        const onMousedown = (e) => {
          // Stop mousedown from reaching native header handlers.
          try {
            const chip = e.target?.closest?.(HEADER_CHIP_SELECTOR_MHC);
            if (chip) e.stopPropagation();
          } catch (_) {}
        };
        const onClick = (e) => { _activateChipFromEvent_MHC(e, "click"); };
        const onKeydown = (e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          _activateChipFromEvent_MHC(e, "keydown");
        };

        doc.addEventListener("mousedown", onMousedown, true);
        doc.addEventListener("click", onClick, true);
        doc.addEventListener("keydown", onKeydown, true);
        doc[PROP_MOUSEDOWN_MHC] = onMousedown;
        doc[PROP_CLICK_MHC] = onClick;
        doc[PROP_KEYDOWN_MHC] = onKeydown;
      } catch (e) {
        console.error(`${LOG_PREFIX_MHC} attachChipDelegation failed:`, e);
      }
    }

    function detachChipDelegation_MHC(doc) {
      try {
        if (!doc) return;
        const prevMousedown = doc[PROP_MOUSEDOWN_MHC];
        const prevClick = doc[PROP_CLICK_MHC];
        const prevKeydown = doc[PROP_KEYDOWN_MHC];
        if (prevMousedown) {
          try { doc.removeEventListener("mousedown", prevMousedown, true); } catch (_) {}
        }
        if (prevClick) {
          try { doc.removeEventListener("click", prevClick, true); } catch (_) {}
        }
        if (prevKeydown) {
          try { doc.removeEventListener("keydown", prevKeydown, true); } catch (_) {}
        }
        try { delete doc[PROP_MOUSEDOWN_MHC]; } catch (_) {}
        try { delete doc[PROP_CLICK_MHC]; } catch (_) {}
        try { delete doc[PROP_KEYDOWN_MHC]; } catch (_) {}
      } catch (e) {
        console.error(`${LOG_PREFIX_MHC} detachChipDelegation failed:`, e);
      }
    }

    // ───── Header re-render watcher (MutationObserver) ─────
    //
    // TB sometimes wipes and re-fills the message header (charset toggle,
    // body-as switch, view-source). When that happens our chip vanishes
    // along with the rest of the subtree. Watch the parent of
    // #expandedButtonsBox (in case TB recreates the box itself) and repaint
    // when something changes. Debounced 50 ms per doc so a churn of
    // mutations during a single re-render coalesces into one repaint.

    function _attachHeaderMO_MHC(doc) {
      try {
        if (!doc) return;
        _detachHeaderMO_MHC(doc);
        const win = doc.defaultView;
        if (!win || typeof win.MutationObserver !== "function") return;
        const target = doc.getElementById?.(HEADER_RE_RENDER_PARENT_ID_MHC);
        if (!target) return;
        const mo = new win.MutationObserver(() => {
          // Coalesce bursts. clearTimeout undef is safe.
          try { win.clearTimeout?.(doc[PROP_MO_TIMER_MHC]); } catch (_) {}
          try {
            doc[PROP_MO_TIMER_MHC] = win.setTimeout(() => {
              try { doc[PROP_MO_TIMER_MHC] = 0; } catch (_) {}
              _repaintDoc(doc);
            }, MO_DEBOUNCE_MS_MHC);
          } catch (_) {}
        });
        mo.observe(target, { childList: true, subtree: true });
        doc[PROP_MO_MHC] = mo;
      } catch (e) {
        console.warn(`${LOG_PREFIX_MHC} _attachHeaderMO failed:`, e);
      }
    }

    function _detachHeaderMO_MHC(doc) {
      try {
        if (!doc) return;
        const prevMO = doc[PROP_MO_MHC];
        if (prevMO) {
          try { prevMO.disconnect(); } catch (_) {}
          try { delete doc[PROP_MO_MHC]; } catch (_) {}
        }
        const prevTimer = doc[PROP_MO_TIMER_MHC];
        if (prevTimer) {
          try { doc.defaultView?.clearTimeout?.(prevTimer); } catch (_) {}
          try { doc[PROP_MO_TIMER_MHC] = 0; } catch (_) {}
        }
      } catch (_) {}
    }

    // ───── Per-doc cleanup (chips only — Phase 1) ─────

    /**
     * Remove any header chips painted in `win`. Used during shutdown so
     * disabling/uninstalling the experiment leaves no stale UI behind.
     */
    function removeAllChipsInWindow(win) {
      try {
        for (const doc of enumerateMessageHeaderDocs(win)) {
          try {
            const anchor = doc?.getElementById?.(ANCHOR_ID_MHC);
            const existing = anchor?.querySelector?.(HEADER_CHIP_SELECTOR_MHC);
            if (existing && existing.parentNode) {
              existing.parentNode.removeChild(existing);
            }
          } catch (_) {}
        }
      } catch (_) {}
    }

    // ───── Window attach / detach ─────

    function attachToWindow(win) {
      try {
        if (!win) return;
        for (const doc of enumerateMessageHeaderDocs(win)) {
          attachChipDelegation_MHC(doc);     // Phase 2
          _attachHeaderMO_MHC(doc);          // Phase 3
          _repaintDoc(doc);
        }
      } catch (e) {
        console.error(`${LOG_PREFIX_MHC} attachToWindow failed:`, e);
      }
    }

    function detachFromWindow(win) {
      try {
        for (const doc of enumerateMessageHeaderDocs(win)) {
          try { detachChipDelegation_MHC(doc); } catch (_) {}
          try { _detachHeaderMO_MHC(doc); } catch (_) {}
        }
        removeAllChipsInWindow(win);
      } catch (e) {
        console.error(`${LOG_PREFIX_MHC} detachFromWindow failed:`, e);
      }
    }

    // ───── Lifecycle ─────

    async function init(_opts = {}) {
      console.log(`${LOG_PREFIX_MHC} ═══ init() called ═══`);
      if (!ServicesMHC || !ServicesMHC.wm) {
        console.error(`${LOG_PREFIX_MHC} Services.wm not available!`);
        return;
      }
      if (isInitialized) {
        console.log(`${LOG_PREFIX_MHC} Already initialized, skipping`);
        return;
      }
      isInitialized = true;

      // Attach to existing matching windows.
      const enumWin = ServicesMHC.wm.getEnumerator(null);
      while (enumWin.hasMoreElements()) {
        const win = enumWin.getNext();
        try {
          if (!CHROME_URLS_MHC.includes(win?.location?.href)) continue;
          if (win.document?.readyState === "complete") {
            attachToWindow(win);
          } else {
            win.addEventListener("load", () => attachToWindow(win), { once: true });
          }
        } catch (_) {}
      }

      // Future windows.
      windowListenerId = context.extension.id + "-tmMessageHeaderChip";
      try { ExtensionSupport_MHC.unregisterWindowListener(windowListenerId); } catch (_) {}
      ExtensionSupport_MHC.registerWindowListener(windowListenerId, {
        chromeURLs: CHROME_URLS_MHC,
        onLoadWindow: (win) => attachToWindow(win),
      });
      context.__tmHeaderChipWindowListenerRegistered = true;
      console.log(`${LOG_PREFIX_MHC} ✓ Initialization complete`);
    }

    function cleanup() {
      console.log(`${LOG_PREFIX_MHC} cleanup() called`);
      try {
        if (windowListenerId && context.__tmHeaderChipWindowListenerRegistered) {
          try { ExtensionSupport_MHC.unregisterWindowListener(windowListenerId); } catch (_) {}
          windowListenerId = null;
          context.__tmHeaderChipWindowListenerRegistered = false;
        }
      } catch (_) {}
      try {
        if (ServicesMHC?.wm) {
          for (const url of CHROME_URLS_MHC) {
            const enumWin = ServicesMHC.wm.getEnumerator(null);
            while (enumWin.hasMoreElements()) {
              const win = enumWin.getNext();
              try {
                if (win?.location?.href === url) detachFromWindow(win);
              } catch (_) {}
            }
          }
        }
      } catch (e) {
        console.error(`${LOG_PREFIX_MHC} Error during cleanup:`, e);
      }
      isInitialized = false;
      console.log(`${LOG_PREFIX_MHC} cleanup() complete`);
    }

    this._tmCleanup = cleanup;

    async function shutdown() {
      console.log(`${LOG_PREFIX_MHC} shutdown() called from WebExtension API`);
      cleanup();
    }

    async function refreshAll() {
      _repaintAll();
    }

    return {
      tmMessageHeaderChip: {
        init,
        shutdown,
        refreshAll,
        onActionChipClick: new ExtensionCommon_MHC.EventManager({
          context,
          name: "tmMessageHeaderChip.onActionChipClick",
          register: (fire) => {
            // Capture the fire function so _activateChipFromEvent_MHC can
            // dispatch into MV3. Same pattern as
            // tmMessageListCardView.sys.mjs:1876-1888.
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
