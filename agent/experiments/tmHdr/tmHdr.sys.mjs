/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

const { ExtensionCommon: ExtensionCommonTMHdr } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
);
const CiTM = globalThis.Ci || Components?.interfaces;

// ---------------------------------------------------------------------------
// Action-on-hdr helpers (Phase 2b).
//
// The AI action ("reply"/"archive"/"delete"/"none") is stored as a custom
// nsIMsgDBHdr string property named "tm-action". This property is LOCAL to
// the mork DB — IMAP sync (HandleCustomFlags) only overwrites the "keywords"
// property, so "tm-action" survives IMAP FETCH/IDLE roundtrips. It is
// synchronously readable from any render path (fillRow, sortCallback,
// column handlers), which eliminates the need for an in-memory action map
// mirrored between MV3 and experiments.
// ---------------------------------------------------------------------------

const TM_ACTION_PROP_NAME = "tm-action";

let _invalLog = 0;

function _isValidViewIndex(index) {
  return typeof index === "number" && index >= 0 && index < 0x7fffffff;
}

/**
 * Enumerate each dbView and its owning thread tree, including inactive
 * about:3pane tabs. A single Thunderbird window can keep several independent
 * folder/search views alive; `currentAbout3Pane` covers only the focused one.
 */
function _enumerateViewTreesInWindow(win) {
  const views = [];
  const addView = (view, tree) => {
    if (view && tree && !views.some(entry => entry.view === view && entry.tree === tree)) {
      views.push({ view, tree });
    }
  };
  const addContentWindow = contentWin => {
    if (!contentWin) return;
    const tree = contentWin.document?.getElementById?.("threadTree");
    addView(contentWin.gDBView || null, tree);
    addView(contentWin.gFolderDisplay?.view?.dbView || null, tree);
  };

  try {
    const tabmail = win?.document?.getElementById?.("tabmail");
    addContentWindow(tabmail?.currentAbout3Pane || null);
    addContentWindow(tabmail?.currentTabInfo?.chromeBrowser?.contentWindow || null);
    addContentWindow(tabmail?.currentTabInfo?.browser?.contentWindow || null);
    for (const tabInfo of tabmail?.tabInfo || []) {
      addContentWindow(tabInfo?.chromeBrowser?.contentWindow || null);
      addContentWindow(tabInfo?.browser?.contentWindow || null);
    }
  } catch (_) {}

  // Compatibility path for windows/TB generations that expose the dbView on
  // the outer messenger window rather than the about:3pane content window.
  const tree = win?.document?.getElementById?.("threadTree");
  addView(win?.gDBView || null, tree);
  addView(win?.gFolderDisplay?.view?.dbView || null, tree);
  return views;
}

/**
 * Resolve the row Thunderbird will actually render for `hdr` without
 * expanding a collapsed thread. `findIndexOfMsgHdr` searches for the exact
 * header and therefore returns -1 for a hidden child; `findIndexForMsgURI`
 * explicitly maps that child to the view's visible thread root.
 */
function _findRenderedRowForHdr(view, hdr) {
  if (!view || !hdr) return -1;

  try {
    const index = view.findIndexOfMsgHdr?.(hdr, false);
    if (_isValidViewIndex(index)) return index;
  } catch (_) {}

  try {
    const msgURI = hdr.folder?.getUriForMsg?.(hdr) || "";
    if (msgURI) {
      const index = view.findIndexForMsgURI?.(msgURI, false);
      if (_isValidViewIndex(index)) return index;
    }
  } catch (_) {}

  // Plain unthreaded folder compatibility path.
  try {
    const folderURI = hdr.folder?.URI || "";
    const viewFolderURI = view.msgFolder?.URI || view.displayedFolder?.URI || "";
    if (folderURI && viewFolderURI === folderURI) {
      const index = view.FindKey?.(hdr.messageKey, true);
      if (_isValidViewIndex(index)) return index;
    }
  } catch (_) {}

  return -1;
}

/**
 * Find every currently-open 3pane dbView that contains this hdr and
 * call `threadTree.invalidateRow(rowIndex)` so TB re-renders that row
 * immediately. NoteChange is not exposed by nsIMsgDBView to JavaScript.
 * The tree invalidation re-invokes our patched fillRow → painter picks up the
 * new property value.
 *
 * Uses `view.findIndexOfMsgHdr(hdr)` which works across unified inboxes,
 * virtual folders, and plain folder views — no URI-string comparison.
 */
function _invalidateRowForHdrInAllWindows(hdr) {
  try {
    const Services = globalThis.Services;
    const wm = Services?.wm;
    if (!wm || !hdr) return;
    const folderURI = hdr.folder?.URI || "";
    const msgKey = hdr.messageKey;
    let diagViewsSeen = 0;
    let diagNoted = 0;
    const enumWin = wm.getEnumerator("mail:3pane");
    while (enumWin.hasMoreElements()) {
      const win = enumWin.getNext();
      try {
        for (const { view, tree } of _enumerateViewTreesInWindow(win)) {
          diagViewsSeen++;
          const rowIndex = _findRenderedRowForHdr(view, hdr);
          if (rowIndex >= 0) {
            try { tree.invalidateRow(rowIndex); diagNoted++; } catch (_) {}
          }
        }
      } catch (_) {}
    }
    if (_invalLog < 20) {
      _invalLog++;
      console.log(
        `[tmHdr] invalidate folderURI="${folderURI}" msgKey=${msgKey} ` +
        `viewsSeen=${diagViewsSeen} notedRows=${diagNoted}`
      );
    }
  } catch (_) {}
}

var tmHdr = class extends ExtensionCommonTMHdr.ExtensionAPI {
  getAPI(context) {
    const mm = context?.extension?.messageManager;

    function setActionOnHdr(weMsgId, action) {
      try {
        if (!mm) return false;
        const hdr = mm.get(weMsgId);
        if (!hdr) return false;
        const valid = action === "" || action === "reply" || action === "archive" || action === "delete" || action === "none";
        if (action && !valid) return false;
        try {
          hdr.setStringProperty(TM_ACTION_PROP_NAME, action ? String(action) : "");
        } catch (eSet) {
          console.warn("[tmHdr] setStringProperty(tm-action) failed", eSet);
          return false;
        }
        // Fire view invalidation so the row re-renders with the new property.
        _invalidateRowForHdrInAllWindows(hdr);
        return true;
      } catch (e) {
        console.warn("[tmHdr] setActionOnHdr error", e);
        return false;
      }
    }

    function readFlagBulk(messageIds, flag) {
      return (Array.isArray(messageIds) ? messageIds : []).map((id) => {
        try {
          const hdr = mm ? mm.get(id) : null;
          return !!(hdr && (hdr.flags & flag));
        } catch (_) {
          return false;
        }
      });
    }

    return {
      tmHdr: {
        /**
         * Set the AI action for a message. Writes to the native hdr's
         * "tm-action" string property and invalidates the row so it
         * re-renders. Returns true on success, false on missing hdr or
         * invalid action.
         */
        async setAction(weMsgId, action) {
          return setActionOnHdr(weMsgId, action || null);
        },

        /**
         * Clear the AI action for a message. Shortcut for setAction(null).
         */
        async clearAction(weMsgId) {
          return setActionOnHdr(weMsgId, null);
        },

        /**
         * Bulk set actions. Each entry is {weMsgId, action}. Used by the
         * startup backfill to populate hdr properties from IDB.
         */
        async setActionsBulk(entries) {
          if (!Array.isArray(entries) || entries.length === 0) return 0;
          let written = 0;
          for (const e of entries) {
            try {
              if (!mm) break;
              const hdr = mm.get(e?.weMsgId);
              if (!hdr) continue;
              const action = e?.action;
              const valid = action === "" || action === "reply" || action === "archive" || action === "delete" || action === "none";
              if (!valid) continue;
              try {
                hdr.setStringProperty(TM_ACTION_PROP_NAME, String(action));
                written++;
              } catch (_) {}
            } catch (_) {}
          }
          // Invalidate all 3pane windows — cheap broad invalidate after bulk write.
          try {
            const Services = globalThis.Services;
            const wm = Services?.wm;
            if (wm) {
              const enumWin = wm.getEnumerator("mail:3pane");
              while (enumWin.hasMoreElements()) {
                const win = enumWin.getNext();
                try {
                  for (const { view, tree } of _enumerateViewTreesInWindow(win)) {
                    const rc = view?.rowCount || 0;
                    if (rc > 0) {
                      try { tree.invalidate(); } catch (_) {}
                    }
                  }
                } catch (_) {}
              }
            }
          } catch (_) {}
          return written;
        },

        /**
         * Read the AI action for a message. Primarily for debugging / tests;
         * the painter reads hdr.getStringProperty directly (synchronous).
         */
        async getAction(weMsgId) {
          try {
            if (!mm) return "";
            const hdr = mm.get(weMsgId);
            if (!hdr) return "";
            try { return String(hdr.getStringProperty(TM_ACTION_PROP_NAME) || ""); } catch (_) { return ""; }
          } catch (_) { return ""; }
        },

        // Header flags, looked up by WebExtension message id. A WebExtension id is not the
        // message's key in its folder, so it is never passed to GetMessageHeader. A message
        // that is gone reads as false.
        async getRepliedBulk(messageIds) {
          return readFlagBulk(messageIds, CiTM.nsMsgMessageFlags.Replied);
        },
        // nsMsgMessageFlags.HasRe: the original subject started with "Re:", which Thunderbird
        // strips from MessageHeader.subject.
        async getHasReBulk(messageIds) {
          return readFlagBulk(messageIds, CiTM.nsMsgMessageFlags.HasRe);
        },
        // Thunderbird's MessageHeader has no attachment field, so the flag comes from the
        // message database: nsMsgMessageFlags.Attachment, the flag behind Thunderbird's
        // paperclip column. Looked up by WebExtension message id; null when the message is
        // gone or the read fails, so callers never mistake "could not tell" for "no".
        async getHasAttachmentBulk(messageIds) {
          const NS = CiTM.nsMsgMessageFlags;
          let unknown = 0;
          const out = (Array.isArray(messageIds) ? messageIds : []).map((id) => {
            try {
              const hdr = mm ? mm.get(id) : null;
              if (hdr) return !!(hdr.flags & NS.Attachment);
            } catch (e) {
              console.warn("[TMDBG tmHdr] getHasAttachmentBulk: header read failed for", id, e);
            }
            unknown++;
            return null;
          });
          if (unknown > 0) {
            console.warn(`[TMDBG tmHdr] getHasAttachmentBulk: ${unknown} of ${out.length} headers unavailable`);
          }
          return out;
        },
      },
    };
  }
};
