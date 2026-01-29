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
const MAX_EVENT_LOG_ENTRIES = 500; // Ring buffer size

let _eventLog = []; // In-memory buffer
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
        
        // Only restore event log if debug mode is enabled
        if (_debugMode) {
            const stored = await browser.storage.local.get(EVENT_LOG_STORAGE_KEY);
            const arr = stored?.[EVENT_LOG_STORAGE_KEY] || [];
            if (Array.isArray(arr)) {
                _eventLog = arr;
                console.log(`[EventLogger] Debug mode ON - restored ${_eventLog.length} events from storage`);
            }
        } else {
            console.log(`[EventLogger] Debug mode OFF - event logging disabled`);
        }
        
        // Listen for debug mode changes
        _storageChangeListener = (changes, area) => {
            if (area === "local" && changes.debugMode !== undefined) {
                const newValue = !!changes.debugMode.newValue;
                if (newValue !== _debugMode) {
                    _debugMode = newValue;
                    console.log(`[EventLogger] Debug mode changed to ${_debugMode ? "ON" : "OFF"}`);
                    
                    // If debug mode turned off, clear the in-memory log to save memory
                    if (!_debugMode) {
                        _eventLog = [];
                    }
                }
            }
        };
        browser.storage.onChanged.addListener(_storageChangeListener);
        
    } catch (e) {
        console.error(`[EventLogger] Failed to initialize: ${e}`);
    }
}

/**
 * Persist the event log to storage
 */
async function _persistNow() {
    try {
        // Trim to max size before persisting
        if (_eventLog.length > MAX_EVENT_LOG_ENTRIES) {
            _eventLog = _eventLog.slice(-MAX_EVENT_LOG_ENTRIES);
        }
        await browser.storage.local.set({ [EVENT_LOG_STORAGE_KEY]: _eventLog });
        console.log(`[EventLogger] Persisted ${_eventLog.length} events`);
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

    _eventLog.push(entry);

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

        _eventLog.push(entry);

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

        _eventLog.push(entry);

        console.log(`[EventLogger] ${isoTime} | ${eventType} | ${source} | from=${entry.originalFolderPath} to=${entry.destinationFolderPath} | headerMsgId=${entry.headerMessageId} | subject="${entry.subject}"`);
    }

    _schedulePersist();
}

/**
 * Get the event log for inspection
 * 
 * @param {Object} options - Filter options
 * @param {number} options.since - Only return events after this timestamp
 * @param {string} options.eventType - Filter by event type
 * @param {number} options.limit - Max number of events to return (default: 100)
 * @returns {Array} Event log entries
 */
export function getEventLog(options = {}) {
    let result = [..._eventLog];

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
export function getEventSummary(sinceMins = 60) {
    const sinceTs = Date.now() - (sinceMins * 60 * 1000);
    const recentEvents = _eventLog.filter(e => e.ts >= sinceTs);

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
export function findEventsByHeaderId(headerMessageId) {
    return _eventLog.filter(e => 
        e.headerMessageId === headerMessageId || 
        (e.headerMessageId && headerMessageId && e.headerMessageId.includes(headerMessageId))
    ).sort((a, b) => b.ts - a.ts);
}

/**
 * Clear the event log (for testing/debugging)
 */
export async function clearEventLog() {
    _eventLog = [];
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

    // Persist any pending events before cleanup (only if debug mode was on)
    if (_debugMode && _eventLog.length > 0) {
        await _persistNow();
    }

    _inited = false;
    _debugMode = false;
}

/**
 * Export the entire event log for external inspection
 * (e.g., for correlating with scan results)
 */
export function exportEventLog() {
    return {
        exportedAt: new Date().toISOString(),
        totalEvents: _eventLog.length,
        maxEntries: MAX_EVENT_LOG_ENTRIES,
        events: [..._eventLog].sort((a, b) => b.ts - a.ts),
    };
}
