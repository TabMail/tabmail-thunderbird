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

// Debug flag
const DEBUG_MSG_NOTIFY = true;

function debugLog(...args) {
  if (DEBUG_MSG_NOTIFY) {
    console.log("[tmMsgNotify]", ...args);
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
    
    return {
      headerMessageId,
      weMsgId,
      weFolderId,
      folderPath,
      accountId,
      subject,
      author,
      dateMs,
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
      }
    }
    
    return {
      headerMessageId,
      weFolderId,
      folderPath,
      accountId,
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
