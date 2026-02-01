// idTranslator.js – Simplified ID translation layer for TabMail
// Maps complex Thunderbird IDs to simple numeric IDs for LLM interaction
// Uses ctx.idTranslation for session persistence
// Supports persistent idMap across window opens (infinite chat)

import { log } from "../../agent/modules/utils.js";
import { ctx } from "./context.js";
import { loadIdMap, saveIdMap, saveIdMapImmediate } from "./persistentChatStore.js";

// Collector for per-turn ref bookkeeping. When non-null, toRealId records every
// numeric ID it resolves. Only active during collectTurnRefs() calls in the main
// chat window — headless sessions never set this.
let _activeRefsCollector = null;

// Resolve translation context: use provided override or fall back to global ctx.
// Headless sessions pass an isolated context to avoid cross-session contamination.
function _resolveCtx(overrideCtx) {
  return overrideCtx || ctx.idTranslation;
}

// Create an isolated translation context for headless sessions.
// Each headless call (proactive check-in, reply generation, etc.) should create its own
// context so concurrent background sessions don't contaminate each other's idMap.
export function createIsolatedContext() {
  return {
    idMap: new Map(),
    nextNumericId: 1,
    lastAccessed: Date.now(),
    freeIds: [],
  };
}

/**
 * Initialize idTranslation from persistent storage.
 * Called on chat window open to restore the idMap from the previous session.
 */
export async function initIdTranslation() {
  try {
    const persisted = await loadIdMap();
    const idTranslation = ctx.idTranslation;

    // Restore map entries
    idTranslation.idMap.clear();
    for (const [numericId, realId] of persisted.entries) {
      if (typeof numericId === "number" && typeof realId === "string") {
        idTranslation.idMap.set(numericId, realId);
      }
    }
    idTranslation.nextNumericId = persisted.nextNumericId || 1;
    idTranslation.freeIds = Array.isArray(persisted.freeIds) ? [...persisted.freeIds] : [];
    idTranslation.refCounts = new Map(persisted.refCounts || []);
    idTranslation.lastAccessed = Date.now();

    log(`[TMDBG IDTranslator] initIdTranslation: restored ${idTranslation.idMap.size} entries, nextId=${idTranslation.nextNumericId}, freeIds=${idTranslation.freeIds.length}, refCounts=${idTranslation.refCounts.size}`);
  } catch (e) {
    log(`[TMDBG IDTranslator] initIdTranslation failed: ${e}`, "error");
  }
}

/**
 * Persist current idMap to storage (debounced).
 */
export function persistIdMap() {
  const idTranslation = ctx.idTranslation;
  saveIdMap(idTranslation.idMap, idTranslation.nextNumericId, idTranslation.freeIds || [], idTranslation.refCounts);
}

/**
 * Force-persist idMap immediately (for beforeunload).
 */
export async function persistIdMapImmediate() {
  const idTranslation = ctx.idTranslation;
  await saveIdMapImmediate(idTranslation.idMap, idTranslation.nextNumericId, idTranslation.freeIds || [], idTranslation.refCounts);
}

// Convert real Thunderbird ID to numeric ID for LLM consumption
export function toNumericId(realId, overrideCtx) {
  if (!realId || typeof realId !== 'string') {
    log(`[TMDBG IDTranslator] Invalid realId: ${realId}`, "warn");
    return null;
  }

  // Skip if it's already a numeric ID (prevent double translation)
  if (/^\d+$/.test(realId)) {
    log(`[TMDBG IDTranslator] Skipping numeric ID: ${realId}`, "warn");
    return Number(realId);
  }

  const idTranslation = _resolveCtx(overrideCtx);

  // Check if we already have this real ID mapped
  for (const [numericId, mappedRealId] of idTranslation.idMap.entries()) {
    if (mappedRealId === realId) {
      log(`[Translate] Real->Numeric: ${realId} -> ${numericId}`);
      return numericId;
    }
  }

  // Create new mapping — check freeIds first, then use nextNumericId
  let numericId;
  const freeIds = idTranslation.freeIds || [];
  if (freeIds.length > 0) {
    numericId = freeIds.pop();
    log(`[Translate] Reused free ID ${numericId} for: ${realId}`);
  } else {
    numericId = idTranslation.nextNumericId++;
  }
  idTranslation.idMap.set(numericId, realId);
  idTranslation.lastAccessed = Date.now();
  log(`[Translate] Real->Numeric: ${realId} -> ${numericId}`);

  // Persist idMap (debounced) — only for the main chat context, not overrides
  if (!overrideCtx) {
    persistIdMap();
  }

  return numericId;
}

// Convert numeric ID back to real Thunderbird ID for tool execution
export function toRealId(numericId, overrideCtx) {
  if (typeof numericId !== 'number' && typeof numericId !== 'string') {
    log(`[TMDBG IDTranslator] Invalid numericId: ${numericId}`, "warn");
    return null;
  }

  const numericIdNum = Number(numericId);
  if (!Number.isInteger(numericIdNum) || numericIdNum < 1) {
    log(`[TMDBG IDTranslator] Invalid numericId: ${numericId}`, "warn");
    return null;
  }

  // Record this ID if a ref collector is active (per-turn bookkeeping)
  if (_activeRefsCollector) _activeRefsCollector.add(numericIdNum);

  const idTranslation = _resolveCtx(overrideCtx);
  const realId = idTranslation.idMap.get(numericIdNum);

  if (!realId) {
    log(`[TMDBG IDTranslator] No mapping found for numericId: ${numericId}`, "warn");
    return null;
  }

  idTranslation.lastAccessed = Date.now();
  log(`[Translate] Numeric->Real: ${numericId} -> ${realId}`);
  return realId;
}

// Process tool call arguments to convert LLM numeric IDs to Thunderbird real IDs
export function processToolCallLLMtoTB(toolName, args, overrideCtx) {
  if (!args || typeof args !== 'object') return args;

  try {
    log(`[TMDBG IDTranslator] processToolCallLLMtoTB called for tool: ${toolName} with args: ${JSON.stringify(args)}`);
    const processedArgs = { ...args };

    // Handle different tool types based on their name prefix
    // Email tools (email_*)
    if (toolName.startsWith('email_')) {
      // Handle single unique_id parameter
      if ((processedArgs.unique_id || processedArgs.UniqueID) && (typeof (processedArgs.unique_id || processedArgs.UniqueID) === 'number' || typeof (processedArgs.unique_id || processedArgs.UniqueID) === 'string')) {
        const realId = toRealId(processedArgs.unique_id || processedArgs.UniqueID, overrideCtx);
        if (realId) {
          if (processedArgs.unique_id) processedArgs.unique_id = realId;
          if (processedArgs.UniqueID) processedArgs.UniqueID = realId;
        }
      }

      // Handle unique_ids array parameter (for email_archive, email_delete, email_move_to_inbox, etc.)
      if (processedArgs.unique_ids && Array.isArray(processedArgs.unique_ids)) {
        log(`[TMDBG IDTranslator] Email tool - unique_ids array: ${JSON.stringify(processedArgs.unique_ids)}`);
        const translatedIds = processedArgs.unique_ids.map(id => {
          if (typeof id === 'number' || typeof id === 'string') {
            const realId = toRealId(id, overrideCtx);
            log(`[TMDBG IDTranslator] Email tool - translated unique_id: ${id} -> ${realId}`);
            return realId || id;
          }
          return id;
        });
        processedArgs.unique_ids = translatedIds;
        log(`[TMDBG IDTranslator] Email tool - translated unique_ids array: ${JSON.stringify(translatedIds)}`);
      }
    }

    // Calendar event tools (calendar_event_*)
    if (toolName.startsWith('calendar_event_')) {
      const eventId = processedArgs.event_id || processedArgs.EventID;
      log(`[TMDBG IDTranslator] Calendar event tool - eventId: ${eventId}, type: ${typeof eventId}`);
      if (eventId && (typeof eventId === 'number' || typeof eventId === 'string')) {
        const realId = toRealId(eventId, overrideCtx);
        log(`[TMDBG IDTranslator] Calendar event tool - translated eventId: ${eventId} -> ${realId}`);
        if (realId) {
          if (processedArgs.event_id) processedArgs.event_id = realId;
          if (processedArgs.EventID) processedArgs.EventID = realId;
        }
      }
      // Handle compound calendar event IDs (calendar_id:event_id)
      if (eventId && typeof eventId === 'string' && eventId.includes(':')) {
        const [numericCalendarId, numericEventId] = eventId.split(':');
        const realCalendarId = toRealId(Number(numericCalendarId), overrideCtx);
        const realEventId = toRealId(Number(numericEventId), overrideCtx);
        if (realCalendarId && realEventId) {
          const compoundId = `${realCalendarId}:${realEventId}`;
          if (processedArgs.event_id) processedArgs.event_id = compoundId;
          if (processedArgs.EventID) processedArgs.EventID = compoundId;
        }
      }

      // Also handle calendar_id parameter for calendar event tools
      const calendarId = processedArgs.calendar_id || processedArgs.CalendarID;
      log(`[TMDBG IDTranslator] Calendar event tool - calendarId: ${calendarId}, type: ${typeof calendarId}`);
      if (calendarId && (typeof calendarId === 'number' || typeof calendarId === 'string')) {
        const realId = toRealId(calendarId, overrideCtx);
        log(`[TMDBG IDTranslator] Calendar event tool - translated calendarId: ${calendarId} -> ${realId}`);
        if (realId) {
          if (processedArgs.calendar_id) processedArgs.calendar_id = realId;
          if (processedArgs.CalendarID) processedArgs.CalendarID = realId;
        }
      }
    }

    // Contact tools (contacts_*)
    if (toolName.startsWith('contacts_')) {
      if ((processedArgs.contact_id || processedArgs.ContactID) && (typeof (processedArgs.contact_id || processedArgs.ContactID) === 'number' || typeof (processedArgs.contact_id || processedArgs.ContactID) === 'string')) {
        const realId = toRealId(processedArgs.contact_id || processedArgs.ContactID, overrideCtx);
        if (realId) {
          if (processedArgs.contact_id) processedArgs.contact_id = realId;
          if (processedArgs.ContactID) processedArgs.ContactID = realId;
        }
      }
      // Handle addressbook_id parameter
      if (processedArgs.addressbook_id && (typeof processedArgs.addressbook_id === 'number' || typeof processedArgs.addressbook_id === 'string')) {
        const realAddressbookId = toRealId(processedArgs.addressbook_id, overrideCtx);
        if (realAddressbookId) {
          processedArgs.addressbook_id = realAddressbookId;
        }
      }
    }

    // Calendar tools (calendar_read, calendar_search - but not calendar_event_*)
    if (toolName.startsWith('calendar_') && !toolName.startsWith('calendar_event_')) {
      const calendarId = processedArgs.calendar_id || processedArgs.CalendarID;
      log(`[TMDBG IDTranslator] Calendar tool - calendarId: ${calendarId}, type: ${typeof calendarId}`);
      if (calendarId && (typeof calendarId === 'number' || typeof calendarId === 'string')) {
        const realId = toRealId(calendarId, overrideCtx);
        log(`[TMDBG IDTranslator] Calendar tool - translated calendarId: ${calendarId} -> ${realId}`);
        if (realId) {
          if (processedArgs.calendar_id) processedArgs.calendar_id = realId;
          if (processedArgs.CalendarID) processedArgs.CalendarID = realId;
        }
      }
    }

    return processedArgs;
  } catch (e) {
    log(`[TMDBG IDTranslator] Error processing tool call LLMtoTB: ${e}`, "error");
    return args;
  }
}

// Process string content to convert LLM numeric IDs back to Thunderbird real IDs (for display)
function processStringLLMtoTB(str) {
  if (typeof str !== 'string') return str;

  let processed = str;

  // Debug: Log what we're processing
  if (str.includes('[Email]') || str.includes('[Contact]') || str.includes('[Event]') || 
      str.includes('unique_id') || str.includes('contact_id')) {
    log(`[TMDBG IDTranslator] Processing LLM response with markdown: ${str.substring(0, 200)}...`);
  }

  // FIRST: Handle exception patterns (malformed ID references) before normal patterns
  // This catches patterns like "unique_id 4 and 6" and converts them to "[Email](4) and [Email](6)"
  processed = handleIdExceptions(processed);

  // Handle [Email xx] patterns (square brackets with space) - convert to [Email](realId)
  processed = processed.replace(/\[(Email|email)\s+(\d+)\]/g, (match, type, numericId) => {
    log(`[TMDBG IDTranslator] Found [Email xx] pattern: ${match} -> type: ${type}, numericId: ${numericId}`);
    const realId = toRealId(Number(numericId));
    const result = realId ? `[${type}](${realId})` : match;
    log(`[TMDBG IDTranslator] [Email xx] translation result: ${result}`);
    return result;
  });

  // Handle (Email xx) patterns (parentheses with space) - convert to [Email](realId)
  processed = processed.replace(/\((Email|email)\s+(\d+)\)/g, (match, type, numericId) => {
    log(`[TMDBG IDTranslator] Found (Email xx) pattern: ${match} -> type: ${type}, numericId: ${numericId}`);
    const realId = toRealId(Number(numericId));
    const result = realId ? `[${type}](${realId})` : match;
    log(`[TMDBG IDTranslator] (Email xx) translation result: ${result}`);
    return result;
  });

  // Handle "Email xx" patterns (no brackets or parentheses) - convert to [Email](realId)
  processed = processed.replace(/\b(Email|email)\s+(\d+)\b/g, (match, type, numericId) => {
    log(`[TMDBG IDTranslator] Found "Email xx" pattern: ${match} -> type: ${type}, numericId: ${numericId}`);
    const realId = toRealId(Number(numericId));
    const result = realId ? `[${type}](${realId})` : match;
    log(`[TMDBG IDTranslator] "Email xx" translation result: ${result}`);
    return result;
  });

  // Replace numeric IDs in markdown links back to real IDs
  // Handle both formats: [Email](14) and [Email](unique_id:14)
  processed = processed.replace(/\[(Email|email)\]\((?:unique_id:)?(\d+)\)/g, (match, type, numericId) => {
    log(`[TMDBG IDTranslator] Found markdown pattern: ${match} -> type: ${type}, numericId: ${numericId}`);
    const realId = toRealId(Number(numericId));
    const result = realId ? `[${type}](${realId})` : match;
    log(`[TMDBG IDTranslator] Markdown translation result: ${result}`);
    return result;
  });

  // Handle calendar events with compound IDs (numeric_calendar_id:numeric_event_id)
  processed = processed.replace(/\[(Event|event)\]\((\d+:\d+)\)/g, (match, type, compoundId) => {
    const [numericCalendarId, numericEventId] = compoundId.split(':');
    const realCalendarId = toRealId(Number(numericCalendarId));
    const realEventId = toRealId(Number(numericEventId));
    if (realCalendarId && realEventId) {
      // Store in entityMap for autocomplete (LLM→TB is when we see compound links)
      ctx.entityMap.set(compoundId, {
        type: 'event',
        compoundNumericId: compoundId,
        realEventId: realEventId,
        realCalendarId: realCalendarId,
      });
      log(`[TMDBG IDTranslator] Event link LLM->TB: ${compoundId} -> ${realCalendarId}:${realEventId} (stored in entityMap)`);
      return `[${type}](${realCalendarId}:${realEventId})`;
    }
    return match;
  });

  // Handle contacts with compound IDs (numeric_addressbook_id:numeric_contact_id)
  processed = processed.replace(/\[(Contact|contact)\]\((\d+:\d+)\)/g, (match, type, compoundId) => {
    const [numericAddressbookId, numericContactId] = compoundId.split(':');
    const realAddressbookId = toRealId(Number(numericAddressbookId));
    const realContactId = toRealId(Number(numericContactId));
    if (realAddressbookId && realContactId) {
      // Store in entityMap for autocomplete (LLM→TB is when we see compound links)
      ctx.entityMap.set(compoundId, {
        type: 'contact',
        compoundNumericId: compoundId,
        realContactId: realContactId,
        realAddressbookId: realAddressbookId,
      });
      log(`[TMDBG IDTranslator] Contact link LLM->TB: ${compoundId} -> ${realAddressbookId}:${realContactId} (stored in entityMap)`);
      return `[${type}](${realAddressbookId}:${realContactId})`;
    }
    return match;
  });

  // Handle additional ID patterns for markdown rendering: (id_type X), id_type X, id_type: X
  // These patterns should be converted to markdown links for proper rendering
  // Only handle unique_id - contact_id and event_id need compound formats
  const idPatterns = [
    { 
      idType: 'unique_id', 
      linkType: 'Email',
      patterns: [
        { regex: /\(unique_id\s+(\d+)\)/g, name: 'parentheses' },
        { regex: /\bunique_id\s+(\d+)\b/g, name: 'word_boundary' },
        { regex: /\bunique_id:\s*(\d+)\b/g, name: 'colon' }
      ]
    }
  ];

  // Handle compound ID patterns for contacts and events
  const compoundIdPatterns = [
    {
      idType: 'contact_id',
      linkType: 'Contact',
      patterns: [
        { regex: /\(addressbook_id:\s*(\d+):contact_id:\s*(\d+)\)/g, name: 'parentheses_compound' },
        { regex: /\baddressbook_id:\s*(\d+):contact_id:\s*(\d+)\b/g, name: 'word_boundary_compound' },
        { regex: /\baddressbook_id:\s*(\d+):contact_id:\s*(\d+)\b/g, name: 'colon_compound' }
      ]
    },
    {
      idType: 'event_id',
      linkType: 'Event',
      patterns: [
        { regex: /\(calendar_id:\s*(\d+):event_id:\s*(\d+)\)/g, name: 'parentheses_compound' },
        { regex: /\bcalendar_id:\s*(\d+):event_id:\s*(\d+)\b/g, name: 'word_boundary_compound' },
        { regex: /\bcalendar_id:\s*(\d+):event_id:\s*(\d+)\b/g, name: 'colon_compound' }
      ]
    }
  ];

  idPatterns.forEach(({ idType, linkType, patterns }) => {
    patterns.forEach(({ regex, name }) => {
      processed = processed.replace(regex, (match, numericId) => {
        log(`[TMDBG IDTranslator] Found ${idType} pattern (${name}): ${match} -> numericId: ${numericId}`);
        const realId = toRealId(Number(numericId));
        const result = realId ? `[${linkType}](${realId})` : match;
        log(`[TMDBG IDTranslator] ${idType} pattern translation result: ${result}`);
        return result;
      });
    });
  });

  // Process compound ID patterns
  compoundIdPatterns.forEach(({ idType, linkType, patterns }) => {
    patterns.forEach(({ regex, name }) => {
      processed = processed.replace(regex, (match, id1, id2) => {
        log(`[TMDBG IDTranslator] Found ${idType} compound pattern (${name}): ${match} -> id1: ${id1}, id2: ${id2}`);
        const realId1 = toRealId(Number(id1));
        const realId2 = toRealId(Number(id2));
        const result = (realId1 && realId2) ? `[${linkType}](${realId1}:${realId2})` : match;
        log(`[TMDBG IDTranslator] ${idType} compound pattern translation result: ${result}`);
        return result;
      });
    });
  });


  return processed;
}

// Process string content to convert Thunderbird real IDs to LLM numeric IDs
function processStringTBtoLLM(str, overrideCtx) {
  if (typeof str !== 'string') return str;

  let processed = str;

  // Debug: Log what we're processing
  if (str.includes('unique_id:') || str.includes('contact_id:') || str.includes('event_id:') || str.includes('calendar_id:') || str.includes('addressbook_id:')) {
    log(`[TMDBG IDTranslator] Processing string with ID patterns: ${str.substring(0, 200)}...`);
  }


  // Replace underscore ID patterns (tools now use consistent format)
  // Match exact format: "unique_id: XXXX" (with space after colon)
  // Parse until newline since IDs are now single-line
  // Handle folder paths with spaces by matching until newline or end of string
  // Use greedy match to capture full folder paths with spaces
  processed = processed.replace(/(unique_id|contact_id|event_id|calendar_id|addressbook_id):\s+([^\n]+?)(?=\n|$)/g, (match, fieldName, realId) => {
    log(`[TMDBG IDTranslator] Found pattern: ${match} -> fieldName: ${fieldName}, realId: ${realId}`);
    const numericId = toNumericId(realId, overrideCtx);
    const result = numericId ? `${fieldName}: ${numericId}` : match;
    log(`[TMDBG IDTranslator] Translation result: ${result}`);
    return result;
  });

  // Replace markdown links
  processed = processed.replace(/\[(Email|email)\]\(([^\)]+?)\)/g, (match, type, realId) => {
    const numericId = toNumericId(realId, overrideCtx);
    return numericId ? `[${type}](${numericId})` : match;
  });

  // Handle contact markdown links with compound IDs
  // [Contact](addressbookRealId:contactRealId) -> [Contact](numericAB:numericContact)
  processed = processed.replace(/\[(Contact|contact)\]\(([^\)]+?)\)/g, (match, type, contactId) => {
    if (contactId.includes(':')) {
      const [addressbookId, contactIdPart] = contactId.split(':');
      const numericAddressbookId = toNumericId(addressbookId, overrideCtx);
      const numericContactId = toNumericId(contactIdPart, overrideCtx);
      if (numericAddressbookId && numericContactId) {
        log(`[TMDBG IDTranslator] Contact link TB->LLM: ${contactId} -> ${numericAddressbookId}:${numericContactId}`);
        return `[${type}](${numericAddressbookId}:${numericContactId})`;
      }
    }
    return match;
  });

  // Handle calendar event markdown links with compound IDs
  // [Event](calendarRealId:eventRealId) -> [Event](numericCal:numericEvent)
  processed = processed.replace(/\[(Event|event)\]\(([^\)]+?)\)/g, (match, type, eventId) => {
    if (eventId.includes(':')) {
      const [calendarId, eventIdPart] = eventId.split(':');
      const numericCalendarId = toNumericId(calendarId, overrideCtx);
      const numericEventId = toNumericId(eventIdPart, overrideCtx);
      if (numericCalendarId && numericEventId) {
        log(`[TMDBG IDTranslator] Event link TB->LLM: ${eventId} -> ${numericCalendarId}:${numericEventId}`);
        return `[${type}](${numericCalendarId}:${numericEventId})`;
      }
    }
    return match;
  });

  return processed;
}

/**
 * ==================================================================================
 * CENTRALIZED EXCEPTION HANDLER FOR MALFORMED ID PATTERNS
 * ==================================================================================
 * 
 * This function handles patterns where the LLM incorrectly uses "and" or commas
 * to refer to multiple IDs instead of separate markdown references.
 * 
 * WHY THIS EXISTS:
 * The LLM sometimes generates responses like "I've archived emails (unique_id 4 and 6)"
 * instead of the correct format "I've archived [Email](4) and [Email](6)".
 * This function catches these exceptions BEFORE normal pattern matching.
 * 
 * EXAMPLES OF PATTERNS THIS HANDLES:
 * - "unique_id 4 and 6" -> "[Email](4) and [Email](6)"
 * - "(unique_id 4, 6)" -> "([Email](4), [Email](6))"
 * - "unique_id 4, 6, and 7" -> "[Email](4), [Email](6), and [Email](7)"
 * - "contact_id 14 and 15" -> "[Contact](14) and [Contact](15)"
 * - "event_id 5 and 6" -> "[Event](5) and [Event](6)"
 * 
 * HOW TO ADD NEW EXCEPTION PATTERNS:
 * 1. Identify the malformed pattern from logs (look for "TMDBG IDTranslator Exception")
 * 2. Create a regex that captures all numeric IDs in the pattern
 * 3. Add a replace call that converts each captured ID to proper markdown format
 * 4. Add appropriate logging for debugging
 * 5. Update the prompt (system_prompt_agent.md) to warn against using this pattern
 * 
 * @param {string} str - The input string to process
 * @returns {string} - The processed string with corrected ID references
 */
function handleIdExceptions(str) {
  if (typeof str !== 'string') return str;
  
  let processed = str;
  
  // Exception patterns for emails (unique_id)
  // Pattern 1: "unique_id X and Y" -> "[Email](X) and [Email](Y)"
  processed = processed.replace(/\bunique_id\s+(\d+)\s+and\s+(\d+)\b/g, (match, id1, id2) => {
    log(`[TMDBG IDTranslator Exception] Found "unique_id X and Y" pattern: ${match}`);
    const realId1 = toRealId(Number(id1));
    const realId2 = toRealId(Number(id2));
    if (realId1 && realId2) {
      const result = `[Email](${realId1}) and [Email](${realId2})`;
      log(`[TMDBG IDTranslator Exception] Converted to: ${result}`);
      return result;
    }
    return match;
  });
  
  // Pattern 2: "(unique_id X and Y)" -> "([Email](X) and [Email](Y))"
  processed = processed.replace(/\(unique_id\s+(\d+)\s+and\s+(\d+)\)/g, (match, id1, id2) => {
    log(`[TMDBG IDTranslator Exception] Found "(unique_id X and Y)" pattern: ${match}`);
    const realId1 = toRealId(Number(id1));
    const realId2 = toRealId(Number(id2));
    if (realId1 && realId2) {
      const result = `([Email](${realId1}) and [Email](${realId2}))`;
      log(`[TMDBG IDTranslator Exception] Converted to: ${result}`);
      return result;
    }
    return match;
  });
  
  // Pattern 3: "unique_id X, Y" -> "[Email](X), [Email](Y)"
  processed = processed.replace(/\bunique_id\s+(\d+),\s*(\d+)\b/g, (match, id1, id2) => {
    log(`[TMDBG IDTranslator Exception] Found "unique_id X, Y" pattern: ${match}`);
    const realId1 = toRealId(Number(id1));
    const realId2 = toRealId(Number(id2));
    if (realId1 && realId2) {
      const result = `[Email](${realId1}), [Email](${realId2})`;
      log(`[TMDBG IDTranslator Exception] Converted to: ${result}`);
      return result;
    }
    return match;
  });
  
  // Pattern 4: "(unique_id X, Y)" -> "([Email](X), [Email](Y))"
  processed = processed.replace(/\(unique_id\s+(\d+),\s*(\d+)\)/g, (match, id1, id2) => {
    log(`[TMDBG IDTranslator Exception] Found "(unique_id X, Y)" pattern: ${match}`);
    const realId1 = toRealId(Number(id1));
    const realId2 = toRealId(Number(id2));
    if (realId1 && realId2) {
      const result = `([Email](${realId1}), [Email](${realId2}))`;
      log(`[TMDBG IDTranslator Exception] Converted to: ${result}`);
      return result;
    }
    return match;
  });
  
  // Pattern 5: "unique_id X, Y, and Z" -> "[Email](X), [Email](Y), and [Email](Z)"
  processed = processed.replace(/\bunique_id\s+(\d+),\s*(\d+),\s*and\s+(\d+)\b/g, (match, id1, id2, id3) => {
    log(`[TMDBG IDTranslator Exception] Found "unique_id X, Y, and Z" pattern: ${match}`);
    const realId1 = toRealId(Number(id1));
    const realId2 = toRealId(Number(id2));
    const realId3 = toRealId(Number(id3));
    if (realId1 && realId2 && realId3) {
      const result = `[Email](${realId1}), [Email](${realId2}), and [Email](${realId3})`;
      log(`[TMDBG IDTranslator Exception] Converted to: ${result}`);
      return result;
    }
    return match;
  });
  
  // Exception patterns for contacts (addressbook_id:contact_id)
  // Pattern 1: "contact_id X and Y" -> "[Contact](X) and [Contact](Y)"
  processed = processed.replace(/\bcontact_id\s+(\d+)\s+and\s+(\d+)\b/g, (match, id1, id2) => {
    log(`[TMDBG IDTranslator Exception] Found "contact_id X and Y" pattern: ${match}`);
    const realId1 = toRealId(Number(id1));
    const realId2 = toRealId(Number(id2));
    if (realId1 && realId2) {
      const result = `[Contact](${realId1}) and [Contact](${realId2})`;
      log(`[TMDBG IDTranslator Exception] Converted to: ${result}`);
      return result;
    }
    return match;
  });
  
  // Pattern 2: "contact_id X, Y" -> "[Contact](X), [Contact](Y)"
  processed = processed.replace(/\bcontact_id\s+(\d+),\s*(\d+)\b/g, (match, id1, id2) => {
    log(`[TMDBG IDTranslator Exception] Found "contact_id X, Y" pattern: ${match}`);
    const realId1 = toRealId(Number(id1));
    const realId2 = toRealId(Number(id2));
    if (realId1 && realId2) {
      const result = `[Contact](${realId1}), [Contact](${realId2})`;
      log(`[TMDBG IDTranslator Exception] Converted to: ${result}`);
      return result;
    }
    return match;
  });
  
  // Exception patterns for events (calendar_id:event_id)
  // Pattern 1: "event_id X and Y" (assumes same calendar) -> "[Event](cal:X) and [Event](cal:Y)"
  processed = processed.replace(/\bevent_id\s+(\d+)\s+and\s+(\d+)\b/g, (match, id1, id2) => {
    log(`[TMDBG IDTranslator Exception] Found "event_id X and Y" pattern: ${match}`);
    const realId1 = toRealId(Number(id1));
    const realId2 = toRealId(Number(id2));
    if (realId1 && realId2) {
      const result = `[Event](${realId1}) and [Event](${realId2})`;
      log(`[TMDBG IDTranslator Exception] Converted to: ${result}`);
      return result;
    }
    return match;
  });
  
  // Pattern 2: "event_id X, Y" -> "[Event](X), [Event](Y)"
  processed = processed.replace(/\bevent_id\s+(\d+),\s*(\d+)\b/g, (match, id1, id2) => {
    log(`[TMDBG IDTranslator Exception] Found "event_id X, Y" pattern: ${match}`);
    const realId1 = toRealId(Number(id1));
    const realId2 = toRealId(Number(id2));
    if (realId1 && realId2) {
      const result = `[Event](${realId1}), [Event](${realId2})`;
      log(`[TMDBG IDTranslator Exception] Converted to: ${result}`);
      return result;
    }
    return match;
  });
  
  return processed;
}

// Process object data to convert Thunderbird real IDs to LLM numeric IDs
function processObjectTBtoLLM(obj, overrideCtx) {
  if (!obj || typeof obj !== 'object') return obj;

  if (Array.isArray(obj)) {
    return obj.map(item => processObjectTBtoLLM(item, overrideCtx));
  }

  const processed = {};
  for (const [key, value] of Object.entries(obj)) {
    // Handle all ID fields uniformly (including camelCase variants)
    if ((key === 'unique_id' || key === 'UniqueID' || key === 'uniqueId' ||
         key === 'event_id' || key === 'EventID' || key === 'eventId' ||
         key === 'contact_id' || key === 'ContactID' || key === 'contactId' ||
         key === 'calendar_id' || key === 'CalendarID' || key === 'calendarId' ||
         key === 'addressbook_id' || key === 'AddressbookID' || key === 'addressbookId') &&
        typeof value === 'string') {
      log(`[TMDBG IDTranslator] Processing object field: ${key} = ${value}`);
      const numericId = toNumericId(value, overrideCtx);
      processed[key] = numericId || value;
      log(`[TMDBG IDTranslator] Object field result: ${key} = ${processed[key]}`);
    } else if (typeof value === 'string' &&
               (value.includes('unique_id:') || value.includes('contact_id:') ||
                value.includes('event_id:') || value.includes('calendar_id:') ||
                value.includes('addressbook_id:'))) {
      // Process string fields that contain ID patterns (like 'results' field)
      log(`[TMDBG IDTranslator] Processing string field '${key}' with ID patterns: ${value.substring(0, 100)}...`);
      processed[key] = processStringTBtoLLM(value, overrideCtx);
      log(`[TMDBG IDTranslator] String field result: ${processed[key].substring(0, 100)}...`);
    } else {
      processed[key] = processObjectTBtoLLM(value, overrideCtx);
    }
  }
  return processed;
}

// Process tool result data to convert Thunderbird real IDs to LLM numeric IDs
export function processToolResultTBtoLLM(result, overrideCtx) {
  if (!result) return result;

  try {
    log(`[TMDBG IDTranslator] processToolResultTBtoLLM called with: ${typeof result}`);
    if (typeof result === 'string') {
      log(`[TMDBG IDTranslator] Processing string result: ${result.substring(0, 200)}...`);
      return processStringTBtoLLM(result, overrideCtx);
    } else if (typeof result === 'object' && result !== null) {
      log(`[TMDBG IDTranslator] Processing object result: ${JSON.stringify(result).substring(0, 200)}...`);
      return processObjectTBtoLLM(result, overrideCtx);
    }
    return result;
  } catch (e) {
    log(`[TMDBG IDTranslator] Error processing tool result TBtoLLM: ${e}`, "error");
    return result;
  }
}

// Process LLM response to convert numeric IDs back to Thunderbird real IDs for display
export function processLLMResponseLLMtoTB(response) {
  if (!response) return response;
  
  try {
    if (typeof response === 'string') {
      return processStringLLMtoTB(response);
    } else if (typeof response === 'object' && response !== null) {
      const processed = { ...response };
      if (processed.assistant && typeof processed.assistant === 'string') {
        processed.assistant = processStringLLMtoTB(processed.assistant);
      }
      return processed;
    }
    return response;
  } catch (e) {
    log(`[TMDBG IDTranslator] Error processing LLM response LLMtoTB: ${e}`, "error");
    return response;
  }
}

// Get the current ID map for debugging
export function getIdMap() {
  return new Map(ctx.idTranslation.idMap);
}

// Reset the ID translation cache for the current session
export function resetIdTranslationCache() {
  ctx.idTranslation.idMap.clear();
  ctx.idTranslation.nextNumericId = 1;
  ctx.idTranslation.lastAccessed = Date.now();
  log(`[TMDBG IDTranslator] Reset ID translation cache`);
}

// Restore an idMap from serialized entries (e.g., from a persisted proactive check-in session).
// Merges into the current map so any existing mappings are preserved.
export function restoreIdMap(entries) {
  if (!Array.isArray(entries)) return;
  const idTranslation = ctx.idTranslation;
  let restored = 0;
  for (const [numericId, realId] of entries) {
    if (typeof numericId === "number" && typeof realId === "string") {
      idTranslation.idMap.set(numericId, realId);
      restored++;
      // Advance nextNumericId past any restored IDs to avoid collisions
      if (numericId >= idTranslation.nextNumericId) {
        idTranslation.nextNumericId = numericId + 1;
      }
    }
  }
  idTranslation.lastAccessed = Date.now();
  log(`[TMDBG IDTranslator] Restored ${restored} entries from serialized idMap`);
}

/**
 * Merge idMap entries from a headless session into the active chat window's map.
 * Handles conflicts: if a headless numericId is already used for a different realId,
 * assigns a new numericId and rewrites references in the message.
 *
 * @param {Array<[number, string]>} entries - Serialized idMap from headless session
 * @param {string} message - Proactive message containing [Email](numericId) references
 * @returns {string} - Message with numericIds remapped to the chat window's map
 */
export function mergeIdMapFromHeadless(entries, message) {
  if (!Array.isArray(entries) || !entries.length) return message;

  const idTranslation = ctx.idTranslation;
  const remapTable = new Map(); // headless numericId → chat numericId

  for (const [headlessNumericId, realId] of entries) {
    if (typeof headlessNumericId !== "number" || typeof realId !== "string") continue;

    // Check if this realId already exists in the chat's map
    let existingNumericId = null;
    for (const [numId, mappedRealId] of idTranslation.idMap.entries()) {
      if (mappedRealId === realId) {
        existingNumericId = numId;
        break;
      }
    }

    if (existingNumericId !== null) {
      // realId already mapped — reuse existing numeric ID
      remapTable.set(headlessNumericId, existingNumericId);
    } else if (!idTranslation.idMap.has(headlessNumericId)) {
      // No conflict — add directly with same numeric ID
      idTranslation.idMap.set(headlessNumericId, realId);
      if (headlessNumericId >= idTranslation.nextNumericId) {
        idTranslation.nextNumericId = headlessNumericId + 1;
      }
      remapTable.set(headlessNumericId, headlessNumericId);
    } else {
      // Conflict: headlessNumericId already maps to a different realId
      const newNumericId = idTranslation.nextNumericId++;
      idTranslation.idMap.set(newNumericId, realId);
      remapTable.set(headlessNumericId, newNumericId);
    }
  }

  idTranslation.lastAccessed = Date.now();

  // Rewrite entity references in the message using the remap table
  const remappedMessage = message.replace(
    /\[(Email|Contact|Event)\]\((\d+(?::\d+)?)\)/g,
    (match, type, idPart) => {
      if (idPart.includes(":")) {
        // Compound ID (e.g., calendar:event or addressbook:contact)
        const parts = idPart.split(":");
        const newParts = parts.map((p) => {
          const oldNum = Number(p);
          return remapTable.has(oldNum) ? String(remapTable.get(oldNum)) : p;
        });
        return `[${type}](${newParts.join(":")})`;
      }
      const oldNum = Number(idPart);
      if (remapTable.has(oldNum)) {
        return `[${type}](${remapTable.get(oldNum)})`;
      }
      return match;
    }
  );

  const remappedCount = [...remapTable.entries()].filter(([o, n]) => o !== n).length;
  log(
    `[TMDBG IDTranslator] mergeIdMapFromHeadless: merged ${entries.length} entries, ` +
    `${remappedCount} needed remapping, map now has ${idTranslation.idMap.size} entries`
  );

  return remappedMessage;
}

// Get translation statistics for debugging
export function getTranslationStats() {
  return {
    totalMappings: ctx.idTranslation.idMap.size,
    nextNumericId: ctx.idTranslation.nextNumericId,
    lastAccessed: ctx.idTranslation.lastAccessed,
    mappings: Array.from(ctx.idTranslation.idMap.entries()).map(([numericId, realId]) => ({
      numericId,
      realId,
      type: realId.includes(':') && realId.includes('@') ? 'email' : 
            realId.includes('@') ? 'contact' : 
            realId.includes('_') && realId.includes('@') ? 'event' : 'unknown'
    }))
  };
}

// ---------------------------------------------------------------------------
// Per-turn ID reference bookkeeping
// ---------------------------------------------------------------------------

/**
 * Collect all numeric IDs referenced in a turn by running its content through
 * the LLM-to-TB translation pipeline. This uses toRealId as the chokepoint —
 * every pattern (standard, exception, loose) funnels through it, so we capture
 * all IDs without duplicating regex logic.
 *
 * @param {object} turn - A persisted turn object
 * @returns {number[]} Array of unique numeric IDs referenced in this turn
 */
export function collectTurnRefs(turn) {
  const collector = new Set();
  _activeRefsCollector = collector;
  try {
    // Process assistant content through the full LLM->TB pipeline
    if (turn.content && turn.content !== "chat_converse") {
      processStringLLMtoTB(turn.content);
    }
    // Also process user_message (user turns may contain [Email](N) references)
    if (turn.user_message) {
      processStringLLMtoTB(turn.user_message);
    }
  } finally {
    _activeRefsCollector = null;
  }
  return Array.from(collector);
}

/**
 * Register a turn's refs in the global refCounts map. Call after creating a
 * turn and populating its _refs. Debounced persist.
 *
 * @param {object} turn - Turn with _refs populated
 */
export function registerTurnRefs(turn) {
  if (!turn._refs || turn._refs.length === 0) return;
  const refCounts = ctx.idTranslation.refCounts;
  for (const id of turn._refs) {
    refCounts.set(id, (refCounts.get(id) || 0) + 1);
  }
  persistIdMap();
}

/**
 * Internal: decrement refCounts for a turn's refs, freeing IDs that drop to 0.
 * Does NOT persist — caller is responsible for batching and calling persistIdMap().
 *
 * @param {object} turn - Turn with _refs populated
 * @returns {number} Count of IDs freed (removed from idMap, added to freeIds)
 */
function _unregisterRefsInternal(turn) {
  if (!turn._refs || turn._refs.length === 0) return 0;
  const idTranslation = ctx.idTranslation;
  const refCounts = idTranslation.refCounts;
  if (!idTranslation.freeIds) idTranslation.freeIds = [];
  let freedCount = 0;
  for (const id of turn._refs) {
    const current = refCounts.get(id) || 0;
    if (current <= 1) {
      refCounts.delete(id);
      // Free this ID: remove from idMap, add to freeIds pool
      if (idTranslation.idMap.has(id)) {
        idTranslation.idMap.delete(id);
        idTranslation.freeIds.push(id);
        freedCount++;
      }
    } else {
      refCounts.set(id, current - 1);
    }
  }
  return freedCount;
}

/**
 * Unregister a single turn's refs and persist. Use for one-off removals
 * (e.g. retryLastMessage popping a turn, nudge removal).
 *
 * @param {object} turn - Turn with _refs populated
 */
export function unregisterTurnRefs(turn) {
  const freedCount = _unregisterRefsInternal(turn);
  if (freedCount > 0 || (turn._refs && turn._refs.length > 0)) {
    persistIdMap();
  }
}

/**
 * One-time migration helper: build refCounts from all turns' _refs arrays.
 * Also sweeps orphan IDs (in idMap but not referenced by any turn).
 * Persists the result immediately.
 *
 * @param {object[]} turns - All persisted turns (must have _refs populated)
 */
export function buildRefCounts(turns) {
  const idTranslation = ctx.idTranslation;
  const refCounts = new Map();

  // Build counts from all turns
  for (const turn of turns) {
    if (!turn._refs) continue;
    for (const id of turn._refs) {
      refCounts.set(id, (refCounts.get(id) || 0) + 1);
    }
  }

  // Sweep orphan IDs: in idMap but not referenced by any turn
  if (!idTranslation.freeIds) idTranslation.freeIds = [];
  let orphanCount = 0;
  for (const [numericId] of idTranslation.idMap.entries()) {
    if (!refCounts.has(numericId)) {
      idTranslation.idMap.delete(numericId);
      idTranslation.freeIds.push(numericId);
      orphanCount++;
    }
  }

  idTranslation.refCounts = refCounts;
  log(`[TMDBG IDTranslator] buildRefCounts: ${refCounts.size} IDs referenced, ${orphanCount} orphans freed`);
  persistIdMap();
}

/**
 * Clean up idMap entries for evicted turns.
 * Uses per-turn _refs metadata and refCounts for O(k) cleanup where k = refs in evicted turns.
 *
 * @param {object[]} evictedTurns - Turns that were just evicted (must have _refs)
 */
export function cleanupEvictedIds(evictedTurns) {
  try {
    if (!evictedTurns || evictedTurns.length === 0) return;

    // Batch unregister all evicted turns' refs (no per-turn persist)
    let totalFreed = 0;
    for (const turn of evictedTurns) {
      totalFreed += _unregisterRefsInternal(turn);
    }

    if (totalFreed > 0) {
      const idTranslation = ctx.idTranslation;
      log(`[TMDBG IDTranslator] cleanupEvictedIds: freed ${totalFreed} IDs from ${evictedTurns.length} evicted turns, freeIds pool now ${idTranslation.freeIds.length}`);
    }

    // Single persist for the whole batch
    persistIdMap();
  } catch (e) {
    log(`[TMDBG IDTranslator] cleanupEvictedIds error: ${e}`, "error");
  }
}

// Remap any numeric IDs that currently point to oldRealId so they point to newRealId
export function remapUniqueId(oldRealId, newRealId) {
  try {
    if (!oldRealId || !newRealId || typeof oldRealId !== 'string' || typeof newRealId !== 'string') {
      log(`[TMDBG IDTranslator] remapUniqueId invalid args old='${oldRealId}' new='${newRealId}'`, "warn");
      return 0;
    }
    const idMap = ctx.idTranslation.idMap;

    let updatedCount = 0;
    for (const [numericId, mappedRealId] of idMap.entries()) {
      if (mappedRealId === oldRealId) {
        idMap.set(numericId, newRealId);
        updatedCount++;
        // log(`[TMDBG IDTranslator remapUniqueId] Remapped numericId=${numericId} from '${oldRealId}' -> '${newRealId}'`);
      }
    }
    if (updatedCount === 0) {
      // log(`[TMDBG IDTranslator remapUniqueId] No mappings found for old='${oldRealId}' (no-op)`);
    } else {
      ctx.idTranslation.lastAccessed = Date.now();
      // log(`[TMDBG IDTranslator remapUniqueId] Remap complete count=${updatedCount}`);
    }
    return updatedCount;
  } catch (e) {
    log(`[TMDBG IDTranslator remapUniqueId] error: ${e}`, "error");
    return 0;
  }
}