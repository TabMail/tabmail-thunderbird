/**
 * Event Logger Module
 * 
 * Persistent logging of ALL message events for debugging race conditions
 * and queue-dropping issues.
 * 
 * Purpose: Capture raw event firings BEFORE any processing, so we can later
 * inspect whether events were fired but dropped vs never fired at all.
 * 
 * Storage: Uses browser.storage.local with a ring buffer to avoid unbounded growth.
 * 
 * NOTE: Only enabled when debugMode is ON to avoid wasting storage for regular users.
 */

import { SETTINGS } from "./config.js";

const EVENT_LOG_STORAGE_KEY = "debug_event_log";
const MAX_EVENT_LOG_ENTRIES = 500000; // Ring buffer size (500k max)

let _sessionBuffer = []; // In-memory buffer for NEW events this session only (not full history)
let _persistTimer = null;
let _inited = false;
let _debugMode = false; // Cached debug mode state

// Configuration for event logging
function _cfg() {
    return SETTINGS?.eventLogger || {};
}

function _isEnabled() {
    // Only enabled when debugMode is ON (to avoid wasting storage for regular users)
    // Can also be explicitly disabled via config even in debug mode
    return _debugMode && _cfg().enabled !== false;
}

function _persistDebounceMs() {
    // Debounce persistence to avoid storage thrashing
    // Default 1000ms (1 second) - we want fast logging but not on every event
    const v = _cfg().persistDebounceMs;
    return typeof v === "number" && v >= 0 ? v : 1000;
}

// Storage change listener reference for cleanup
let _storageChangeListener = null;

/**
 * Initialize the event logger - restores from storage and checks debug mode
 */
export async function initEventLogger() {
    if (_inited) return;
    _inited = true;

    try {
        // Check debug mode first
        const debugStored = await browser.storage.local.get({ debugMode: false });
        _debugMode = !!debugStored.debugMode;
        
        // Don't load full history into memory - we use append-only approach
        // Session buffer starts empty, gets appended to storage on persist
        _sessionBuffer = [];
        console.log(`[EventLogger] Initialized (append-only mode, no memory preload)`);
        
        // Listen for debug mode changes
        _storageChangeListener = (changes, area) => {
            if (area === "local" && changes.debugMode !== undefined) {
                const newValue = !!changes.debugMode.newValue;
                if (newValue !== _debugMode) {
                    _debugMode = newValue;
                    console.log(`[EventLogger] Debug mode changed to ${_debugMode ? "ON" : "OFF"}`);
                }
            }
        };
        browser.storage.onChanged.addListener(_storageChangeListener);
        
    } catch (e) {
        console.error(`[EventLogger] Failed to initialize: ${e}`);
    }
}

/**
 * Persist the session buffer to storage (append-only approach)
 * Reads existing entries, appends new ones, trims to max, saves back
 */
async function _persistNow() {
    if (_sessionBuffer.length === 0) return;
    
    try {
        // Read existing from storage
        const stored = await browser.storage.local.get(EVENT_LOG_STORAGE_KEY);
        let existing = stored?.[EVENT_LOG_STORAGE_KEY] || [];
        if (!Array.isArray(existing)) existing = [];
        
        // Append new session events
        const combined = [...existing, ..._sessionBuffer];
        
        // Trim to max size (keep most recent)
        const trimmed = combined.length > MAX_EVENT_LOG_ENTRIES
            ? combined.slice(-MAX_EVENT_LOG_ENTRIES)
            : combined;
        
        // Save back to storage
        await browser.storage.local.set({ [EVENT_LOG_STORAGE_KEY]: trimmed });
        
        const newCount = _sessionBuffer.length;
        // Clear session buffer after successful persist
        _sessionBuffer = [];
        
        console.log(`[EventLogger] Appended ${newCount} events (total: ${trimmed.length})`);
    } catch (e) {
        console.error(`[EventLogger] Failed to persist: ${e}`);
    }
}

function _schedulePersist() {
    const ms = _persistDebounceMs();
    if (ms <= 0) {
        _persistNow().catch(() => {});
        return;
    }
    if (_persistTimer) clearTimeout(_persistTimer);
    _persistTimer = setTimeout(() => {
        _persistTimer = null;
        _persistNow().catch(() => {});
    }, ms);
}

/**
 * Log a message event
 * 
 * @param {string} eventType - Type of event: 'onNewMailReceived', 'onMoved', 'onCopied', 'onDeleted', 'tmMsgNotify', etc.
 * @param {string} source - Which listener captured this: 'background', 'onMoved', 'fts', etc.
 * @param {Object} details - Event details
 */
export function logMessageEvent(eventType, source, details) {
    if (!_isEnabled()) return;

    const now = Date.now();
    const isoTime = new Date(now).toISOString();

    const entry = {
        ts: now,
        iso: isoTime,
        eventType,
        source,
        ...details,
    };

    _sessionBuffer.push(entry);

    // Prevent unbounded in-memory growth between persist cycles
    const maxBuf = _cfg().maxSessionBufferSize || 10000;
    if (_sessionBuffer.length > maxBuf) {
        _sessionBuffer = _sessionBuffer.slice(-maxBuf);
    }

    // Log to console immediately for debugging
    console.log(`[EventLogger] ${isoTime} | ${eventType} | ${source} | ${JSON.stringify(details)}`);

    // Schedule persistence
    _schedulePersist();
}

/**
 * Log a batch of messages from a single event (e.g., onNewMailReceived can have multiple messages)
 */
export function logMessageEventBatch(eventType, source, folder, messages) {
    if (!_isEnabled()) return;
    if (!messages || messages.length === 0) return;

    const now = Date.now();
    const isoTime = new Date(now).toISOString();

    // Log each message individually for easier correlation
    for (const msg of messages) {
        const entry = {
            ts: now,
            iso: isoTime,
            eventType,
            source,
            folderName: folder?.name || msg?.folder?.name || "unknown",
            folderPath: folder?.path || msg?.folder?.path || "unknown",
            folderType: folder?.type || msg?.folder?.type || "unknown",
            accountId: folder?.accountId || msg?.folder?.accountId || "unknown",
            headerMessageId: msg?.headerMessageId || "unknown",
            weId: msg?.id,
            subject: (msg?.subject || "").substring(0, 100),
            author: msg?.author || "unknown",
            date: msg?.date ? new Date(msg.date).toISOString() : "unknown",
            messageCount: messages.length,
        };

        _sessionBuffer.push(entry);

        console.log(`[EventLogger] ${isoTime} | ${eventType} | ${source} | folder=${entry.folderPath} | headerMsgId=${entry.headerMessageId} | subject="${entry.subject}"`);
    }

    _schedulePersist();
}

/**
 * Log a move/copy event with before and after states
 */
export function logMoveEvent(eventType, source, originalFolder, messages, destinationFolder = null) {
    if (!_isEnabled()) return;
    if (!messages || messages.length === 0) return;

    const now = Date.now();
    const isoTime = new Date(now).toISOString();

    for (const msg of messages) {
        const entry = {
            ts: now,
            iso: isoTime,
            eventType,
            source,
            originalFolderName: originalFolder?.name || "unknown",
            originalFolderPath: originalFolder?.path || "unknown",
            destinationFolderName: destinationFolder?.name || msg?.folder?.name || "unknown",
            destinationFolderPath: destinationFolder?.path || msg?.folder?.path || "unknown",
            headerMessageId: msg?.headerMessageId || "unknown",
            weId: msg?.id,
            subject: (msg?.subject || "").substring(0, 100),
            author: msg?.author || "unknown",
            date: msg?.date ? new Date(msg.date).toISOString() : "unknown",
            messageCount: messages.length,
        };

        _sessionBuffer.push(entry);

        console.log(`[EventLogger] ${isoTime} | ${eventType} | ${source} | from=${entry.originalFolderPath} to=${entry.destinationFolderPath} | headerMsgId=${entry.headerMessageId} | subject="${entry.subject}"`);
    }

    _schedulePersist();
}

/**
 * Get all events from storage (reads from disk, not memory)
 */
async function _getAllEventsFromStorage() {
    try {
        const stored = await browser.storage.local.get(EVENT_LOG_STORAGE_KEY);
        const arr = stored?.[EVENT_LOG_STORAGE_KEY] || [];
        // Combine with any pending session buffer entries
        return Array.isArray(arr) ? [...arr, ..._sessionBuffer] : [..._sessionBuffer];
    } catch (e) {
        console.error(`[EventLogger] Failed to read from storage: ${e}`);
        return [..._sessionBuffer];
    }
}

/**
 * Get the event log for inspection
 * 
 * @param {Object} options - Filter options
 * @param {number} options.since - Only return events after this timestamp
 * @param {string} options.eventType - Filter by event type
 * @param {number} options.limit - Max number of events to return (default: 100)
 * @returns {Promise<Array>} Event log entries
 */
export async function getEventLog(options = {}) {
    let result = await _getAllEventsFromStorage();

    if (options.since) {
        result = result.filter(e => e.ts >= options.since);
    }

    if (options.eventType) {
        result = result.filter(e => e.eventType === options.eventType);
    }

    // Sort by timestamp descending (most recent first)
    result.sort((a, b) => b.ts - a.ts);

    const limit = options.limit || 100;
    return result.slice(0, limit);
}

/**
 * Get event summary statistics for debugging
 */
export async function getEventSummary(sinceMins = 60) {
    const allEvents = await _getAllEventsFromStorage();
    const sinceTs = Date.now() - (sinceMins * 60 * 1000);
    const recentEvents = allEvents.filter(e => e.ts >= sinceTs);

    const counts = {};
    for (const e of recentEvents) {
        const key = `${e.eventType}:${e.source}`;
        counts[key] = (counts[key] || 0) + 1;
    }

    return {
        totalEvents: recentEvents.length,
        oldestEvent: recentEvents.length > 0 ? new Date(Math.min(...recentEvents.map(e => e.ts))).toISOString() : null,
        newestEvent: recentEvents.length > 0 ? new Date(Math.max(...recentEvents.map(e => e.ts))).toISOString() : null,
        eventCounts: counts,
        sinceMins,
    };
}

/**
 * Search for a specific headerMessageId in the event log
 */
export async function findEventsByHeaderId(headerMessageId) {
    const allEvents = await _getAllEventsFromStorage();
    return allEvents.filter(e => 
        e.headerMessageId === headerMessageId || 
        (e.headerMessageId && headerMessageId && e.headerMessageId.includes(headerMessageId))
    ).sort((a, b) => b.ts - a.ts);
}

/**
 * Clear the event log (for testing/debugging)
 */
export async function clearEventLog() {
    _sessionBuffer = [];
    try {
        await browser.storage.local.remove(EVENT_LOG_STORAGE_KEY);
        console.log("[EventLogger] Event log cleared");
    } catch (e) {
        console.error(`[EventLogger] Failed to clear: ${e}`);
    }
}

/**
 * Cleanup on extension suspend/unload
 */
export async function cleanupEventLogger() {
    if (_persistTimer) {
        clearTimeout(_persistTimer);
        _persistTimer = null;
    }

    // Remove storage change listener
    if (_storageChangeListener) {
        try {
            browser.storage.onChanged.removeListener(_storageChangeListener);
        } catch (e) {
            // Ignore errors during cleanup
        }
        _storageChangeListener = null;
    }

    // Persist any pending session buffer events
    if (_sessionBuffer.length > 0) {
        await _persistNow();
    }

    _inited = false;
    _debugMode = false;
}

/**
 * Export the entire event log for external inspection
 * (e.g., for correlating with scan results)
 */
export async function exportEventLog() {
    const allEvents = await _getAllEventsFromStorage();
    return {
        exportedAt: new Date().toISOString(),
        totalEvents: allEvents.length,
        maxEntries: MAX_EVENT_LOG_ENTRIES,
        events: allEvents.sort((a, b) => b.ts - a.ts),
    };
}

/**
 * Log an FTS operation for debugging the full pipeline
 * 
 * This captures everything from queue → resolution → indexing → verification
 * so we can trace a message's full journey through the FTS system.
 * 
 * @param {string} operation - Operation type: 'enqueue', 'resolve', 'filter', 'index', 'verify', 'dequeue', 'drop', 'retry', etc.
 * @param {string} status - Status: 'start', 'success', 'failure', 'skip'
 * @param {Object} details - Operation details
 */
export function logFtsOperation(operation, status, details = {}) {
    if (!_isEnabled()) return;

    const now = Date.now();
    const isoTime = new Date(now).toISOString();

    const entry = {
        ts: now,
        iso: isoTime,
        eventType: `fts:${operation}`,
        source: "fts",
        status,
        ...details,
    };

    _sessionBuffer.push(entry);

    // Build a concise log line
    const headerMsgIdPart = details.headerMessageId ? ` | headerMsgId=${details.headerMessageId}` : "";
    const uniqueKeyPart = details.uniqueKey ? ` | key=${details.uniqueKey}` : "";
    const weIdPart = details.weId ? ` | weId=${details.weId}` : "";
    const countPart = details.count !== undefined ? ` | count=${details.count}` : "";
    const reasonPart = details.reason ? ` | reason=${details.reason}` : "";
    const subjectPart = details.subject ? ` | subject="${(details.subject || "").substring(0, 50)}"` : "";

    console.log(`[EventLogger] ${isoTime} | fts:${operation} | ${status}${uniqueKeyPart}${headerMsgIdPart}${weIdPart}${countPart}${reasonPart}${subjectPart}`);

    _schedulePersist();
}

/**
 * Log a batch FTS operation (e.g., indexBatch results)
 */
export function logFtsBatchOperation(operation, status, details = {}) {
    if (!_isEnabled()) return;

    const now = Date.now();
    const isoTime = new Date(now).toISOString();

    const entry = {
        ts: now,
        iso: isoTime,
        eventType: `fts:${operation}`,
        source: "fts",
        status,
        ...details,
    };

    _sessionBuffer.push(entry);

    const totalPart = details.total !== undefined ? ` | total=${details.total}` : "";
    const successPart = details.successCount !== undefined ? ` | success=${details.successCount}` : "";
    const failPart = details.failCount !== undefined ? ` | fail=${details.failCount}` : "";
    const skipPart = details.skipCount !== undefined ? ` | skip=${details.skipCount}` : "";

    console.log(`[EventLogger] ${isoTime} | fts:${operation} | ${status}${totalPart}${successPart}${failPart}${skipPart}`);

    _schedulePersist();
}
