// Helpers shared by chat window modules
// Thunderbird 140, MV3 compatible.

import { log } from "../../agent/modules/utils.js";
import { CHAT_SETTINGS } from "./chatConfig.js";
import { ctx } from "./context.js";
import { attachSpecialLinkListeners, renderMarkdown } from "./markdown.js";

// Controller used to manage streaming timers per element so we can cancel old streams
const STREAM_CTRL = Symbol.for("tm_stream_control");

/**
 * Sanitize text to ensure valid UTF-8 for JSON serialization.
 * Removes null bytes, control characters, and other problematic chars.
 * @param {string} text - Input text
 * @returns {string} - Sanitized text
 */
function sanitizeForJson(text) {
  if (!text || typeof text !== 'string') return '';
  // Remove null bytes and control characters (except newline, tab)
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

/**
 * Extract plain text from rendered HTML, preserving resolved entity names in brackets.
 * Used for capturing rendered chat content for KB snapshot.
 * @param {string} html - Rendered HTML from bubble
 * @returns {string} - Plain text with resolved entities
 */
export function extractPlainTextFromHtml(html) {
  if (!html) return "";
  let text = html;

  // Mark blockquote boundaries with PUA markers (processed after tag stripping)
  const BQ_OPEN = "\uE000";
  const BQ_CLOSE = "\uE001";
  text = text.replace(/<blockquote[^>]*>/gi, `\n${BQ_OPEN}`);
  text = text.replace(/<\/blockquote>/gi, `${BQ_CLOSE}\n`);

  // Convert horizontal rules to text separator
  text = text.replace(/<hr[^>]*>/gi, "\n---\n");

  // Convert block elements to newlines
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/p>/gi, "\n\n");
  text = text.replace(/<\/div>/gi, "\n");
  text = text.replace(/<\/h[1-6]>/gi, "\n\n");
  text = text.replace(/<\/li>/gi, "\n");
  text = text.replace(/<\/tr>/gi, "\n");
  text = text.replace(/<\/td>/gi, " | ");
  text = text.replace(/<\/th>/gi, " | ");

  // Extract text from TabMail special links, wrap in brackets with type prefix
  text = text.replace(/<a[^>]*class="[^"]*tm-(email|contact|event)-link[^"]*"[^>]*>([^<]*)<\/a>/gi, (match, type, content) => {
    // Remove emoji prefix - match common email/contact/calendar emojis
    const cleanContent = content.replace(/^[\u{1F4E7}\u{1F4E9}\u{1F464}\u{1F4C5}\u{1F4C6}📧👤📅]\s*/u, '').trim();
    if (!cleanContent) return '';
    // Add type prefix instead of emoji
    const prefix = type === 'email' ? 'Email' : type === 'contact' ? 'Contact' : 'Calendar';
    return `[${prefix}: ${cleanContent}]`;
  });

  // Handle regular links - keep the link text
  text = text.replace(/<a[^>]*>([^<]*)<\/a>/gi, "$1");

  // Strip remaining HTML tags
  text = text.replace(/<[^>]+>/g, "");

  // Decode HTML entities
  text = text.replace(/&nbsp;/gi, " ");
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&amp;/g, "&");
  text = text.replace(/&lt;/g, "<");
  text = text.replace(/&gt;/g, ">");
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&apos;/gi, "'");

  // Convert blockquote markers to > prefixed lines (now that content is plain text)
  text = text.replace(new RegExp(`${BQ_OPEN}([\\s\\S]*?)${BQ_CLOSE}`, "g"), (match, inner) => {
    const lines = inner.split("\n").map(l => l.trim()).filter(l => l);
    return lines.map(l => `> ${l}`).join("\n");
  });

  // Clean up whitespace and sanitize for JSON
  text = text.replace(/\n{3,}/g, "\n\n").trim();
  return sanitizeForJson(text);
}


/**
 * Extract plain text from a bubble element's rendered content.
 * @param {HTMLElement} bubble - The bubble element
 * @returns {string} - Plain text with resolved entities
 */
export function extractTextFromBubble(bubble) {
  if (!bubble) return "";
  try {
    const contentEl = bubble.querySelector(".bubble-content") || bubble;
    return extractPlainTextFromHtml(contentEl.innerHTML || "");
  } catch (e) {
    log(`[ChatSnapshot] Failed to extract text from bubble: ${e}`, "warn");
    return "";
  }
}

function _cancelExistingStream(element) {
  try {
    const ctrl = element && element[STREAM_CTRL];
    if (ctrl && ctrl.timer) {
      clearInterval(ctrl.timer);
      ctrl.active = false;
      element[STREAM_CTRL] = null;
      try { log(`[TMDBG ChatHelpers] Canceled existing stream for element`); } catch (_) {}
    }
  } catch (_) {}
}

// -------------------------------------------------------------
// LLM tool-response helper
// -------------------------------------------------------------

export function buildToolResponse(tool, response) {
  return [
    "```json",
    JSON.stringify({ tool, response }, null, 2),
    "```",
  ].join("\n");
}

// -------------------------------------------------------------
// User/account helper
// -------------------------------------------------------------

export async function getUserName(fullname=false) {
  try {
    const accounts = await browser.accounts.list();
    if (accounts && accounts.length) {
      for (const acc of accounts) {
        if (acc.identities && acc.identities.length) {
          const id = acc.identities[0];
          if (id.name) return fullname ? id.name : id.name.split(" ")[0];
          if (id.email) return id.email.split("@")[0];
        }
      }
    }
  } catch (e) {
    log(`[TMDBG ChatHelpers] Failed to fetch user name: ${e}`);
  }
  return "there";
}

// -------------------------------------------------------------
// UI helpers used by various modules
// -------------------------------------------------------------

/**
 * Streams text into a DOM element, character-by-character, to mimic typing.
 * @param {HTMLElement} element
 * @param {string} text
 * @param {number} speed – ms delay per character (default 15)
 */
export async function streamText(element, text, speed = 5) {
  try { await setBubbleText(element, text, { stream: true, speed }); }
  catch (e) { try { log(`[TMDBG ChatHelpers] streamText failed: ${e}`, "error"); } catch(_) {} }
}

/**
 * Sets bubble content using Markdown, with optional streaming effect.
 * Always uses Markdown for consistency across UI.
 * @param {HTMLElement} element
 * @param {string} text
 * @param {{stream?:boolean, speed?:number}} [options]
 */
export async function setBubbleText(element, text, options = {}) {
  const { stream = false, speed = 5 } = options;
  const full = String(text || "");
  const contentEl = _ensureBubbleContentElement(element);
  // Always cancel any in-progress stream before setting new content
  _cancelExistingStream(element);
  if (!stream) {
    try {
      const html = await renderMarkdown(full);
      if (html && html.trim()) {
        contentEl.innerHTML = html;
        // Attach event listeners for special TabMail links
        attachSpecialLinkListeners(contentEl);
      } else {
        // Maintain a first block child for icon inline placement
        const first = contentEl.firstElementChild;
        if (first) first.textContent = "";
      }
      log(`[TMDBG ChatHelpers] setBubbleText (non-stream) len=${full.length}`);
    } catch (e) {
      contentEl.textContent = full;
      log(`[TMDBG ChatHelpers] setBubbleText render failed: ${e}`, "warn");
    }
    return;
  }
  // Streaming path – block-only with Markdown rendering
  try {
    const mode = 'block';
    const delay = Math.max(1, CHAT_SETTINGS?.streamDelayMs || speed || 5);
    contentEl.innerHTML = "";
    if (mode === 'block') {
      // Pre-render full HTML once, then progressively append units (paragraph lines, list items, table rows)
      const fullHtml = await renderMarkdown(full);
      const staging = document.createElement('div');
      staging.innerHTML = fullHtml || "";

      function animateOnce(el) {
        try {
          el.classList.remove('tm-fade-swipe');
          // eslint-disable-next-line no-unused-expressions
          void el.offsetWidth;
          el.classList.add('tm-fade-swipe');
        } catch (_) {}
      }

      // Build a queue of append steps
      const steps = [];

      Array.from(staging.children).forEach((node, blockIdx) => {
        const tag = (node.tagName || '').toLowerCase();
        if (tag === 'blockquote') {
          // Reveal blockquote container, then its child blocks progressively
          const bqNode = node.cloneNode(true);
          const childBlocks = Array.from(bqNode.children);
          steps.push(() => {
            const bq = document.createElement('blockquote');
            contentEl.appendChild(bq);
            contentEl.__tm_last_bq = bq;
            animateOnce(bq);
            // log(`[TMDBG ChatHelpers] Added blockquote container for block #${blockIdx}`);
          });
          childBlocks.forEach((child, idx) => {
            steps.push(() => {
              const bq = contentEl.__tm_last_bq || contentEl;
              const c = child.cloneNode(true);
              bq.appendChild(c);
              animateOnce(c);
              log(`[TMDBG ChatHelpers] Appended blockquote child ${idx + 1}/${childBlocks.length} for block #${blockIdx}`);
            });
          });
          steps.push(() => { try { delete contentEl.__tm_last_bq; } catch(_) {} });
          return;
        }
        if (tag === 'ul' || tag === 'ol') {
          // Create list container first
          const listTag = tag;
          const listClasses = node.className;
          steps.push(() => {
            const listEl = document.createElement(listTag);
            if (listClasses) listEl.className = listClasses;
            contentEl.appendChild(listEl);
            animateOnce(listEl);
            // Store reference on contentEl to retrieve in subsequent steps
            contentEl.__tm_last_list = listEl;
            log(`[TMDBG ChatHelpers] Added list container <${listTag}> for block #${blockIdx}`);
          });
          // Append each <li> one by one
          Array.from(node.children).forEach((liNode, liIdx) => {
            steps.push(() => {
              const listEl = contentEl.__tm_last_list;
              const li = liNode.cloneNode(true);
              (listEl || contentEl).appendChild(li);
              animateOnce(li);
              log(`[TMDBG ChatHelpers] Appended list item ${liIdx + 1} for block #${blockIdx}`);
            });
          });
          // Cleanup ref after finishing this list
          steps.push(() => { try { delete contentEl.__tm_last_list; } catch(_) {} });
        } else if (tag === 'table') {
          // Create table shell and then append rows progressively
          const tableClasses = node.className;
          const thead = node.querySelector('thead');
          const tbody = node.querySelector('tbody');
          steps.push(() => {
            const t = document.createElement('table');
            if (tableClasses) t.className = tableClasses;
            const tHead = document.createElement('thead');
            const tBody = document.createElement('tbody');
            t.appendChild(tHead);
            t.appendChild(tBody);
            // Use auto layout to allow content-based column sizing; avoid equal-width forcing
            try { t.style.tableLayout = 'auto'; } catch(_) {}
            contentEl.appendChild(t);
            // Optional: animate the table container lightly
            animateOnce(t);
            contentEl.__tm_last_table = { t, tHead, tBody };
            if (thead) {
              tHead.innerHTML = thead.innerHTML;
              try {
                const ths = tHead.querySelectorAll('th');
                const colCount = ths?.length || 0;
                const headerLens = Array.from(ths || []).map(th => (th.textContent || '').length);
                log(`[TMDBG ChatHelpers] Table streaming shell created: cols=${colCount}, headerLens=${JSON.stringify(headerLens)}, layout=auto (no colgroup)`);
              } catch (_) {}
            }
            log(`[TMDBG ChatHelpers] Added table shell for block #${blockIdx}`);
          });
          const rows = tbody ? Array.from(tbody.children) : [];
          rows.forEach((trNode, rowIdx) => {
            steps.push(() => {
              const ref = contentEl.__tm_last_table;
              const dest = ref?.tBody || contentEl;
              const tr = trNode.cloneNode(true);
              dest.appendChild(tr);
              animateOnce(tr);
              log(`[TMDBG ChatHelpers] Appended table row ${rowIdx + 1}/${rows.length} for block #${blockIdx}`);
            });
          });
          steps.push(() => { try { delete contentEl.__tm_last_table; } catch(_) {} });
        } else if (tag === 'pre') {
          // Stream code blocks line-by-line
          const preNode = node.cloneNode(true);
          const codeChild = preNode.querySelector('code');
          const codeText = codeChild ? (codeChild.textContent || '') : (preNode.textContent || '');
          const codeClass = codeChild ? codeChild.className : '';
          
          // DIAGNOSTIC: Log exactly what we received
          const realNewlineCount = (codeText.match(/\n/g) || []).length;
          const escapedNewlineCount = (codeText.match(/\\n/g) || []).length;
          log(`[TMDBG ChatHelpers] Code block streaming diagnostic: len=${codeText.length}, realNewlines=${realNewlineCount}, escapedNewlines=${escapedNewlineCount}, sample=${JSON.stringify(codeText.slice(0, 120))}`);
          
          steps.push(() => {
            const pre = document.createElement('pre');
            const code = document.createElement('code');
            if (codeClass) code.className = codeClass;
            pre.appendChild(code);
            contentEl.appendChild(pre);
            contentEl.__tm_last_pre = { pre, code };
            animateOnce(pre);
            log(`[TMDBG ChatHelpers] Added code block container for block #${blockIdx}`);
          });
          const lines = codeText.split('\n');
          log(`[TMDBG ChatHelpers] Code block split into ${lines.length} lines`);
          lines.forEach((ln, lnIdx) => {
            steps.push(() => {
              const ref = contentEl.__tm_last_pre;
              const code = ref?.code || null;
              if (!code) return;
              const lineSpan = document.createElement('span');
              lineSpan.textContent = ln;
              code.appendChild(lineSpan);
              if (lnIdx < lines.length - 1) {
                code.appendChild(document.createTextNode('\n'));
              }
              animateOnce(lineSpan);
              log(`[TMDBG ChatHelpers] Appended code line ${lnIdx + 1}/${lines.length} for block #${blockIdx}`);
            });
          });
          steps.push(() => { try { delete contentEl.__tm_last_pre; } catch(_) {} });
        } else if (tag === 'div' && node.classList.contains('tm-reminder-card')) {
          // Reminder cards: add complete card in one step (container + all children together)
          // This prevents flash from dismiss button appearing separately
          const cardNode = node.cloneNode(true);
          // Add delay before card to smooth transition from previous content
          steps.push(() => {}); // delay step before
          steps.push(() => {
            const card = cardNode.cloneNode(true);
            contentEl.appendChild(card);
            // Animate only the text span, not the dismiss button
            const textSpan = card.querySelector('.tm-reminder-card-text');
            if (textSpan) {
              animateOnce(textSpan);
            }
            log(`[TMDBG ChatHelpers] Added reminder card for block #${blockIdx}`);
          });
          // Add padding steps to slow down reminder card appearance (match paragraph pacing)
          steps.push(() => {}); // delay step after
        } else if (tag === 'p') {
          // Reveal paragraph per visual line separated by <br/>
          const pNode = node.cloneNode(true);
          steps.push(() => {
            const p = document.createElement('p');
            contentEl.appendChild(p);
            // keep reference to append lines
            contentEl.__tm_last_p = p;
            animateOnce(p);
            // log(`[TMDBG ChatHelpers] Added paragraph container for block #${blockIdx}`);
          });
          // Split pNode by <br> boundaries into segments
          const segments = [];
          let currentFragment = [];
          Array.from(pNode.childNodes).forEach((cn) => {
            if (cn.nodeName && cn.nodeName.toLowerCase() === 'br') {
              segments.push(currentFragment);
              currentFragment = [];
            } else {
              currentFragment.push(cn);
            }
          });
          // push the last fragment
          if (currentFragment.length > 0) segments.push(currentFragment);
          segments.forEach((frag, segIdx) => {
            steps.push(() => {
              const p = contentEl.__tm_last_p || contentEl;
              const span = document.createElement('span');
              frag.forEach((n) => span.appendChild(n.cloneNode(true)));
              p.appendChild(span);
              animateOnce(span);
              // re-add <br/> after each segment except the last
              if (segIdx < segments.length - 1) {
                p.appendChild(document.createElement('br'));
              }
              // log(`[TMDBG ChatHelpers] Appended paragraph segment ${segIdx + 1}/${segments.length} for block #${blockIdx}`);
            });
          });
          steps.push(() => { try { delete contentEl.__tm_last_p; } catch(_) {} });
        } else {
          // Default: append the whole block at once
          steps.push(() => {
            const n = node.cloneNode(true);
            contentEl.appendChild(n);
            animateOnce(n);
            log(`[TMDBG ChatHelpers] Appended block <${tag || 'node'}> for block #${blockIdx}`);
          });
        }
      });

      let i = 0;
      const ctrl = { timer: null, active: true };
      element[STREAM_CTRL] = ctrl;
      ctrl.timer = setInterval(() => {
        if (!ctrl.active) { clearInterval(ctrl.timer); return; }
        if (i < steps.length) {
          try { steps[i++](); } catch (e) { log(`[TMDBG ChatHelpers] step ${i} failed: ${e}`, 'warn'); i += 1; }
          try {
            const container = document.getElementById("chat-container");
            if (container) scrollToBottom(container, CHAT_SETTINGS?.scrollFramesOnMutation || 1);
          } catch(_) {}
        } else {
          clearInterval(ctrl.timer);
          element[STREAM_CTRL] = null;
          // Attach event listeners for special TabMail links after streaming completes
          attachSpecialLinkListeners(contentEl);
        }
      }, delay);
      log(`[TMDBG ChatHelpers] setBubbleText (stream-block) steps=${steps.length} delay=${delay}`);
    }
  } catch (e) {
    contentEl.textContent = full;
    log(`[TMDBG ChatHelpers] setBubbleText stream failed: ${e}`, "error");
  }
}

// -------------------------------------------------------------
// Scrolling helpers – only auto-scroll when user was at the bottom
// -------------------------------------------------------------
export function getStickToBottom(container) {
  try { return !!(container && container.__tm_stickToBottom); } catch (_) { return false; }
}

export function setStickToBottom(container, value) {
  try {
    if (!container) return;
    const v = !!value;
    const prev = !!container.__tm_stickToBottom;
    container.__tm_stickToBottom = v;
    if (prev !== v) {
      log(`[TMDBG ChatHelpers] stickToBottom=${v} (was ${prev})`);
    }
  } catch (_) {}
}

/**
 * Computes the stick-to-bottom threshold in pixels based on em units and container font size.
 * This makes the threshold scale with user font size preferences.
 * @param {HTMLElement} container - The container element to get font size from
 * @param {number} thresholdEm - Threshold in em units (default from config)
 * @returns {number} Threshold in pixels
 */
function getThresholdPx(container, thresholdEm = (CHAT_SETTINGS?.stickToBottomThresholdEm || 2)) {
  try {
    if (!container) return 32; // sensible default (~2em at 16px)
    const computedStyle = window.getComputedStyle(container);
    const fontSize = parseFloat(computedStyle.fontSize) || 16;
    return Math.max(1, fontSize * (Number(thresholdEm) || 2));
  } catch (_) { return 32; }
}

export function isAtBottom(container, thresholdEmOrPx = null) {
  try {
    if (!container) return false;
    // Calculate threshold: if caller passes a number, treat as override px; otherwise compute from em
    const thresholdPx = (typeof thresholdEmOrPx === 'number') 
      ? thresholdEmOrPx 
      : getThresholdPx(container, CHAT_SETTINGS?.stickToBottomThresholdEm);
    const remaining = container.scrollHeight - (container.scrollTop + container.clientHeight);
    return remaining <= Math.max(0, thresholdPx);
  } catch (_) { return false; }
}

export function scrollToBottom(container, frames = (CHAT_SETTINGS?.scrollFramesOnAppend || 2)) {
  try {
    const c = container || document.getElementById("chat-container");
    if (!c) return;
    
    // Gate on stickiness; only auto-scroll if we were already at bottom
    if (!getStickToBottom(c)) {
      try {
        const remaining = c.scrollHeight - (c.scrollTop + c.clientHeight);
        log(`[TMDBG ChatHelpers] scrollToBottom skipped (stickToBottom=false, remaining=${remaining})`);
      } catch (_) {}
      return;
    }
    let count = Math.max(1, Number(frames) || 1);
    const step = () => {
      try { c.scrollTop = c.scrollHeight; } catch (_) {}
      if (--count > 0) {
        try { requestAnimationFrame(step); } catch(_) { setTimeout(step, 16); }
      }
    };
    // Run once immediately and then for a few frames to cover layout shifts
    step();
    // Multiple backup ticks at increasing delays to catch layout shifts
    const backupDelays = CHAT_SETTINGS?.scrollBackupDelays || [0, 50, 150, 300];
    for (const delay of backupDelays) {
      try { 
        setTimeout(() => { 
          try { 
            if (getStickToBottom(c)) {
              c.scrollTop = c.scrollHeight; 
            }
          } catch (_) {} 
        }, delay); 
      } catch(_) {}
    }
    // log(`[TMDBG ChatHelpers] scrollToBottom invoked for ${frames} frames`);
  } catch (e) {
    log(`[TMDBG ChatHelpers] scrollToBottom failed: ${e}`, 'warn');
  }
}

// Symbol for tracking ResizeObserver
const RESIZE_OBS_SYM = Symbol.for("tm_resizeObserver");
// Symbol for tracking container MutationObserver
const CONTAINER_MUT_OBS_SYM = Symbol.for("tm_containerMutObserver");

/**
 * Initializes aggressive bottom-sticking behavior on the chat container.
 * Uses ResizeObserver and container-level MutationObserver to catch all layout changes.
 * @param {HTMLElement} container - The chat container element
 */
export function initAggressiveScrollStick(container) {
  if (!container) return;
  
  // Set up ResizeObserver to catch container size changes
  if (!container[RESIZE_OBS_SYM]) {
    try {
      const resizeObserver = new ResizeObserver((entries) => {
        try {
          if (getStickToBottom(container)) {
            container.scrollTop = container.scrollHeight;
            log(`[TMDBG ChatHelpers] ResizeObserver triggered scroll`);
          }
        } catch (_) {}
      });
      resizeObserver.observe(container);
      container[RESIZE_OBS_SYM] = resizeObserver;
      log(`[TMDBG ChatHelpers] ResizeObserver attached to chat container`);
    } catch (e) {
      log(`[TMDBG ChatHelpers] Failed to attach ResizeObserver: ${e}`, 'warn');
    }
  }
  
  // Set up container-level MutationObserver for comprehensive DOM change detection
  if (!container[CONTAINER_MUT_OBS_SYM]) {
    try {
      let scrollPending = false;
      const containerMutObserver = new MutationObserver(() => {
        try {
          if (getStickToBottom(container) && !scrollPending) {
            scrollPending = true;
            requestAnimationFrame(() => {
              try { container.scrollTop = container.scrollHeight; } catch (_) {}
              // Double-tap for layout stability
              requestAnimationFrame(() => {
                try { container.scrollTop = container.scrollHeight; } catch (_) {}
                scrollPending = false;
              });
            });
          }
        } catch (_) { scrollPending = false; }
      });
      containerMutObserver.observe(container, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['class', 'style', 'hidden']
      });
      container[CONTAINER_MUT_OBS_SYM] = containerMutObserver;
      log(`[TMDBG ChatHelpers] Container MutationObserver attached`);
    } catch (e) {
      log(`[TMDBG ChatHelpers] Failed to attach container MutationObserver: ${e}`, 'warn');
    }
  }
}

/**
 * Cleans up scroll observers from the chat container.
 * @param {HTMLElement} container - The chat container element
 */
export function cleanupScrollObservers(container) {
  if (!container) return;
  try {
    if (container[RESIZE_OBS_SYM]) {
      container[RESIZE_OBS_SYM].disconnect();
      container[RESIZE_OBS_SYM] = null;
      log(`[TMDBG ChatHelpers] ResizeObserver disconnected`);
    }
    if (container[CONTAINER_MUT_OBS_SYM]) {
      container[CONTAINER_MUT_OBS_SYM].disconnect();
      container[CONTAINER_MUT_OBS_SYM] = null;
      log(`[TMDBG ChatHelpers] Container MutationObserver disconnected`);
    }
  } catch (e) {
    log(`[TMDBG ChatHelpers] Failed to cleanup scroll observers: ${e}`, 'warn');
  }
}

// -------------------------------------------------------------
// Timestamp formatting for agent messages
// -------------------------------------------------------------

/**
 * Normalizes any datetime input to naive ISO8601 format (without timezone offset).
 * This ensures consistent format for LLM communication and correct DST handling.
 * 
 * @param {number|string|Date} input - Timestamp in ms, ISO string, or Date object
 * @returns {string} Naive ISO8601 string (e.g., "2025-01-15T14:00:00")
 */
export function toNaiveIso(input) {
  try {
    let date;
    
    if (typeof input === 'number') {
      date = new Date(input);
    } else if (typeof input === 'string') {
      // Parse string - remove timezone offset if present
      const cleaned = input.replace(/[zZ]$/, '').replace(/[+\-]\d{2}:?\d{2}$/, '');
      date = new Date(cleaned);
    } else if (input instanceof Date) {
      date = input;
    } else {
      log('[TMDBG Helpers] toNaiveIso: Invalid input type', 'warn');
      return new Date().toISOString().slice(0, 19);
    }
    
    if (isNaN(date.getTime())) {
      log('[TMDBG Helpers] toNaiveIso: Invalid date', 'warn');
      return new Date().toISOString().slice(0, 19);
    }
    
    // Extract local components
    const pad2 = (n) => String(n).padStart(2, '0');
    const year = date.getFullYear();
    const month = pad2(date.getMonth() + 1);
    const day = pad2(date.getDate());
    const hours = pad2(date.getHours());
    const minutes = pad2(date.getMinutes());
    const seconds = pad2(date.getSeconds());
    
    const naive = `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
    log(`[TMDBG Helpers] toNaiveIso: ${input} -> ${naive}`);
    return naive;
  } catch (e) {
    log(`[TMDBG Helpers] toNaiveIso failed: ${e}`, 'warn');
    return new Date().toISOString().slice(0, 19);
  }
}

/**
 * Maps timezone identifiers to generic abbreviations that don't change with DST.
 * This ensures consistency when showing timestamps from different times of year.
 */
const TIMEZONE_GENERIC_MAP = {
  // Pacific Time
  'America/Los_Angeles': 'PT',
  'America/Vancouver': 'PT',
  'America/Tijuana': 'PT',
  'US/Pacific': 'PT',
  'Canada/Pacific': 'PT',
  
  // Mountain Time
  'America/Denver': 'MT',
  'America/Phoenix': 'MST', // Arizona doesn't observe DST
  'America/Edmonton': 'MT',
  'US/Mountain': 'MT',
  'Canada/Mountain': 'MT',
  
  // Central Time
  'America/Chicago': 'CT',
  'America/Winnipeg': 'CT',
  'America/Mexico_City': 'CT',
  'US/Central': 'CT',
  'Canada/Central': 'CT',
  
  // Eastern Time
  'America/New_York': 'ET',
  'America/Toronto': 'ET',
  'US/Eastern': 'ET',
  'Canada/Eastern': 'ET',
  
  // Other common zones
  'UTC': 'UTC',
  'Europe/London': 'GMT',
  'Europe/Paris': 'CET',
  'Asia/Tokyo': 'JST',
  'Australia/Sydney': 'AEST',
};

/**
 * Gets a generic timezone abbreviation that doesn't change with DST.
 * For example, returns "PT" instead of "PDT" or "PST".
 * @param {Date} dateObj - The date to get timezone for (used for fallback detection)
 * @returns {string} Generic timezone abbreviation
 */
export function getGenericTimezoneAbbr(dateObj = new Date()) {
  try {
    // First, get the timezone identifier (e.g., "America/Los_Angeles")
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    
    // Check if we have a generic mapping for this timezone
    if (TIMEZONE_GENERIC_MAP[timeZone]) {
      return TIMEZONE_GENERIC_MAP[timeZone];
    }
    
    // Fallback: try to get short name and convert PDT/PST to PT, EDT/EST to ET, etc.
    const parts = new Intl.DateTimeFormat("en-US", { timeZoneName: "short" }).formatToParts(dateObj);
    const part = parts.find((p) => p.type === "timeZoneName");
    const shortTz = (part?.value || "").replace(/\s/g, "");
    
    // Convert DST-aware abbreviations to generic ones
    if (shortTz === 'PDT' || shortTz === 'PST') {
      return 'PT';
    } else if (shortTz === 'MDT' || shortTz === 'MST') {
      return 'MT';
    } else if (shortTz === 'CDT' || shortTz === 'CST') {
      return 'CT';
    } else if (shortTz === 'EDT' || shortTz === 'EST') {
      return 'ET';
    } else {
      return shortTz;
    }
  } catch (_) {
    return "GMT";
  }
}

/**
 * Returns current time formatted as [DayOfWeek YYYY/MM/DD HH:MM:SS TZ] (e.g., Wednesday 2025/01/08 14:03:07 PT)
 * Per system_prompt_agent.md requirement with day of week addition.
 * Uses generic timezone abbreviations (PT instead of PDT/PST) for consistency across DST changes.
 */
export function formatTimestampForAgent(dateObj = new Date()) {
  try {
    const pad2 = (n) => String(n).padStart(2, "0");
    const YYYY = String(dateObj.getFullYear());
    const MM = pad2(dateObj.getMonth() + 1);
    const DD = pad2(dateObj.getDate());
    const hh = pad2(dateObj.getHours());
    const mm = pad2(dateObj.getMinutes());
    const ss = pad2(dateObj.getSeconds());
    
    // Get day of the week
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const dayOfWeek = dayNames[dateObj.getDay()];
    
    // Get generic timezone abbreviation (PT instead of PDT/PST)
    const tz = getGenericTimezoneAbbr(dateObj);
    
    const out = `${dayOfWeek} ${YYYY}/${MM}/${DD} ${hh}:${mm}:${ss} ${tz}`;
    log(`[TMDBG ChatHelpers] Formatted timestamp: [${out}]`);
    return out;
  } catch (e) {
    log(`[TMDBG ChatHelpers] formatTimestampForAgent failed: ${e}`, "warn");
    return new Date().toISOString();
  }
}

// Ensures an internal container for bubble content, so we can prepend inline icons without
// interfering with markdown rendering and streaming.
function _ensureBubbleContentElement(element) {
  let contentEl = element.querySelector('.bubble-content');
  if (!contentEl) {
    contentEl = document.createElement('div');
    contentEl.className = 'bubble-content';
    element.appendChild(contentEl);
  }
  // Ensure there is at least one block-level child so ::before can attach inline to it
  if (!contentEl.firstElementChild) {
    const p = document.createElement('p');
    p.appendChild(document.createTextNode(""));
    contentEl.appendChild(p);
  }
  return contentEl;
}

// -------------------------------------------------------------
// String fuzzy-matching helper
// -------------------------------------------------------------
/**
 * Attempts to find the best matching string from *candidates* compared to *input*.
 * Uses a lightweight Levenshtein distance with an optional threshold.
 * Returns the matched candidate or null when no sufficiently close match found.
 *
 * @param {string} input – String returned by LLM (may be partial/inaccurate)
 * @param {Array<string>} candidates – List of valid strings
 * @param {number|null} [maxDistance=null] – Max edit distance; when null no threshold.
 * @returns {string|null}
 */
export function fuzzyMatchWithList(input, candidates, maxDistance = null) {
  if (!input || !Array.isArray(candidates) || !candidates.length) return null;
  const norm = (s) => (s || "").toLowerCase().trim();
  const needle = norm(input);

  // 1. Exact (case-insensitive) match
  const exact = candidates.find((c) => norm(c) === needle);
  if (exact) return exact;

  // 2. Substring match (handles truncated IDs)
  const partial = candidates.find((c) => norm(c).includes(needle) || needle.includes(norm(c)));
  if (partial) return partial;

  // 3. Levenshtein distance – pick smallest distance below threshold
  function _lev(a, b) {
    const m = a.length,
      n = b.length;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1, // deletion
          dp[i][j - 1] + 1, // insertion
          dp[i - 1][j - 1] + cost // substitution
        );
      }
    }
    return dp[m][n];
  }

  let best = null;
  let bestDist = Infinity;
  for (const cand of candidates) {
    const d = _lev(needle, norm(cand));
    if (d < bestDist) {
      bestDist = d;
      best = cand;
    }
  }
  if (maxDistance === null || maxDistance === undefined) return best;
  return bestDist <= maxDistance ? best : null;
}

/**
 * Renders a streaming selectable email list (checkbox + subject/from/date) into
 * the provided container.
 */
export async function renderEmailSelectionList(container, emailArray, options = {}) {
  const { delay = 35, initialChecked = true, singleSelect = false, preSelectedHeaderId = null, displayOnly = false } = options;
  if (!container) throw new Error("container is required");

  // Ensure reverse-chronological order (most recent first) when a valid date is present.
  emailArray = [...emailArray].sort((a, b) => {
    const da = a && a.date ? new Date(a.date) : 0;
    const db = b && b.date ? new Date(b.date) : 0;
    return db - da;
  });

  // Render list inside a tool-styled agent bubble for consistent indentation and cleanup
  const bubble = document.createElement("div");
  bubble.className = "agent-message tool";
  try { bubble.setAttribute("data-tm-role", "tool-bubble"); } catch (_) {}
  
  // Set data-pid for tool grouping (matches createNewAgentBubble behavior)
  try {
    const { ctx } = await import("./context.js");
    if (ctx && (ctx.awaitingPid || ctx.activePid || ctx.activeToolCallId)) {
      bubble.setAttribute("data-pid", String(ctx.awaitingPid || ctx.activePid || ctx.activeToolCallId));
    }
  } catch (_) {}
  
  const content = document.createElement("div");
  content.className = "bubble-content";
  bubble.appendChild(content);
  container.appendChild(bubble);
  
  // Add to tool group if collapsing is enabled
  try {
    const { addToolBubbleToGroup, isToolCollapseEnabled } = await import("./toolCollapse.js");
    if (isToolCollapseEnabled()) {
      addToolBubbleToGroup(bubble, container, "Showing selection list...");
    }
  } catch (e) {
    log(`[Helpers] Failed to add list bubble to tool group: ${e}`, "warn");
  }

  const listWrapper = document.createElement("div");
  listWrapper.className = "email-selection-list";
  try { listWrapper.setAttribute("data-tm-tool", "email-selection-list"); } catch (_) {}
  listWrapper.style.position = "relative";
  content.appendChild(listWrapper);

  // Shared tooltip element - append to body to escape parent opacity
  const tooltip = document.createElement("div");
  tooltip.className = "email-item-tooltip";
  tooltip.style.display = "none";
  tooltip.style.position = "fixed"; // Change to fixed since we'll position relative to viewport
  document.body.appendChild(tooltip);

  // Helper to keep row classes and the global selection list in sync when radios change.
  function syncAllRowsAndSelection() {
    try {
      const inputs = listWrapper.querySelectorAll('input[type="radio"], input[type="checkbox"]');
      let selectedMeta = null;
      inputs.forEach((inp) => {
        const row = inp.closest('.email-item-row');
        if (!row) return;
        if (inp.checked) {
          row.classList.remove('unchecked');
          if (singleSelect) {
            const idStr = inp.dataset.messageId;
            const idNum = idStr !== undefined ? Number(idStr) : NaN;
            selectedMeta = {
              uniqueId: inp.dataset.uniqueId || "",
              messageId: Number.isFinite(idNum) ? idNum : idStr,  // Keep for backward compatibility
            };
          }
        } else {
          row.classList.add('unchecked');
        }
      });
      if (singleSelect) {
        if (!window.selectedEmailList) window.selectedEmailList = [];
        if (selectedMeta && selectedMeta.uniqueId) {
          // Preserve reference so external modules that captured the array keep seeing updates
          window.selectedEmailList.length = 0;
          window.selectedEmailList.push(selectedMeta);
        }
        // Log current selection for debugging
        try {
          const sel = window.selectedEmailList?.[0] || {};
          const selUniqueId = sel.uniqueId || '(none)';
          const selId = sel.messageId;
          console.log(`[TMDBG EmailSelect] Synced radio group. Selected uniqueId=${selUniqueId} messageId=${selId} (type=${typeof selId})`);
        } catch (_) {}
      }
    } catch (e) {
      try { console.log(`[TMDBG EmailSelect] syncAllRowsAndSelection failed: ${e}`); } catch(_) {}
    }
  }

  function _createRow(item) {
    const row = document.createElement("div");
    row.className = "email-item-row";

    // Selection control (or bullet when displayOnly)
    let checkbox = null;
    if (!displayOnly) {
      checkbox = document.createElement("input");
      checkbox.type = singleSelect ? "radio" : "checkbox";
      if (singleSelect) {
        checkbox.name = "email-selection-radio";
      }
      checkbox.checked = singleSelect ? item.uniqueId === preSelectedHeaderId : initialChecked;
      checkbox.dataset.uniqueId = item.uniqueId || "";
      checkbox.dataset.messageId = item.messageId;
    } else {
      const bullet = document.createElement("span");
      bullet.className = "bullet-col";
      bullet.textContent = "•";
      row.appendChild(bullet);
    }

    function syncSelection() {
      if (displayOnly || !window.selectedEmailList) return;
      if (singleSelect) {
        if (checkbox && checkbox.checked) {
          // Mutate the original array to preserve references (ctx.selectedEmailList)
          window.selectedEmailList.length = 0;
          window.selectedEmailList.push({ 
            uniqueId: item.uniqueId,
            messageId: item.messageId  // Keep for backward compatibility
          });
          try {
            console.log(`[TMDBG EmailSelect] Selected (single) uniqueId=${item.uniqueId} id=${item.messageId}`);
          } catch (_) {}
        }
      } else {
        const idx = window.selectedEmailList.findIndex((e) => e.uniqueId === item.uniqueId);
        if (checkbox && checkbox.checked && idx === -1) {
          window.selectedEmailList.push({ 
            uniqueId: item.uniqueId,
            messageId: item.messageId  // Keep for backward compatibility
          });
        } else if (checkbox && !checkbox.checked && idx !== -1) {
          window.selectedEmailList.splice(idx, 1);
        }
      }
    }

    const subjectSpan = document.createElement("span");
    subjectSpan.className = "subject-col";
    subjectSpan.textContent = item.subject || "(No subject)";

    const fromSpan = document.createElement("span");
    fromSpan.className = "from-col";
    fromSpan.textContent = item.from || "";

    const dateSpan = document.createElement("span");
    dateSpan.className = "date-col";
    dateSpan.textContent = item.date || "";

    if (!displayOnly && checkbox) row.appendChild(checkbox);
    row.appendChild(subjectSpan);
    row.appendChild(fromSpan);
    row.appendChild(dateSpan);

    function updateUncheckedStyle() {
      if (displayOnly) {
        row.classList.remove("unchecked");
        return;
      }
      if (checkbox && checkbox.checked) {
        row.classList.remove("unchecked");
      } else {
        row.classList.add("unchecked");
      }
      syncSelection();
    }
    if (!displayOnly && checkbox) {
      checkbox.addEventListener("change", () => {
        // Ignore all interactions once the list is locked
        try { if (listWrapper.classList.contains('locked')) return; } catch(_) {}
        // Update this row and then ensure the group visuals are in sync.
        updateUncheckedStyle();
        // For singleSelect radios, the previously-checked input does not reliably
        // emit a change event. Force a full sync of all rows to update visuals.
        if (singleSelect) syncAllRowsAndSelection();
      });
    }
    updateUncheckedStyle();

    if (!displayOnly) {
      row.addEventListener("click", (ev) => {
        // Ignore clicks once locked to prevent visual changes post-return
        try { if (listWrapper.classList.contains('locked')) return; } catch(_) {}
        if (ev.target !== checkbox) {
          if (singleSelect) {
            if (checkbox && !checkbox.checked) {
              checkbox.checked = true;
              updateUncheckedStyle();
              syncAllRowsAndSelection();
            }
          } else {
            if (checkbox) {
              checkbox.checked = !checkbox.checked;
              updateUncheckedStyle();
            }
          }
        }
      });
    }

    // Hover/tooltip handling
    row.addEventListener("mouseenter", (ev) => {
      row.classList.add("hovered");
      try {
        console.log(`[TMDBG EmailSelect] Tooltip mouseenter for item:`, {
          subject: item.subject,
          uniqueId: item.uniqueId,
          hasBlurb: !!item.blurb,
          blurbLength: item.blurb?.length || 0,
          hasTodos: !!item.todos,
          todosLength: item.todos?.length || 0,
          blurbValue: item.blurb,
          todosValue: item.todos
        });
      } catch(_) {}
      let todosHtml = "";
      if (item.todos && item.todos.trim()) {
        const items = item.todos
          .split("•")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((it) => it.replace(/^[-•*\s]+/, ""));
        if (items.length) {
          todosHtml =
            '<strong>Todos:</strong><ul class="tooltip-todos">' +
            items.map((it) => `<li>${it}</li>`).join("") +
            "</ul>";
        }
      }
      const summaryHtml = item.blurb
        ? `<strong>Summary:</strong><div class="tooltip-summary">${item.blurb}</div>`
        : "";
      const tooltipContent = (todosHtml + summaryHtml) || "(No details)";
      try {
        console.log(`[TMDBG EmailSelect] Tooltip content: ${tooltipContent.substring(0, 100)}`);
      } catch(_) {}
      tooltip.innerHTML = tooltipContent;

      const rowRect = row.getBoundingClientRect();

      // Force tooltip to be fully opaque with inline styles
      tooltip.style.display = "block";
      tooltip.style.setProperty("opacity", "1", "important");
      tooltip.style.setProperty("z-index", "999999", "important");
      
      // Debug: Log computed styles to diagnose transparency issue
      try {
        const computedStyle = window.getComputedStyle(tooltip);
        console.log(`[TMDBG Tooltip] Tooltip computed opacity: ${computedStyle.opacity}, z-index: ${computedStyle.zIndex}`);
      } catch(e) {
        console.log(`[TMDBG Tooltip] Debug failed: ${e}`);
      }
      
      const ttRect = tooltip.getBoundingClientRect();
      
      // Position relative to viewport (since we're using fixed positioning)
      let leftPos = rowRect.right - ttRect.width - 8;
      if (leftPos < 8) leftPos = 8;
      const maxLeft = window.innerWidth - ttRect.width - 8;
      if (leftPos > maxLeft) leftPos = maxLeft;
      tooltip.style.left = `${leftPos}px`;

      // Simple positioning: if row is in bottom half of viewport, show tooltip above; otherwise below
      const viewportH = window.innerHeight || document.documentElement.clientHeight;
      const rowCenterY = rowRect.top + (rowRect.height / 2);
      const showAbove = rowCenterY > (viewportH / 2);
      
      let topPos;
      if (showAbove) {
        // Show above: tooltip bottom aligns with row top
        topPos = rowRect.top - ttRect.height - 4;
      } else {
        // Show below: tooltip top aligns with row bottom
        topPos = rowRect.bottom + 4;
      }
      
      try { 
        log(`[TMDBG EmailSelect] Tooltip position: rowCenterY=${rowCenterY} viewportH=${viewportH} showAbove=${showAbove} topPos=${topPos}`);
      } catch(_) {}
      
      tooltip.style.top = `${topPos}px`;
    });

    row.addEventListener("mouseleave", () => {
      row.classList.remove("hovered");
      tooltip.style.display = "none";
    });

    return row;
  }

  for (const emailItem of emailArray) {
    const rowEl = _createRow(emailItem);
    listWrapper.appendChild(rowEl);
    container.scrollTop = container.scrollHeight;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((res) => setTimeout(res, delay));
  }

  return listWrapper;
}

// ---------------------------------------------------------------------------
// Helper – Initialise the compose draft
// ---------------------------------------------------------------------------

export function initialiseEmailCompose() {
  ctx.composeDraft = {
    recipients: [],
    cc: [],
    bcc: [],
    subject: "",
    body: "",
    request: null,
    replyToId: null,
  };
}

// ---------------------------------------------------------------------------
// Shared formatter – Inbox/Search items → wrapped text for LLM prompts
// ---------------------------------------------------------------------------

/**
 * Formats an array of inbox/search items into a wrapped text block suitable for LLM prompts.
 * Each item can include: uniqueId, internalId, date, from, subject, blurb, todos, snippet, hasAttachments.
 * If snippet is available (from FTS search), it will be used instead of blurb/todos.
 *
 * @param {Array<Object>} items
 * @param {{ includeUniqueId?: boolean }} [options]
 * @returns {string}
 */
export function formatMailList(items, options = {}) {
  try {
    const blocks = (Array.isArray(items) ? items : []).map((it) => {
      const lines = [];
      lines.push(
        `unique_id: ${it.uniqueId}`,
        `date: ${it?.date || ""}`,
        `from: ${it?.from || ""}`,
        `subject: ${it?.subject || "(No subject)"}`,
        `has_attachments: ${it?.hasAttachments ? "yes" : "no"}`,
        `currently_tagged_for: ${it?.action || ""}`,
        `replied: ${it?.replied === true ? "yes" : "no"}`
      );
      
      // Use snippet if available (FTS search), otherwise use blurb/todos
      if (it?.snippet && it.snippet.trim()) {
        lines.push(`search snippet: ${it.snippet}`);
      } else {
        // Traditional blurb/todos display (only if they have content)
        if (it?.todos && it.todos.trim()) {
          lines.push(`todos: ${it.todos}`);
        }
        if (it?.blurb && it.blurb.trim()) {
          lines.push(`two-line summary: ${it.blurb}`);
        }
      }
      return lines.join("\n\n");
    });
    const body = blocks.join("\n\n");
    return `====BEGIN EMAIL LIST====\n${body}\n====END EMAIL LIST====`;
  } catch (_) {
    const safe = (Array.isArray(items) ? items : []).length;
    return `====BEGIN EMAIL LIST====\n(Unable to format ${safe} items)\n====END EMAIL LIST====`;
  }
}
