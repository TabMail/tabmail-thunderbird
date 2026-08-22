/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// agent/experiments/tmMsgNotify/tmMsgNotify.sys.mjs
// Experiment API for nsIMsgFolderNotificationService message delta events

const { ExtensionCommon: ExtensionCommonMsgNotify } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
);
const {
  clearInterval: clearGeckoInterval,
  setInterval: setGeckoInterval,
} = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");

let MailServices = null;
try {
  ({ MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs"));
} catch (e) {
  console.error("[tmMsgNotify] Failed to import MailServices:", e);
}

let MailUtilsMsgNotify = null;
try {
  ({ MailUtils: MailUtilsMsgNotify } = ChromeUtils.importESModule("resource:///modules/MailUtils.sys.mjs"));
} catch (e) {
  console.error("[tmMsgNotify] Failed to import MailUtils:", e);
}

// Debug flag
const DEBUG_MSG_NOTIFY = true;

function debugLog(...args) {
  if (DEBUG_MSG_NOTIFY) {
    console.log("[tmMsgNotify]", ...args);
  }
}

const FOLDER_SCAN_MAX_PAGE_ITEMS = 1000;
const FOLDER_SCAN_MAX_LIVE = 8;
const FOLDER_SCAN_IDLE_TTL_MS = 5 * 60 * 1000;
const FOLDER_SCAN_SWEEP_INTERVAL_MS = 60 * 1000;
const folderMessageScans = new Map();
let nextFolderMessageScanId = 1;
let folderMessageScanSweepTimer = null;

function sweepFolderMessageScans(nowMs = Date.now(), reserveSlot = false) {
  for (const [token, scan] of folderMessageScans) {
    if (nowMs - scan.lastAccessMs >= FOLDER_SCAN_IDLE_TTL_MS) {
      folderMessageScans.delete(token);
    }
  }
  const limit = reserveSlot ? FOLDER_SCAN_MAX_LIVE - 1 : FOLDER_SCAN_MAX_LIVE;
  while (folderMessageScans.size > limit) {
    let oldestToken = null;
    let oldestAccess = Infinity;
    for (const [token, scan] of folderMessageScans) {
      if (scan.lastAccessMs < oldestAccess) {
        oldestToken = token;
        oldestAccess = scan.lastAccessMs;
      }
    }
    if (!oldestToken) break;
    folderMessageScans.delete(oldestToken);
  }
}

function isExcludedProofHeader(hdr) {
  try {
    const excludedFlags = Ci.nsMsgMessageFlags.IMAPDeleted
      | Ci.nsMsgMessageFlags.Expunged;
    return !!(hdr && (hdr.flags & excludedFlags));
  } catch (_) {
    // A summary/flag read failure cannot authorize membership proof.
    return true;
  }
}

/**
 * Extract message info from nsIMsgDBHdr for serialization to WebExtension.
 * IMPORTANT: Do not hold references to nsIMsgDBHdr objects - serialize immediately.
 */
function extractMessageInfo(hdr, folderManager, messageManager, eventType) {
  try {
    if (!hdr) return null;
    
    const folder = hdr.folder;
    const headerMessageId = String(hdr.messageId || "").replace(/[<>]/g, "");
    
    // Get folder info
    let weFolderId = null;
    let folderPath = "";
    let accountId = "";
    
    if (folder) {
      try {
        const weFolder = folderManager?.convert(folder);
        weFolderId = weFolder?.id || null;
        folderPath = weFolder?.path || folder.URI || "";
        accountId = weFolder?.accountId || "";
      } catch (e) {
        // Fallback to raw folder properties
        folderPath = folder.URI || "";
        try {
          accountId = folder.server?.key || "";
        } catch (_) {}
      }
    }
    
    // Try to get WebExtension message ID
    let weMsgId = null;
    try {
      const weMsg = messageManager?.convert(hdr);
      weMsgId = weMsg?.id || null;
    } catch (_) {
      // Message may not be convertible yet
    }
    
    const subject = String(hdr.mime2DecodedSubject || hdr.subject || "");
    const author = String(hdr.mime2DecodedAuthor || hdr.author || "");
    const dateMs = hdr.dateInSeconds ? hdr.dateInSeconds * 1000 : 0;
    // msgKey: for IMAP folders this is the IMAP UID — monotonic in
    // arrival-into-folder order. Used by the indexer's per-folder cursor
    // (PLAN_RECONCILE_CURSOR.md / ADR-020).
    let msgKey = null;
    try {
      const k = hdr.messageKey;
      if (typeof k === "number" && Number.isFinite(k)) msgKey = k;
    } catch (_) {}

    return {
      headerMessageId,
      weMsgId,
      weFolderId,
      folderPath,
      accountId,
      subject,
      author,
      dateMs,
      msgKey,
      eventType,
    };
  } catch (e) {
    console.error("[tmMsgNotify] extractMessageInfo failed:", e);
    return null;
  }
}

/**
 * Extract minimal info for removed messages.
 * When messages are deleted, we may not have full header access.
 */
function extractRemovedInfo(hdr, folderManager, eventType) {
  try {
    if (!hdr) return null;
    
    const folder = hdr.folder;
    const headerMessageId = String(hdr.messageId || "").replace(/[<>]/g, "");
    
    let weFolderId = null;
    let folderPath = "";
    let accountId = "";
    
    if (folder) {
      try {
        const weFolder = folderManager?.convert(folder);
        weFolderId = weFolder?.id || null;
        folderPath = weFolder?.path || folder.URI || "";
        accountId = weFolder?.accountId || "";
      } catch (_) {
        folderPath = folder.URI || "";
        try {
          accountId = folder.server?.key || "";
        } catch (_) {}
      }
    }

    let msgKey = null;
    try {
      const k = hdr.messageKey;
      if (typeof k === "number" && Number.isFinite(k)) msgKey = k;
    } catch (_) {}
    
    return {
      headerMessageId,
      weFolderId,
      folderPath,
      accountId,
      msgKey,
      eventType,
    };
  } catch (e) {
    console.error("[tmMsgNotify] extractRemovedInfo failed:", e);
    return null;
  }
}

var tmMsgNotify = class extends ExtensionCommonMsgNotify.ExtensionAPI {
  constructor(extension) {
    super(extension);
    this._listener = null;
    this._onAddedFire = null;
    this._onRemovedFire = null;
  }
  
  onShutdown(isAppShutdown) {
    if (folderMessageScanSweepTimer) {
      clearGeckoInterval(folderMessageScanSweepTimer);
      folderMessageScanSweepTimer = null;
    }
    folderMessageScans.clear();
    if (isAppShutdown) return;
    this._removeListener();
  }
  
  _removeListener() {
    if (this._listener && MailServices?.mfn) {
      try {
        MailServices.mfn.removeListener(this._listener);
        debugLog("Listener removed");
      } catch (e) {
        console.error("[tmMsgNotify] Error removing listener:", e);
      }
      this._listener = null;
    }
  }
  
  getAPI(context) {
    const self = this;
    const folderManager = context.extension.folderManager;
    const messageManager = context.extension.messageManager;
    if (!folderMessageScanSweepTimer) {
      folderMessageScanSweepTimer = setGeckoInterval(
        () => sweepFolderMessageScans(),
        FOLDER_SCAN_SWEEP_INTERVAL_MS,
      );
    }
    
    return {
      tmMsgNotify: {
        onMessageAdded: new ExtensionCommonMsgNotify.EventManager({
          context,
          name: "tmMsgNotify.onMessageAdded",
          register: (fire) => {
            debugLog("onMessageAdded listener registered");
            self._onAddedFire = fire;
            self._ensureListener(folderManager, messageManager);
            
            return () => {
              debugLog("onMessageAdded listener unregistered");
              self._onAddedFire = null;
              if (!self._onRemovedFire) {
                self._removeListener();
              }
            };
          },
        }).api(),
        
        onMessageRemoved: new ExtensionCommonMsgNotify.EventManager({
          context,
          name: "tmMsgNotify.onMessageRemoved",
          register: (fire) => {
            debugLog("onMessageRemoved listener registered");
            self._onRemovedFire = fire;
            self._ensureListener(folderManager, messageManager);
            
            return () => {
              debugLog("onMessageRemoved listener unregistered");
              self._onRemovedFire = null;
              if (!self._onAddedFire) {
                self._removeListener();
              }
            };
          },
        }).api(),
        
        async isListenerActive() {
          return self._listener !== null;
        },

        /**
         * Per-folder msgDB cursor fingerprints for the add-side reconcile
         * (PLAN_RECONCILE_CURSOR.md / ADR-020). IMAP accounts only — for IMAP
         * folders msgKey = IMAP UID (arrival-ordered, monotonic per
         * UIDVALIDITY). Folders whose msgDB cannot be opened are returned
         * with an `error` field so the caller can skip them (never seed or
         * advance a cursor on error).
         */
        async getCursorFolder(accountId, folderPath) {
          const started = Date.now();
          const base = {
            accountId: String(accountId || ""),
            folderPath: String(folderPath || ""),
            folderURI: "",
          };
          debugLog("getCursorFolder:start", `${base.accountId}:${base.folderPath}`);
          try {
            const lookupStarted = Date.now();
            const folder = folderManager?.get(base.accountId, base.folderPath);
            const lookupMs = Date.now() - lookupStarted;
            if (!folder) return { ...base, lookupMs, elapsedMs: Date.now() - started, error: "folder_not_found" };
            base.folderURI = String(folder.URI || "");
            const isVirtual = folder.getFlag(Ci.nsMsgFolderFlags.Virtual);
            if (String(folder.server?.type || "") !== "imap" || isVirtual) {
              return { ...base, lookupMs, elapsedMs: Date.now() - started, error: "not_imap" };
            }

            // This is deliberately one folder per Experiment call. Opening a
            // large or stale summary DB can be synchronous; the WebExtension
            // caller yields between calls so one account-wide loop cannot
            // monopolize Thunderbird's extension thread at startup.
            const dbOpenStarted = Date.now();
            const db = folder.msgDatabase;
            const dbInfo = db.dBFolderInfo;
            const dbOpenMs = Date.now() - dbOpenStarted;
            const result = {
              ...base,
              uidValidity: dbInfo.imapUidValidity || 0,
              highWater: dbInfo.highWater || 0,
              totalMessages: folder.getTotalMessages(false),
              lookupMs,
              dbOpenMs,
              elapsedMs: Date.now() - started,
            };
            debugLog("getCursorFolder:done", `${base.accountId}:${base.folderPath}`, result);
            return result;
          } catch (e) {
            const result = { ...base, elapsedMs: Date.now() - started, error: String(e) };
            console.warn("[tmMsgNotify] getCursorFolder:error", `${base.accountId}:${base.folderPath}`, result);
            return result;
          }
        },

        /**
         * Begin a bounded, live parent-process header walk. The opaque token
         * deliberately is not durable: a restart discards it and the addon
         * restarts the exact fingerprint from the beginning, which can repeat
         * work but cannot skip a row or mint a false checkpoint.
         */
        async beginFolderMessageScan(folderURI, includeMessageIds) {
          try {
            sweepFolderMessageScans(Date.now(), true);
            const folder = MailUtilsMsgNotify?.getExistingFolder?.(folderURI);
            if (!folder) return { error: "folder_not_found" };
            let accountId = "";
            let folderPath = "";
            try {
              const weFolder = folderManager?.convert(folder);
              accountId = weFolder?.accountId || folder.server?.key || "";
              folderPath = weFolder?.path || folder.URI || "";
            } catch (_) {
              accountId = folder.server?.key || "";
              folderPath = folder.URI || "";
            }
            if (!accountId || !folderPath) return { error: "folder_identity_missing" };

            const db = folder.msgDatabase;
            const dbInfo = db.dBFolderInfo;
            const serverType = String(folder.server?.type || "");
            const stableUidKeys = serverType === "imap"
              && !folder.getFlag(Ci.nsMsgFolderFlags.Virtual);
            let highestModSeq = "";
            try {
              highestModSeq = String(dbInfo.getCharProperty("highestModSeq") || "");
            } catch (_) {}
            const token = `folder-scan-${nextFolderMessageScanId++}`;
            folderMessageScans.set(token, {
              enumerator: db.enumerateMessages(),
              includeMessageIds: includeMessageIds === true,
              lastAccessMs: Date.now(),
            });
            return {
              token,
              accountId,
              folderPath,
              serverType,
              stableUidKeys,
              uidValidity: stableUidKeys ? (dbInfo.imapUidValidity || 0) : 0,
              highestModSeq,
            };
          } catch (e) {
            return { error: String(e) };
          }
        },

        /** Pull at most maxItems headers from a live folder scan. */
        async readFolderMessageScanPage(token, maxItems) {
          const scan = folderMessageScans.get(token);
          if (!scan) return { rows: [], done: true, error: "scan_not_found" };
          try {
            scan.lastAccessMs = Date.now();
            const cap = Math.max(1, Math.min(
              FOLDER_SCAN_MAX_PAGE_ITEMS,
              Number.isFinite(maxItems) ? Math.floor(maxItems) : 0,
            ));
            const rows = [];
            let visited = 0;
            while (visited < cap && scan.enumerator.hasMoreElements()) {
              const hdr = scan.enumerator.getNext().QueryInterface(Ci.nsIMsgDBHdr);
              visited++;
              // Match WebExtension messages.list/get: neither IMAPDeleted nor
              // Expunged rows belong to the exact local proof domain.
              if (isExcludedProofHeader(hdr)) continue;
              const row = { msgKey: hdr.messageKey };
              if (scan.includeMessageIds) {
                row.headerMessageId = String(hdr.messageId || "").replace(/[<>]/g, "");
              }
              rows.push(row);
            }
            const done = !scan.enumerator.hasMoreElements();
            if (done) folderMessageScans.delete(token);
            return { rows, done };
          } catch (e) {
            folderMessageScans.delete(token);
            return { rows: [], done: true, error: String(e) };
          }
        },

        async cancelFolderMessageScan(token) {
          return { cancelled: folderMessageScans.delete(token) };
        },

        /** Privacy-safe live scan-token resource telemetry. */
        async getFolderMessageScanStats() {
          sweepFolderMessageScans();
          return {
            live: folderMessageScans.size,
            maxLive: FOLDER_SCAN_MAX_LIVE,
            idleTtlMs: FOLDER_SCAN_IDLE_TTL_MS,
          };
        },

        /**
         * Resolve msgKeys to serialized messageInfos (same shape as the
         * onMessageAdded payload). Keys whose header vanished between list
         * and fetch are silently omitted — message gone means nothing to
         * index; the remove side owns it.
         */
        async getMessageInfosForKeys(folderURI, keys) {
          try {
            const folder = MailUtilsMsgNotify?.getExistingFolder?.(folderURI);
            if (!folder) return { infos: [], error: "folder_not_found" };
            const db = folder.msgDatabase;
            const infos = [];
            for (const key of keys || []) {
              let hdr = null;
              try {
                hdr = db.getMsgHdrForKey(key);
              } catch (_) {
                continue; // header gone — skip
              }
              if (!hdr) continue;
              if (isExcludedProofHeader(hdr)) continue;
              const info = extractMessageInfo(hdr, folderManager, messageManager, "cursorScan");
              if (info) infos.push(info);
            }
            return { infos };
          } catch (e) {
            return { infos: [], error: String(e) };
          }
        },

        /**
         * Cheap startup identity/epoch state for one folder. Exact local
         * membership is collected separately through the bounded live scan.
         */
        async getFolderState(accountId, folderPath) {
          const base = {
            accountId: String(accountId || ""),
            folderPath: String(folderPath || ""),
            folderURI: "",
            serverType: "",
            stableUidKeys: false,
          };
          try {
            const folder = folderManager?.get(base.accountId, base.folderPath);
            if (!folder) return { ...base, error: "folder_not_found" };
            base.folderURI = String(folder.URI || "");
            base.serverType = String(folder.server?.type || "");
            // Saved-search/virtual folders can live under an IMAP server, but
            // their msgDB keys are search-view artifacts, not IMAP UIDs.
            base.stableUidKeys = base.serverType === "imap"
              && !folder.getFlag(Ci.nsMsgFolderFlags.Virtual);

            if (!base.stableUidKeys) {
              return base;
            }

            const db = folder.msgDatabase;
            const dbInfo = db.dBFolderInfo;
            let highestModSeq = "";
            try {
              highestModSeq = String(dbInfo.getCharProperty("highestModSeq") || "");
            } catch (_) {}
            const result = {
              ...base,
              uidValidity: dbInfo.imapUidValidity || 0,
              highestModSeq,
            };
            return result;
          } catch (e) {
            return { ...base, error: String(e) };
          }
        },

        /**
         * Probe headerMessageIds against a folder's msgDB via
         * getMsgHdrForMessageID — a hash index (threading depends on it),
         * so this is the fast stale-finder that needs NO msgDB enumeration
         * (PLAN_FOLDER_SET_RECONCILE.md §2). Ids are stored WITHOUT angle
         * brackets — pass them as-is. Returns the ids with no header
         * (stale CANDIDATES only — the addon confirms each with the
         * ADR-017 verify-then-remove recheck before touching FTS).
         */
        async probeMessageIds(folderURI, headerMessageIds) {
          try {
            const folder = MailUtilsMsgNotify?.getExistingFolder?.(folderURI);
            if (!folder) return { missing: [], error: "folder_not_found" };
            // May throw (missing/out-of-date summary) — caller skips the folder.
            const db = folder.msgDatabase;
            const missing = [];
            for (const id of headerMessageIds || []) {
              let hdr = null;
              try {
                hdr = db.getMsgHdrForMessageID(id);
              } catch (_) {
                // Lookup error = uncertain — do NOT nominate as missing.
                continue;
              }
              if (!hdr || isExcludedProofHeader(hdr)) missing.push(String(id));
            }
            return { missing };
          } catch (e) {
            return { missing: [], error: String(e) };
          }
        },
      },
    };
  }
  
  _ensureListener(folderManager, messageManager) {
    if (this._listener) return;
    if (!MailServices?.mfn) {
      console.error("[tmMsgNotify] MailServices.mfn not available");
      return;
    }
    
    const self = this;
    
    // Create the nsIMsgFolderNotificationService listener
    this._listener = {
      // Called when messages are added to a folder
      msgAdded(hdr) {
        debugLog("msgAdded:", hdr?.messageId?.substring(0, 50));
        if (!self._onAddedFire) return;
        
        const info = extractMessageInfo(hdr, folderManager, messageManager, "added");
        if (info) {
          try {
            self._onAddedFire.async(info);
          } catch (e) {
            console.error("[tmMsgNotify] msgAdded fire failed:", e);
          }
        }
      },
      
      // Called when messages are classified by filters
      msgsClassified(messages, junkProcessed, traitProcessed) {
        debugLog("msgsClassified: count=", messages?.length || 0);
        if (!self._onAddedFire) return;
        
        // messages is an array of nsIMsgDBHdr
        for (const hdr of messages || []) {
          const info = extractMessageInfo(hdr, folderManager, messageManager, "classified");
          if (info) {
            try {
              self._onAddedFire.async(info);
            } catch (e) {
              console.error("[tmMsgNotify] msgsClassified fire failed:", e);
            }
          }
        }
      },
      
      // Called when messages are deleted
      msgsDeleted(messages) {
        debugLog("msgsDeleted: count=", messages?.length || 0);
        if (!self._onRemovedFire) return;
        
        for (const hdr of messages || []) {
          const info = extractRemovedInfo(hdr, folderManager, "deleted");
          if (info) {
            try {
              self._onRemovedFire.async(info);
            } catch (e) {
              console.error("[tmMsgNotify] msgsDeleted fire failed:", e);
            }
          }
        }
      },
      
      // Called when messages are moved (provides both source and destination)
      msgsMoveCopyCompleted(move, srcMessages, destFolder, destMessages) {
        const eventType = move ? "moveCompleted" : "copyCompleted";
        debugLog(eventType, ": srcCount=", srcMessages?.length || 0, "destCount=", destMessages?.length || 0);
        
        // Fire removed events for source messages (if move)
        if (move && self._onRemovedFire) {
          for (const hdr of srcMessages || []) {
            const info = extractRemovedInfo(hdr, folderManager, "moveCompleted");
            if (info) {
              try {
                self._onRemovedFire.async(info);
              } catch (e) {
                console.error("[tmMsgNotify] msgsMoveCopyCompleted remove fire failed:", e);
              }
            }
          }
        }
        
        // Fire added events for destination messages
        if (self._onAddedFire) {
          for (const hdr of destMessages || []) {
            const info = extractMessageInfo(hdr, folderManager, messageManager, eventType);
            if (info) {
              try {
                self._onAddedFire.async(info);
              } catch (e) {
                console.error("[tmMsgNotify] msgsMoveCopyCompleted add fire failed:", e);
              }
            }
          }
        }
      },
      
      // Required interface methods (we may not need all of these)
      folderAdded(folder) {},
      folderDeleted(folder) {},
      folderMoveCopyCompleted(move, srcFolder, destFolder) {},
      folderRenamed(oldFolder, newFolder) {},
      folderCompactStart(folder) {},
      folderCompactFinish(folder) {},
      folderReindexTriggered(folder) {},
      msgKeyChanged(oldKey, newHdr) {},
      msgUnincorporatedMoved(srcFolder, msg) {},
    };
    
    // Register for the notification flags we care about
    // nsIMsgFolderNotificationService flags:
    // msgAdded = 0x1
    // msgsClassified = 0x2
    // msgsDeleted = 0x8
    // msgsMoveCopyCompleted = 0x4
    const notifyFlags = 
      0x1 |  // msgAdded
      0x2 |  // msgsClassified
      0x4 |  // msgsMoveCopyCompleted
      0x8;   // msgsDeleted
    
    try {
      MailServices.mfn.addListener(this._listener, notifyFlags);
      debugLog("Listener registered with flags:", notifyFlags);
    } catch (e) {
      console.error("[tmMsgNotify] Failed to register listener:", e);
      this._listener = null;
    }
  }
};

this.tmMsgNotify = tmMsgNotify;
