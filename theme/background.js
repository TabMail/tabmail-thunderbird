console.log("[TabMail Theme] ═══════════════════════════════════════");
console.log("[TabMail Theme] Background script loaded at:", new Date().toISOString());
console.log("[TabMail Theme] ═══════════════════════════════════════");

import { SETTINGS } from "../agent/modules/config.js";
import { isInboxFolder } from "../agent/modules/folderUtils.js";
import { injectBubblesIntoTab, registerBubblesScripts } from "./modules/bubblesRegistry.js";
import { createCardSnippetProvider } from "./modules/cardSnippetProvider.js";
import { injectMessageDisplayGateIntoTab } from "./modules/messageDisplayGateRegistry.js";
import { applyThunderbirdNativeThemePreference, validateThunderbirdThemeIds } from "./modules/tbThemeSwitcher.js";
import {
    fetchAndSendThreadConversation,
    handleThreadComposeAction,
    handleThreadDownloadAttachment,
    handleThreadMarkRead,
} from "./modules/threadConversation.js";

let _tmCardSnippetProvider = null;

function _ensureCardSnippetProvider(reason) {
    // CardSnippetProvider always runs; the EXP side checks the pref to decide if snippets are enabled.
    try {
        if (!_tmCardSnippetProvider) {
            _tmCardSnippetProvider = createCardSnippetProvider({
                getNeeds: async (opts) => {
                    if (!browser.tmMessageListCardView?.getCardSnippetNeeds) return [];
                    return await browser.tmMessageListCardView.getCardSnippetNeeds(opts || {});
                },
                provideSnippets: async (payload) => {
                    if (!browser.tmMessageListCardView?.provideCardSnippets) {
                        return { ok: false, error: "tmMessageListCardView.provideCardSnippets not available" };
                    }
                    return await browser.tmMessageListCardView.provideCardSnippets(payload);
                },
            });
        }
        try { _tmCardSnippetProvider.start(); } catch (_) {}
        console.log(`[TabMail Theme] CardSnippetProvider started (${reason})`);
    } catch (e) {
        console.log(`[TabMail Theme] CardSnippetProvider init failed: ${e}`);
    }
}

function _stopCardSnippetProvider(reason) {
    try {
        if (_tmCardSnippetProvider) {
            try { _tmCardSnippetProvider.stop(); } catch (_) {}
            console.log(`[TabMail Theme] CardSnippetProvider stopped (${reason})`);
        }
    } catch (_) {}
}

async function initTheme() {
    console.log("[TabMail Theme] ═══ initTheme() called ═══");
    const t0 = Date.now();

    // Card snippets are now tied to the card view row count pref (no startup SAFETY override needed).

    // IMPORTANT: Each step is isolated so a failure in one subsystem can't prevent
    // the experiments from initializing (otherwise hot reload can leave both sheets unregistered).

    // (0) Validate native theme IDs (diagnostic only)
    try {
        await validateThunderbirdThemeIds(SETTINGS);
    } catch (e) {
        console.log(`[TabMail Theme] validateThunderbirdThemeIds failed (continuing): ${e}`);
    }

    // (1) Preview gate – bring up as early as possible.
    try {
        if (browser.tmPreviewGate?.init) {
            console.log("[TabMail PreviewGate] → Calling browser.tmPreviewGate.init() (early)...");
            await browser.tmPreviewGate.init();
            console.log("[TabMail PreviewGate] ✓ tmPreviewGate initialised (early)");
        } else {
            console.warn("[TabMail PreviewGate] tmPreviewGate experiment NOT available – preview gating disabled.");
        }
    } catch (ePgInit) {
        console.log(`[TabMail PreviewGate] Failed to initialise tmPreviewGate (early): ${ePgInit}`);
    }

    try {
        const enabled = !!SETTINGS?.messageDisplayGate?.enabled;
        if (browser.tmPreviewGate?.setPreviewAutoGateEnabled) {
            await browser.tmPreviewGate.setPreviewAutoGateEnabled({
                enabled,
                reason: "initTheme:early",
            });
            console.log(`[TabMail PreviewGate] ✓ AutoGate enabled=${enabled} (early) after ${Date.now() - t0}ms`);
        } else {
            console.log("[TabMail PreviewGate] setPreviewAutoGateEnabled not available");
        }
    } catch (eAuto) {
        console.log(`[TabMail PreviewGate] Failed to setPreviewAutoGateEnabled (early): ${eAuto}`);
    }

    try {
        const forceGate = !!SETTINGS?.messageDisplayGate?.debugForcePreviewGated;
        if (forceGate && browser.tmPreviewGate?.setMessagePreviewGated) {
            console.log("[TabMail Theme] DEBUG: Forcing message preview gated (no reveal)");
            await browser.tmPreviewGate.setMessagePreviewGated({
                gated: true,
                reason: "debugForcePreviewGated:initTheme:early",
                cycleId: -1,
            });
        }
    } catch (eGate) {
        console.log(`[TabMail Theme] DEBUG: Failed to force preview gated (early): ${eGate}`);
    }

    // (2) Content scripts – not required for AGENT_SHEET registration, so don't block theme init.
    try {
        await registerBubblesScripts();
    } catch (e) {
        console.log(`[TabMail Theme] registerBubblesScripts failed (continuing): ${e}`);
    }

    // (3) Theme experiment – should always be attempted even if scripts failed.
    try {
        if (browser.tmTheme?.init) {
            console.log("[TabMail Theme] → Calling browser.tmTheme.init()...");
            await browser.tmTheme.init();
            console.log("[TabMail Theme] ✓ tmTheme initialised");
        } else {
            console.warn("[TabMail Theme] tmTheme experiment NOT available – CSS not injected.");
        }
    } catch (eThemeInit) {
        console.error("[TabMail Theme] tmTheme.init failed:", eThemeInit);
    }

    // (4a) Message list tag coloring experiment - DEPRECATED
    // Native Thunderbird tag colors are used instead. TM tag sorting still works correctly.
    // The tmMessageListTagColoring experiment has been removed from manifest.json.

    // (4b) Message list card view experiment (snippets + sender stripping)
    try {
        if (browser.tmMessageListCardView?.init) {
            console.log("[TabMail Theme] → Calling browser.tmMessageListCardView.init()...");
            await browser.tmMessageListCardView.init({});
            console.log("[TabMail Theme] ✓ tmMessageListCardView initialised");
            _ensureCardSnippetProvider("initTheme");
        } else {
            console.warn("[TabMail Theme] tmMessageListCardView experiment NOT available – card view enhancements disabled.");
        }
    } catch (eCardView) {
        console.error("[TabMail Theme] tmMessageListCardView.init failed:", eCardView);
    }

    // (4c) Message list table view experiment (sender stripping)
    try {
        if (browser.tmMessageListTableView?.init) {
            console.log("[TabMail Theme] → Calling browser.tmMessageListTableView.init()...");
            await browser.tmMessageListTableView.init();
            console.log("[TabMail Theme] ✓ tmMessageListTableView initialised");
        } else {
            console.warn("[TabMail Theme] tmMessageListTableView experiment NOT available – table view enhancements disabled.");
        }
    } catch (eTableView) {
        console.error("[TabMail Theme] tmMessageListTableView.init failed:", eTableView);
    }

    // (4d) Stale row filter experiment (unified inbox bug workaround)
    try {
        if (browser.staleRowFilter?.init) {
            console.log("[TabMail Theme] → Calling browser.staleRowFilter.init()...");
            await browser.staleRowFilter.init();
            console.log("[TabMail Theme] ✓ staleRowFilter initialised");
        } else {
            console.warn("[TabMail Theme] staleRowFilter experiment NOT available – stale row filtering disabled.");
        }
    } catch (eStaleRow) {
        console.error("[TabMail Theme] staleRowFilter.init failed:", eStaleRow);
    }

    console.log(`[TabMail Theme] initTheme() complete after ${Date.now() - t0}ms`);
}

// Initialise on startup and install/update
browser.runtime.onStartup.addListener(() => {
    console.log("[TabMail Theme] ▓▓▓ onStartup fired - browser starting up (likely after OS resume) ▓▓▓");
    initTheme();
});

browser.runtime.onInstalled.addListener((details) => {
    if (details.reason === "install" || details.reason === "update") {
        initTheme();
    }
});

// Immediate init for hot-reloads
initTheme();

// Track which tabs have scripts ready (exposed for other modules to check)
const scriptsReadyTabs = new Set();

// Proactive injection guard (hot-reload safe)
let _proactiveInjectorAttached = false;
const _lastProactiveInjectUrlByTabId = new Map(); // tabId -> { url, ts }

function getThemeScriptsInitDelayMs() {
    try {
        const ms = SETTINGS?.messageDisplayGate?.scriptsInitDelayMs;
        return typeof ms === "number" ? ms : 0;
    } catch (_) {
        return 0;
    }
}

async function injectThemeScriptsForMessageDisplayTab(tabId, contextLabel) {
    try {
        const gateEnabled = !!SETTINGS?.messageDisplayGate?.enabled;
        if (gateEnabled) {
            await injectMessageDisplayGateIntoTab(tabId);
        }

        // Inject all bubble scripts to ensure they're ready.
        const bubbleRes = await injectBubblesIntoTab(tabId);
        if (bubbleRes && bubbleRes.skipped && bubbleRes.reason === "privacyOptOut") {
            // Tell the gate not to wait for summary bubble (otherwise message pane stays hidden).
            try {
                await browser.tabs.sendMessage(tabId, { command: "tm-gate-summary-disabled" });
                console.log(`[TabMail Theme] Sent tm-gate-summary-disabled to tab ${tabId} (${contextLabel})`);
            } catch (eSend) {
                console.log(`[TabMail Theme] Failed to send tm-gate-summary-disabled to tab ${tabId}: ${eSend}`);
            }
        }

        // Give scripts a moment to initialize their listeners before other modules use them.
        // Avoid hardcoding: controlled via SETTINGS.messageDisplayGate.scriptsInitDelayMs
        const delayMs = getThemeScriptsInitDelayMs();
        if (delayMs > 0) {
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    } catch (e) {
        console.log(`[TabMail Theme] injectThemeScriptsForMessageDisplayTab failed (tab=${tabId} ctx=${contextLabel}): ${e}`);
    }
}

// Listen for requests to check if scripts are ready
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.command === "are-theme-scripts-ready") {
        sendResponse({ ready: scriptsReadyTabs.has(message.tabId) });
        return false;
    }
    
    // Handle theme preference changes from config/wizard
    if (message.command === "theme-preference-changed") {
        console.log(`[TabMail Theme] ═══════════════════════════════════════`);
        console.log(`[TabMail Theme] RECEIVED theme-preference-changed message!`);
        console.log(`[TabMail Theme] Theme value: "${message.theme}"`);
        console.log(`[TabMail Theme] ═══════════════════════════════════════`);
        // Apply Thunderbird's *native* theme (Default/Light/Dark) first, then refresh TabMail CSS.
        (async () => {
            try {
                try {
                    const res = await applyThunderbirdNativeThemePreference(message.theme, SETTINGS);
                    console.log("[TabMail Theme] Native theme apply result:", res);
                } catch (eNative) {
                    console.log(`[TabMail Theme] Native theme apply failed (continuing): ${eNative}`);
                }

                console.log("[TabMail Theme] Checking if browser.tmTheme.init is available...");
                if (browser.tmTheme?.init) {
                    console.log("[TabMail Theme] ✓ browser.tmTheme.init is available, calling it...");
                    // Re-init triggers AGENT_SHEET re-registration
                    await browser.tmTheme.init();
                    console.log("[TabMail Theme] ✓ tmTheme.init() completed after theme preference change");
                } else {
                    console.error("[TabMail Theme] ✗ browser.tmTheme.init is NOT available!");
                    console.log("[TabMail Theme] browser.tmTheme:", browser.tmTheme);
                }

                // Tag coloring experiment deprecated - native TB colors used instead

                try {
                    sendResponse({ ok: true });
                } catch (_) {}
            } catch (e) {
                console.error("[TabMail Theme] ✗ Failed to re-init tmTheme after theme change:", e);
                try {
                    sendResponse({ ok: false, error: String(e) });
                } catch (_) {}
            }
        })();
        return true; // async sendResponse
    }

    // Note: appearance-card-snippets-changed removed; snippets are now tied to card view row count pref.

    if (message.command === "tm-gate-diag") {
        try {
            const tabId = sender?.tab?.id;
            const url = String(message?.url || "");
            const cycleId = message?.cycleId;
            const hasRevealedClass = !!message?.hasRevealedClass;
            const readyState = String(message?.readyState || "");
            const frame = message?.frame || "unknown";
            console.log(
                `[TabMail GateDiag] tab=${tabId} frame=${frame} cycle=${cycleId} revealed=${hasRevealedClass} readyState=${readyState} url="${url}"`
            );
        } catch (e) {
            console.log(`[TabMail GateDiag] Failed to log diag: ${e}`);
        }
        return false;
    }
    if (message.command === "tm-preview-gate") {
        try {
            const gated = !!message?.gated;
            const cycleId = message?.cycleId;
            const why = String(message?.why || "");
            const url = String(message?.url || "");
            console.log(
                `[TabMail PreviewGate] gated=${gated} cycle=${cycleId} why=${why} senderTab=${sender?.tab?.id} url="${url}"`
            );

            // Debug: keep preview gated to validate masking works (ignore ungate requests).
            try {
                const forceGate = !!SETTINGS?.messageDisplayGate?.debugForcePreviewGated;
                if (forceGate && !gated) {
                    console.log("[TabMail PreviewGate] DEBUG: Ignoring ungate request (debugForcePreviewGated=true)");
                    return false;
                }
            } catch (_) {}

            try {
                if (browser.tmPreviewGate && browser.tmPreviewGate.setMessagePreviewGated) {
                    browser.tmPreviewGate
                        .setMessagePreviewGated({ gated, reason: `previewGate:${why}`, cycleId })
                        .catch((e) => {
                            console.log(`[TabMail PreviewGate] tmPreviewGate.setMessagePreviewGated failed: ${e}`);
                        });
                } else {
                    console.log("[TabMail PreviewGate] tmPreviewGate.setMessagePreviewGated not available");
                }
            } catch (e2) {
                console.log(`[TabMail PreviewGate] Failed to call tmPreviewGate.setMessagePreviewGated: ${e2}`);
            }
        } catch (e) {
            console.log(`[TabMail PreviewGate] Failed to handle tm-preview-gate: ${e}`);
        }
        return false;
    }

    if (message.command === "tm-thread-mark-read") {
        try {
            const messageId = message?.messageId;
            const reason = String(message?.reason || "");
            handleThreadMarkRead(messageId, { reason })
                .then((res) => sendResponse(res))
                .catch((e) => sendResponse({ ok: false, error: String(e) }));
            return true;
        } catch (e) {
            try {
                console.log(`[TabMail Theme] tm-thread-mark-read handler failed: ${e}`);
            } catch (_) {}
            sendResponse({ ok: false, error: String(e) });
            return false;
        }
    }

    if (message.command === "tm-thread-compose-action") {
        try {
            const action = message?.action;
            const messageId = message?.messageId;
            handleThreadComposeAction(action, messageId)
                .then((res) => sendResponse(res))
                .catch((e) => sendResponse({ ok: false, error: String(e) }));
            return true;
        } catch (e) {
            try {
                console.log(`[TabMail Theme] tm-thread-compose-action handler failed: ${e}`);
            } catch (_) {}
            sendResponse({ ok: false, error: String(e) });
            return false;
        }
    }

    if (message.command === "tm-thread-download-attachment") {
        try {
            const messageId = message?.messageId;
            const partName = message?.partName;
            const filename = message?.filename || "attachment";
            console.log(`[TabMail Theme] Thread bubble: download attachment requested messageId=${messageId} partName=${partName} filename=${filename}`);
            handleThreadDownloadAttachment(messageId, partName, filename)
                .then((res) => sendResponse(res))
                .catch((e) => sendResponse({ ok: false, error: String(e) }));
            return true;
        } catch (e) {
            try {
                console.log(`[TabMail Theme] tm-thread-download-attachment handler failed: ${e}`);
            } catch (_) {}
            sendResponse({ ok: false, error: String(e) });
            return false;
        }
    }

});

// Inject theme scripts when messages are displayed
// This ensures scripts are ready BEFORE other modules try to use them
// This is needed in TB 141+ since messageDisplayScripts is not available
browser.messageDisplay.onMessagesDisplayed.addListener(async (tab, messages) => {
    console.log(`[TabMail Theme] Messages displayed in tab ${tab.id}, injecting theme scripts`);

    await injectThemeScriptsForMessageDisplayTab(tab.id, "onMessagesDisplayed");
    
    // Mark this tab as ready and broadcast to other modules
    scriptsReadyTabs.add(tab.id);
    console.log(`[TabMail Theme] Theme scripts ready in tab ${tab.id}`);
    
    // Notify other modules that theme scripts are ready
    browser.runtime.sendMessage({
        command: "theme-scripts-ready",
        tabId: tab.id
    }).catch(() => {
        // No listeners yet, that's okay
    });
    
    // Fetch and send thread conversation data if enabled
    const threadConfig = SETTINGS.threadConversation || {};
    console.log(`[TabMail Theme] Thread conversation config:`, JSON.stringify(threadConfig));
    
    // TB 145 note: in 3-pane, `messages` sometimes arrives as an object (or empty array).
    // Normalize without adding a fallback routine.
    const normalizedMessages = Array.isArray(messages)
        ? messages
        : (Array.isArray(messages?.messages) ? messages.messages : []);

    try {
        const msgKeys = messages && typeof messages === "object" ? Object.keys(messages).slice(0, 10) : [];
        console.log(`[TabMail Theme] onMessagesDisplayed messages arg: isArray=${Array.isArray(messages)} len=${messages?.length} keys=${JSON.stringify(msgKeys)}`);
    } catch (_) {}

    if (threadConfig.enabled && normalizedMessages.length > 0) {
        // Use the first message (primary displayed message)
        const primaryMessage = normalizedMessages[0];
        console.log(`[TabMail Theme] Primary message id: ${primaryMessage?.id}, subject: "${primaryMessage?.subject}"`);

        // Non-inbox behavior: the agent summary pipeline intentionally skips non-inbox folders.
        // In that case, ensure the message preview is NOT stuck behind the gate.
        try {
            const folder = primaryMessage?.folder || null;
            const inInbox = isInboxFolder(folder);
            if (!inInbox) {
                console.log(`[TabMail Theme] Non-inbox message detected; ensuring preview is visible (folder="${folder?.name}" path="${folder?.path}")`);
                try {
                    await browser.tabs.sendMessage(tab.id, { command: "tm-gate-summary-disabled" });
                    console.log(`[TabMail Theme] Sent tm-gate-summary-disabled to tab ${tab.id} (non-inbox)`);
                } catch (eSend) {
                    console.log(`[TabMail Theme] Failed to send tm-gate-summary-disabled to tab ${tab.id} (non-inbox): ${eSend}`);
                }
                try {
                    if (browser.tmPreviewGate?.setMessagePreviewGated) {
                        await browser.tmPreviewGate.setMessagePreviewGated({
                            gated: false,
                            reason: "nonInbox:onMessagesDisplayed",
                            cycleId: -1,
                        });
                    }
                } catch (eUngate) {
                    console.log(`[TabMail Theme] Failed to ungate preview via tmPreviewGate (non-inbox): ${eUngate}`);
                }
            }
        } catch (eNonInbox) {
            console.log(`[TabMail Theme] Non-inbox ungate guard failed: ${eNonInbox}`);
        }
        
        if (primaryMessage && primaryMessage.id) {
            fetchAndSendThreadConversation(tab.id, primaryMessage.id);
        } else {
            console.log(`[TabMail Theme] No valid primary message ID`);
        }
    } else {
        console.log(`[TabMail Theme] Thread conversation disabled or no messages (enabled: ${threadConfig.enabled}, normalizedMessages: ${normalizedMessages.length})`);
    }
});

// Proactively inject scripts when a messageDisplay tab starts loading, so the "gate"
// can hide unwrapped content before the first paint in many cases.
// NOTE: We keep onMessagesDisplayed injection as a safety net.
function attachProactiveMessageDisplayInjector() {
    if (_proactiveInjectorAttached) return;
    _proactiveInjectorAttached = true;

    try {
        browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
            try {
                if (!SETTINGS?.messageDisplayGate?.enabled) return;
                if (!changeInfo || changeInfo.status !== "loading") return;
                if (!tab || tab.type !== "messageDisplay") return;

                const url = String(tab.url || "");
                const entry = _lastProactiveInjectUrlByTabId.get(tabId);
                if (url && entry && entry.url === url) {
                    return;
                }
                _lastProactiveInjectUrlByTabId.set(tabId, { url, ts: Date.now() });
                // Prune oldest entries when over size cap
                const maxEntries = SETTINGS?.memoryManagement?.proactiveInjectMaxEntries || 500;
                if (_lastProactiveInjectUrlByTabId.size > maxEntries) {
                    try {
                        const sorted = [..._lastProactiveInjectUrlByTabId.entries()]
                            .sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0));
                        const toRemove = _lastProactiveInjectUrlByTabId.size - maxEntries;
                        for (let i = 0; i < toRemove; i++) _lastProactiveInjectUrlByTabId.delete(sorted[i][0]);
                    } catch (_) {}
                }
                console.log(`[TabMail Theme] Proactive inject for messageDisplay tab ${tabId} url="${url}"`);

                await injectThemeScriptsForMessageDisplayTab(tabId, "tabs.onUpdated");
            } catch (e) {
                console.log(`[TabMail Theme] Proactive injector error (tab=${tabId}): ${e}`);
            }
        });
        console.log("[TabMail Theme] Proactive messageDisplay injector attached");
    } catch (e) {
        console.log(`[TabMail Theme] Failed to attach proactive injector: ${e}`);
    }
}

attachProactiveMessageDisplayInjector();

// Cleanup on suspend/reload
browser.runtime.onSuspend?.addListener(async () => {
    console.log("[TabMail Theme] Extension suspending");

    try { _stopCardSnippetProvider("onSuspend"); } catch (_) {}
    
    // Call experiment shutdown to clean up listeners and observers
    // This is a safety net in case Thunderbird doesn't call onShutdown during hot reload
    try {
        if (browser.tmTheme?.shutdown) {
            await browser.tmTheme.shutdown();
            console.log("[TabMail Theme] ✓ tmTheme.shutdown() called on suspend");
        }
        if (browser.tmPreviewGate?.shutdown) {
            await browser.tmPreviewGate.shutdown();
            console.log("[TabMail PreviewGate] ✓ tmPreviewGate.shutdown() called on suspend");
        }
        if (browser.staleRowFilter?.shutdown) {
            await browser.staleRowFilter.shutdown();
            console.log("[TabMail StaleRowFilter] ✓ staleRowFilter.shutdown() called on suspend");
        }
    } catch (e) {
        console.error("[TabMail Theme] experiment shutdown on suspend failed:", e);
    }
    
    // Reset content script registration flags so scripts can be re-registered after reload
    // (messageDisplayScripts registrations are automatically cleared by Thunderbird on suspend)
    try {
        const { resetBubblesRegistrationFlag } = await import("./modules/bubblesRegistry.js");
        resetBubblesRegistrationFlag();
    } catch (e) {
        console.error("[TabMail Theme] Error resetting bubbles registration flag:", e);
    }
    
    console.log("[TabMail Theme] Cleanup complete");

    try {
        _lastProactiveInjectUrlByTabId.clear();
    } catch (_) {}
});

