// mentionAutocomplete.js – @ mention UI for email selection in chat
// Thunderbird 142 MV3
//
// ID TRANSLATION FLOW:
// 1. Email cache stores realIds (from uniqueId field in inbox data)
// 2. User selects email → convert realId to numericId using toNumericId()
// 3. Insert [Email](numericId) into user's message text
// 4. User message goes to LLM with numericId in markdown format
// 5. When displaying (user or agent message):
//    - renderMarkdown() calls processLLMResponseLLMtoTB()
//    - Converts [Email](numericId) → [Email](realId)
//    - Creates clickable link using realId
//
// This matches the existing ID translation system used throughout TabMail.

import { log } from "../../agent/modules/utils.js";
import { SETTINGS } from "../../agent/modules/config.js";
import { ctx } from "./context.js";
import { resolveContactDetails, resolveEventDetails } from "./entityResolver.js";
import { toNumericId } from "./idTranslator.js";

// Store email data for fuzzy matching - populated from inbox on init
let emailCache = [];

// Store idMap items (contacts, calendar events) for fuzzy matching
// These are items that have been mentioned in the chat conversation
let entityCache = [];

// Current autocomplete state
let autocompleteState = {
  isActive: false,
  query: "",
  matches: [],
  selectedIndex: 0,
  cursorPosition: 0,
  savedRange: null, // Save the selection range when @ is detected
};

/**
 * Update the email cache from inbox data
 * Should be called when inbox data is refreshed
 */
export async function updateEmailCacheForMentions(emails) {
  try {
    emailCache = (emails || []).map((email) => ({
      uniqueId: email.uniqueId || email.messageId,
      subject: email.subject || "(No subject)",
      from: email.from || "",
      to: email.to || "",
      date: email.date || "",
    }));
    
    // Sort by date descending (most recent first)
    emailCache.sort((a, b) => {
      const da = a.date ? new Date(a.date) : 0;
      const db = b.date ? new Date(b.date) : 0;
      return db - da;
    });

    // Cap to most recent N emails to prevent memory bloat on large inboxes
    const maxSize = SETTINGS?.memoryManagement?.emailCacheMaxSize || 2000;
    if (emailCache.length > maxSize) {
      emailCache = emailCache.slice(0, maxSize);
    }

    log(`[MentionAutocomplete] Updated email cache: ${emailCache.length} emails`, 'debug');
  } catch (e) {
    log(`[MentionAutocomplete] Failed to update email cache: ${e}`, "error");
  }
}

/**
 * Refresh the entity items cache from ctx.entityMap
 * This captures contacts and calendar events that have been mentioned in the chat
 * The entityMap is populated by idTranslator when it sees compound markdown links
 */
export async function refreshEntityCache() {
  try {
    const items = [];
    const entityMap = ctx.entityMap;
    
    if (!entityMap || entityMap.size === 0) {
      entityCache = [];
      log(`[MentionAutocomplete] entityMap is empty, cleared entityCache`, 'debug');
      return;
    }
    
    log(`[MentionAutocomplete] Scanning entityMap with ${entityMap.size} entries`, 'debug');
    
    for (const [compoundNumericId, entity] of entityMap.entries()) {
      log(`[MentionAutocomplete] Processing entity: ${compoundNumericId}, type=${entity.type}`, 'debug');
      
      if (entity.type === 'contact') {
        // Resolve contact details using the real contact ID
        const contactDetails = await resolveContactDetails(entity.realContactId);
        if (contactDetails) {
          log(`[MentionAutocomplete] Contact resolved: name="${contactDetails.name}", compoundId="${compoundNumericId}"`, 'debug');
          items.push({
            type: "contact",
            compoundId: compoundNumericId,
            realId: entity.realContactId,
            label: contactDetails.name,
            description: contactDetails.email ? `Contact • ${contactDetails.email}` : "Contact",
            searchFields: [contactDetails.name, contactDetails.email, ...contactDetails.emails].filter(Boolean),
          });
        } else {
          log(`[MentionAutocomplete] Failed to resolve contact: ${entity.realContactId}`, 'debug');
        }
      } else if (entity.type === 'event') {
        // Resolve event details using the real event ID
        const eventDetails = await resolveEventDetails(entity.realEventId);
        if (eventDetails) {
          log(`[MentionAutocomplete] Event resolved: title="${eventDetails.title}", compoundId="${compoundNumericId}"`, 'debug');
          items.push({
            type: "event",
            compoundId: compoundNumericId,
            realId: entity.realEventId,
            label: eventDetails.title,
            description: eventDetails.startDate ? `Event • ${eventDetails.startDate}` : "Event",
            searchFields: [eventDetails.title, eventDetails.startDate, eventDetails.location].filter(Boolean),
          });
        } else {
          log(`[MentionAutocomplete] Failed to resolve event: ${entity.realEventId}`, 'debug');
        }
      }
    }
    
    entityCache = items;
    log(`[MentionAutocomplete] Refreshed entityCache: ${items.length} items (contacts/events)`, 'debug');
  } catch (e) {
    log(`[MentionAutocomplete] Failed to refresh entityCache: ${e}`, "error");
    entityCache = [];
  }
}

/**
 * Check if query matches a field using substring matching
 * Returns score (lower = better match) or null if no match
 * Score is based on: prefix match (0-100), contains match (100-200), word boundary match (50-150)
 */
function getMatchScore(query, field) {
  if (!query || !field) return null;
  
  const queryLower = query.toLowerCase().trim();
  const fieldLower = field.toLowerCase();
  
  if (!queryLower) return null;
  
  // Prefix match (best score: 0-100, based on how much of the field is matched)
  if (fieldLower.startsWith(queryLower)) {
    return queryLower.length / fieldLower.length * 100;
  }
  
  // Word boundary match (score: 50-150)
  // Check if query matches the start of any word in the field
  const words = fieldLower.split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    if (words[i].startsWith(queryLower)) {
      return 50 + (i * 10) + (queryLower.length / words[i].length * 50);
    }
  }
  
  // Contains match (score: 100-200)
  const index = fieldLower.indexOf(queryLower);
  if (index !== -1) {
    return 100 + (index / fieldLower.length * 100);
  }
  
  return null; // No match
}

/**
 * Fuzzy match idMap items (contacts, calendar events) by their searchable fields
 * Returns array of {item, score} sorted by score
 */
function fuzzyMatchIdMapItems(query, maxResults = 20) {
  const matches = [];
  
  for (const item of entityCache) {
    let bestScore = null;
    
    // Check each searchable field for a match
    for (const field of item.searchFields) {
      const score = getMatchScore(query, field);
      if (score !== null && (bestScore === null || score < bestScore)) {
        bestScore = score;
      }
    }
    
    if (bestScore !== null) {
      matches.push({
        item: item,
        score: bestScore,
      });
    }
  }
  
  // Sort by score (lower is better) and take top N
  matches.sort((a, b) => a.score - b.score);
  return matches.slice(0, maxResults);
}

/**
 * Get email data by ID - fetches live from Thunderbird, not cache
 * This ensures we have the same data that ID translator has
 */
async function getEmailById(uniqueId) {
  try {
    // Parse uniqueId and get the email header
    const { parseUniqueId, headerIDToWeID } = await import("../../agent/modules/utils.js");
    const parsed = parseUniqueId(uniqueId);
    if (parsed) {
      const { weFolder, headerID } = parsed;
      const weID = await headerIDToWeID(headerID, weFolder);
      if (weID) {
        const header = await browser.messages.get(weID);
        if (header) {
          // Extract to field from recipients
          const toRecipients = header.recipients || [];
          const toField = toRecipients.join(", ");
          return {
            uniqueId: uniqueId,
            subject: header.subject || "(No subject)",
            from: header.author || "",
            to: toField,
            date: header.date ? new Date(header.date) : null,
          };
        }
      }
    }
    
    // Fallback to cache if live fetch fails
    return emailCache.find((e) => e.uniqueId === uniqueId);
  } catch (e) {
    log(`[MentionAutocomplete] Failed to fetch email by ID: ${e}`, "warn");
    return emailCache.find((e) => e.uniqueId === uniqueId);
  }
}

/**
 * Create mention text from email data
 * Returns markdown format: [Email](id)
 * The markdown renderer will fetch and display the subject automatically
 */
function createMentionText(email, numericId) {
  // Use simple format that markdown renderer expects
  // The renderer will look up the email and show subject in tooltip
  return `[Email](${numericId})`;
}

/**
 * Initialize mention autocomplete on a contenteditable
 */
export function initMentionAutocomplete(contenteditable) {
  if (!contenteditable) {
    log(`[MentionAutocomplete] No contenteditable provided`, "warn");
    return;
  }

  // Create dropdown element
  const dropdown = document.createElement("div");
  dropdown.id = "mention-autocomplete-dropdown";
  dropdown.className = "mention-autocomplete-dropdown";
  dropdown.style.display = "none";
  
  // Prevent dropdown from stealing focus from contenteditable
  dropdown.addEventListener("mousedown", (e) => {
    e.preventDefault(); // Prevents focus loss
    log(`[MentionAutocomplete] Dropdown mousedown prevented default`, 'debug');
  });
  
  document.body.appendChild(dropdown);

  // Handle @ detection and query updates
  contenteditable.addEventListener("input", (e) => {
    handleInput(contenteditable, dropdown);
  });

  // Handle keyboard navigation
  contenteditable.addEventListener("keydown", (e) => {
    handleKeydown(e, contenteditable, dropdown);
  });

  // Close dropdown when clicking outside
  document.addEventListener("click", (e) => {
    if (e.target !== contenteditable && !dropdown.contains(e.target)) {
      closeAutocomplete(dropdown);
    }
  });

  log(`[MentionAutocomplete] Initialized on contenteditable`, 'debug');
}

/**
 * Get text content and cursor position from contenteditable
 */
function getContentEditableState(contenteditable) {
  const text = contenteditable.textContent || "";
  const selection = window.getSelection();
  let cursorPos = 0;
  
  if (selection.rangeCount > 0) {
    const range = selection.getRangeAt(0);
    const preCaretRange = range.cloneRange();
    preCaretRange.selectNodeContents(contenteditable);
    preCaretRange.setEnd(range.endContainer, range.endOffset);
    cursorPos = preCaretRange.toString().length;
  }
  
  return { text, cursorPos };
}

/**
 * Handle input event on contenteditable
 */
async function handleInput(contenteditable, dropdown) {
  const { text, cursorPos } = getContentEditableState(contenteditable);
  
  // Find @ symbol before cursor
  let atPos = -1;
  for (let i = cursorPos - 1; i >= 0; i--) {
    if (text[i] === "@") {
      // Check if @ is at start or preceded by whitespace
      if (i === 0 || /\s/.test(text[i - 1])) {
        atPos = i;
        break;
      }
    }
    // Allow spaces in query - don't exit @ mode on whitespace
  }

  if (atPos === -1) {
    // No @ found, close autocomplete
    closeAutocomplete(dropdown);
    return;
  }

  // Extract query from @ to cursor
  const query = text.substring(atPos + 1, cursorPos);
  
  // Cancel @ mode if query starts with space (@ followed immediately by space)
  if (query.startsWith(" ")) {
    closeAutocomplete(dropdown);
    return;
  }
  
  // Save current selection range for later restoration (update on every input)
  const selection = window.getSelection();
  if (selection.rangeCount > 0) {
    autocompleteState.savedRange = selection.getRangeAt(0).cloneRange();
  }
  
  // If @ was just detected (not active yet), log it
  if (!autocompleteState.isActive) {
    log(`[MentionAutocomplete] @ detected at position ${atPos}, query: "${query}"`, 'debug');
  }
  
  // Update state and show autocomplete
  autocompleteState.isActive = true;
  autocompleteState.query = query;
  autocompleteState.cursorPosition = atPos;
  autocompleteState.selectedIndex = 0;
  
  // Notify chat that autocomplete is active
  window.mentionAutocompleteActive = true;
  log(`[MentionAutocomplete] Set mentionAutocompleteActive = true`, 'debug');

  // Get matches (async now)
  await updateMatches(query);
  
  // Show dropdown
  showAutocomplete(contenteditable, dropdown, atPos);
}

/**
 * Update matches based on query
 */
async function updateMatches(query) {
  const matches = [];
  
  // Refresh idMap items cache to catch any new contacts/events mentioned in chat
  await refreshEntityCache();

  // If query is empty, show only selected emails (quick reference to current selection)
  if (!query.trim()) {
    // Show ALL selected emails (no limit)
    if (ctx.selectedMessageIds && ctx.selectedMessageIds.length > 0) {
      for (let i = 0; i < ctx.selectedMessageIds.length; i++) {
        const selectedId = ctx.selectedMessageIds[i];
        const email = await getEmailById(selectedId);
        
        if (email) {
          matches.push({
            type: "selected",
            email: email,
            label: email.subject || "(No subject)",
            description: `Selected • From: ${email.from}`,
          });
        }
      }
    }
    
    // If no selected emails, show recent emails as fallback
    if (matches.length === 0) {
      const recentEmails = emailCache.slice(0, 10);
      recentEmails.forEach((email) => {
        matches.push({
          type: "recent",
          email: email,
          label: email.subject || "(No subject)",
          description: `From: ${email.from}`,
        });
      });
    }
  } else {
    // Query is not empty - show fuzzy matches from emails AND idMap items
    const emailFuzzyMatches = fuzzyMatchEmails(query, 30); // Up to 30 email matches
    const idMapFuzzyMatches = fuzzyMatchIdMapItems(query, 20); // Up to 20 idMap matches
    
    // Add email matches
    emailFuzzyMatches.forEach((match) => {
      matches.push({
        type: "fuzzy",
        email: match.email,
        label: match.email.subject,
        description: `From: ${match.email.from}`,
        score: match.score,
      });
    });
    
    // Add idMap matches (contacts, events)
    idMapFuzzyMatches.forEach((match) => {
      matches.push({
        type: match.item.type, // "contact" or "event"
        idMapItem: match.item,
        label: match.item.label,
        description: match.item.description,
        score: match.score,
      });
    });
    
    // Sort combined matches by score
    matches.sort((a, b) => (a.score || 0) - (b.score || 0));
    
    // Limit total results
    matches.splice(50);
  }

  autocompleteState.matches = matches;
  log(`[MentionAutocomplete] Found ${matches.length} matches for query "${query}"`, 'debug');
}

/**
 * Fuzzy match emails by subject, from, and to fields
 * Uses substring matching - query must be contained in the field
 * Returns array of {email, score} sorted by score
 */
function fuzzyMatchEmails(query, maxResults = 3) {
  const matches = [];

  emailCache.forEach((email) => {
    const subject = email.subject || "";
    const from = email.from || "";
    const to = email.to || "";
    
    // Build list of searchable fields
    const searchFields = [subject, from, to].filter(Boolean);
    
    // Find best match score across all fields
    let bestScore = null;
    for (const field of searchFields) {
      const score = getMatchScore(query, field);
      if (score !== null && (bestScore === null || score < bestScore)) {
        bestScore = score;
      }
    }
    
    if (bestScore !== null) {
      matches.push({
        email: email,
        score: bestScore,
      });
    }
  });

  // Sort by score (lower is better) and take top N
  matches.sort((a, b) => a.score - b.score);
  return matches.slice(0, maxResults);
}

/**
 * Show autocomplete dropdown
 */
function showAutocomplete(contenteditable, dropdown, atPos) {
  const matches = autocompleteState.matches;

  if (matches.length === 0) {
    closeAutocomplete(dropdown);
    return;
  }

  // Clear dropdown
  dropdown.innerHTML = "";

  // Create items
  matches.forEach((match, index) => {
    const item = document.createElement("div");
    item.className = "mention-autocomplete-item";
    if (index === autocompleteState.selectedIndex) {
      item.classList.add("selected");
    }

    const label = document.createElement("div");
    label.className = "mention-item-label";
    label.textContent = match.label;

    const description = document.createElement("div");
    description.className = "mention-item-description";
    description.textContent = match.description;

    item.appendChild(label);
    item.appendChild(description);

    // Click handler
    item.addEventListener("click", (e) => {
      log(`[MentionAutocomplete] Dropdown item clicked: index=${index}, label="${match.label}"`, 'debug');
      e.preventDefault();
      e.stopPropagation();
      log(`[MentionAutocomplete] Prevented default and stopped propagation`, 'debug');
      selectMatch(index, contenteditable, dropdown);
    });

    dropdown.appendChild(item);
  });

  // Position dropdown (dropup style - above contenteditable)
  positionDropdown(contenteditable, dropdown);

  dropdown.style.display = "block";
}

/**
 * Position dropdown relative to contenteditable
 */
function positionDropdown(contenteditable, dropdown) {
  const rect = contenteditable.getBoundingClientRect();
  
  dropdown.style.position = "fixed";
  dropdown.style.bottom = `${window.innerHeight - rect.top + 5}px`; // 5px gap above input
  dropdown.style.left = `${rect.left}px`;
  dropdown.style.width = `${rect.width}px`;
  // max-height is set in CSS (300px), scrollbar appears automatically
}

/**
 * Close autocomplete dropdown
 */
function closeAutocomplete(dropdown) {
  log(`[MentionAutocomplete] closeAutocomplete called`, "trace");
  dropdown.style.display = "none";
  autocompleteState.isActive = false;
  autocompleteState.query = "";
  autocompleteState.matches = [];
  autocompleteState.selectedIndex = 0;
  autocompleteState.savedRange = null; // Clear saved range
  
  // Notify chat that autocomplete is no longer active
  window.mentionAutocompleteActive = false;
  log(`[MentionAutocomplete] Set mentionAutocompleteActive = false`, "trace");
}

/**
 * Handle keydown events for navigation
 */
function handleKeydown(e, contenteditable, dropdown) {
  if (!autocompleteState.isActive) return;

  const matches = autocompleteState.matches;

  if (e.key === "ArrowDown") {
    // Navigate down
    e.preventDefault();
    e.stopImmediatePropagation();
    autocompleteState.selectedIndex = (autocompleteState.selectedIndex + 1) % matches.length;
    updateDropdownSelection(dropdown);
  } else if (e.key === "ArrowUp") {
    // Navigate up
    e.preventDefault();
    e.stopImmediatePropagation();
    autocompleteState.selectedIndex = (autocompleteState.selectedIndex - 1 + matches.length) % matches.length;
    updateDropdownSelection(dropdown);
  } else if (e.key === "Tab" || e.key === "Enter") {
    // Select current match (both Tab and Enter)
    if (matches.length > 0) {
      log(`[MentionAutocomplete] ${e.key} pressed in autocomplete, selecting match and blocking propagation`, 'debug');
      e.preventDefault();
      e.stopImmediatePropagation(); // Prevent chat's Enter/Tab handler from firing
      selectMatch(autocompleteState.selectedIndex, contenteditable, dropdown);
      return;
    }
  } else if (e.key === "Escape") {
    // Close autocomplete
    e.preventDefault();
    e.stopImmediatePropagation();
    closeAutocomplete(dropdown);
  }
}

/**
 * Update dropdown visual selection
 */
function updateDropdownSelection(dropdown) {
  const items = dropdown.querySelectorAll(".mention-autocomplete-item");
  items.forEach((item, index) => {
    if (index === autocompleteState.selectedIndex) {
      item.classList.add("selected");
      // Scroll selected item into view
      item.scrollIntoView({ block: "nearest", behavior: "smooth" });
    } else {
      item.classList.remove("selected");
    }
  });
}

/**
 * Select a match and insert chip into contenteditable
 */
async function selectMatch(index, contenteditable, dropdown) {
  log(`[MentionAutocomplete] selectMatch called: index=${index}`, 'debug');
  const match = autocompleteState.matches[index];
  if (!match) {
    log(`[MentionAutocomplete] No match found at index ${index}`, "warn");
    return;
  }
  
  log(`[MentionAutocomplete] Match found: type="${match.type}", label="${match.label}"`, 'debug');
  
  // Determine numeric ID, label, and chip display based on match type
  let numericId = null;
  let chipLabel = "";
  let chipEmoji = "";
  let chipTitle = "";
  let markdownType = "";
  
  if (match.type === "contact" || match.type === "event") {
    // Entity item (contact or calendar event) from entityMap
    const item = match.idMapItem;
    // Use compound ID directly - this is the full "parent:child" format
    numericId = item.compoundId;
    chipLabel = item.label;
    chipTitle = item.label;
    
    if (match.type === "contact") {
      chipEmoji = "👤";
      markdownType = "Contact";
      log(`[MentionAutocomplete] Using contact compound ID for chip: ${numericId}`, 'debug');
    } else {
      chipEmoji = "📅";
      markdownType = "Event";
      log(`[MentionAutocomplete] Using event compound ID for chip: ${numericId}`, 'debug');
    }
  } else {
    // Email (selected, recent, or fuzzy match)
    const email = match.email;
    
    // Convert real ID to numeric ID for LLM
    try {
      numericId = toNumericId(email.uniqueId);
      if (!numericId && numericId !== 0) {
        log(`[MentionAutocomplete] Failed to convert ID to numeric: ${email.uniqueId}`, "error");
        return; // Abort if ID conversion fails
      }
    } catch (e) {
      log(`[MentionAutocomplete] Exception during ID conversion: ${e}`, "error");
      return; // Abort if ID conversion throws
    }
    
    chipLabel = email.subject || `Email ${numericId}`;
    chipTitle = email.subject || `Email ${numericId}`;
    chipEmoji = "📧";
    markdownType = "Email";
  }
  
  // Truncate chip label if too long
  if (chipLabel.length > 30) {
    chipLabel = chipLabel.substring(0, 27) + "...";
  }

  // Restore saved selection range (important for click events where focus is lost)
  const selection = window.getSelection();
  if (autocompleteState.savedRange) {
    log(`[MentionAutocomplete] Restoring saved selection range`, 'debug');
    selection.removeAllRanges();
    selection.addRange(autocompleteState.savedRange.cloneRange());
    contenteditable.focus();
  }

  // Delete @ and query text
  if (selection.rangeCount > 0) {
    const { text } = getContentEditableState(contenteditable);
    const atPos = autocompleteState.cursorPosition;
    
    // Create new range to select @ and query
    const deleteRange = document.createRange();
    deleteRange.setStart(contenteditable.firstChild || contenteditable, 0);
    deleteRange.setEnd(contenteditable.firstChild || contenteditable, 0);
    
    // Walk through text nodes to find the @ position
    let charCount = 0;
    const walker = document.createTreeWalker(contenteditable, NodeFilter.SHOW_TEXT, null, false);
    let node;
    
    while ((node = walker.nextNode())) {
      const nodeLength = node.textContent.length;
      if (charCount + nodeLength >= atPos) {
        deleteRange.setStart(node, atPos - charCount);
        break;
      }
      charCount += nodeLength;
    }
    
    // Set end to include the query text
    const queryEndPos = atPos + 1 + autocompleteState.query.length;
    charCount = 0;
    const walker2 = document.createTreeWalker(contenteditable, NodeFilter.SHOW_TEXT, null, false);
    let node2;
    
    while ((node2 = walker2.nextNode())) {
      const nodeLength = node2.textContent.length;
      if (charCount + nodeLength >= queryEndPos) {
        deleteRange.setEnd(node2, queryEndPos - charCount);
        break;
      }
      charCount += nodeLength;
    }
    
    log(`[MentionAutocomplete] Deleting range from @ to end of query`, 'debug');
    deleteRange.deleteContents();
    
    // Create chip element
    const chip = document.createElement("span");
    chip.className = "email-mention-chip";
    chip.contentEditable = "false"; // Make chip non-editable
    chip.dataset.numericId = numericId;
    chip.dataset.markdownType = markdownType; // "Email", "Contact", or "Event"
    chip.textContent = `${chipEmoji} ${chipLabel}`;
    chip.title = chipTitle;
    
    // Prevent chip from being dragged or causing weird selection behavior
    chip.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };
    
    // Delete button
    const deleteBtn = document.createElement("span");
    deleteBtn.className = "chip-delete";
    deleteBtn.textContent = "×";
    deleteBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      chip.remove();
      contenteditable.focus();
    };
    chip.appendChild(deleteBtn);
    
    // Insert chip
    deleteRange.insertNode(chip);
    
    // Add space after chip
    const space = document.createTextNode(" ");
    chip.parentNode.insertBefore(space, chip.nextSibling);
    
    // Move cursor after space
    const newRange = document.createRange();
    newRange.setStartAfter(space);
    newRange.collapse(true);
    selection.removeAllRanges();
    selection.addRange(newRange);
  }

  // Close autocomplete
  log(`[MentionAutocomplete] Closing autocomplete dropdown`, 'debug');
  closeAutocomplete(dropdown);

  // Debug: log contenteditable state
  log(`[MentionAutocomplete] Contenteditable innerHTML: "${contenteditable.innerHTML}"`, 'debug');
  log(`[MentionAutocomplete] Contenteditable textContent: "${contenteditable.textContent}"`, 'debug');
  log(`[MentionAutocomplete] Contenteditable isEmpty: ${contenteditable.childNodes.length === 0}`, 'debug');
  log(`[MentionAutocomplete] Contenteditable data-placeholder: "${contenteditable.getAttribute('data-placeholder')}"`, 'debug');

  // Trigger input event
  log(`[MentionAutocomplete] Triggering input event`, 'debug');
  contenteditable.dispatchEvent(new Event("input", { bubbles: true }));

  log(`[MentionAutocomplete] Inserted chip for ${markdownType} ${numericId}`, 'debug');
}

/**
 * Extract markdown text from contenteditable (convert chips to [Type](id))
 * Supports Email, Contact, and Event markdown types
 */
export function extractMarkdownFromContentEditable(contenteditable) {
  const clone = contenteditable.cloneNode(true);
  
  // Replace all chip elements with [Type](id) text
  const chips = clone.querySelectorAll(".email-mention-chip");
  chips.forEach((chip) => {
    const numericId = chip.dataset.numericId;
    const markdownType = chip.dataset.markdownType || "Email"; // Default to Email for backwards compatibility
    const textNode = document.createTextNode(`[${markdownType}](${numericId})`);
    chip.parentNode.replaceChild(textNode, chip);
  });
  
  return clone.textContent || "";
}

/**
 * Clear contenteditable content
 */
export function clearContentEditable(contenteditable) {
  contenteditable.innerHTML = "";
}

/**
 * Render email mentions as inline chips overlaying the textarea (DEPRECATED - using contenteditable now)
 */
async function renderMentionChips_DEPRECATED(textarea) {
  try {
    // Get or create overlay container
    let overlay = document.getElementById("mention-chips-overlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "mention-chips-overlay";
      overlay.className = "mention-chips-overlay";
      const inputContainer = document.getElementById("input-container");
      if (inputContainer) {
        inputContainer.insertBefore(overlay, textarea);
      } else {
        textarea.parentNode.insertBefore(overlay, textarea);
      }
    }

    // Clear overlay
    overlay.innerHTML = "";

    const text = textarea.value;
    const mentionPattern = /\[Email\]\((\d+)\)/g;
    
    // Parse text and build overlay content
    let lastIndex = 0;
    let match;
    const fragments = [];

    while ((match = mentionPattern.exec(text)) !== null) {
      // Add text before mention
      if (match.index > lastIndex) {
        const beforeText = text.substring(lastIndex, match.index);
        fragments.push({ type: "text", content: beforeText });
      }

      // Add mention chip
      const numericId = match[1];
      
      // Get email subject for display
      let subject = `Email ${numericId}`;
      try {
        const { toRealId } = await import("./idTranslator.js");
        const realId = toRealId(Number(numericId));
        if (realId) {
          const { parseUniqueId, headerIDToWeID } = await import("../../agent/modules/utils.js");
          const parsed = parseUniqueId(realId);
          if (parsed) {
            const { weFolder, headerID } = parsed;
            const weID = await headerIDToWeID(headerID, weFolder);
            if (weID) {
              const header = await browser.messages.get(weID);
              if (header && header.subject) {
                subject = header.subject.length > 30 
                  ? header.subject.substring(0, 27) + "..." 
                  : header.subject;
              }
            }
          }
        }
      } catch (e) {
        log(`[MentionAutocomplete] Failed to fetch email subject: ${e}`, "warn");
      }
      
      fragments.push({ 
        type: "mention", 
        numericId: numericId,
        subject: subject,
        fullMatch: match[0],
        startIndex: match.index,
        endIndex: match.index + match[0].length
      });

      lastIndex = match.index + match[0].length;
    }

    // Add remaining text
    if (lastIndex < text.length) {
      fragments.push({ type: "text", content: text.substring(lastIndex) });
    }

    // Render fragments - ONLY render mention chips, not text
    for (const fragment of fragments) {
      if (fragment.type === "text") {
        // Don't render text in overlay - let textarea show it
        // Just add spacing to maintain position
        const spacer = document.createElement("span");
        spacer.className = "mention-overlay-spacer";
        spacer.textContent = fragment.content;
        spacer.style.visibility = "hidden"; // Hidden but maintains layout
        overlay.appendChild(spacer);
      } else if (fragment.type === "mention") {
        const chip = document.createElement("span");
        chip.className = "mention-chip-overlay";
        chip.textContent = `📧 ${fragment.subject}`;
        chip.dataset.numericId = fragment.numericId;
        chip.dataset.startIndex = fragment.startIndex;
        chip.dataset.endIndex = fragment.endIndex;
        chip.title = `Email ${fragment.numericId}`;
        
        // Delete button
        const deleteBtn = document.createElement("span");
        deleteBtn.className = "mention-chip-delete-btn";
        deleteBtn.textContent = "×";
        deleteBtn.onclick = (e) => {
          e.stopPropagation();
          deleteMention(textarea, fragment.startIndex, fragment.endIndex);
        };
        
        chip.appendChild(deleteBtn);
        overlay.appendChild(chip);
      }
    }

    // Show/hide overlay and adjust textarea visibility
    const hasMentions = fragments.some(f => f.type === "mention");
    overlay.style.display = hasMentions ? "block" : "none";
    
    // Instead of making textarea transparent, hide the mention text specifically
    if (hasMentions) {
      // Use a CSS approach to hide [Email](id) text in textarea
      textarea.classList.add("has-mention-chips");
    } else {
      textarea.classList.remove("has-mention-chips");
    }
  } catch (e) {
    log(`[MentionAutocomplete] Failed to render mention chips: ${e}`, "error");
  }
}

/**
 * Delete a mention from the textarea
 */
function deleteMention(textarea, startIndex, endIndex) {
  try {
    const text = textarea.value;
    const before = text.substring(0, startIndex);
    const after = text.substring(endIndex);
    
    // Remove the mention and any trailing space
    let newText = before + after;
    if (newText[startIndex] === " ") {
      newText = before + after.substring(1);
    }
    
    textarea.value = newText;
    
    // Update cursor position
    textarea.setSelectionRange(startIndex, startIndex);
    
    // Re-render chips
    renderMentionChips(textarea);
    
    // Trigger input event
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    
    log(`[MentionAutocomplete] Deleted mention at ${startIndex}-${endIndex}`, 'debug');
  } catch (e) {
    log(`[MentionAutocomplete] Failed to delete mention: ${e}`, "error");
  }
}

/**
 * Clean up mention autocomplete
 */
export function cleanupMentionAutocomplete() {
  try {
    const dropdown = document.getElementById("mention-autocomplete-dropdown");
    if (dropdown) {
      dropdown.remove();
    }
    
    // Clear local caches
    emailCache = [];
    entityCache = [];
    
    // Clear entityMap
    if (ctx.entityMap) {
      ctx.entityMap.clear();
    }
    
    log(`[MentionAutocomplete] Cleaned up`, 'debug');
  } catch (e) {
    log(`[MentionAutocomplete] Failed to clean up: ${e}`, "error");
  }
}

