/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// agent/experiments/tmMsgNotify/tmMsgNotify.sys.mjs
// Experiment API for nsIMsgFolderNotificationService message delta events

const { ExtensionCommon: ExtensionCommonMsgNotify } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
);

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

const HASH_CHUNK_BYTES = 1024 * 1024;

// Experiment modules run in a privileged Thunderbird scope where Web-platform
// globals such as TextEncoder are not guaranteed (TB 154 Beta has none). Keep
// the encoding local and deterministic instead of failing the entire API at
// module evaluation time. Lone UTF-16 surrogates match TextEncoder semantics
// by becoming U+FFFD.
function encodeUtf8(value) {
  const input = String(value);
  const bytes = [];
  for (let i = 0; i < input.length; i++) {
    let cp = input.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff) {
      const low = input.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (low - 0xdc00);
        i++;
      } else {
        cp = 0xfffd;
      }
    } else if (cp >= 0xdc00 && cp <= 0xdfff) {
      cp = 0xfffd;
    }

    if (cp <= 0x7f) {
      bytes.push(cp);
    } else if (cp <= 0x7ff) {
      bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp <= 0xffff) {
      bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      bytes.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return Uint8Array.from(bytes);
}

function bytesCompare(a, b) {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

function finishSha256Hex(hash) {
  const binary = hash.finish(false);
  let hex = "";
  for (let i = 0; i < binary.length; i++) {
    hex += binary.charCodeAt(i).toString(16).padStart(2, "0");
  }
  return hex;
}

/** Hash sorted UTF-8 strings using the native helper's length framing. */
function fingerprintStrings(values) {
  const encoded = Array.from(values, encodeUtf8);
  encoded.sort(bytesCompare);
  const hash = Cc["@mozilla.org/security/hash;1"].createInstance(Ci.nsICryptoHash);
  hash.init(hash.SHA256);
  const chunk = new Uint8Array(HASH_CHUNK_BYTES);
  const chunkView = new DataView(chunk.buffer);
  let offset = 0;
  const flush = () => {
    if (offset === 0) return;
    hash.update(chunk.subarray(0, offset), offset);
    offset = 0;
  };
  for (const bytes of encoded) {
    if (bytes.length + 8 > chunk.length) {
      flush();
      const length = new Uint8Array(8);
      new DataView(length.buffer).setUint32(4, bytes.length, false);
      hash.update(length, length.length);
      hash.update(bytes, bytes.length);
      continue;
    }
    if (offset + 8 + bytes.length > chunk.length) flush();
    chunkView.setUint32(offset, 0, false);
    chunkView.setUint32(offset + 4, bytes.length, false);
    offset += 8;
    chunk.set(bytes, offset);
    offset += bytes.length;
  }
  flush();
  return { count: encoded.length, sha256: finishSha256Hex(hash) };
}

/** Hash sorted msgDB keys. In IMAP folders these are the folder's UID set. */
function fingerprintMsgKeys(keys) {
  const sorted = Array.from(keys || [], Number).filter(Number.isFinite).sort((a, b) => a - b);
  const hash = Cc["@mozilla.org/security/hash;1"].createInstance(Ci.nsICryptoHash);
  hash.init(hash.SHA256);
  const chunk = new Uint8Array(HASH_CHUNK_BYTES);
  const view = new DataView(chunk.buffer);
  let offset = 0;
  for (const key of sorted) {
    if (offset + 4 > chunk.length) {
      hash.update(chunk, offset);
      offset = 0;
    }
    view.setUint32(offset, key >>> 0, false);
    offset += 4;
  }
  if (offset > 0) hash.update(chunk.subarray(0, offset), offset);
  return { count: sorted.length, sha256: finishSha256Hex(hash) };
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
         * List msgKeys strictly above sinceKey, ascending. When more than
         * maxKeys are above, returns the HIGHEST maxKeys (newest arrivals
         * win) with truncated=true so the caller can log the gap loudly.
         */
        async listKeysAboveKey(folderURI, sinceKey, maxKeys) {
          try {
            const folder = MailUtilsMsgNotify?.getExistingFolder?.(folderURI);
            if (!folder) return { keys: [], truncated: false, totalAbove: 0, error: "folder_not_found" };
            const db = folder.msgDatabase;
            const since = Number.isFinite(sinceKey) ? sinceKey : 0;
            const keys = db.listAllKeys().filter((k) => k > since).sort((a, b) => a - b);
            const cap = Number.isFinite(maxKeys) && maxKeys > 0 ? maxKeys : keys.length;
            const truncated = keys.length > cap;
            return {
              keys: truncated ? keys.slice(keys.length - cap) : keys,
              truncated,
              totalAbove: keys.length,
            };
          } catch (e) {
            return { keys: [], truncated: false, totalAbove: 0, error: String(e) };
          }
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
              const info = extractMessageInfo(hdr, folderManager, messageManager, "cursorScan");
              if (info) infos.push(info);
            }
            return { infos };
          } catch (e) {
            return { infos: [], error: String(e) };
          }
        },

        /**
         * Cheap startup membership state for every folder. IMAP msgDB keys
         * are UIDs, so their sorted digest plus UIDVALIDITY is a stable,
         * deletion-sensitive fingerprint. Other server types deliberately do
         * not claim stable keys and are verified from Message-IDs each boot.
         */
        async getFolderState(accountId, folderPath) {
          const started = Date.now();
          const base = {
            accountId: String(accountId || ""),
            folderPath: String(folderPath || ""),
            folderURI: "",
            serverType: "",
            stableUidKeys: false,
          };
          debugLog("getFolderState:start", `${base.accountId}:${base.folderPath}`);
          try {
            const lookupStarted = Date.now();
            const folder = folderManager?.get(base.accountId, base.folderPath);
            const lookupMs = Date.now() - lookupStarted;
            if (!folder) return { ...base, lookupMs, elapsedMs: Date.now() - started, error: "folder_not_found" };
            base.folderURI = String(folder.URI || "");
            base.serverType = String(folder.server?.type || "");
            // Saved-search/virtual folders can live under an IMAP server, but
            // their msgDB keys are search-view artifacts, not IMAP UIDs.
            base.stableUidKeys = base.serverType === "imap"
              && !folder.getFlag(Ci.nsMsgFolderFlags.Virtual);

            if (!base.stableUidKeys) {
              const result = { ...base, lookupMs, elapsedMs: Date.now() - started };
              debugLog("getFolderState:done", `${base.accountId}:${base.folderPath}`, result);
              return result;
            }

            const dbOpenStarted = Date.now();
            const db = folder.msgDatabase;
            const dbInfo = db.dBFolderInfo;
            const dbOpenMs = Date.now() - dbOpenStarted;
            const hashStarted = Date.now();
            const uid = fingerprintMsgKeys(db.listAllKeys());
            const hashMs = Date.now() - hashStarted;
            let highestModSeq = "";
            try {
              highestModSeq = String(dbInfo.getCharProperty("highestModSeq") || "");
            } catch (_) {}
            const result = {
              ...base,
              uidValidity: dbInfo.imapUidValidity || 0,
              uidCount: uid.count,
              uidSha256: uid.sha256,
              highestModSeq,
              lookupMs,
              dbOpenMs,
              hashMs,
              elapsedMs: Date.now() - started,
            };
            debugLog("getFolderState:done", `${base.accountId}:${base.folderPath}`, result);
            return result;
          } catch (e) {
            const result = { ...base, elapsedMs: Date.now() - started, error: String(e) };
            console.warn("[tmMsgNotify] getFolderState:error", `${base.accountId}:${base.folderPath}`, result);
            return result;
          }
        },

        /**
         * Exact expected FTS-key fingerprint from the folder's local msgDB.
         * This reads headers only (never message bodies), normalizes the same
         * account:path:Message-ID key used by the indexer, and de-duplicates
         * duplicate Message-IDs to match the native primary key.
         */
        async fingerprintFolderMessages(folderURI) {
          try {
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
            const msgIds = new Set();
            let unkeyedCount = 0;
            for (const key of db.listAllKeys()) {
              let hdr = null;
              try {
                hdr = db.getMsgHdrForKey(key);
              } catch (_) {
                continue;
              }
              const headerMessageId = String(hdr?.messageId || "").replace(/[<>]/g, "");
              if (!headerMessageId) {
                unkeyedCount += 1;
                continue;
              }
              msgIds.add(`${accountId}:${folderPath}:${headerMessageId}`);
            }
            return {
              ...fingerprintStrings(msgIds),
              accountId,
              folderPath,
              unkeyedCount,
            };
          } catch (e) {
            return { error: String(e) };
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
              if (!hdr) missing.push(String(id));
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
