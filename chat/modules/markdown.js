// markdown.js – very small Markdown renderer for chat bubbles (TB 140 MV3)
// Supports: fenced code (```), inline code (`code`), links [t](url), bold **text**, italics *text*,
// ATX headers (#, ##, ### ...), nested lists (unordered: - item, ordered: 1. item), blockquotes (> text), 
// GitHub-style tables, and basic paragraphs with <br/> for single newlines.
// Special links: [Email](unique_id), [Contact](contact_id), [Event](calendar_id:event_id)
// Shorthand special links: (email 1), (contact 1), (event 1) - converted to full format
// No external deps; outputs minimal, sanitized HTML.

import { log, normalizeUnicode } from "../../agent/modules/utils.js";
import { resolveContactDetails, resolveEventDetails } from "./entityResolver.js";
import { getGenericTimezoneAbbr } from "./helpers.js";

// Module-local config (avoid magic numbers in logic)
const MARKDOWN_RENDERER_CONFIG = {
  // If a fenced code block contains NO real newlines but DOES contain many literal "\n" sequences,
  // it's likely double-escaped (e.g., from JSON). Convert those to real newlines for display.
  minEscapedNewlinesToConvertInCodeFence: 2,
  // Heuristic: if escaped newlines dominate real newlines by this ratio, treat the block as escaped.
  // (This avoids converting intentional "\n" inside code strings in most cases.)
  escapedToRealNewlineDominanceRatio: 2,
};

// Save markdown resolution failure logs to the logs folder
async function saveMarkdownResolutionLog(type, id, beforeTranslation, afterTranslation, errorMsg) {
  try {
    // Check if logging is enabled (import SETTINGS dynamically to avoid circular deps)
    const { SETTINGS } = await import("../../agent/modules/config.js");
    if (!SETTINGS.debugMode) return;

    const timestamp = Date.now();
    const payload = {
      type: type,
      id: id,
      errorMsg: errorMsg || "Resolution failed",
      beforeTranslation: beforeTranslation,
      afterTranslation: afterTranslation,
      timestamp: new Date().toISOString()
    };

    const blob = new Blob([
      JSON.stringify(payload, null, 2)
    ], { type: "application/json" });

    const url = URL.createObjectURL(blob);
    const sanitizedType = type.toLowerCase().replace(/[^a-z0-9]/g, "_");
    const sanitizedId = String(id).replace(/[^a-z0-9]/gi, "_").substring(0, 50);
    const filename = `${SETTINGS.logFolder || "logs"}/markdown_${sanitizedType}_${sanitizedId}_${timestamp}.json`;
    
    await browser.downloads.download({ url, filename, saveAs: false });
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    
    log(`[TMDBG Markdown] Saved resolution failure log: ${filename}`);
  } catch (e) {
    log(`[TMDBG Markdown] Failed to save resolution log: ${e}`, "warn");
  }
}

function escapeHtml(input) {
  if (typeof input !== "string") return "";
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function sanitizeUrl(rawUrl) {
  try {
    const trimmed = String(rawUrl || "").trim();
    const lower = trimmed.toLowerCase();
    if (lower.startsWith("http://") || lower.startsWith("https://") || lower.startsWith("mailto:")) {
      return trimmed;
    }
  } catch (e) {
    log(`[TMDBG Markdown] sanitizeUrl failed: ${e}`, "warn");
  }
  return "#";
}

/**
 * Unwraps fenced blocks of the form:
 * ```markdown
 * ...markdown...
 * ```
 *
 * Many LLMs wrap markdown examples (like tables) inside ```markdown fences, which makes them
 * render as code instead of actual markdown. We treat ```markdown / ```md fences as "container"
 * markers and unwrap them so their content renders normally.
 *
 * Also, LLMs sometimes *nest* fences inside the ```markdown block (e.g., inner ```python). Standard
 * markdown doesn't support nested fences, so we rewrite inner backtick fences to tildes (~~~) so
 * they won't prematurely close the outer wrapper, and we can still render them as code blocks.
 *
 * @param {string} input
 * @returns {{ text: string, unwrapped: number, rewrittenInnerFences: number }}
 */
function unwrapMarkdownFenceContainers(input) {
  try {
    const src = String(input || "");
    const lines = src.split(/\r?\n/);
    const out = [];

    let inMarkdownFence = false;
    let inInnerCodeBlock = false; // Track if we're inside a nested code block
    let unwrapped = 0;
    let rewrittenInnerFences = 0;

    for (const rawLine of lines) {
      const line = String(rawLine ?? "");

      if (!inMarkdownFence) {
        // Start of wrapper fence (no lang variants other than markdown/md are unwrapped)
        if (/^\s*```(?:markdown|md)\s*$/i.test(line)) {
          inMarkdownFence = true;
          unwrapped += 1;
          continue; // drop the wrapper start fence
        }
        out.push(line);
        continue;
      }

      // We are inside a markdown wrapper fence
      
      if (inInnerCodeBlock) {
        // We're inside an inner code block (e.g., ```python ... ```)
        // Look for its closing fence (bare ``` or ~~~)
        if (/^\s*```\s*$/.test(line) || /^\s*~~~\s*$/.test(line)) {
          // Close of inner code block - rewrite to ~~~
          out.push("~~~");
          inInnerCodeBlock = false;
          continue;
        }
        // Regular content inside inner code block - pass through as-is
        out.push(line);
        continue;
      }
      
      // Not inside an inner code block
      if (/^\s*```\s*$/.test(line)) {
        // Bare ``` is the close of the outer markdown wrapper
        inMarkdownFence = false;
        continue; // drop the wrapper end fence
      }

      // Check for start of inner code block (``` with optional language tag)
      if (/^\s*```[\w+-]*\s*$/.test(line)) {
        // Start of inner code block - rewrite to ~~~
        rewrittenInnerFences += 1;
        out.push(line.replace(/```/, "~~~"));
        inInnerCodeBlock = true;
        continue;
      }

      out.push(line);
    }

    if (inMarkdownFence) {
      // Wrapper fence never closed; keep content but warn loudly
      log(`[TMDBG Markdown] Warning: markdown fence wrapper was not closed (unwrapped=${unwrapped})`, "warn");
    }

    return { text: out.join("\n"), unwrapped, rewrittenInnerFences };
  } catch (e) {
    log(`[TMDBG Markdown] unwrapMarkdownFenceContainers failed: ${e}`, "warn");
    return { text: String(input || ""), unwrapped: 0, rewrittenInnerFences: 0 };
  }
}

// Special link handlers for TabMail entities
async function handleEmailClick(uniqueId) {
  try {
    log(`[TMDBG Markdown] Opening email: ${uniqueId}`);
    // Parse unique_id to get folderUri and headerID
    const { parseUniqueId, headerIDToWeID } = await import("../../agent/modules/utils.js");
    const parsed = parseUniqueId(uniqueId);
    if (!parsed) {
      log(`[TMDBG Markdown] Failed to parse email unique_id: ${uniqueId}`, "error");
      return;
    }
    
    const { weFolder, headerID } = parsed;
    
    // Convert headerMessageId to WebExtension message ID (weID)
    const weID = await headerIDToWeID(headerID, weFolder);
    if (!weID) {
      log(`[TMDBG Markdown] Failed to resolve headerID to weID: ${headerID}`, "error");
      return;
    }
    
    log(`[TMDBG Markdown] Resolved email ${uniqueId} -> headerID: ${headerID}, weID: ${weID}`);
    
    // Try to open the email in Thunderbird's thread view
    try {
      await browser.runtime.sendMessage({
        command: "openEmailInThread",
        uniqueId: uniqueId,
        weFolder: weFolder,
        headerID: headerID,
        weID: weID
      });
    } catch (e) {
      log(`[TMDBG Markdown] Failed to open email: ${e}`, "error");
    }
  } catch (e) {
    log(`[TMDBG Markdown] Email click handler failed: ${e}`, "error");
  }
}

async function handleContactClick(contactId) {
  try {
    log(`[TMDBG Markdown] Opening contact: ${contactId}`);
    // Try to open the contact in Thunderbird's address book
    try {
      await browser.runtime.sendMessage({
        command: "openContactInAddressBook",
        contactId: contactId
      });
    } catch (e) {
      log(`[TMDBG Markdown] Failed to open contact: ${e}`, "error");
    }
  } catch (e) {
    log(`[TMDBG Markdown] Contact click handler failed: ${e}`, "error");
  }
}

async function handleEventClick(calendarId, eventId) {
  try {
    log(`[TMDBG Markdown] Opening calendar event: ${calendarId}:${eventId}`);
    // Try to open the calendar event in Thunderbird's calendar view
    try {
      await browser.runtime.sendMessage({
        command: "openCalendarEvent",
        calendarId: calendarId,
        eventId: eventId
      });
    } catch (e) {
      log(`[TMDBG Markdown] Failed to open calendar event: ${e}`, "error");
    }
  } catch (e) {
    log(`[TMDBG Markdown] Calendar event click handler failed: ${e}`, "error");
  }
}

// Parse nested lists (ordered and unordered) with proper indentation handling
function parseNestedList(lines, startIndex) {
  const listItems = [];
  let i = startIndex;
  
  // Determine base indentation from first item
  const firstMatch = lines[i].match(/^(\s*)([0-9]+\.|-)\s+(.*)$/);
  if (!firstMatch) {
    return { html: "", nextIndex: startIndex };
  }
  
  const baseIndent = firstMatch[1].length;
  const isOrdered = /^\d+\.$/.test(firstMatch[2]);
  const listTag = isOrdered ? "ol" : "ul";
  
  log(`[TMDBG Markdown] Starting ${isOrdered ? 'ordered' : 'unordered'} list at line ${startIndex}, baseIndent=${baseIndent}`);
  
  // Collect all items at this indentation level and deeper
  while (i < lines.length) {
    const line = lines[i];
    
    // Skip blank lines within the list (allow spacing between items)
    if (line.trim() === '') {
      // Look ahead to see if there's another list item coming
      let lookahead = i + 1;
      while (lookahead < lines.length && lines[lookahead].trim() === '') {
        lookahead++;
      }
      if (lookahead < lines.length) {
        const nextMatch = lines[lookahead].match(/^(\s*)([0-9]+\.|-)\s+(.*)$/);
        if (nextMatch && nextMatch[1].length >= baseIndent) {
          // There's another list item after blank lines, skip the blanks
          i = lookahead;
          continue;
        }
      }
      // No more list items, end the list
      break;
    }
    
    const match = line.match(/^(\s*)([0-9]+\.|-)\s+(.*)$/);
    
    if (!match) {
      // Not a list item, end of this list
      break;
    }
    
    const indent = match[1].length;
    const marker = match[2];
    const content = match[3];
    
    if (indent < baseIndent) {
      // Less indented than our level, this belongs to parent list
      break;
    }
    
    if (indent === baseIndent) {
      // Same level item
      const itemIsOrdered = /^\d+\.$/.test(marker);
      
      // Check if list type changed at same level (switch from ul to ol or vice versa)
      if ((itemIsOrdered && !isOrdered) || (!itemIsOrdered && isOrdered)) {
        // List type changed, end current list
        break;
      }
      
      // Collect this item's content
      listItems.push({ content, indent });
      i += 1;
      
      // Check if next line is a nested list (more indented)
      if (i < lines.length) {
        const nextMatch = lines[i].match(/^(\s*)([0-9]+\.|-)\s+(.*)$/);
        if (nextMatch && nextMatch[1].length > baseIndent) {
          // Parse nested list
          const nested = parseNestedList(lines, i);
          // Append nested list to the last item
          listItems[listItems.length - 1].nested = nested.html;
          i = nested.nextIndex;
        }
      }
    } else if (indent > baseIndent) {
      // This shouldn't happen as we handle nested lists above, but just in case
      // Parse as nested list
      const nested = parseNestedList(lines, i);
      if (listItems.length > 0) {
        listItems[listItems.length - 1].nested = nested.html;
      }
      i = nested.nextIndex;
    }
  }
  
  // Build HTML
  const itemsHtml = listItems.map(item => {
    let html = `<li>${item.content}`;
    if (item.nested) {
      html += item.nested;
    }
    html += `</li>`;
    return html;
  }).join("");
  
  const finalHtml = `<${listTag}>${itemsHtml}</${listTag}>`;
  log(`[TMDBG Markdown] Completed ${listTag} with ${listItems.length} items, nextIndex=${i}`);
  
  return { html: finalHtml, nextIndex: i };
}

export async function renderMarkdown(mdText) {
  try {
    if (!mdText) return "";
    let src = String(mdText);
    
    // DIAGNOSTIC: Log input BEFORE any processing
    const inputNewlines = (src.match(/\n/g) || []).length;
    const inputEscapedNewlines = (src.match(/\\n/g) || []).length;
    const hasCodeFence = src.includes("```");
    log(`[TMDBG Markdown] INPUT: len=${src.length}, realNewlines=${inputNewlines}, escapedNewlines=${inputEscapedNewlines}, hasCodeFence=${hasCodeFence}, first150=${JSON.stringify(src.slice(0, 150))}`);
    
    src = normalizeUnicode(src);

    // Store original markdown before translation for logging
    const srcBeforeTranslation = src;
    
    // ID Translation: Convert numeric IDs to real IDs for display
    try {
      const { processLLMResponseLLMtoTB } = await import("./idTranslator.js");
      src = processLLMResponseLLMtoTB(src);
      log(`[TMDBG Markdown] Converted numeric IDs to real IDs for display`);
    } catch (e) {
      log(`[TMDBG Markdown] ID translation for display failed: ${e}`, "warn");
    }
    
    // Store markdown after translation for logging
    const srcAfterTranslation = src;

    // Unwrap ```markdown / ```md container fences so markdown content (tables, quotes, lists)
    // renders as markdown instead of code. Also rewrites nested inner ``` fences to ~~~.
    try {
      const unwrap = unwrapMarkdownFenceContainers(src);
      if (unwrap.unwrapped > 0) {
        src = unwrap.text;
        log(`[TMDBG Markdown] Unwrapped markdown fence container(s): ${unwrap.unwrapped}, rewrittenInnerFences=${unwrap.rewrittenInnerFences}`);
      }
    } catch (e) {
      log(`[TMDBG Markdown] markdown fence unwrap failed: ${e}`, "warn");
    }

    // Collect fenced code blocks first to avoid formatting inside them
    const codeBlockHtml = [];
    // Support both LF and CRLF newlines (we may receive CRLF from some providers / logs)
    src = src.replace(/```([\w+-]*)\r?\n([\s\S]*?)```/g, (_, lang, code) => {
      const idx = codeBlockHtml.length;
      const safeLang = (lang || "").trim().toLowerCase().slice(0, 32);
      let rawCode = String(code || "");
      
      // DIAGNOSTIC: Log exactly what we extracted from the code fence
      const actualNewlines = (rawCode.match(/\n/g) || []).length;
      const escapedNewlines = (rawCode.match(/\\n/g) || []).length;
      log(`[TMDBG Markdown] Code fence EXTRACTION: lang=${safeLang || "none"}, len=${rawCode.length}, realNewlines=${actualNewlines}, escapedNewlines=${escapedNewlines}, first100=${JSON.stringify(rawCode.slice(0, 100))}`);
      
      try {
        if (
          escapedNewlines >= (MARKDOWN_RENDERER_CONFIG.minEscapedNewlinesToConvertInCodeFence || 0) &&
          escapedNewlines >
            actualNewlines * (MARKDOWN_RENDERER_CONFIG.escapedToRealNewlineDominanceRatio || 1)
        ) {
          rawCode = rawCode.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n");
          log(
            `[TMDBG Markdown] Converted escaped \\\\n sequences to real newlines in fenced code block (lang=${safeLang || "none"}, escapedNewlines=${escapedNewlines}, actualNewlines=${actualNewlines})`
          );
        }
      } catch (e) {
        log(`[TMDBG Markdown] Code fence newline normalization failed: ${e}`, "warn");
      }
      const safeCode = escapeHtml(rawCode);
      const cls = safeLang ? ` class="language-${safeLang}"` : "";
      codeBlockHtml.push(`<pre><code${cls}>${safeCode}</code></pre>`);
      return `@@CODEBLOCK_${idx}@@`;
    });
    // Support tilde fences too (used when unwrapping nested fences inside ```markdown containers)
    src = src.replace(/~~~([\w+-]*)\r?\n([\s\S]*?)~~~/g, (_, lang, code) => {
      const idx = codeBlockHtml.length;
      const safeLang = (lang || "").trim().toLowerCase().slice(0, 32);
      let rawCode = String(code || "");
      try {
        const actualNewlines = (rawCode.match(/\n/g) || []).length;
        const escapedNewlines = (rawCode.match(/\\n/g) || []).length;
        if (
          escapedNewlines >= (MARKDOWN_RENDERER_CONFIG.minEscapedNewlinesToConvertInCodeFence || 0) &&
          escapedNewlines >
            actualNewlines * (MARKDOWN_RENDERER_CONFIG.escapedToRealNewlineDominanceRatio || 1)
        ) {
          rawCode = rawCode.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n");
          log(
            `[TMDBG Markdown] Converted escaped \\\\n sequences to real newlines in tilde-fenced code block (lang=${safeLang || "none"}, escapedNewlines=${escapedNewlines}, actualNewlines=${actualNewlines})`
          );
        }
      } catch (e) {
        log(`[TMDBG Markdown] Tilde code fence newline normalization failed: ${e}`, "warn");
      }
      const safeCode = escapeHtml(rawCode);
      const cls = safeLang ? ` class="language-${safeLang}"` : "";
      codeBlockHtml.push(`<pre><code${cls}>${safeCode}</code></pre>`);
      return `@@CODEBLOCK_${idx}@@`;
    });
    if (src.includes("```") && codeBlockHtml.length === 0) {
      try {
        const hasCR = src.includes("\r");
        const newlineCount = (src.match(/\n/g) || []).length;
        log(`[TMDBG Markdown] Detected fenced marker but extracted 0 code blocks (hasCR=${hasCR}, newlines=${newlineCount})`, "warn");
      } catch (_) {}
    }

    // Convert shorthand special link patterns to full format BEFORE processing inline code
    // (contact 1) -> [Contact](1), (email 1) -> [Email](1), (event 1) -> [Event](1)
    src = src.replace(/\((email|contact|event)\s+([^\)]+?)\)/gi, (match, type, id) => {
      const capitalizedType = type.charAt(0).toUpperCase() + type.slice(1).toLowerCase();
      log(`[TMDBG Markdown] Converting shorthand ${match} to [${capitalizedType}](${id.trim()})`);
      return `[${capitalizedType}](${id.trim()})`;
    });
    
    // Special TabMail links: [Email](unique_id), [Contact](contact_id), [Event](calendar_id:event_id)
    // Extract these BEFORE inline code backticks so backtick-wrapped links are still recognized
    const specialLinkHtml = [];
    const specialLinkMatches = [];
    
    // First, find all special links (even if wrapped in backticks)
    src = src.replace(/`?\[(Email|Contact|Event)\]\(([^\)]+?)\)`?/g, (match, type, id) => {
      const idx = specialLinkMatches.length;
      specialLinkMatches.push({ type, id, idx });
      log(`[TMDBG Markdown] Found special link (possibly backtick-wrapped): ${match} -> [${type}](${id})`);
      return `@@SPECIAL_LINK_${idx}@@`;
    });

    // Inline code – match single backticks (don't match across newlines, require at least one char)
    // This runs AFTER special links so backtick-wrapped links are already extracted
    const inlineCodeHtml = [];
    src = src.replace(/`([^`\n]+)`/g, (_, code) => {
      const idx = inlineCodeHtml.length;
      inlineCodeHtml.push(`<code>${escapeHtml(code)}</code>`);
      return `@@CODE_${idx}@@`;
    });
    
    // Process each special link with async data gathering
    for (const match of specialLinkMatches) {
      const { type, id, idx } = match;
      const safeId = escapeHtml(id);
      
      let className = "tm-link";
      let dataType = "";
      let dataId = "";
      let icon = "";
      let displayText = "";
      let tooltipData = null;
      
      try {
        if (type === "Email") {
          className += " tm-email-link";
          dataType = "email";
          dataId = safeId;
          icon = "📧"; // Email envelope emoji
          
          // Gather email data upfront
          const { parseUniqueId, headerIDToWeID } = await import("../../agent/modules/utils.js");
          const parsed = parseUniqueId(id);
          if (parsed) {
            const { weFolder, headerID } = parsed;
            const weID = await headerIDToWeID(headerID, weFolder);
            if (weID) {
              const header = await browser.messages.get(weID);
              if (header) {
                displayText = header.subject || "No subject";
                tooltipData = {
                  subject: header.subject || "No subject",
                  from: header.author || "Unknown sender",
                  to: header.recipients?.join(", ") || "Unknown recipients"
                };
              }
            }
          }
          
          if (!displayText) {
            log(`[TMDBG Markdown] Failed to resolve email: ${id}, hiding item`, "warn");
            // Save failure log with before/after translation
            await saveMarkdownResolutionLog("Email", id, srcBeforeTranslation, srcAfterTranslation, "Failed to resolve email");
            // Hide failed resolutions - LLM mistake we cannot recover from
            specialLinkHtml[idx] = "";
            continue;
          }
          
        } else if (type === "Contact") {
          className += " tm-contact-link";
          dataType = "contact";
          dataId = safeId;
          icon = "👤"; // Person emoji
          
          // Handle compound contact IDs (addressbook_id:contact_id)
          let contactId = id;
          if (id.includes(':')) {
            const parts = id.split(':');
            if (parts.length === 2) {
              const expectedAddressbookId = parts[0]; // Address book ID
              contactId = parts[1]; // Contact ID
              log(`[TMDBG Markdown] Extracted from compound ID: addressbook='${expectedAddressbookId}', contact='${contactId}'`);
            }
          }
          
          // Gather contact data upfront using shared resolver
          try {
            const contactDetails = await resolveContactDetails(contactId);
            if (contactDetails) {
              displayText = contactDetails.name || "Unknown contact";
              tooltipData = {
                name: displayText,
                emails: contactDetails.emails.slice(0, 4), // Limit to 4 emails max
                primaryEmail: contactDetails.email || "Unknown email"
              };
            }
          } catch (e) {
            log(`[TMDBG Markdown] Failed to resolve contact: ${contactId} (from compound ID: ${id}), error: ${e}`, "warn");
            // Save failure log with before/after translation
            await saveMarkdownResolutionLog("Contact", id, srcBeforeTranslation, srcAfterTranslation, `Failed to resolve contact: ${e}`);
          }
          
          if (!displayText) {
            log(`[TMDBG Markdown] Failed to resolve contact: ${id}, hiding item`, "warn");
            // Save failure log with before/after translation
            await saveMarkdownResolutionLog("Contact", id, srcBeforeTranslation, srcAfterTranslation, "Contact resolution returned no data");
            // Hide failed resolutions - LLM mistake we cannot recover from
            specialLinkHtml[idx] = "";
            continue;
          }
          
        } else if (type === "Event") {
          className += " tm-event-link";
          dataType = "event";
          dataId = safeId;
          icon = "📅"; // Calendar emoji
          
          // Handle compound event IDs (calendar_id:event_id)
          let eventId = id;
          if (id.includes(':')) {
            const parts = id.split(':');
            if (parts.length === 2) {
              eventId = parts[1]; // Event ID
              log(`[TMDBG Markdown] Extracted event ID from compound: ${eventId}`);
            }
          }
          
          // Gather calendar event data upfront using shared resolver
          try {
            const eventDetails = await resolveEventDetails(eventId);
            if (eventDetails && eventDetails.ok) {
              displayText = eventDetails.title || "Untitled event";
              // Use the same pattern as calendarDelete.js - pass directly to Date constructor
              const startTime = eventDetails.start ? new Date(eventDetails.start).toLocaleString() : "Unknown start time";
              const endTime = eventDetails.end ? new Date(eventDetails.end).toLocaleString() : "Unknown end time";
              
              tooltipData = {
                title: displayText,
                startTime: startTime,
                endTime: endTime,
                attendees: eventDetails.attendees,
                attendeeList: eventDetails.attendeeList,
                organizer: eventDetails.organizer,
                location: eventDetails.location
              };
            }
          } catch (e) {
            log(`[TMDBG Markdown] Failed to resolve calendar event: ${id}, error: ${e}`, "warn");
            // Save failure log with before/after translation
            await saveMarkdownResolutionLog("Event", id, srcBeforeTranslation, srcAfterTranslation, `Failed to resolve event: ${e}`);
          }
          
          if (!displayText) {
            log(`[TMDBG Markdown] Failed to resolve event: ${id}, hiding item`, "warn");
            // Save failure log with before/after translation
            await saveMarkdownResolutionLog("Event", id, srcBeforeTranslation, srcAfterTranslation, "Event resolution returned no data");
            // Hide failed resolutions - LLM mistake we cannot recover from
            specialLinkHtml[idx] = "";
            continue;
          }
        }
      } catch (e) {
        log(`[TMDBG Markdown] Error gathering data for ${type}: ${e}, hiding item`, "warn");
        // Save failure log with before/after translation
        await saveMarkdownResolutionLog(type, id, srcBeforeTranslation, srcAfterTranslation, `Error gathering data: ${e}`);
        // Hide failed resolutions - LLM mistake we cannot recover from
        specialLinkHtml[idx] = "";
        continue;
      }
      
      // Truncate display text if too long
      const maxLength = 30;
      if (displayText.length > maxLength) {
        displayText = displayText.substring(0, maxLength - 3) + "...";
      }
      
      const safeDisplayText = escapeHtml(displayText);
      const tooltipDataAttr = tooltipData ? ` data-tm-tooltip='${escapeHtml(JSON.stringify(tooltipData))}'` : '';
      
      specialLinkHtml[idx] = `<a href="#" class="${className}" data-tm-type="${dataType}" data-tm-id="${dataId}"${tooltipDataAttr}>${icon} ${safeDisplayText}</a>`;
    }

    // Regular links [text](url)
    const linkHtml = [];
    src = src.replace(/\[([^\]]+?)\]\(([^\)\s]+?)\)/g, (_, text, url) => {
      const idx = linkHtml.length;
      const safeText = escapeHtml(text);
      const safeUrl = sanitizeUrl(url);
      linkHtml.push(`<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeText}</a>`);
      return `@@LINK_${idx}@@`;
    });

    // Process tables before HTML escaping to preserve HTML entities and tags in cells
    const tableData = [];
    const tableTempLines = src.split(/\r?\n/);
    const linesWithTableMarkers = [];
    let lineIdx = 0;
    while (lineIdx < tableTempLines.length) {
      const line = tableTempLines[lineIdx];
      // GitHub-style table detection
      if (/^\s*\|.+\|\s*$/.test(line)) {
        const tableLines = [];
        while (lineIdx < tableTempLines.length && /^\s*\|.+\|\s*$/.test(tableTempLines[lineIdx])) {
          tableLines.push(tableTempLines[lineIdx].trim());
          lineIdx += 1;
        }
        if (tableLines.length >= 2) {
          const tableIdx = tableData.length;
          // Store the raw table lines for later processing
          tableData.push(tableLines);
          // Replace with placeholder
          linesWithTableMarkers.push(`@@TABLE_${tableIdx}@@`);
          log(`[TMDBG Markdown] Marked table ${tableIdx} with ${tableLines.length} lines for processing`);
          continue;
        } else {
          // Not enough lines for a valid table, treat as regular text
          log(`[TMDBG Markdown] Skipping invalid table with only ${tableLines.length} line(s)`);
          linesWithTableMarkers.push(...tableLines);
          continue;
        }
      }
      linesWithTableMarkers.push(tableTempLines[lineIdx]);
      lineIdx += 1;
    }
    src = linesWithTableMarkers.join("\n");

    // Process reminder cards before blockquotes
    // Format: [reminder] content - renders as styled card with dismiss button
    // Hashes are linked post-hoc by index via getDisplayedReminderHashes()
    const reminderPattern = /^\[reminder\]\s*/;
    const reminderLines = src.split(/\r?\n/);
    const linesWithReminderMarkers = [];
    let reminderCount = 0;
    for (let ri = 0; ri < reminderLines.length; ri++) {
      const line = reminderLines[ri];
      const match = line.match(reminderPattern);
      if (match) {
        const content = line.replace(reminderPattern, "").trimEnd();
        // Mark with index only - hash will be looked up post-hoc
        linesWithReminderMarkers.push(`@@REMINDER_${reminderCount}@@`);
        linesWithReminderMarkers.push(content);
        linesWithReminderMarkers.push(`@@REMINDER_END_${reminderCount}@@`);
        reminderCount += 1;
        log(`[TMDBG Markdown] Marked reminder ${reminderCount - 1}`);
      } else {
        linesWithReminderMarkers.push(line);
      }
    }
    src = linesWithReminderMarkers.join("\n");

    // Process blockquotes before HTML escaping to preserve > character
    // Replace > with markers so the content can go through inline formatting
    const blockquoteLines = src.split(/\r?\n/);
    const linesWithBlockquoteMarkers = [];
    let bqIdx = 0;
    let blockquoteCount = 0;
    while (bqIdx < blockquoteLines.length) {
      const line = blockquoteLines[bqIdx];
      if (/^\s*>\s?/.test(line)) {
        const startIdx = blockquoteCount;
        const quoteLines = [];
        while (bqIdx < blockquoteLines.length && /^\s*>\s?/.test(blockquoteLines[bqIdx])) {
          // Strip one leading ">" and optional space and keep the content
          const stripped = blockquoteLines[bqIdx].replace(/^\s*>\s?/, "").trimEnd();
          quoteLines.push(stripped);
          bqIdx += 1;
        }
        // Mark the start and end, with content in between that will be processed
        linesWithBlockquoteMarkers.push(`@@BLOCKQUOTE_START_${startIdx}@@`);
        linesWithBlockquoteMarkers.push(...quoteLines);
        linesWithBlockquoteMarkers.push(`@@BLOCKQUOTE_END_${startIdx}@@`);
        blockquoteCount += 1;
        log(`[TMDBG Markdown] Marked blockquote ${startIdx} with ${quoteLines.length} lines for processing`);
      } else {
        linesWithBlockquoteMarkers.push(line);
        bqIdx += 1;
      }
    }
    src = linesWithBlockquoteMarkers.join("\n");

    // Handle literal <br> sequences using placeholders so they don't split table rows.
    // We first count potential occurrences for diagnostics, then capture them.
    const brHtml = [];
    try {
      const plainBrCount = (src.match(/<br\s*\/?>(?![^@]*@@)/gi) || []).length;
      const entBrCount = (src.match(/&lt;br\s*\/?&gt;(?![^@]*@@)/gi) || []).length;
      const totalBr = plainBrCount + entBrCount;
      if (totalBr > 0) {
        log(`[TMDBG Markdown] Capturing ${totalBr} '<br>'-like sequences as placeholders (pre-escape)`);
      }
      src = src.replace(/(?:<br\s*\/?>(?![^@]*@@))|(?:&lt;br\s*\/?&gt;(?![^@]*@@))/gi, () => {
        const idx = brHtml.length;
        brHtml.push("<br/>");
        return `@@BR_${idx}@@`;
      });
    } catch (e) {
      log(`[TMDBG Markdown] br placeholder capture failed: ${e}`, "warn");
    }

    // Escape remaining text now that placeholders are inserted
    src = escapeHtml(src);

    // Bold then italics (non-greedy, don't match across newlines)
    // Bold: match **text** without crossing newlines
    src = src.replace(/\*\*([^\n]+?)\*\*/g, '<strong>$1</strong>');
    // Italic: match *text* but not **text** (lookbehind/lookahead prevent matching ** boundaries)
    // Don't cross newlines, exclude asterisks from content to avoid **bold*
    src = src.replace(/(?<!\*)\*(?!\*)([^\n*]+)\*(?!\*)/g, '<em>$1</em>');

    // Restore placeholders for links and code
    src = src.replace(/@@SPECIAL_LINK_(\d+)@@/g, (_, i) => specialLinkHtml[Number(i)] || "");
    src = src.replace(/@@LINK_(\d+)@@/g, (_, i) => linkHtml[Number(i)] || "");
    src = src.replace(/@@CODE_(\d+)@@/g, (_, i) => inlineCodeHtml[Number(i)] || "");
    // Restore <br> placeholders as actual HTML line breaks
    if (brHtml.length > 0) {
      const beforeRestoreLen = brHtml.length;
      src = src.replace(/@@BR_(\d+)@@/g, (_, i) => brHtml[Number(i)] || "");
      log(`[TMDBG Markdown] Restored ${beforeRestoreLen} '<br>' placeholders to <br/>`);
    }

    // NOTE: Code block placeholders (@@CODEBLOCK_N@@) are restored AFTER block building.
    // Restoring them here would inject <pre><code>...\n...\n...</code></pre> into `src`,
    // and the newlines inside would be treated as separate lines, breaking code blocks.

    // Build block-level structure: headers, tables, lists, and paragraphs
    const lines = src.split(/\r?\n/);
    const blocks = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      // ATX headers: up to 3 leading spaces, then 1-6 '#', a space, then text; optional closing hashes
      const mHdr = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (mHdr) {
        const level = Math.min(6, Math.max(1, mHdr[1].length));
        const text = mHdr[2];
        blocks.push(`<h${level}>${text}</h${level}>`);
        i += 1;
        continue;
      }

      // Table placeholder - handle as a block element
      const tableMatch = line.match(/^@@TABLE_(\d+)@@$/);
      if (tableMatch) {
        blocks.push(line); // Keep the placeholder, will restore later
        i += 1;
        continue;
      }

      // Code block placeholder - handle as a block element.
      // If we don't treat it as a block, it can end up inside <p>...</p> and get <br/> inserted,
      // which breaks streaming (the UI expects top-level <pre> blocks).
      const codeMatch = line.match(/^@@CODEBLOCK_(\d+)@@$/);
      if (codeMatch) {
        blocks.push(line); // Keep the placeholder, will restore later
        i += 1;
        continue;
      }

      // Reminder markers - collect content and create styled card with dismiss button
      // Format: @@REMINDER_idx@@ content @@REMINDER_END_idx@@
      // Hash is looked up post-hoc by index via data-reminder-index attribute
      const reminderStartMatch = line.match(/^@@REMINDER_(\d+)@@$/);
      if (reminderStartMatch) {
        const remIdx = reminderStartMatch[1];
        const remLines = [];
        i += 1; // Skip the START marker line
        // Collect lines until we hit the END marker
        let foundEnd = false;
        while (i < lines.length) {
          const endMatch = lines[i].match(/^@@REMINDER_END_(\d+)@@$/);
          if (endMatch && endMatch[1] === remIdx) {
            i += 1; // Skip the END marker line
            foundEnd = true;
            break;
          }
          remLines.push(lines[i]);
          i += 1;
        }
        if (!foundEnd) {
          log(`[TMDBG Markdown] Warning: reminder ${remIdx} END marker not found`, "warn");
        }
        // Build reminder card with content on left, dismiss button placeholder on right
        // The dismiss button gets its hash post-hoc via attachSpecialLinkListeners
        const inner = remLines.join("<br/>");
        blocks.push(`<div class="tm-reminder-card" data-reminder-index="${remIdx}"><span class="tm-reminder-card-text">${inner}</span><span class="tm-reminder-dismiss">don't show again</span></div>`);
        log(`[TMDBG Markdown] Assembled reminder ${remIdx}`);
        continue;
      }

      // Blockquote markers - collect content between START and END markers
      const bqStartMatch = line.match(/^@@BLOCKQUOTE_START_(\d+)@@$/);
      if (bqStartMatch) {
        const bqIdx = bqStartMatch[1];
        const bqLines = [];
        i += 1; // Skip the START marker line
        // Collect lines until we hit the END marker
        let foundEnd = false;
        while (i < lines.length) {
          const endMatch = lines[i].match(/^@@BLOCKQUOTE_END_(\d+)@@$/);
          if (endMatch && endMatch[1] === bqIdx) {
            i += 1; // Skip the END marker line
            foundEnd = true;
            break;
          }
          bqLines.push(lines[i]);
          i += 1;
        }
        if (!foundEnd) {
          log(`[TMDBG Markdown] Warning: blockquote ${bqIdx} END marker not found`, "warn");
        }
        // Join lines with <br/> and wrap in blockquote
        const inner = bqLines.join("<br/>");
        blocks.push(`<blockquote><p>${inner}</p></blockquote>`);
        log(`[TMDBG Markdown] Assembled blockquote ${bqIdx} with ${bqLines.length} processed lines`);
        continue;
      }

      // List block (ordered or unordered, with nesting support)
      // Match: optional indent + (digit+. or -) + space
      const listMatch = line.match(/^(\s*)([0-9]+\.|-)\s+(.*)$/);
      if (listMatch) {
        const listHtml = parseNestedList(lines, i);
        blocks.push(listHtml.html);
        i = listHtml.nextIndex;
        continue;
      }

      // Paragraph: collect until blank line or special placeholder
      const para = [];
      while (
        i < lines.length &&
        lines[i] !== "" &&
        !/^@@CODEBLOCK_\d+@@$/.test(lines[i]) &&
        !/^@@TABLE_\d+@@$/.test(lines[i]) &&
        !/^@@BLOCKQUOTE_START_\d+@@$/.test(lines[i]) &&
        !/^@@BLOCKQUOTE_END_\d+@@$/.test(lines[i]) &&
        !/^@@REMINDER_\d+@@$/.test(lines[i]) &&
        !/^@@REMINDER_END_\d+@@$/.test(lines[i]) &&
        !/^\s{0,3}#{1,6}\s+/.test(lines[i]) &&
        !/^\s*([0-9]+\.|-)\s+/.test(lines[i])  // Exclude both ordered and unordered lists
      ) {
        para.push(lines[i]);
        i += 1;
      }
      if (para.length > 0) {
        const pHtml = para.join("<br/>");
        blocks.push(`<p>${pHtml}</p>`);
      } else {
        // blank line
        i += 1;
      }
    }

    // Convert remaining <br> tags to proper line breaks after all block processing
    let out = blocks.join("\n");
    
    // Restore table placeholders with processed cell content
    if (tableData.length > 0) {
      out = out.replace(/@@TABLE_(\d+)@@/g, (_, idx) => {
        const tableLines = tableData[Number(idx)];
        if (!tableLines || tableLines.length < 2) return "";
        
        const header = tableLines[0];
        const alignLine = tableLines[1];
        const isDivider = /^\s*\|\s*(:?-+:?\s*\|\s*)+:?-+:?\s*\|?\s*$/.test(alignLine);
        const body = isDivider ? tableLines.slice(2) : tableLines.slice(1);
        
        // Process cells: escape HTML but preserve common HTML entities and <br> tags
        const processCellContent = (cellText) => {
          let processed = cellText.trim();
          
          // Restore link and code placeholders BEFORE escaping (they were added before table extraction)
          // These placeholders contain already-safe HTML that should not be escaped
          processed = processed.replace(/@@SPECIAL_LINK_(\d+)@@/g, (_, i) => specialLinkHtml[Number(i)] || "");
          processed = processed.replace(/@@LINK_(\d+)@@/g, (_, i) => linkHtml[Number(i)] || "");
          processed = processed.replace(/@@CODE_(\d+)@@/g, (_, i) => inlineCodeHtml[Number(i)] || "");
          
          // Temporarily protect <br> tags (with various formats)
          const brPlaceholders = [];
          processed = processed.replace(/<br\s*\/?>/gi, () => {
            const idx = brPlaceholders.length;
            brPlaceholders.push('<br/>');
            return `@@TABLECELL_BR_${idx}@@`;
          });
          
          // Temporarily protect HTML entities (named, decimal, and hex)
          const entityPlaceholders = [];
          processed = processed.replace(/&(nbsp|lt|gt|amp|quot|apos|#x[0-9a-fA-F]+|#\d+);/gi, (match) => {
            const idx = entityPlaceholders.length;
            entityPlaceholders.push(match);
            return `@@TABLECELL_ENTITY_${idx}@@`;
          });
          
          // Temporarily protect already-rendered HTML tags from link/code restoration
          const htmlTagPlaceholders = [];
          processed = processed.replace(/<[^>]+>/g, (match) => {
            const idx = htmlTagPlaceholders.length;
            htmlTagPlaceholders.push(match);
            return `@@TABLECELL_HTML_${idx}@@`;
          });
          
          // Now escape any remaining HTML (but not our protected placeholders)
          processed = escapeHtml(processed);
          
          // Restore HTML tags (from link/code restoration)
          processed = processed.replace(/@@TABLECELL_HTML_(\d+)@@/g, (_, i) => htmlTagPlaceholders[Number(i)] || '');
          
          // Apply markdown formatting to table cells (bold and italic)
          // Bold: match **text** without crossing newlines
          processed = processed.replace(/\*\*([^\n]+?)\*\*/g, '<strong>$1</strong>');
          // Italic: match *text* but not **text** (lookbehind/lookahead prevent matching ** boundaries)
          // Don't cross newlines, exclude asterisks from content to avoid **bold*
          processed = processed.replace(/(?<!\*)\*(?!\*)([^\n*]+)\*(?!\*)/g, '<em>$1</em>');
          
          // Restore entities
          processed = processed.replace(/@@TABLECELL_ENTITY_(\d+)@@/g, (_, i) => entityPlaceholders[Number(i)] || '');
          
          // Restore <br> tags
          processed = processed.replace(/@@TABLECELL_BR_(\d+)@@/g, (_, i) => brPlaceholders[Number(i)] || '');
          
          return processed;
        };
        
        const headerCells = header.split("|").slice(1, -1).map(processCellContent);
        const rows = body.map((r) => 
          r.split("|").slice(1, -1).map(processCellContent)
        );
        
        try {
          const colCounts = [headerCells.length, ...rows.map((r) => r.length)];
          const minCols = Math.min.apply(null, colCounts);
          const maxCols = Math.max.apply(null, colCounts);
          log(`[TMDBG Markdown] Restored table ${idx}: lines=${tableLines.length}, headerCols=${headerCells.length}, rows=${rows.length}, minCols=${minCols}, maxCols=${maxCols}, divider=${isDivider}`);
        } catch (e) {
          log(`[TMDBG Markdown] Table restore metrics failed: ${e}`, "warn");
        }
        
        const thead = `<thead><tr>${headerCells.map((c) => `<th>${c}</th>`).join("")}</tr></thead>`;
        const tbody = `<tbody>${rows
          .map((cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`)
          .join("")}</tbody>`;
        return `<table class="md-table">${thead}${tbody}</table>`;
      });
    }
    
    // Restore code block placeholders AFTER block building.
    // This ensures the <pre><code>...</code></pre> HTML is inserted as a complete block,
    // not split by newlines and treated as paragraph content.
    if (codeBlockHtml.length > 0) {
      const beforeRestore = (out.match(/@@CODEBLOCK_\d+@@/g) || []).length;
      out = out.replace(/@@CODEBLOCK_(\d+)@@/g, (_, i) => codeBlockHtml[Number(i)] || "");
      const afterRestore = (out.match(/@@CODEBLOCK_\d+@@/g) || []).length;
      log(`[TMDBG Markdown] Restored ${beforeRestore - afterRestore} code block placeholders (${beforeRestore} -> ${afterRestore} remaining, ${codeBlockHtml.length} available)`);
    }
    
    try {
      const brMatches = out.match(/<br\s*\/?\>/gi) || [];
      if (brMatches.length > 0) {
        out = out.replace(/<br\s*\/?\>/gi, "<br/>");
        log(`[TMDBG Markdown] Processed ${brMatches.length} '<br>' tags in final output`);
      }
    } catch (e) {
      log(`[TMDBG Markdown] Final br processing failed: ${e}`, "warn");
    }
    return out;
  } catch (e) {
    log(`[TMDBG Markdown] renderMarkdown failed: ${e}`, "error");
    try {
      return `<p>${escapeHtml(String(mdText || ""))}</p>`;
    } catch {
      return "";
    }
  }
}

// Attach event listeners to special TabMail links after HTML is rendered
export function attachSpecialLinkListeners(container) {
  if (!container) return;
  
  log(`[TMDBG Markdown] Attaching special link listeners to container`);
  
  // Find all special TabMail links
  const emailLinks = container.querySelectorAll('.tm-email-link');
  const contactLinks = container.querySelectorAll('.tm-contact-link');
  const eventLinks = container.querySelectorAll('.tm-event-link');
  
  log(`[TMDBG Markdown] Found links: emails=${emailLinks.length}, contacts=${contactLinks.length}, events=${eventLinks.length}`);
  
  // Attach click handlers for emails
  emailLinks.forEach(link => {
    const uniqueId = link.getAttribute('data-tm-id');
    if (uniqueId) {
      link.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        log(`[TMDBG Markdown] Email link clicked: ${uniqueId}`);
        
        // Clear any existing hover timeout to prevent hiding
        const existingTimeout = link._tooltipTimeout;
        if (existingTimeout) {
          clearTimeout(existingTimeout);
          link._tooltipTimeout = null;
        }
        
        // Show tooltip on click and keep it visible
        const tooltipDataAttr = link.getAttribute('data-tm-tooltip');
        if (tooltipDataAttr) {
          try {
            const tooltipData = JSON.parse(tooltipDataAttr);
            showTooltip(link, tooltipData, 'email', true);
          } catch (e) {
            log(`[TMDBG Markdown] Tooltip data parse failed on click: ${e}`, "warn");
          }
        }
        // Don't open email immediately - let user click the link in tooltip
      });
      
      // Attach tooltip handler for hover
      attachTooltipHandler(link, 'email', uniqueId);
    }
  });
  
  // Attach click handlers for contacts
  contactLinks.forEach(link => {
    const contactId = link.getAttribute('data-tm-id');
    if (contactId) {
      link.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        log(`[TMDBG Markdown] Contact link clicked: ${contactId}`);
        
        // Clear any existing hover timeout to prevent hiding
        const existingTimeout = link._tooltipTimeout;
        if (existingTimeout) {
          clearTimeout(existingTimeout);
          link._tooltipTimeout = null;
        }
        
        // Show tooltip on click and keep it visible
        const tooltipDataAttr = link.getAttribute('data-tm-tooltip');
        if (tooltipDataAttr) {
          try {
            const tooltipData = JSON.parse(tooltipDataAttr);
            showTooltip(link, tooltipData, 'contact', true);
          } catch (e) {
            log(`[TMDBG Markdown] Tooltip data parse failed on click: ${e}`, "warn");
          }
        }
      });
      
      // Attach tooltip handler for hover
      attachTooltipHandler(link, 'contact', contactId);
    }
  });
  
  // Attach click handlers for calendar events
  eventLinks.forEach(link => {
    const eventId = link.getAttribute('data-tm-id');
    if (eventId) {
      link.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        log(`[TMDBG Markdown] Event link clicked: ${eventId}`);
        
        // Clear any existing hover timeout to prevent hiding
        const existingTimeout = link._tooltipTimeout;
        if (existingTimeout) {
          clearTimeout(existingTimeout);
          link._tooltipTimeout = null;
        }
        
        // Show tooltip on click and keep it visible
        const tooltipDataAttr = link.getAttribute('data-tm-tooltip');
        log(`[TMDBG Markdown] Tooltip data attr: ${tooltipDataAttr}`);
        if (tooltipDataAttr) {
          try {
            const tooltipData = JSON.parse(tooltipDataAttr);
            log(`[TMDBG Markdown] Parsed tooltip data:`, tooltipData);
            showTooltip(link, tooltipData, 'event', true);
          } catch (e) {
            log(`[TMDBG Markdown] Tooltip data parse failed on click: ${e}`, "warn");
          }
        } else {
          log(`[TMDBG Markdown] No tooltip data found for event link`, "warn");
        }
      });
      
      // Attach tooltip handler for hover
      attachTooltipHandler(link, 'event', eventId);
    }
  });
  
  // Handle regular external links (non-TabMail links) to open in default browser
  const externalLinks = container.querySelectorAll('a[href^="http"]:not(.tm-link)');
  log(`[TMDBG Markdown] Found ${externalLinks.length} external links`);
  
  externalLinks.forEach(link => {
    const url = link.getAttribute('href');
    if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
      link.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        log(`[TMDBG Markdown] External link clicked: ${url}`);
        try {
          // TB 145: open in the user's default system browser (not a Thunderbird tab)
          await browser.windows.openDefaultBrowser(url);
          log(`[TMDBG Markdown] External link opened in default browser: ${url}`);
        } catch (err) {
          log(`[TMDBG Markdown] Failed to open external link: ${err}`, "error");
        }
      });
      // Make sure link looks clickable
      link.style.cursor = 'pointer';
      link.style.textDecoration = 'underline';
    }
  });
  
  // Attach click handlers for reminder dismiss buttons
  // Look up hashes by index from getDisplayedReminderHashes()
  const reminderCards = container.querySelectorAll('.tm-reminder-card[data-reminder-index]');
  log(`[TMDBG Markdown] Found ${reminderCards.length} reminder cards to link`);
  
  if (reminderCards.length > 0) {
    // Dynamically import to get the hashes
    import("../../agent/modules/reminderBuilder.js").then(({ getDisplayedReminderHashes }) => {
      const hashes = getDisplayedReminderHashes();
      log(`[TMDBG Markdown] Got ${hashes.length} hashes for ${reminderCards.length} cards`);
      
      reminderCards.forEach(card => {
        const indexStr = card.getAttribute('data-reminder-index');
        const index = parseInt(indexStr, 10);
        const hash = hashes[index] || "";
        
        if (hash) {
          // Set the hash on the card for reference
          card.setAttribute('data-hash', hash);
          
          // Find the dismiss button and attach handler
          const btn = card.querySelector('.tm-reminder-dismiss');
          if (btn) {
            btn.addEventListener('click', async (e) => {
              e.preventDefault();
              e.stopPropagation();
              log(`[TMDBG Markdown] Reminder dismiss clicked: index=${index}, hash=${hash.substring(0, 8)}...`);
              
              try {
                const result = await browser.runtime.sendMessage({
                  command: "disable-reminder",
                  hash: hash,
                });
                
                if (result && result.ok) {
                  log(`[TMDBG Markdown] Reminder disabled successfully: ${hash.substring(0, 8)}...`);
                  card.style.transition = 'opacity 0.3s ease';
                  card.style.opacity = '0.3';
                  btn.textContent = 'hidden';
                  btn.style.pointerEvents = 'none';
                } else {
                  log(`[TMDBG Markdown] Failed to disable reminder: ${result?.error || 'unknown'}`, "error");
                }
              } catch (err) {
                log(`[TMDBG Markdown] Error disabling reminder: ${err}`, "error");
              }
            });
          }
        } else {
          log(`[TMDBG Markdown] No hash found for reminder index ${index}`, "warn");
        }
      });
    }).catch(err => {
      log(`[TMDBG Markdown] Failed to import reminderBuilder for hashes: ${err}`, "error");
    });
  }
}

// Global tooltip management
let globalTooltip = null;
let globalClickHandler = null;

// Set up global click handler to hide tooltips when clicking elsewhere
function setupGlobalClickHandler() {
  if (globalClickHandler) {
    document.removeEventListener('click', globalClickHandler);
  }
  
  globalClickHandler = (e) => {
    // Hide tooltip if clicking anywhere except on the tooltip itself
    if (globalTooltip && !globalTooltip.contains(e.target)) {
      hideTooltip();
    }
  };
  
  // Add a small delay to prevent immediate hiding from the same click that showed the tooltip
  setTimeout(() => {
    document.addEventListener('click', globalClickHandler);
  }, 100);
}

// Attach tooltip functionality to special links
function attachTooltipHandler(link, type, id) {
  link.addEventListener('mouseenter', () => {
    // Don't show hover tooltip if one is already visible from click
    if (globalTooltip && globalTooltip.classList.contains('click-tooltip')) {
      return;
    }
    
    if (link._tooltipTimeout) {
      clearTimeout(link._tooltipTimeout);
    }
    
    link._tooltipTimeout = setTimeout(() => {
      try {
        // Read pre-gathered tooltip data from data attribute
        const tooltipDataAttr = link.getAttribute('data-tm-tooltip');
        if (tooltipDataAttr) {
          const tooltipData = JSON.parse(tooltipDataAttr);
          showTooltip(link, tooltipData, type);
        }
      } catch (e) {
        log(`[TMDBG Markdown] Tooltip data parse failed: ${e}`, "warn");
      }
    }, 500); // 500ms delay before showing tooltip
  });
  
  link.addEventListener('mouseleave', () => {
    if (link._tooltipTimeout) {
      clearTimeout(link._tooltipTimeout);
      link._tooltipTimeout = null;
    }
    // Only hide if it's not a click tooltip
    if (!globalTooltip || !globalTooltip.classList.contains('click-tooltip')) {
      hideTooltip();
    }
  });
}

// Show tooltip with data
function showTooltip(link, data, type, isClickTooltip = false) {
  log(`[TMDBG Markdown] showTooltip called with type: ${type}, isClickTooltip: ${isClickTooltip}`, data);
  hideTooltip(); // Remove any existing tooltip
  
  globalTooltip = document.createElement('div');
  globalTooltip.className = 'tm-tooltip';
  
  // Add scrolling if content might be long - horizontal for long emails/names
  globalTooltip.style.maxWidth = '400px';
  globalTooltip.style.overflowX = 'auto';
  globalTooltip.style.whiteSpace = 'nowrap';
  globalTooltip.style.display = 'block'; // Make sure it's visible
  
  // Mark click tooltips so hover doesn't interfere
  if (isClickTooltip) {
    globalTooltip.classList.add('click-tooltip');
    // Set up global click handler to hide tooltip when clicking elsewhere
    setupGlobalClickHandler();
  }
  
  let content = '';
  let clickText = '';
  
  if (type === 'email') {
    clickText = 'Click to open email';
    content = `
      <div class="tm-tooltip-title">${escapeHtml(data.subject)}</div>
      <div class="tm-tooltip-field"><strong>From:</strong> ${escapeHtml(data.from)}</div>
      <div class="tm-tooltip-field"><strong>To:</strong> ${escapeHtml(data.to)}</div>
      <div class="tm-tooltip-click"><a href="#" class="tm-tooltip-link" data-action="open-email">${clickText}</a></div>
    `;
  } else if (type === 'contact') {
    clickText = 'Contact information';
    let emailContent = '';
    if (data.emails && data.emails.length > 0) {
      emailContent = data.emails.map(email => 
        `<div class="tm-tooltip-field"><strong>Email:</strong> ${escapeHtml(email)}</div>`
      ).join('');
    } else if (data.primaryEmail) {
      emailContent = `<div class="tm-tooltip-field"><strong>Email:</strong> ${escapeHtml(data.primaryEmail)}</div>`;
    }
    
    content = `
      <div class="tm-tooltip-title">${escapeHtml(data.name)}</div>
      ${emailContent}
    `;
  } else if (type === 'event') {
    clickText = 'Calendar event information';
    
    // Format the date/time in the user-friendly format
    let formattedDateTime = "Unknown date/time";
    if (data.startTime && data.endTime && data.startTime !== "Unknown start time" && data.endTime !== "Unknown end time") {
      try {
        const startDate = new Date(data.startTime);
        const endDate = new Date(data.endTime);
        
        // Format date: "Tuesday, Sep 29, PT" (using generic timezone abbreviation)
        const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        
        const dayName = dayNames[startDate.getDay()];
        const monthName = monthNames[startDate.getMonth()];
        const day = startDate.getDate();
        
        // Get generic timezone abbreviation (PT instead of PDT/PST for consistency)
        const timezone = getGenericTimezoneAbbr(startDate);
        
        const formattedDate = `${dayName}, ${monthName} ${day}${timezone ? `, ${timezone}` : ""}`;
        
        // Format time: "10:30 AM -- 12:30 PM"
        const startTimeStr = startDate.toLocaleTimeString("en-US", { 
          hour: "numeric", 
          minute: "2-digit", 
          hour12: true 
        });
        const endTimeStr = endDate.toLocaleTimeString("en-US", { 
          hour: "numeric", 
          minute: "2-digit", 
          hour12: true 
        });
        
        const formattedTime = `${startTimeStr} -- ${endTimeStr}`;
        formattedDateTime = `${formattedDate}\n${formattedTime}`;
      } catch (e) {
        formattedDateTime = `${data.startTime}\n${data.endTime}`;
      }
    }
    
    // Format attendee list
    let attendeeContent = '';
    if (data.attendeeList && Array.isArray(data.attendeeList) && data.attendeeList.length > 0) {
      const attendeeNames = data.attendeeList.map(attendee => {
        const name = attendee.name || attendee.commonName || '';
        // Extract email from various possible fields, removing mailto: prefix if present
        let email = '';
        if (attendee.email) {
          email = String(attendee.email).replace(/^mailto:/i, '').trim();
        } else if (attendee.id) {
          email = String(attendee.id).replace(/^mailto:/i, '').trim();
        } else if (attendee.mail) {
          email = String(attendee.mail).replace(/^mailto:/i, '').trim();
        } else if (attendee.address) {
          email = String(attendee.address).replace(/^mailto:/i, '').trim();
        }
        // Always show email if available (this is the email used to add the attendee)
        if (name && email) {
          return `${name} <${email}>`;
        } else if (email) {
          return `<${email}>`;
        } else if (name) {
          return name;
        }
        return 'Unknown attendee';
      }).slice(0, 5); // Limit to 5 attendees to keep tooltip manageable
      
      attendeeContent = `<div class="tm-tooltip-field"><strong>Attendees:</strong><br/>${attendeeNames.map(name => `• ${escapeHtml(name)}`).join('<br/>')}${data.attendees > 5 ? `<br/>... and ${data.attendees - 5} more` : ''}</div>`;
    } else if (data.attendees > 0) {
      attendeeContent = `<div class="tm-tooltip-field"><strong>Attendees:</strong> ${data.attendees}</div>`;
    }
    
    content = `
      <div class="tm-tooltip-title">${escapeHtml(data.title)}</div>
      <div class="tm-tooltip-field">${escapeHtml(formattedDateTime)}</div>
      ${data.location ? `<div class="tm-tooltip-field"><strong>Location:</strong> ${escapeHtml(data.location)}</div>` : ''}
      ${data.organizer ? `<div class="tm-tooltip-field"><strong>Organizer:</strong> ${escapeHtml(data.organizer)}</div>` : ''}
      ${attendeeContent}
    `;
  }
  
  globalTooltip.innerHTML = content;
  document.body.appendChild(globalTooltip);
  
  log(`[TMDBG Markdown] Tooltip created and added to DOM`);
  
  // Add click handler for email link
  const emailLink = globalTooltip.querySelector('.tm-tooltip-link[data-action="open-email"]');
  if (emailLink) {
    emailLink.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const uniqueId = link.getAttribute('data-tm-id');
      if (uniqueId) {
        await handleEmailClick(uniqueId);
        hideTooltip(); // Hide tooltip after opening email
      }
    });
  }
  
  // Smart positioning similar to email list tooltips
  const linkRect = link.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  
  // Show tooltip first to get dimensions
  globalTooltip.style.display = 'block';
  const tooltipRect = globalTooltip.getBoundingClientRect();
  
  // Horizontal positioning - prefer right side, fallback to left
  let leftPos = linkRect.right + 8; // Start to the right
  if (leftPos + tooltipRect.width > viewportWidth - 8) {
    // Not enough space on right, try left side
    leftPos = linkRect.left - tooltipRect.width - 8;
    if (leftPos < 8) {
      // Not enough space on left either, center it
      leftPos = Math.max(8, (viewportWidth - tooltipRect.width) / 2);
    }
  }
  
  // Vertical positioning - prefer above, fallback to below
  let topPos = linkRect.top - tooltipRect.height - 8; // Start above
  if (topPos < 8) {
    // Not enough space above, try below
    topPos = linkRect.bottom + 8;
    if (topPos + tooltipRect.height > viewportHeight - 8) {
      // Not enough space below either, position at top of viewport
      topPos = 8;
    }
  }
  
  globalTooltip.style.left = `${leftPos}px`;
  globalTooltip.style.top = `${topPos}px`;
  
  log(`[TMDBG Markdown] Tooltip positioned at: left=${leftPos}px, top=${topPos}px`);
  log(`[TMDBG Markdown] Tooltip display style: ${globalTooltip.style.display}`);
}

// Hide tooltip
function hideTooltip() {
  if (globalTooltip) {
    globalTooltip.remove();
    globalTooltip = null;
    
    // Clean up global click handler
    if (globalClickHandler) {
      document.removeEventListener('click', globalClickHandler);
      globalClickHandler = null;
    }
  }
}



