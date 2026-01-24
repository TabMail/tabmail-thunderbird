/**
 * threadMessages experiment - Get parent messages in a thread for conversation view
 * 
 * Provides a Gmail-like conversation view by walking up the thread chain
 * and returning parent message IDs and metadata.
 * 
 * Note: Body content is fetched separately via WebExtension API in background.js
 * to avoid complex MIME parsing in the experiment.
 */

// IMPORTANT (hot reload): avoid top-level block-scoped declarations (`const`/`let`).
// Thunderbird can evaluate this parent script multiple times during add-on reloads,
// and block-scoped redeclaration throws (often reported as "redeclaration of const ...").
var ExtensionCommonThreadMessages = globalThis.__TM_threadMessages_ExtensionCommon || null;
if (!ExtensionCommonThreadMessages) {
  ExtensionCommonThreadMessages = ChromeUtils.importESModule(
    "resource://gre/modules/ExtensionCommon.sys.mjs"
  ).ExtensionCommon;
  globalThis.__TM_threadMessages_ExtensionCommon = ExtensionCommonThreadMessages;
}

// Configuration constants (matching SETTINGS pattern)
var CONFIG = {
  maxMessages: 10,       // Default max parent messages to return
  maxIterations: 50,     // Safety limit for thread walking
  maxThreadMessages: 50, // Default max thread messages to return (full thread enumeration)
};

function tlog(...args) {
  console.log("[ThreadMessages]", ...args);
}

tlog("Loaded threadMessages.sys.mjs (v2 hot-reload-safe)", new Date().toISOString());

/**
 * Format sender address for display
 */
function formatSender(author) {
  if (!author) return "Unknown";
  // Extract name from "Name <email>" format
  const match = author.match(/^([^<]+)\s*</);
  if (match) return match[1].trim();
  // If just email, return it cleaned
  return author.replace(/<|>/g, '').trim();
}

function _safeGetMsgDatabase(folder) {
  // Prefer getMsgDatabase() if available to ensure DB is opened/ready.
  try {
    if (folder && typeof folder.getMsgDatabase === "function") {
      const db = folder.getMsgDatabase(null);
      if (db) return db;
    }
  } catch (e) {
    tlog("[ThreadMessages] folder.getMsgDatabase failed:", e);
  }
  try {
    if (!folder) return null;
    if (folder.msgDatabase) return folder.msgDatabase;
  } catch (_) {}
  return null;
}

function _safeGetThreadForHdr(db, hdr) {
  if (!db || !hdr) return null;
  try {
    if (typeof db.GetThreadContainingMsgHdr === "function") {
      return db.GetThreadContainingMsgHdr(hdr);
    }
  } catch (e1) {
    tlog("[ThreadMessages] GetThreadContainingMsgHdr threw:", e1);
  }
  try {
    if (typeof db.getThreadContainingMsgHdr === "function") {
      return db.getThreadContainingMsgHdr(hdr);
    }
  } catch (e2) {
    tlog("[ThreadMessages] getThreadContainingMsgHdr threw:", e2);
  }
  return null;
}

function _safeGetNumChildren(thread) {
  if (!thread) return 0;
  try {
    const n = thread.numChildren;
    if (Number.isFinite(n)) return n;
  } catch (_) {}
  try {
    if (typeof thread.getNumChildren === "function") {
      const n = thread.getNumChildren();
      if (Number.isFinite(n)) return n;
    }
  } catch (_) {}
  return 0;
}

function _safeGetChildHdrAt(thread, i) {
  if (!thread) return null;
  try {
    if (typeof thread.getChildHdrAt === "function") {
      return thread.getChildHdrAt(i);
    }
  } catch (e1) {
    tlog(`[ThreadMessages] getChildHdrAt(${i}) threw:`, e1);
  }
  try {
    if (typeof thread.GetChildHdrAt === "function") {
      return thread.GetChildHdrAt(i);
    }
  } catch (e2) {
    tlog(`[ThreadMessages] GetChildHdrAt(${i}) threw:`, e2);
  }
  return null;
}

var threadMessages = class extends ExtensionCommonThreadMessages.ExtensionAPI {
  getAPI(context) {
    tlog("═══ threadMessages API initialized ═══");
    return {
      threadMessages: {
        async getThreadParents(weMsgId, options = {}) {
          try {
            tlog(`═══ getThreadParents called for weMsgId=${weMsgId} ═══`);
            tlog(`Options:`, JSON.stringify(options));
            
            if (!Number.isFinite(weMsgId) || weMsgId < 0) {
              return { success: false, error: "Invalid weMsgId", messages: [] };
            }
            
            const maxMessages = options.maxMessages || CONFIG.maxMessages;
            
            // Get the native header via WebExtension messageManager
            const msgMgr = context.extension.messageManager;
            if (!msgMgr) {
              return { success: false, error: "messageManager not available", messages: [] };
            }
            
            let currentHdr = null;
            try {
              currentHdr = msgMgr.get(weMsgId);
            } catch (e) {
              return { success: false, error: `messageManager.get failed: ${e}`, messages: [] };
            }
            
            if (!currentHdr) {
              return { success: false, error: "Native header not found", messages: [] };
            }

            try {
              tlog(
                `[ThreadMessages] currentHdr: messageKey=${currentHdr.messageKey} threadId=${currentHdr.threadId} threadParent=${currentHdr.threadParent} messageId=${currentHdr.messageId}`
              );
            } catch (eDebug) {
              tlog("[ThreadMessages] Failed to log currentHdr props:", eDebug);
            }
            
            const folder = currentHdr.folder;
            if (!folder) {
              return { success: false, error: "Message has no folder", messages: [] };
            }

            try {
              tlog(`[ThreadMessages] folder: name="${folder.prettyName || folder.name || ""}" URI="${folder.URI || ""}"`);
            } catch (_) {}
            
            // Collect parent message headers by walking up the threadParent chain
            const parentHdrs = [];
            let iterations = 0;
            let hdr = currentHdr;
            
            // Walk up the parent chain
            while (iterations < CONFIG.maxIterations && parentHdrs.length < maxMessages) {
              iterations++;
              
              const parentKey = hdr.threadParent;
              tlog(`[ThreadMessages] walk#${iterations}: hdr.messageKey=${hdr.messageKey} parentKey=${parentKey}`);
              
              // Check if we've reached the root (no parent)
              if (!parentKey || parentKey === 0 || parentKey === 0xFFFFFFFF) {
                tlog(`Reached thread root at iteration ${iterations}`);
                break;
              }
              
              // Try to get parent header
              let parentHdr = null;
              try {
                if (typeof folder.GetMessageHeader === "function") {
                  parentHdr = folder.GetMessageHeader(parentKey);
                }
              } catch (eParent) {
                tlog(`GetMessageHeader for parent ${parentKey} failed:`, eParent);
                break;
              }
              
              if (!parentHdr) {
                tlog(`Parent header ${parentKey} not found, stopping`);
                break;
              }

              try {
                tlog(
                  `[ThreadMessages] parentHdr found: messageKey=${parentHdr.messageKey} threadParent=${parentHdr.threadParent} messageId=${parentHdr.messageId}`
                );
              } catch (_) {}
              
              parentHdrs.push(parentHdr);
              hdr = parentHdr;
            }
            
            tlog(`Found ${parentHdrs.length} parent messages in ${iterations} iterations`);
            
            if (parentHdrs.length === 0) {
              return { success: true, messages: [] };
            }
            
            // Reverse to get oldest-first order (root -> ... -> immediate parent)
            parentHdrs.reverse();
            
            // Convert headers to message objects (body will be fetched by background.js)
            const messages = [];
            
            for (const parentHdr of parentHdrs) {
              try {
                // Convert native header to WebExtension message
                const weMsg = msgMgr.convert(parentHdr);
                
                if (!weMsg) {
                  tlog(`Failed to convert parent header to WE message`);
                  continue;
                }
                
                const msgObj = {
                  weId: weMsg.id,
                  from: formatSender(weMsg.author || parentHdr.author || parentHdr.mime2DecodedAuthor),
                  date: weMsg.date ? new Date(weMsg.date).toISOString() : null,
                  subject: weMsg.subject || parentHdr.subject || parentHdr.mime2DecodedSubject || "",
                };
                
                messages.push(msgObj);
              } catch (msgErr) {
                tlog(`Failed to process parent message:`, msgErr);
              }
            }
            
            tlog(`Returning ${messages.length} thread parent messages`);
            
            return {
              success: true,
              messages,
              totalParents: parentHdrs.length,
            };
            
          } catch (e) {
            tlog("getThreadParents error:", e);
            return { success: false, error: String(e), messages: [] };
          }
        },

        async getThreadMessages(weMsgId, options = {}) {
          try {
            tlog(`═══ getThreadMessages called for weMsgId=${weMsgId} ═══`);
            tlog(`Options:`, JSON.stringify(options));

            if (!Number.isFinite(weMsgId) || weMsgId < 0) {
              return { success: false, error: "Invalid weMsgId", messages: [] };
            }

            const maxMessages = options.maxMessages || CONFIG.maxThreadMessages;

            // Get the native header via WebExtension messageManager
            const msgMgr = context.extension.messageManager;
            if (!msgMgr) {
              return { success: false, error: "messageManager not available", messages: [] };
            }

            let currentHdr = null;
            try {
              currentHdr = msgMgr.get(weMsgId);
            } catch (e) {
              return { success: false, error: `messageManager.get failed: ${e}`, messages: [] };
            }

            if (!currentHdr) {
              return { success: false, error: "Native header not found", messages: [] };
            }

            const folder = currentHdr.folder;
            if (!folder) {
              return { success: false, error: "Message has no folder", messages: [] };
            }

            let threadId = null;
            let threadParent = null;
            let messageKey = null;
            let headerMessageId = null;
            try {
              threadId = currentHdr.threadId;
            } catch (_) {}
            try {
              threadParent = currentHdr.threadParent;
            } catch (_) {}
            try {
              messageKey = currentHdr.messageKey;
            } catch (_) {}
            try {
              headerMessageId = currentHdr.messageId;
            } catch (_) {}

            try {
              tlog(
                `[ThreadMessages] currentHdr(thread): messageKey=${messageKey} threadId=${threadId} threadParent=${threadParent} messageId=${headerMessageId}`
              );
            } catch (_) {}

            try {
              tlog(`[ThreadMessages] folder(thread): name="${folder.prettyName || folder.name || ""}" URI="${folder.URI || ""}"`);
              tlog(`[ThreadMessages] folder(thread): hasMsgDatabase=${!!folder.msgDatabase} hasGetMsgDatabase=${typeof folder.getMsgDatabase === "function"}`);
            } catch (_) {}

            const db = _safeGetMsgDatabase(folder);
            if (!db) {
              return { success: false, error: "Folder msgDatabase not available", messages: [] };
            }

            // Diagnostic: if threadParent is set, verify the parent header can be resolved in this folder DB.
            try {
              if (threadParent && threadParent !== 0 && threadParent !== 0xFFFFFFFF) {
                let parentHdr = null;
                try {
                  if (typeof folder.GetMessageHeader === "function") {
                    parentHdr = folder.GetMessageHeader(threadParent);
                  }
                } catch (eParent) {
                  tlog(`[ThreadMessages] Diagnostic GetMessageHeader(threadParent=${threadParent}) threw:`, eParent);
                }
                if (parentHdr) {
                  let pKey = null;
                  let pParent = null;
                  let pId = null;
                  try { pKey = parentHdr.messageKey; } catch (_) {}
                  try { pParent = parentHdr.threadParent; } catch (_) {}
                  try { pId = parentHdr.messageId; } catch (_) {}
                  tlog(`[ThreadMessages] Diagnostic parentHdr resolved: messageKey=${pKey} threadParent=${pParent} messageId=${pId}`);
                } else {
                  tlog(`[ThreadMessages] Diagnostic parentHdr NOT found in folder DB for threadParent=${threadParent}`);
                }
              }
            } catch (_) {}

            const thread = _safeGetThreadForHdr(db, currentHdr);
            if (!thread) {
              tlog("[ThreadMessages] Could not resolve nsIMsgThread for message; thread enumeration unavailable");
              return { success: true, messages: [], totalInThread: 0, threadId, threadParent };
            }

            const totalInThread = _safeGetNumChildren(thread);
            tlog(`[ThreadMessages] Thread resolved: threadId=${threadId} totalInThread=${totalInThread} (threadParent=${threadParent})`);
            try {
              if ((totalInThread === 1 || totalInThread === 0) && threadParent && threadParent !== 0 && threadParent !== 0xFFFFFFFF) {
                tlog(`[ThreadMessages] ⚠ mismatch: threadParent is set but totalInThread=${totalInThread} (expected >1)`);
              }
            } catch (_) {}

            const messages = [];
            const seenWeIds = new Set();

            // Enumerate children; cap to maxMessages to avoid giant UI payloads.
            const limit = Math.min(totalInThread || 0, maxMessages);
            for (let i = 0; i < limit; i++) {
              const childHdr = _safeGetChildHdrAt(thread, i);
              if (!childHdr) continue;

              try {
                const weMsg = msgMgr.convert(childHdr);
                if (!weMsg || !weMsg.id) continue;
                if (seenWeIds.has(weMsg.id)) continue;
                seenWeIds.add(weMsg.id);

                messages.push({
                  weId: weMsg.id,
                  from: formatSender(weMsg.author || childHdr.author || childHdr.mime2DecodedAuthor),
                  date: weMsg.date ? new Date(weMsg.date).toISOString() : null,
                  subject: weMsg.subject || childHdr.subject || childHdr.mime2DecodedSubject || "",
                });
              } catch (msgErr) {
                tlog(`[ThreadMessages] Failed to convert/enrich child message #${i}:`, msgErr);
              }
            }

            tlog(`[ThreadMessages] Returning ${messages.length} thread messages (cap=${maxMessages}, totalInThread=${totalInThread})`);

            return {
              success: true,
              messages,
              totalInThread,
              threadId,
              threadParent,
            };
          } catch (e) {
            tlog("getThreadMessages error:", e);
            return { success: false, error: String(e), messages: [] };
          }
        },
      },
    };
  }
};

