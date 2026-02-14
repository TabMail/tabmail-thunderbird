export const SETTINGS = {
    // Supabase Authentication Configuration
    supabaseUrl: "https://auth.tabmail.ai",
    supabaseAnonKey: "sb_publishable_1mtT87g-94P0yxFgM19Itw_P3ih9PUD",
    // Base domain for single-level subdomain routing (SSL certificate compatibility)
    backendBaseProd: "api", // for production (e.g., autocomplete-api.tabmail.ai)
    backendBaseDev: "dev", // for development (e.g., autocomplete-dev.tabmail.ai)
    backendDomain: "tabmail.ai", // root domain
    // Status page URL for server health issues
    statusPageUrl: "https://tabmail.ai/status.html",
    // Health check configuration
    healthCheck: {
        timeoutMs: 10000, // 10 seconds timeout for health checks
        endpoints: {
            api: "/health", // relative to backend URL
        },
    },
    // SSE timeout configuration (fetched from server via whoami)
    sseMaxTimeoutSec: 600, // Default: 10 minutes, updated from server
    sseToolListenTimeoutSec: 600, // Default: 10 minutes, updated from server
    // Authentication configuration
    authSignInTimeoutMs: 180000, // 3 minutes - after this, show "timeout" page (keeps window open for user awareness)
    authSignOutTimeoutMs: 30000, // 30 seconds - after this, show "timeout" page
    authAutoReauthEnabled: true, // Default: auto-reauth enabled (can be changed by user in popup)
    authTokenRefreshRetries: 3, // Number of retry attempts for token refresh before giving up
    // Consent gating (post-signin) configuration
    // After sign-in, TabMail requires an explicit 18+ + Terms/Privacy consent before features are enabled.
    authConsentTimeoutMs: 300000, // 5 minutes max to complete consent before we give up
    authConsentPollIntervalMs: 2000, // How often to re-check consent status
    consentPageUrl: "https://tabmail.ai/consent.html",
    // Auth popup window dimensions (fixed, no scrolling)
    authWindow: {
        defaultWidth: 500,
        defaultHeight: 860,
    },
    // Welcome wizard popup window dimensions
    welcomeWindow: {
        defaultWidth: 780,
        defaultHeight: 750,
    },
    // Autocomplete and explicitly urgent requests can bypass this limit.
    maxAgentWorkers: 32,
    // Cache cleanup debounce delay (ms) - triggered after message processing events
    // Replaces the old periodic scan cleanup; runs after a batch of messages is processed
    cacheCleanupDebounceMs: 10000, // 10 seconds
    replyTTLSeconds: 604800, // 1 week. How long a reply cache entry should live without being touched.
    actionTTLSeconds: 604800, // 1 week. How long an action cache entry should live without being touched.
    summaryTTLSeconds: 604800, // 1 week. How long a summary cache entry should live without being touched.
    getFullTTLSeconds: 1800, // 30 minutes. How long a getFull cache entry should live in memory.
    // Agent maintenance cadence
    getFullCleanupIntervalMinutes: 15, // Periodic cleanup of in-memory getFull cache (minutes)
    // Safety cap: bound in-memory getFull cache size to avoid memory explosion on very large mailboxes.
    getFullMaxCacheEntries: 1200,
    // safeGetFull diagnostics (bounded to avoid log spam)
    getFullDiag: {
        ftsMissLogMax: 40,
        ftsMissLogMinIntervalMs: 1000,
        ftsEmptyLogMax: 40,
        ftsEmptyLogMinIntervalMs: 1000,
        ftsHitLogMax: 40,
        ftsHitLogMinIntervalMs: 1000,
        ftsStatsLogMax: 5,
        ftsStatsLogMinIntervalMs: 5000,
        ftsNoResponseLogMax: 20,
        ftsNoResponseLogMinIntervalMs: 1000,
    },
    // Card snippet cache should be larger than getFull cache but still bounded.
    cardSnippetMaxCacheEntries: 2400,
    // Persistent IDB snippet cache settings (tiered: memory → IDB → fetch)
    // Note: Empty snippets are NEVER cached to avoid persisting race condition failures
    snippetCacheMaxMemoryEntries: 600, // L1 memory cache size
    snippetCacheMaxIdbEntries: 50000, // L2 IDB cache size (can be very large)
    snippetCacheMemoryTtlMs: 5 * 60 * 1000, // 5 minutes in memory
    snippetCacheIdbTtlMs: 90 * 24 * 60 * 60 * 1000, // 90 days on disk
    // FTS engine diagnostics (bounded to avoid log spam)
    ftsEngineDiag: {
        missLogMax: 40,
        missLogMinIntervalMs: 1000,
    },
    // FTS maintenance log detail capture (TB 145 / MV3)
    // This controls how many per-message "correction" entries we persist for each maintenance run
    // (used to diagnose incremental indexer gaps).
    ftsMaintenanceLog: {
        maxCorrectionEntriesPerRun: 200,
    },
    // FTS cleanup chunking configuration (TB 145 / MV3)
    // Prevents native FTS disconnection by keeping RPC traffic flowing during large maintenance ops.
    ftsCleanup: {
        queryChunkSize: 500,        // Entries per queryByDateRange call (pagination)
        validationBatchSize: 50,    // Entries between native keepalive pings
        removeBatchSize: 100,       // Entries per removeBatch call
        batchDelayMs: 100,          // Delay between validation batches (yield)
        entryDelayMs: 50,           // Per-entry delay during validation (reduced from 200ms)
    },
    logTruncateLength: 100,
    threadHistoryApiConcurrency: 1, // Max concurrent API calls when building a thread to avoid UI lag.
    useSingleMessageHistory: true, // For performance, treat the body of the last email as the full thread history.
    maxAgeDays: 60, // How many days back to look for emails during a full index.
    verboseLogging: true, // Set to true to enable info/warn logs.
    debugLogging: false, // Set to true to enable granular debug/trace logs (very noisy).
    // Thread tooltip master toggle (default disabled). When enabled, tooltips
    // will show cached summary/todo on hover; may not function after suspend.
    threadTooltipEnabled: false,
    // Force unthreaded view for simpler email management (no thread collapsing).
    forceUnthreadedView: false,
    // Theme experiment toggle: when enabled, injects CSS to adjust Card View text
    themeEnabled: true,
    // Optional: run heavy theme diagnose logs (may cause errors in some TB builds)
    enableThemeDiagnose: true,
    // Message display gating (TB 145 / MV3): hide message body until bubbles are ready.
    // Also used for proactive injection to reduce flash of unwrapped content.
    messageDisplayGate: {
        enabled: true,
        // Small delay to allow content scripts to attach runtime listeners before other modules send messages.
        // (Avoids "Receiving end does not exist" errors.)
        scriptsInitDelayMs: 0,
        // Debug: force the 3-pane message preview to stay hidden (do NOT reveal).
        // Use this to verify masking works before tuning reveal timing.
        debugForcePreviewGated: false,
    },
    // Summary banner UX timing knobs (TB 145 / MV3)
    summaryBanner: {
        // Retry delays for sending banner messages if the content script isn't ready yet.
        // Only retries on "Receiving end does not exist" errors.
        // Keep this bounded to avoid masking real issues.
        sendRetryDelaysMs: [0, 10, 50, 100, 200],
        // How long to wait for the summary bubble content script to signal ready before proceeding.
        // This prevents "Receiving end does not exist" race conditions.
        bubbleReadyTimeoutMs: 200,
        // Message shown when user is not logged in
        notLoggedInMessage: "Not logged in, please signin from the toolbar menu on the top-right",
    },
    // Summary bubble font sizing (reads from TB prefs, this is the fallback)
    summaryBubble: {
        // Obvious fallback - if you see 50px fonts, wiring is broken!
        defaultBaseFontSizePx: 50,
    },
    // Thread tooltip behavior: when true, only use cache for summaries to avoid heavy LLM calls.
    threadTooltipCacheOnly: true,
    // FSM tool behavior
    // How long to wait for FSM tools (compose/reply/forward, etc.) to complete
    // before timing out and cancelling the workflow (milliseconds)
    // Use -1 for no timeout.
    fsmToolTimeoutMs: -1,
    // Debug mode - default value, will be overridden by storage on init
    // When enabled: uses development backend URL and saves chat logs
    // When disabled: uses production backend URL and does not save chat logs
    debugMode: false,
    // Relative folder (inside the default Downloads directory) where chat logs
    // should be written. If missing, utils.js falls back to "logs".
    logFolder: "logs",
    // UI: Emoji used to identify TabMail entries and toolbar badge.
    // Use a Tab-like symbol; can be changed in one place for theming/branding.
    addonEmoji: "⇥",
    // Cross-module event names (runtime messages)
    events: {
        userActionPromptUpdated: "user-action-prompt-updated",
        userKBPromptUpdated: "user-kb-prompt-updated",
    },
    // Patch application leniency: always on (simplifies debug and improves robustness)
    // Action generation: number of parallel LLM calls to make and pick the mode result
    actionGenerationParallelCalls: 1,
    // Mail sync preferences
    mailSync: {
        defaultCheckIntervalMinutes: 5, // Default periodic check interval for IMAP accounts
        enableAllFoldersCheck: true,     // Enable checking all IMAP folders (Archive, Sent, etc.)
        verticalLayoutOnInstall: true,  // Apply vertical layout nudge on first install
    },
    // Appearance preferences (Thunderbird preference names)
    appearance: {
        prefs: {
            listView: "mail.threadpane.listview",        // 0 = card view, 1 = table view
            cardRowCount: "mail.threadpane.cardsview.rowcount", // 3 = three-row card view
            density: "mail.uidensity",                   // 0 = compact, 1 = default, 2 = relaxed
            sortOrder: "mailnews.default_sort_order", // 2 = new message on top, 1 = new message bottom
            tagSortEnabled: "extensions.tabmail.tagSortEnabled", // 1 = enabled (default), 0 = disabled
        },
        // Thunderbird theme control:
        // - The *actual* active theme is controlled by the enabled Theme add-on.
        // - `extensions.activeThemeID` reflects which theme add-on is active.
        // - We use `management.setEnabled` to switch between default/light/dark themes.
        // - We still read/clear `ui.systemUsesDarkTheme` for diagnostics and to avoid stale overrides.
        thunderbirdThemes: {
            prefs: {
                activeThemeId: "extensions.activeThemeID",
                systemUsesDarkTheme: "ui.systemUsesDarkTheme",
            },
            // Built-in theme IDs (stable IDs, non-localized).
            // NOTE: Verified on TB 145: "Light"/"Dark" are thunderbird-compact-* theme IDs.
            ids: {
                default: "default-theme@mozilla.org",
                light: "thunderbird-compact-light@mozilla.org",
                dark: "thunderbird-compact-dark@mozilla.org",
            },
        },
        defaults: {
            listView: 0,         // Default to card view (0 = card, 1 = table)
            cardRowCount: 3,     // Default to three-row card view
            density: 0,          // Default to compact density (0 = compact)
            sortOrder: 2,        // Default to new message on top (2 = descending)
            tagSortEnabled: 1,   // Default to enabled (1 = enabled, 0 = disabled)
        },
    },

    // TabMail action-tag behavior (Inbox-only).
    // - per-message action is cached as idb key: "action:<uniqueKey>"
    // - per-thread tag aggregate (Inbox thread) is cached as idb key: "threadTags:<threadKey>"
    // ThreadKey format is defined in agent/modules/tagHelper.js.
    actionTagging: {
        // Config page toggle (Appearance): when enabled, tag all Inbox messages by the thread's max-priority action.
        tagByThreadDefault: false,
        // Priority order: higher wins when grouping is enabled.
        // IMPORTANT: keep this in config (not hardcoded in logic) so it’s easy to tune/debug.
        actionPriority: {
            delete: 0,
            archive: 1,
            none: 2,
            reply: 3,
        },
        // Thread enumeration settings (via threadMessages experiment, Inbox folder DB thread only).
        threadEnumeration: {
            maxThreadMessages: 50,
        },
        // Retagging settings used when message grouping is toggled.
        retagOnToggle: {
            // How many messages we will inspect per Inbox when rebuilding thread aggregates.
            // This should be high enough to cover the user’s “active” inbox without being unbounded.
            maxMessagesPerInbox: 2000,
            // Safety cap on how many threads we will attempt to process per Inbox in one toggle pass.
            maxThreadsPerInbox: 2000,
            // Concurrency for messages.update() operations during retagging.
            updateConcurrency: 8,
        },

        // Loop guard: when TabMail updates tags, ignore those `messages.onUpdated` events
        // for a short window to avoid self-triggered recompute loops.
        // Kept in config (not hardcoded in code) for easier debugging/tuning.
        selfTagUpdateIgnoreMs: 3000,

        // Tag update retry settings: when browser.messages.update fails or verification fails,
        // retry up to this many times with a delay between attempts.
        tagUpdateRetries: 2,
        tagUpdateRetryDelayMs: 200,

        // Debug: cross-folder tag probe for Gmail/IMAP label semantics.
        // When enabled, TabMail will log the state of other folder copies (All Mail/Archives/Trash)
        // for the same headerMessageId when we observe tag changes or apply effective tags.
        debugCrossFolderProbe: {
            enabled: false,
            // Which folder specialUse values to include in the probe (lowercased compare).
            specialUseAllowList: ["inbox", "all", "archives", "trash"],
            // Hard cap on folders included to avoid expensive wide queries.
            maxFolders: 32,
            // Hard cap on log entries per probe.
            maxMatchesToLog: 20,
        },

        // When enabled, TabMail will also apply the same tm_* tags to special-use folder
        // copies (e.g., Gmail "All Mail") *as long as that message still exists in Inbox*.
        // This makes tags visually consistent when viewing All Mail/Archive while the
        // message is still in Inbox.
        crossFolderTagSync: {
            enabled: true,
            specialUseAllowList: ["all", "archives"],
            maxFolders: 32,
            maxMatchesToUpdate: 200,
        },
        // Debug: when enabled, emit extra logs that help diagnose tag “ping-pong”
        // between per-message tagging and thread-level effective tagging.
        debugTagRace: {
            enabled: false,
            // How many stack lines to include in debug logs (only used when debugTagRace.enabled=true).
            stackMaxLines: 6,
        },
    },
    // After-send indexing via header Message-ID
    afterSendIndex: {
        enabled: true,
        maxWaitMs: 15000,
        initialDelayMs: 150,
        maxDelayMs: 1000,
    },
    // Proactive reachout / notification settings
    notifications: {
        proactiveEnabled: false,             // Default disabled — opt-in feature
        newReminderWindowDays: 7,            // Only reach out for new reminders with due dates within this many days
        dueReminderAdvanceMinutes: 30,       // Reach out this many minutes before a reminder's due time
        graceMinutes: 5,                     // Grace window added to advance minutes when batching upcoming reminders
        debounceMs: 1000,                    // Debounce after reminder change detected
    },
    // Chat session settings
    chat: {
        idleThresholdMinutes: 10,        // Minutes of inactivity before inserting a session_break (grey boundary)
    },
    // Reminder (MOTD) generation settings
    reminderGeneration: {
        enabled: true,                // Enable/disable reminder generation feature
        showInChat: true,            // Show random reminder when opening chat
        maxRemindersToShow: 3,       // Number of reminders to show in chat greeting (default: 3)
        timeoutMs: 60000,            // LLM request timeout (60 seconds)
        debounceMs: 2000,            // Debounce delay for queued reminder generation (2 seconds)
    },
    // Inbox management settings
    inboxManagement: {
        // Maximum recent emails to consider for processing, context, and coverage.
        // Inboxes larger than this are treated as "large" (only recent messages processed).
        // Also used by tagSort experiment for maxRowsToCheck.
        maxRecentEmails: 100,
        archiveAgeDays: 14,          // Age threshold for archive prompt (2 weeks)
    },
    // messages.onMoved behavior (TB 145 / MV3)
    onMoved: {
        // Gmail/IMAP moves can behave like copy+delete or keyword reassert during sync.
        // We strip TabMail action tags on BOTH ids (before+after) and verify/retry.
        tagClearOnLeaveInbox: {
            maxAttempts: 3,
            baseDelayMs: 250,
            // For Gmail label semantics, a message can exist in multiple IMAP folders (e.g. All Mail + Trash).
            // Clear TabMail action tags across special-use folder copies by headerMessageId.
            clearByHeaderMessageId: {
                enabled: true,
                // Which folder specialUse values to include in the query scope.
                // Note: values are compared lowercased.
                specialUseAllowList: ["inbox", "trash", "all", "archives"],
                // Hard cap on folders included to avoid expensive wide queries.
                maxFolders: 32,
            },
        },
        // Watchdog to enforce invariant: messages outside Inbox should not have TabMail action tags.
        // This handles IMAP sync reassert (e.g., Gmail) by stripping tags again when TB reports updates.
        tagReassertWatchdog: {
            enabled: true,
            // Minimum time between handling the same message id to avoid loops/spam.
            minHandleIntervalMs: 2000,
            // When we strip tags ourselves, ignore onUpdated events for a short window.
            selfUpdateIgnoreMs: 3000,
        },
        // Bounded reassert guard: some IMAP servers (notably Gmail) can reassert keywords
        // without reliably triggering messages.onUpdated. For messages that just left Inbox,
        // we schedule a small number of delayed checks and re-strip if needed.
        //
        // This is NOT global polling: it only runs for recently moved messages and ends after the delay list.
        tagReassertGuard: {
            enabled: true,
            // Delay schedule (ms) after leaving Inbox to check for tag reappearance.
            delaysMs: [8000, 30000, 120000],
        },
        // Safety-net sweep: periodic low-frequency scan of non-inbox folders for stray TabMail action tags.
        // Catches anything the bounded guard missed (e.g., very late IMAP reasserts).
        staleTagSweep: {
            enabled: true,
            // How often to run the sweep (minutes). Keep high to avoid performance impact.
            intervalMinutes: 15,
            // Only check messages from the last N days (0 = no limit).
            // Older messages are unlikely to have fresh stale tags.
            maxAgeDays: 30,
            // Which folder specialUse values to scan.
            // NOTE: "all" (Gmail All Mail) is included, but we check if the message also exists in Inbox
            // before stripping — if it does, we skip (it's the All Mail view of an Inbox message).
            specialUseAllowList: ["trash", "all", "archives"],
            // Max folders to query per sweep.
            maxFolders: 32,
            // Max messages to strip per sweep (avoid blocking if huge backlog).
            maxMessagesPerSweep: 100,
        },
    },

    // Small in-app notice popups
    userNotice: {
        cannotTagSelf: {
            width: 420,
            height: 130,
        },
    },
    
    // Thread conversation view (Gmail-like) configuration
    // Shows related messages as collapsible bubbles below the current message
    threadConversation: {
        enabled: true,                  // Enable thread conversation view in message preview
        // Source for "related messages":
        // - folderThread: uses per-folder thread db (fast, but Inbox-only for Gmail label semantics)
        // - glodaConversation: uses Gloda global DB conversation (cross-folder: Inbox/Sent/Archive/All Mail)
        source: "glodaConversation",
        // NOTE: The UI can be expensive if a thread is very large; cap the number of messages.
        // This is a strict cap (no heuristic fallbacks); if you want true "no cap", set high.
        maxThreadMessages: 50,          // Maximum number of thread messages to fetch/display
        maxConversationMessages: 50,    // Maximum number of Gloda conversation messages to fetch/display
        excludeCurrentMessage: true,    // Avoid duplicating the currently displayed message as a bubble
        includeBody: true,              // Include message body content in bubbles
        // If null/undefined, do not truncate body (expanded view wants full message).
        bodyMaxLength: null,
        // How many lines to show in collapsed preview (content script uses CSS line-clamp).
        previewLines: 2,
        // Max number of thread messages to include in debug preview logs.
        previewLogSampleMax: 5,
        // Max number of dedupe collisions to include in debug log payloads.
        // Keeps logs readable while still showing representative duplicates.
        dedupeLogSampleMax: 5,
        // Hide messages that are "later" than the currently displayed message.
        // Gloda conversations can include the whole thread; showing future replies is confusing.
        excludeFutureMessages: true,
        // Max number of "future" dropped messages to include in debug logs.
        futureDropLogSampleMax: 5,
    },

    // ----------------------------------------------------------
    // Persistent background queues (TB 145 / MV3)
    // ----------------------------------------------------------
    // NOTE:
    // - These queues are meant to survive offline/disruptions by persisting pending work to storage.local.
    // - Timers in MV3 can be suspended; we still use timers while awake, and we always restore on startup.
    agentQueues: {
        // Event-driven email pipeline (summary → action → reply) queue.
        // Used to ensure messages are retried when network/backend is unavailable.
        processMessage: {
            // How often the queue watchdog tries to drain pending work while the worker is awake.
            watchIntervalMs: 10000,
            // Delay used when we want to “kick” processing soon after enqueue (debounced).
            kickDelayMs: 0,
            // Debounce persistence writes. 0 = persist immediately on enqueue (idempotent, no storm risk).
            persistDebounceMs: 0,
            // How many queued messages to attempt per drain cycle.
            // High value to process backlog quickly.
            batchSize: 100,
            // If a processing attempt fails (e.g., backend/network), wait this long before retrying.
            retryDelayMs: 10000,
            // Max attempts to resolve a message (headerIDToWeID / messages.get) before dropping.
            // Transient IMAP/Gmail sync can cause temporary resolve failures; retry a few times.
            maxResolveAttempts: 5,
        },
        // FTS incremental indexer retry policy.
        // This does NOT change the normal batchDelay used after new events; it only affects retry cadence on errors.
        ftsIncremental: {
            retryDelayMs: 10000,
            // Max consecutive processing cycles with no progress (no successful dequeues)
            // before dropping stuck entries. With 10s watchdog, 20 cycles = ~200 seconds.
            // If anything gets dequeued, the counter resets.
            maxConsecutiveNoProgress: 20,
        },
        // Proactive inbox scan - DISABLED.
        // Replaced by tagSort row coloring pass coverage which detects untagged
        // messages and enqueues them for processing automatically.
        // Set to 0 to disable periodic scanning.
        inboxScan: {
            intervalMs: 0, // Disabled - coverage handled by tagSort
        },
    },
    // Event logger configuration for debugging race conditions
    // Captures ALL message events immediately for later inspection
    eventLogger: {
        // Enable/disable event logging (default: true)
        enabled: true,
        // Debounce persistence to avoid storage thrashing (ms)
        persistDebounceMs: 1000,
        // Max in-memory events between persist cycles (prevents burst-induced bloat)
        maxSessionBufferSize: 10000,
    },
    // ----------------------------------------------------------
    // Memory management: pruning / eviction settings for in-memory Maps and caches.
    // These are conservative defaults — entries are tiny, so caps are generous.
    // ----------------------------------------------------------
    memoryManagement: {
        // tagHelper: _selfTagUpdateIgnoreUntilByMsgId prune interval (ms)
        selfTagIgnorePruneIntervalMs: 60_000,
        // onMoved: watchdog maps prune interval and stale threshold (ms)
        watchdogPruneIntervalMs: 5 * 60_000,
        watchdogStaleMs: 5 * 60_000,
        // headerIndex: max entries before LRU eviction
        headerIndexMaxSize: 10000,
        // nativeEngine: RPC timeout (ms) for stuck native helper calls
        nativeRpcTimeoutMs: 60_000,
        // mentionAutocomplete: max emails to keep in memory cache
        emailCacheMaxSize: 2000,
        // theme/background: max entries in proactive inject URL tracking map
        proactiveInjectMaxEntries: 500,
    },
};

// Helper function to get the current backend URL based on debugMode
// Always reads from storage to ensure correct value across all contexts (MV3)
// Unified Backend architecture with path-based routing:
//   - Production: https://api.tabmail.ai
//   - Dev: https://dev.tabmail.ai
// Endpoint type is no longer used for subdomain routing
export async function getBackendUrl(endpointType = null) {
    try {
        const stored = await browser.storage.local.get({ debugMode: false });
        SETTINGS.debugMode = stored.debugMode; // Keep local state in sync
        
        const baseEnv = stored.debugMode ? SETTINGS.backendBaseDev : SETTINGS.backendBaseProd;
        const domain = SETTINGS.backendDomain;
        
        // Unified Backend uses single base URL (not subdomain per endpoint)
        const baseUrl = `https://${baseEnv}.${domain}`;
        
        // Log for debugging (endpoint type is now ignored, kept for API compatibility)
        if (SETTINGS.debugLogging) {
            if (endpointType) {
                console.log(`[Config] getBackendUrl: endpoint=${endpointType} (ignored), url=${baseUrl}`);
            } else {
                console.log(`[Config] getBackendUrl: no endpoint type, returning base ${baseUrl}`);
            }
        }
        
        return baseUrl;
    } catch (e) {
        if (SETTINGS.debugLogging) console.warn("[Config] Failed to load debugMode from storage, using default:", e);
        const baseEnv = SETTINGS.backendBaseProd;
        const domain = SETTINGS.backendDomain;
        return `https://${baseEnv}.${domain}`;
    }
}

// Helper function to get the template marketplace worker URL based on debugMode
// Template worker is a separate service for template sharing/marketplace
//   - Production: https://templates.tabmail.ai
//   - Dev: https://templates-dev.tabmail.ai
export async function getTemplateWorkerUrl() {
    try {
        const stored = await browser.storage.local.get({ debugMode: false });
        SETTINGS.debugMode = stored.debugMode; // Keep local state in sync
        
        const domain = SETTINGS.backendDomain;
        const subdomain = stored.debugMode ? "templates-dev" : "templates";
        const templateUrl = `https://${subdomain}.${domain}`;
        
        if (SETTINGS.debugLogging) console.log(`[Config] getTemplateWorkerUrl: url=${templateUrl}`);
        return templateUrl;
    } catch (e) {
        if (SETTINGS.debugLogging) console.warn("[Config] Failed to load debugMode from storage, using default:", e);
        const domain = SETTINGS.backendDomain;
        return `https://templates.${domain}`;
    }
}

// Centralized storage management for debugMode
// This listener keeps SETTINGS.debugMode in sync with storage changes from any source
let _storageChangeListener = null;

export function cleanupConfigListeners() {
    if (_storageChangeListener) {
        try {
            browser.storage.onChanged.removeListener(_storageChangeListener);
            _storageChangeListener = null;
            if (SETTINGS.debugLogging) console.log("[TMDBG Config] Storage change listener cleaned up");
        } catch (e) {
            if (SETTINGS.debugLogging) console.error(`[TMDBG Config] Failed to remove storage change listener: ${e}`);
        }
    }
}

// Initialize listener with cleanup tracking
if (!_storageChangeListener) {
    _storageChangeListener = async (changes, area) => {
        if (area === "local" && changes.debugMode) {
            SETTINGS.debugMode = changes.debugMode.newValue;
            const baseEnv = SETTINGS.debugMode ? SETTINGS.backendBaseDev : SETTINGS.backendBaseProd;
            if (SETTINGS.debugLogging) console.log(`[TMDBG Config] debugMode updated to: ${SETTINGS.debugMode}, baseEnv: ${baseEnv}`);
        }
    };
    browser.storage.onChanged.addListener(_storageChangeListener);
}

// Initialize debugMode from storage synchronously on first access
// This avoids async module loading issues while ensuring we get the current value
(async () => {
    try {
        const stored = await browser.storage.local.get({ debugMode: false });
        SETTINGS.debugMode = stored.debugMode;
        const baseEnv = SETTINGS.debugMode ? SETTINGS.backendBaseDev : SETTINGS.backendBaseProd;
        if (SETTINGS.debugLogging) console.log(`[TMDBG Config] debugMode initialized: ${SETTINGS.debugMode}, baseEnv: ${baseEnv}`);
    } catch (e) {
        if (SETTINGS.debugLogging) console.warn("[TMDBG Config] Failed to load debugMode from storage, using default:", e);
    }
})(); 