// chatConfig.js – Chat-only defaults and configuration (TB 140, MV3)

export const CHAT_SETTINGS = {
  // Chat window popup dimensions (shared across all chat window openers)
  chatWindow: {
    defaultWidth: 600,
    defaultHeight: 800,
  },
  // Streaming behavior for assistant bubbles in chat UI
  // streamMode: 'block' | 'line' | 'char'
  streamMode: 'block',
  // Delay (ms) per stream unit (line when streamMode='line', char when 'char')
  streamDelayMs: 100,
  // --- Tool bubble visuals/timing ---
  // Time (ms) to keep temporary tool bubbles visible after final reply arrives
  toolBubbleHoldMs: 600,
  // Fade-out duration (ms) for tool bubbles before removal
  toolBubbleFadeMs: 250,
  // --- Search tool configuration (chat-only) ---
  // Default number of emails to return for search results when not specified.
  searchDefaultLimit: 5,
  // Hard cap to protect performance.
  searchMaxLimit: 50,
  // Default lookback window in days if no explicit date range provided.
  searchDefaultDaysBack: 365,
  // Use Gloda experiment for search if available.
  useGlodaSearch: true,
  // Apply date filters via Gloda's query.date unless explicitly disabled.
  glodaIgnoreDate: false,
  // --- FTS (Full Text Search) A/B Testing Configuration ---
  // Use FTS WASM SQLite backend instead of Gloda for search (A/B test flag)
  useFtsSearch: true,
  // FTS indexer tunables
  ftsBatchSize: 250,                    // messages per index batch
  ftsMaxInflight: 1,                    // concurrency limit
  ftsSleepBetweenBatchMs: 250,         // yield between batches
  ftsLongYieldMs: 1000,                // yield between folders
  ftsMaxBatchBytes: 8388608,           // 8MB soft limit per batch
  // Initial FTS scan settings
  ftsInitialScanEnabled: true,         // enable initial scan on install
  ftsInitialScanRetryDelayMs: 300000,  // retry delay after error (5 minutes)
  // Incremental indexing settings (ON BY DEFAULT)
  ftsIncrementalEnabled: true,         // enable real-time indexing of new/moved messages
  ftsIncrementalBatchDelay: 1000,      // delay before processing batched incremental updates (1s)
  ftsIncrementalBatchSize: 50,         // max messages per incremental batch
  // Periodic maintenance settings 
  ftsMaintenanceEnabled: true,         // enable periodic maintenance scans
  ftsMaintenanceHourlyEnabled: true,   // hourly scan of last 1 day messages
  ftsMaintenanceDailyEnabled: true,    // daily scan of last 3 days messages  
  ftsMaintenanceWeeklyEnabled: true,   // weekly scan of last 3 weeks messages
  ftsMaintenanceMonthlyEnabled: false, // monthly scan of last 3 months messages (disabled by default)
  // Summary retrieval behavior for search results:
  //  - 'cache_only': search displays cached summaries only (no generation). Missing entries show a hint.
  //  - 'generate' : search will generate summaries on-demand (existing behavior).
  searchSummaryMode: 'cache_only',
  // Contacts: soft timeout (ms) for address book lookups in chat tools
  contactsQueryTimeoutMs: 100,
  // Contacts: normalize recipients by filling names from address book
  normalizeRecipientsFromContacts: true,
  // Contacts: default/max result limits for contacts_search tool
  contactsDefaultLimit: 25,
  contactsMaxLimit: 100,
  // --- Pagination (chat tools) ---
  // Inbox page size (items per page) for inbox_read tool
  inboxPageSizeDefault: 100,
  inboxPageSizeMax: 50,
  // Search page size (items per page) for email_search tool
  searchPageSizeDefault: 20,
  searchPageSizeMax: 500,
  // Calendar page size (items per page) for calendar_search tool
  calendarPageSizeDefault: 100,
  calendarPageSizeMax: 100,
  // --- Calendar helpers (chat tools) ---
  // Milliseconds in a day for date arithmetic
  msPerDay: 86400000,
  // Tolerance when matching an event by start time (ms)
  calendarEntryMatchToleranceMs: 60000,
  // Midday hour used for computing stable date headers (avoid DST edge cases)
  middayHourForDateHeader: 12,
  // Logging preview lengths for calendar search (avoid hardcoded values)
  calendarQueryLogPreviewChars: 120,
  calendarQueryLogTermsPreviewCount: 5,
  // --- Calendar creation tool ---
  // Default duration for new events when end time not provided (minutes)
  createEventDefaultDurationMinutes: 30,
  // For email_search: number of pages to prefetch in one backend query
  // This avoids needing offset support and lets repeated calls with the same
  // arguments advance pages locally without re-querying Gloda.
  searchPrefetchPagesDefault: 100,
  // Safety cap on total prefetched results for a single search session
  searchPrefetchMaxResults: 10000,
  // --- Hotkeys ---
  // Enable opening chat via the tabOverride experiment's hotkey
  openChatHotkeyEnabled: true,
  // --- Scrolling behavior (chat window) ---
  // Consider we are at bottom if remaining scrollable space <= this threshold (in em units, scales with font size)
  // 2em ≈ 2 lines of text - feels natural for "at the bottom" detection
  stickToBottomThresholdEm: 2,
  // Frames to scroll when appending new bubbles
  scrollFramesOnAppend: 3,
  // Frames to scroll during bubble content mutation (streaming)
  scrollFramesOnMutation: 2,
  // Backup scroll delays (ms) to catch layout shifts after initial scroll
  scrollBackupDelays: [0, 50, 150, 300],
  // --- Tool collapsing behavior ---
  // Enable collapsible tool call displays (older tool calls auto-collapse)
  toolCollapseEnabled: true,
  // Minimum number of tool bubbles before auto-collapsing older ones
  toolCollapseMinCount: 2,
  // Animation duration for collapse/expand transitions (ms)
  toolCollapseAnimationMs: 200,
  // --- LLM retry behavior ---
  // Maximum retries when LLM returns empty response (typically indicates an error)
  llmEmptyResponseMaxRetries: 5,
};


