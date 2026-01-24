// Message Bubble Registration and Injection Module
// Handles registration and on-demand injection of messageBubble.js content script

let _messageBubbleRegistered = false;

export async function registerMessageBubbleScript() {
    if (_messageBubbleRegistered) {
        return;
    }
    
    // Try to register via messageDisplayScripts if available (TB < 141)
    if (browser.messageDisplayScripts && browser.messageDisplayScripts.register) {
        try {
            await browser.messageDisplayScripts.register({
                js: [
                    { file: "agent/modules/quoteAndSignature.js" },
                    { file: "theme/modules/threadBubbleConfig.js" },
                    { file: "theme/modules/messageBubbleConfig.js" },
                    { file: "theme/modules/messageBubbleStyles.js" },
                    { file: "theme/modules/threadBubble.js" },
                    { file: "theme/modules/messageBubble.js" },
                ],
                runAt: "document_end",
            });
            _messageBubbleRegistered = true;
            console.log("[TabMail Theme] ✓ Registered messageBubble.js via messageDisplayScripts");
            return;
        } catch (e) {
            console.log("[TabMail Theme] messageDisplayScripts registration failed:", e.message);
        }
    }
    
    // In TB 141+, messageDisplayScripts is not available
    // We'll inject on-demand via browser.tabs.onUpdated
    console.log("[TabMail Theme] Will inject messageBubble.js on-demand (TB 141+)");
}

export async function injectMessageBubbleIntoTab(tabId) {
    try {
        if (browser.scripting && browser.scripting.executeScript) {
            await browser.scripting.executeScript({
                target: { tabId, allFrames: true },
                files: [
                    "agent/modules/quoteAndSignature.js",
                    "theme/modules/threadBubbleConfig.js",
                    "theme/modules/messageBubbleConfig.js",
                    "theme/modules/messageBubbleStyles.js",
                    "theme/modules/threadBubble.js",
                    "theme/modules/messageBubble.js",
                ],
            });
            console.log(`[TabMail Theme] ✓ Injected messageBubble.js into tab ${tabId}`);
        } else if (browser.tabs && browser.tabs.executeScript) {
            // tabs.executeScript only supports a single file per call; preserve order.
            await browser.tabs.executeScript(tabId, {
                file: "agent/modules/quoteAndSignature.js",
                allFrames: true,
                runAt: "document_end",
            });
            await browser.tabs.executeScript(tabId, {
                file: "theme/modules/threadBubbleConfig.js",
                allFrames: true,
                runAt: "document_end",
            });
            await browser.tabs.executeScript(tabId, {
                file: "theme/modules/messageBubbleConfig.js",
                allFrames: true,
                runAt: "document_end",
            });
            await browser.tabs.executeScript(tabId, {
                file: "theme/modules/messageBubbleStyles.js",
                allFrames: true,
                runAt: "document_end",
            });
            await browser.tabs.executeScript(tabId, {
                file: "theme/modules/threadBubble.js",
                allFrames: true,
                runAt: "document_end",
            });
            await browser.tabs.executeScript(tabId, {
                file: "theme/modules/messageBubble.js",
                allFrames: true,
                runAt: "document_end",
            });
            console.log(`[TabMail Theme] ✓ Injected messageBubble.js into tab ${tabId} (fallback)`);
        } else {
            console.error("[TabMail Theme] No script injection API available");
        }
    } catch (e) {
        console.warn(`[TabMail Theme] Failed to inject messageBubble.js into tab ${tabId}:`, e);
    }
}

/**
 * Reset the registration flag for hot-reload scenarios.
 * Called during extension suspend so scripts can be re-registered on next init.
 */
export function resetMessageBubbleRegistrationFlag() {
    _messageBubbleRegistered = false;
    console.log("[TabMail Theme] Message bubble registration flag reset");
}

