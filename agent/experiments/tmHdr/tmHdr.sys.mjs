const { MailUtils: MailUtilsTMHdr } = ChromeUtils.importESModule(
  "resource:///modules/MailUtils.sys.mjs"
);
const { ExtensionCommon: ExtensionCommonTMHdr } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
);
const { MailServices: MailServicesTMHdr } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);

const CiTM = globalThis.Ci || Components?.interfaces;

function resolveMsgFolder(folderURI, pathStr) {
  try {
    // First attempt: native URI via MailUtils.getExistingFolder
    try {
      const f1 = typeof MailUtilsTMHdr.getExistingFolder === "function" ? MailUtilsTMHdr.getExistingFolder(folderURI) : null;
      if (f1) {
        return f1;
      }
    } catch (e1) {
      console.warn("[ReplyDetect] resolveMsgFolder: getExistingFolder threw:", e1);
    }

    // Second attempt: accountN://... + WebExtension path traversal
    const m = /^([a-z]+\d+):\/\//i.exec(String(folderURI || ""));
    if (!m) {
      console.warn("[ReplyDetect] resolveMsgFolder: folderURI not account-scheme and not resolvable:", folderURI);
      return null;
    }
    const accountKey = m[1];
    let root = null;
    try {
      const acc = MailServicesTMHdr?.accounts?.getAccount(accountKey);
      root = acc?.incomingServer?.rootFolder || null;
    } catch (e2) {
      console.warn("[ReplyDetect] resolveMsgFolder: getAccount failed for", accountKey, e2);
      return null;
    }
    if (!root) return null;

    let path = String(pathStr || "").replace(/^\/+/, "");
    if (!path) {
      try {
        const m2 = /^([a-z]+\d+):\/\/(.*)$/i.exec(String(folderURI || ""));
        const fromUri = m2 && m2[2] ? m2[2] : "";
        path = String(fromUri).replace(/^\/+/, "");
      } catch(_) {}
    }
    const parts = String(path).split("/").filter(Boolean);
    if (parts.length === 0) {
      console.warn("[ReplyDetect] resolveMsgFolder: empty pathStr for", folderURI);
      return root;
    }
    let cur = root;
    for (const name of parts) {
      if (typeof cur.getChildNamed !== "function") {
        console.warn("[ReplyDetect] resolveMsgFolder: getChildNamed not available at", cur?.URI || "<no-URI>");
        return null;
      }
      try {
        cur = cur.getChildNamed(name);
      } catch (e3) {
        console.warn("[ReplyDetect] resolveMsgFolder: getChildNamed threw for", name, e3);
        return null;
      }
      if (!cur) {
        console.warn("[ReplyDetect] resolveMsgFolder: child not found for", name);
        return null;
      }
    }
    return cur;
  } catch (e) {
    console.warn("[ReplyDetect] resolveMsgFolder exception", e);
    return null;
  }
}

function tmGetHdrByKey(folderURI, key, pathStr) {
  try {
    if (typeof key !== "number" || key < 0) {
      return null;
    }
    let folder = resolveMsgFolder(folderURI, pathStr);
    if (!folder) {
      console.warn("[ReplyDetect] tmHdr.getHdrByKey: folder not resolved (uri+path)", folderURI, pathStr || "<no-path>");
      return null;
    }
    try {
      void folder.msgDatabase;
    } catch (e) {
      console.warn("[ReplyDetect] tmHdr.getHdrByKey: accessing msgDatabase threw (continuing)", String(e));
    }
    const hdr = folder.GetMessageHeader(key);
    if (!hdr) {
      console.warn("[ReplyDetect] tmHdr.getHdrByKey: header not found for key", key, "in", folderURI);
    }
    return hdr || null;
  } catch (e) {
    // This is expected if the key is a WE id, so don't log as an error.
    // The fallback logic will handle it.
    return null;
  }
}

function tmToFlagsObj(hdr) {
  if (!hdr) return { exists: false };
  try {
    const f = hdr.flags >>> 0; // uint32
    const NS = CiTM.nsMsgMessageFlags;
    const obj = {
      exists: true,
      raw: f,
      replied: !!(f & NS.Replied),
      forwarded: !!(f & NS.Forwarded),
      read: !!(f & NS.Read),
    };
    return obj;
  } catch (e) {
    console.error("[ReplyDetect] tmHdr.toFlagsObj failed", e);
    return { exists: false };
  }
}

function tmGetHdrByMessageId(folderURI, messageId, pathStr) {
  try {
    const folder = resolveMsgFolder(folderURI, pathStr);
    if (!folder) {
      console.warn("[ReplyDetect] tmHdr.getHdrByMessageId: folder not resolved (uri+path)", folderURI, pathStr || "<no-path>");
      return null;
    }
    let hdr = null;
    try {
      const raw = String(messageId || "");
      const normalized = raw.startsWith("<") ? raw : `<${raw.replace(/[<>]/g, "")}>`;
      const bare = raw.replace(/[<>]/g, "");
      if (typeof MailUtilsTMHdr.findMsgIdInFolder === "function") {
        try {
          hdr = MailUtilsTMHdr.findMsgIdInFolder(normalized, folder);
        } catch (e1) {
          console.warn("[ReplyDetect] findMsgIdInFolder failed with normalized, retrying bare", e1);
        }
        if (!hdr) {
          try {
            hdr = MailUtilsTMHdr.findMsgIdInFolder(bare, folder);
          } catch (e2) {
            console.warn("[ReplyDetect] findMsgIdInFolder(bare) threw", e2);
          }
        }
      } else {
        console.warn("[ReplyDetect] MailUtils.findMsgIdInFolder not available");
      }
    } catch (e) {
      console.warn("[ReplyDetect] tmHdr.getHdrByMessageId: findMsgIdInFolder threw", e);
    }
    if (!hdr) {
      console.warn("[ReplyDetect] tmHdr.getHdrByMessageId: header not found for message-id", messageId);
      return null;
    }
    return hdr;
  } catch (e) {
    console.error("[ReplyDetect] tmHdr.getHdrByMessageId exception", e);
    return null;
  }
}

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
// nsMsgViewNotificationCodeValue (from comm-central/mailnews/base/public/nsIMsgDBView.idl).
// CRITICAL: `1` is `insertOrDelete`, NOT `changed`. Passing `1` made TB
// shift `view.selection.currentIndex` down by one for every NoteChange
// issued at or before the selection (observed 2026-04-24 as the "selected
// row slides down" bug in card view). `2` is the correct "row body changed,
// no structural shift" code — forces fillRow without touching selection.
const NOTIFY_CHANGED = 2;

/**
 * Find any currently-open 3pane window whose dbView contains this hdr and
 * issue `view.NoteChange(rowIndex, 1, CHANGED)` so TB re-renders that row
 * immediately (which re-invokes our patched fillRow → painter picks up the
 * new property value).
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
        const tabmail = win.document?.getElementById?.("tabmail");
        const contentWin = tabmail?.currentAbout3Pane
          || tabmail?.currentTabInfo?.chromeBrowser?.contentWindow
          || tabmail?.currentTabInfo?.browser?.contentWindow;
        const view = contentWin?.gDBView
          || contentWin?.gFolderDisplay?.view?.dbView
          || win.gDBView
          || null;
        if (!view) continue;
        diagViewsSeen++;
        // findIndexOfMsgHdr returns 0xffffffff (signed: -1) if hdr not in view.
        let rowIndex = -1;
        try {
          const r = view.findIndexOfMsgHdr?.(hdr, false);
          if (typeof r === "number" && r >= 0 && r < 0x7fffffff) rowIndex = r;
        } catch (_) {}
        // Fallback: FindKey on the view's msgFolder (works for plain views
        // where the msgKey matches the folder the hdr lives in).
        if (rowIndex < 0) {
          try {
            const viewFolderURI = view?.msgFolder?.URI || view?.displayedFolder?.URI || "";
            if (viewFolderURI === folderURI) {
              const r2 = view.FindKey?.(msgKey, true);
              if (typeof r2 === "number" && r2 >= 0) rowIndex = r2;
            }
          } catch (_) {}
        }
        if (rowIndex >= 0) {
          try { view.NoteChange?.(rowIndex, 1, NOTIFY_CHANGED); diagNoted++; } catch (_) {}
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
        const valid = action === "reply" || action === "archive" || action === "delete" || action === "none";
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
          // Group by folder for a single view-invalidation per folder.
          const touchedViews = new Map(); // folderURI -> {view, minRow, maxRow}
          for (const e of entries) {
            try {
              if (!mm) break;
              const hdr = mm.get(e?.weMsgId);
              if (!hdr) continue;
              const action = e?.action;
              const valid = action === "reply" || action === "archive" || action === "delete" || action === "none";
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
                  const tabmail = win.document?.getElementById?.("tabmail");
                  const contentWin = tabmail?.currentAbout3Pane
                    || tabmail?.currentTabInfo?.chromeBrowser?.contentWindow
                    || tabmail?.currentTabInfo?.browser?.contentWindow;
                  const view = contentWin?.gDBView
                    || contentWin?.gFolderDisplay?.view?.dbView
                    || win.gDBView
                    || null;
                  const rc = view?.rowCount || 0;
                  if (view && rc > 0) {
                    try { view.NoteChange?.(0, rc, NOTIFY_CHANGED); } catch (_) {}
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

        async getMsgKey(folderURI, weId, pathStr) {
          try {
            const folder = resolveMsgFolder(folderURI, pathStr);
            if (!folder) {
              console.warn("[ReplyDetect] getMsgKey: folder not resolved", folderURI, pathStr || "<no-path>");
              return -1;
            }
            // In TB, WebExtension message id is not the nsMsgKey. There is no
            // direct API to map WE id to nsMsgKey. We try common mapping via
            // URI formed by folder + key; if hdr lookup fails, return -1.
            try {
              const hdr = folder.GetMessageHeader(weId);
              if (hdr && typeof hdr.messageKey === "number") {
                return hdr.messageKey >>> 0;
              }
            } catch (_) {}
            return -1;
          } catch (e) {
            console.warn("[ReplyDetect] getMsgKey error", e);
            return -1;
          }
        },
        async getReplied(folderURI, key, pathStr, messageId) {
          try {
            let hdr = tmGetHdrByKey(folderURI, key, pathStr);
            if (!hdr && messageId) {
              hdr = tmGetHdrByMessageId(folderURI, messageId, pathStr);
            }
            if (!hdr) {
              return false;
            }
            const NS = CiTM.nsMsgMessageFlags;
            const val = !!(hdr.flags & NS.Replied);
            return val;
          } catch (e) {
            console.error("[ReplyDetect] tmHdr.getReplied error", e, folderURI, key);
            return false;
          }
        },
        async getFlags(folderURI, key, pathStr, messageId) {
          try {
            let hdr = tmGetHdrByKey(folderURI, key, pathStr);
            if (!hdr && messageId) {
              hdr = tmGetHdrByMessageId(folderURI, messageId, pathStr);
            }
            const flags = tmToFlagsObj(hdr);
            return flags;
          } catch (e) {
            console.error("[ReplyDetect] tmHdr.getFlags error", e, folderURI, key);
            return { exists: false };
          }
        },
        async getRepliedByMessageId(folderURI, messageId, pathStr) {
          // This API is slow and deprecated.
          return false;
        },
        async getFlagsByMessageId(folderURI, messageId, pathStr) {
          // This API is slow and deprecated.
          return { exists: false };
        },
        async getRepliedBulk(items) {
          try {
            if (!Array.isArray(items)) return [];
            const NS = CiTM.nsMsgMessageFlags;
            let nullCount = 0;
            const out = items.map((it) => {
              try {
                let hdr = tmGetHdrByKey(it.folderURI, it.key, it.pathStr);
                if (!hdr && it.messageId) {
                  hdr = tmGetHdrByMessageId(it.folderURI, it.messageId, it.pathStr);
                }
                const v = !!(hdr && (hdr.flags & NS.Replied));
                if (!hdr) nullCount++;
                return v;
              } catch (e) {
                console.warn("[ReplyDetect] tmHdr.getRepliedBulk item failed", e, it);
                return false;
              }
            });
            if (nullCount > 0) {
              console.warn(`[ReplyDetect] tmHdr.getRepliedBulk done nullHdrs=${nullCount}`);
            }
            return out;
          } catch (e) {
            console.error("[ReplyDetect] tmHdr.getRepliedBulk error", e);
            return [];
          }
        },
        async getHasReBulk(items) {
          try {
            if (!Array.isArray(items)) return [];
            const NS = CiTM.nsMsgMessageFlags;
            return items.map((it) => {
              try {
                let hdr = tmGetHdrByKey(it.folderURI, it.key, it.pathStr);
                if (!hdr && it.messageId) {
                  hdr = tmGetHdrByMessageId(it.folderURI, it.messageId, it.pathStr);
                }
                return !!(hdr && (hdr.flags & NS.HasRe));
              } catch (e) {
                return false;
              }
            });
          } catch (e) {
            console.error("[ReplyDetect] tmHdr.getHasReBulk error", e);
            return [];
          }
        },
      },
    };
  }
};


