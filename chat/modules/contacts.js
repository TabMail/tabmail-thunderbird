// contacts.js – shared address book helpers (TB 140, MV3)
// Centralizes contact querying, vCard parsing, and recipient list UI rendering.

import { log } from "../../agent/modules/utils.js";
import { CHAT_SETTINGS } from "./chatConfig.js";
import { ctx } from "./context.js";

// -----------------------------------------------------------------------------
// Query contacts with a soft timeout
// IMPORTANT: Low-level primitive. Prefer using findContactsCandidates() for
// all app logic. If you must call queryContacts directly, follow the same
// strategy as findContactsCandidates: run a global query, then fall back to
// per-book queries on timeout/zero results, parse vCards, and dedupe.
// -----------------------------------------------------------------------------
export async function queryContacts(searchString, timeoutMs) {
  try {
    let didTimeout = false;
    const startedAt = Date.now();
    const result = await Promise.race([
      browser.addressBooks.contacts.query({ searchString }),
      new Promise((resolve) =>
        setTimeout(() => {
          didTimeout = true;
          resolve([]);
        }, timeoutMs)
      ),
    ]);
    const elapsedMs = Date.now() - startedAt;
    try {
      log(
        `[TMDBG Contacts] contacts.query('${searchString}') returned ${Array.isArray(result) ? result.length : 0} in ${elapsedMs}ms${didTimeout ? " (timeout)" : ""}`
      );
    } catch (_) {}
    return { rows: Array.isArray(result) ? result : [], didTimeout, elapsedMs };
  } catch (err) {
    log(
      `[TMDBG Contacts] contacts.query failed: ${err?.message || err}`,
      "warn"
    );
    return { rows: [], didTimeout: false, elapsedMs: 0 };
  }
}

// -----------------------------------------------------------------------------
// Minimal vCard parser for common fields (FN, N, NICKNAME, EMAIL)
// -----------------------------------------------------------------------------
export function parseVCardBasic(vcardText) {
  const result = {
    fn: "",
    firstName: "",
    lastName: "",
    nickName: "",
    emails: [],
    preferredEmail: "",
  };
  if (!vcardText || typeof vcardText !== "string") return result;

  const lines = [];
  for (const rawLine of vcardText.split(/\r?\n/)) {
    const line = String(rawLine || "");
    if (line.startsWith(" ") && lines.length > 0) {
      lines[lines.length - 1] += line.slice(1);
    } else {
      lines.push(line);
    }
  }

  const emailCandidates = [];
  for (const line of lines) {
    const up = line.toUpperCase();
    if (up.startsWith("FN:")) {
      result.fn = line.slice(3).trim();
      continue;
    }
    if (up.startsWith("N:")) {
      const parts = line.slice(2).split(";");
      result.lastName = (parts[0] || "").trim();
      result.firstName = (parts[1] || "").trim();
      continue;
    }
    if (up.startsWith("NICKNAME:")) {
      result.nickName = line.slice(9).trim();
      continue;
    }
    if (up.startsWith("EMAIL")) {
      const [left, value = ""] = line.split(":");
      const params = left
        .split(";")
        .slice(1)
        .map((p) => p.trim().toUpperCase());
      const email = value.trim();
      if (email) emailCandidates.push({ email, params });
    }
  }
  result.emails = emailCandidates.map((e) => e.email);
  const pref = emailCandidates.find((e) => e.params.some((p) => p.includes("PREF")));
  result.preferredEmail = (pref ? pref.email : result.emails[0] || "").trim();
  return result;
}

// -----------------------------------------------------------------------------
// High-level search: run global query, then per-book aggregation on timeout/zero
// Returns deduped [{ name, email }]
//
// Preferred API for contact lookups. Always use this in tools/modules instead of
// queryContacts(). Handles timeouts, per-book fallback, vCard parsing, and
// deduplication.
// -----------------------------------------------------------------------------
export async function findContactsCandidates(queryText, options = {}) {
  const timeoutMs = Number(options.timeoutMs ?? CHAT_SETTINGS?.contactsQueryTimeoutMs);
  const parentIds = Array.isArray(options.parentIds)
    ? options.parentIds.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim())
    : [];
  const limit = Number.isFinite(options.limit) ? options.limit : undefined;

  if (!queryText || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    log(`[TMDBG Contacts] findContactsCandidates: invalid params query='${queryText}' timeoutMs='${timeoutMs}'`, "error");
    return [];
  }

  try {
    // Log API availability and book inventory once per call
    try {
      const exists = !!(browser?.addressBooks?.contacts?.query);
      log(`[TMDBG Contacts] findContactsCandidates: contacts.query available=${exists}`);
      const books = await browser.addressBooks.list();
      const bookInfo = (books || []).map((b) => {
        try {
          const id = b?.id || "";
          const name = b?.name || b?.properties?.dirName || "";
          const type = b?.type || b?.addressBookType || "";
          return `${name || id}(${type || ""})`;
        } catch (_) {
          return "<unknown>";
        }
      });
      log(`[TMDBG Contacts] findContactsCandidates: books=${bookInfo.join(", ")}`);
    } catch (invErr) {
      log(`[TMDBG Contacts] findContactsCandidates: addressBooks.list failed: ${invErr}`, "warn");
    }

    let main = { rows: [], didTimeout: false, elapsedMs: 0 };
    let aggregatedRows = [];

    if (parentIds.length > 0) {
      log(`[TMDBG Contacts] findContactsCandidates: using explicit parent_ids (${parentIds.length})`);
      for (const parentId of parentIds) {
        let didTimeout = false;
        const startedAt = Date.now();
        try {
          const res = await Promise.race([
            browser.addressBooks.contacts.query({ searchString: queryText, parentId }),
            new Promise((resolve) =>
              setTimeout(() => {
                didTimeout = true;
                resolve([]);
              }, Math.min(timeoutMs, 8000))
            ),
          ]);
          const elapsed = Date.now() - startedAt;
          const count = Array.isArray(res) ? res.length : 0;
          log(
            `[TMDBG Contacts] findContactsCandidates(parent_ids): parent='${parentId}' returned ${count} in ${elapsed}ms${didTimeout ? " (timeout)" : ""}`
          );
          if (!didTimeout && count > 0) aggregatedRows.push(...res);
        } catch (e) {
          log(`[TMDBG Contacts] findContactsCandidates(parent_ids): parent='${parentId}' query failed: ${e}`, "warn");
        }
      }
      log(`[TMDBG Contacts] findContactsCandidates: aggregated rows from parent_ids=${aggregatedRows.length}`);
    } else {
      main = await queryContacts(queryText, timeoutMs);
      log(`[TMDBG Contacts] findContactsCandidates: raw matches=${Array.isArray(main.rows) ? main.rows.length : 0}`);
    }

    if (parentIds.length === 0 && (main.didTimeout || (Array.isArray(main.rows) && main.rows.length === 0))) {
      try {
        const books = await browser.addressBooks.list();
        for (const b of books || []) {
          const parentId = b?.id;
          const name = b?.name || b?.properties?.dirName || parentId;
          let didTimeout = false;
          const startedAt = Date.now();
          try {
            const res = await Promise.race([
              browser.addressBooks.contacts.query({ searchString: queryText, parentId }),
              new Promise((resolve) =>
                setTimeout(() => {
                  didTimeout = true;
                  resolve([]);
                }, Math.min(timeoutMs, 8000))
              ),
            ]);
            const elapsed = Date.now() - startedAt;
            const count = Array.isArray(res) ? res.length : 0;
            log(
              `[TMDBG Contacts] findContactsCandidates(diag): parent='${name}' returned ${count} in ${elapsed}ms${didTimeout ? " (timeout)" : ""}`
            );
            if (!didTimeout && count > 0) aggregatedRows.push(...res);
          } catch (e) {
            log(`[TMDBG Contacts] findContactsCandidates(diag): parent='${name}' query failed: ${e}`, "warn");
          }
        }
        log(`[TMDBG Contacts] findContactsCandidates: aggregated per-book rows=${aggregatedRows.length}`);
      } catch (e) {
        log(`[TMDBG Contacts] findContactsCandidates(diag): addressBooks.list failed: ${e}`, "warn");
      }
    }

    // Build candidates from properties and vCard; skip entries without any email
    const candidates = [];
    const rowsToProcess = aggregatedRows.length > 0 ? aggregatedRows : main.rows;
    for (const m of rowsToProcess) {
      const props = m?.properties || {};
      const vcard = m?.vCard || m?.vcard || "";
      const parsed = parseVCardBasic(vcard);
      try {
        const propKeys = Object.keys(props || {});
        log(
          `[TMDBG Contacts] findContactsCandidates: node keys=${Object.keys(m || {}).join(",")} props=${propKeys.join(",")} vCardLen=${vcard ? vcard.length : 0} emails=${parsed.emails.length}`
        );
      } catch (_) {}

      const displayName = (props.DisplayName || parsed.fn || "").trim();
      const firstName = (props.FirstName || parsed.firstName || "").trim();
      const lastName = (props.LastName || parsed.lastName || "").trim();
      const nickName = (props.NickName || parsed.nickName || "").trim();
      const combinedName = [firstName, lastName].filter(Boolean).join(" ").trim();
      const resolvedName = displayName || combinedName || nickName || "";

      const primaryEmail = (props.PrimaryEmail || parsed.preferredEmail || "").trim();
      const secondEmail = (props.SecondEmail || parsed.emails[1] || "").trim();
      const allEmails = [primaryEmail, secondEmail, ...parsed.emails].filter(
        (e, idx, arr) => e && arr.indexOf(e) === idx
      );

      if (allEmails.length === 0) {
        log(
          `[TMDBG Contacts] findContactsCandidates: skipping contact with no email (name='${resolvedName}')`
        );
        continue;
      }

      candidates.push({ name: resolvedName, emails: allEmails, primaryEmail });
    }

    // Dedupe by primary email; keep entry with longer name
    const byEmail = new Map();
    for (const entry of candidates) {
      for (const email of entry.emails) {
        const key = email.toLowerCase();
        const existing = byEmail.get(key);
        if (!existing) {
          byEmail.set(key, { name: entry.name, email, primaryEmail: entry.primaryEmail });
        } else {
          const newNameLen = (entry.name || "").length;
          const oldNameLen = (existing.name || "").length;
          if (newNameLen > oldNameLen) {
            log(
              `[TMDBG Contacts] findContactsCandidates: dedupe choose longer name '${entry.name}' over '${existing.name}' for ${key}`
            );
            byEmail.set(key, { name: entry.name, email, primaryEmail: entry.primaryEmail });
          }
        }
      }
    }

    let results = Array.from(byEmail.values());
    if (Number.isFinite(limit) && limit > 0 && results.length > limit) {
      results = results.slice(0, limit);
    }
    log(`[TMDBG Contacts] findContactsCandidates: returning ${results.length} unique contacts`);
    return results;
  } catch (e) {
    log(`[TMDBG Contacts] findContactsCandidates failed: ${e}`, "error");
    return [];
  }
}

// -----------------------------------------------------------------------------
// findContactsRawRows – return raw contacts rows with IDs using same strategy
// as findContactsCandidates (global then per-book aggregation). This ensures
// callers that need IDs/parentIds index from the exact same pool used for
// candidate building, avoiding mismatches due to timeouts or per-book paths.
// -----------------------------------------------------------------------------
export async function findContactsRawRows(queryText, options = {}) {
  const timeoutMs = Number(options.timeoutMs ?? CHAT_SETTINGS?.contactsQueryTimeoutMs);
  const parentIds = Array.isArray(options.parentIds)
    ? options.parentIds.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim())
    : [];

  if (!queryText || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    log(`[TMDBG Contacts] findContactsRawRows: invalid params query='${queryText}' timeoutMs='${timeoutMs}'`, "error");
    return [];
  }

  try {
    let main = { rows: [], didTimeout: false, elapsedMs: 0 };
    let aggregatedRows = [];

    if (parentIds.length > 0) {
      log(`[TMDBG Contacts] findContactsRawRows: using explicit parent_ids (${parentIds.length})`);
      for (const parentId of parentIds) {
        let didTimeout = false;
        const startedAt = Date.now();
        try {
          const res = await Promise.race([
            browser.addressBooks.contacts.query({ searchString: queryText, parentId }),
            new Promise((resolve) =>
              setTimeout(() => {
                didTimeout = true;
                resolve([]);
              }, Math.min(timeoutMs, 8000))
            ),
          ]);
          const elapsed = Date.now() - startedAt;
          const count = Array.isArray(res) ? res.length : 0;
          log(
            `[TMDBG Contacts] findContactsRawRows(parent_ids): parent='${parentId}' returned ${count} in ${elapsed}ms${didTimeout ? " (timeout)" : ""}`
          );
          if (!didTimeout && count > 0) aggregatedRows.push(...res);
        } catch (e) {
          log(`[TMDBG Contacts] findContactsRawRows(parent_ids): parent='${parentId}' query failed: ${e}`, "warn");
        }
      }
      log(`[TMDBG Contacts] findContactsRawRows: aggregated rows from parent_ids=${aggregatedRows.length}`);
    } else {
      main = await queryContacts(queryText, timeoutMs);
      log(`[TMDBG Contacts] findContactsRawRows: raw matches=${Array.isArray(main.rows) ? main.rows.length : 0}`);
    }

    if (parentIds.length === 0 && (main.didTimeout || (Array.isArray(main.rows) && main.rows.length === 0))) {
      try {
        const books = await browser.addressBooks.list();
        for (const b of books || []) {
          const parentId = b?.id;
          const name = b?.name || b?.properties?.dirName || parentId;
          let didTimeout = false;
          const startedAt = Date.now();
          try {
            const res = await Promise.race([
              browser.addressBooks.contacts.query({ searchString: queryText, parentId }),
              new Promise((resolve) =>
                setTimeout(() => {
                  didTimeout = true;
                  resolve([]);
                }, Math.min(timeoutMs, 8000))
              ),
            ]);
            const elapsed = Date.now() - startedAt;
            const count = Array.isArray(res) ? res.length : 0;
            log(
              `[TMDBG Contacts] findContactsRawRows(diag): parent='${name}' returned ${count} in ${elapsed}ms${didTimeout ? " (timeout)" : ""}`
            );
            if (!didTimeout && count > 0) aggregatedRows.push(...res);
          } catch (e) {
            log(`[TMDBG Contacts] findContactsRawRows(diag): parent='${name}' query failed: ${e}`, "warn");
          }
        }
        log(`[TMDBG Contacts] findContactsRawRows: aggregated per-book rows=${aggregatedRows.length}`);
      } catch (e) {
        log(`[TMDBG Contacts] findContactsRawRows(diag): addressBooks.list failed: ${e}`, "warn");
      }
    }

    const out = aggregatedRows.length > 0 ? aggregatedRows : (Array.isArray(main.rows) ? main.rows : []);
    log(`[TMDBG Contacts] findContactsRawRows: returning rows=${out.length}`);
    return out;
  } catch (e) {
    log(`[TMDBG Contacts] findContactsRawRows failed: ${e}`, "error");
    return [];
  }
}

// -----------------------------------------------------------------------------
// UI: render a simple selectable recipient list (name + address only)
// (moved from chat/modules/compose.js)
// -----------------------------------------------------------------------------
export async function renderRecipientSelectionList(
  container,
  recips,
  { delay = 25 } = {}
) {
  // Wrap list in a tool-styled bubble for consistent styling and tool group integration
  const bubble = document.createElement("div");
  bubble.className = "agent-message tool";
  try { bubble.setAttribute("data-tm-role", "tool-bubble"); } catch (_) {}
  
  // Set data-pid for tool grouping
  try {
    if (ctx && (ctx.awaitingPid || ctx.activePid || ctx.activeToolCallId)) {
      bubble.setAttribute("data-pid", String(ctx.awaitingPid || ctx.activePid || ctx.activeToolCallId));
    }
  } catch (_) {}
  
  const bubbleContent = document.createElement("div");
  bubbleContent.className = "bubble-content";
  bubble.appendChild(bubbleContent);
  container.appendChild(bubble);
  
  // Add to tool group if collapsing is enabled
  try {
    const { addToolBubbleToGroup, isToolCollapseEnabled } = await import("./toolCollapse.js");
    if (isToolCollapseEnabled()) {
      addToolBubbleToGroup(bubble, container, "Showing recipients...");
    }
  } catch (e) {
    log(`[Contacts] Failed to add recipient list bubble to tool group: ${e}`, "warn");
  }
  
  const listWrapper = document.createElement("div");
  listWrapper.className = "recipient-selection-list";
  bubbleContent.appendChild(listWrapper);

  function _createRow(item) {
    const row = document.createElement("div");
    row.className = "recipient-row";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = item.checked !== false; // default checked true

    const nameSpan = document.createElement("span");
    nameSpan.className = "name-col";
    nameSpan.textContent = item.name || "(No name)";

    const emailSpan = document.createElement("span");
    emailSpan.className = "email-col";
    emailSpan.textContent = item.email || "";

    row.appendChild(checkbox);
    row.appendChild(nameSpan);
    row.appendChild(emailSpan);

    function syncSelection() {
      if (!ctx.selectedRecipientList) ctx.selectedRecipientList = [];
      const idx = ctx.selectedRecipientList.findIndex(
        (e) => e.email === item.email
      );
      if (checkbox.checked && idx === -1) {
        ctx.selectedRecipientList.push(item);
      } else if (!checkbox.checked && idx !== -1) {
        ctx.selectedRecipientList.splice(idx, 1);
      }
    }
    syncSelection();
    checkbox.addEventListener("change", syncSelection);

    row.addEventListener("click", (ev) => {
      if (ev.target !== checkbox) {
        checkbox.checked = !checkbox.checked;
        syncSelection();
      }
    });
    return row;
  }

  for (const rec of recips) {
    const rowEl = _createRow(rec);
    listWrapper.appendChild(rowEl);
    container.scrollTop = container.scrollHeight;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((res) => setTimeout(res, delay));
  }

  return listWrapper;
}


// -----------------------------------------------------------------------------
// normalizeRecipients – fill missing names and override LLM-provided names
// using the address book when available. Returns new array.
// Each recipient is an object: { email: string, name?: string }
// -----------------------------------------------------------------------------
export async function normalizeRecipients(inputRecipients) {
  try {
    const shouldNormalize = !!CHAT_SETTINGS?.normalizeRecipientsFromContacts;
    if (!shouldNormalize) {
      log(`[TMDBG Contacts] normalizeRecipients: normalization disabled in config`);
      return Array.isArray(inputRecipients) ? inputRecipients.slice() : [];
    }
    const timeoutMs = Number(CHAT_SETTINGS?.contactsQueryTimeoutMs) || 100;
    if (!Array.isArray(inputRecipients) || inputRecipients.length === 0) return [];

    log(`[TMDBG Contacts] normalizeRecipients: starting for ${inputRecipients.length} recipient(s)`);

    const results = [];
    for (const rec of inputRecipients) {
      const email = (rec?.email || "").trim();
      const llmName = (rec?.name || "").trim();
      if (!email) {
        log(`[TMDBG Contacts] normalizeRecipients: skip entry missing email`);
        continue;
      }

      // Prefer robust candidate finder (handles per-book queries and vCard parsing)
      let resolvedName = "";
      try {
        const candidates = await findContactsCandidates(email, { timeoutMs, limit: 10 });
        log(`[TMDBG Contacts] normalizeRecipients: candidates for '${email}' = ${candidates.length}`);
        let selected = candidates.find((c) => String(c.email || "").toLowerCase() === email.toLowerCase());
        if (!selected) selected = candidates.find((c) => String(c.primaryEmail || "").toLowerCase() === email.toLowerCase());
        if (!selected && candidates.length > 0) selected = candidates[0];
        if (selected) {
          resolvedName = (selected.name || "").trim();
          log(`[TMDBG Contacts] normalizeRecipients: selected name='${resolvedName}' for ${email}`);
        } else {
          log(`[TMDBG Contacts] normalizeRecipients: no candidate matched for ${email}`);
        }
      } catch (e) {
        log(`[TMDBG Contacts] normalizeRecipients: findContactsCandidates failed for ${email}: ${e}`, "warn");
      }

      // Overwrite name if address book provides one, else keep LLM name or empty
      const finalName = resolvedName || llmName || "";
      results.push({ email, name: finalName });
    }

    log(`[TMDBG Contacts] normalizeRecipients: completed; normalized ${results.length} recipient(s)`);
    return results;
  } catch (e) {
    log(`[TMDBG Contacts] normalizeRecipients failed: ${e}`, "error");
    // Per repo rule, no fallbacks; return original list to avoid silent behavior changes
    return Array.isArray(inputRecipients) ? inputRecipients.slice() : [];
  }
}


