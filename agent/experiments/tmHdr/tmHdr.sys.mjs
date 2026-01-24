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

var tmHdr = class extends ExtensionCommonTMHdr.ExtensionAPI {
  getAPI(context) {
    return {
      tmHdr: {
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
      },
    };
  }
};


