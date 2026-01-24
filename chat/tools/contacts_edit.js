// contacts_edit.js – edit a contact in the main (default) address book

import { log } from "../../agent/modules/utils.js";
import { parseVCardBasic } from "../modules/contacts.js";

function normalizeArgs(args = {}) {
  const a = args || {};
  const out = {};
  if (typeof a.contact_id === "string") out.contact_id = a.contact_id.trim();
  if (typeof a.addressbook_id === "string") out.addressbook_id = a.addressbook_id.trim();
  if (typeof a.name === "string") out.name = a.name.trim();
  if (typeof a.email === "string") out.email = a.email.trim();
  if (Array.isArray(a.other_emails)) {
    out.other_emails = a.other_emails.filter(Boolean).map((s) => String(s).trim()).filter(Boolean);
  }
  if (typeof a.first_name === "string") out.first_name = a.first_name.trim();
  if (typeof a.last_name === "string") out.last_name = a.last_name.trim();
  if (typeof a.nickname === "string") out.nickname = a.nickname.trim();
  return out;
}

async function getDefaultAddressBookId() {
  try {
    const { defaultAddressBookId } = await browser.storage.local.get({ defaultAddressBookId: null });
    if (!defaultAddressBookId) {
      log("[TMDBG Tools] contacts_edit: no defaultAddressBookId set in storage", "error");
      try {
        const books = await browser.addressBooks.list();
        const bookInfo = (books || []).map((b) => {
          try {
            const id = b?.id || "";
            const name = b?.name || b?.properties?.dirName || "";
            const type = b?.type || b?.addressBookType || "";
            return `${name || id}(${type || ""})#${id}`;
          } catch (_) {
            return "<unknown>";
          }
        });
        log(`[TMDBG Tools] contacts_edit: available address books: ${bookInfo.join(", ")}`);
      } catch (e) {
        log(`[TMDBG Tools] contacts_edit: failed to list address books: ${e}`, "warn");
      }
      return null;
    }
    return defaultAddressBookId;
  } catch (e) {
    log(`[TMDBG Tools] contacts_edit: failed to read defaultAddressBookId: ${e}`, "error");
    return null;
  }
}

async function ensureContactInDefaultBook(contactId, defaultParentId) {
  try {
    const c = await browser.addressBooks.contacts.get(contactId);
    const parentId = c?.parentId || c?.parentid || c?.parent_id || null;
    if (parentId !== defaultParentId) {
      log(`[TMDBG Tools] contacts_edit: contact '${contactId}' not in default book. parentId='${parentId}' default='${defaultParentId}'`, "error");
      return { ok: false, error: "Contact is not in the default address book." };
    }
    return { ok: true, contact: c };
  } catch (e) {
    log(`[TMDBG Tools] contacts_edit: failed to load contact '${contactId}': ${e}`, "error");
    return { ok: false, error: String(e) };
  }
}

function updateVCard(vCard, fields, currentProps = {}) {
  // Naive but deterministic line-based updater for FN, N, NICKNAME, EMAIL
  try {
    const lines = String(vCard || "").split(/\r?\n/);
    let out = [];
    for (const line of lines) {
      const up = line.toUpperCase();
      if (up.startsWith("FN:")) continue;
      if (up.startsWith("N:")) continue;
      if (up.startsWith("NICKNAME:")) continue;
      if (up.startsWith("EMAIL")) continue;
      out.push(line);
    }

    // Parse current values to support preservation behaviour
    const parsed = parseVCardBasic(vCard || "");
    const currentFirst = (currentProps.FirstName || parsed.firstName || "").trim();
    const currentLast = (currentProps.LastName || parsed.lastName || "").trim();
    const currentFN = (parsed.fn || `${currentFirst} ${currentLast}`.trim()).trim();
    const currentNick = (currentProps.NickName || parsed.nickName || "").trim();
    const currentPrimary = (currentProps.PrimaryEmail || parsed.preferredEmail || "").trim();
    const currentOthersRaw = [currentProps.SecondEmail, ...parsed.emails].filter(Boolean);
    const currentOthers = Array.from(new Set(currentOthersRaw.filter((e) => String(e).trim() && String(e).trim().toLowerCase() !== currentPrimary.toLowerCase())));

    // Helper to merge provided scalar field with current, removing only on explicit empty string
    const mergeField = (currentVal, providedVal) => {
      if (typeof providedVal === "undefined") return currentVal;
      if (typeof providedVal === "string" && providedVal === "") return ""; // explicit removal
      return String(providedVal);
    };

    const nextFN = mergeField(currentFN, fields.name);
    const nextFirst = mergeField(currentFirst, fields.first_name);
    const nextLast = mergeField(currentLast, fields.last_name);
    const nextNick = mergeField(currentNick, fields.nickname);
    const nextPrimary = mergeField(currentPrimary, fields.email).trim();

    let nextOthers = currentOthers.slice();
    if (Array.isArray(fields.other_emails)) {
      nextOthers = fields.other_emails.map((e) => String(e || "").trim()).filter(Boolean);
    }
    // Deduplicate and ensure primary is not duplicated among others
    const dedup = new Set();
    const finalOthers = [];
    for (const e of nextOthers) {
      const low = e.toLowerCase();
      if (low && low !== nextPrimary.toLowerCase() && !dedup.has(low)) {
        dedup.add(low);
        finalOthers.push(e);
      }
    }

    const rebuilt = [];
    for (const l of out) {
      if (l === "BEGIN:VCARD" || l === "VERSION:3.0") rebuilt.push(l);
      else if (l === "END:VCARD") break;
      else rebuilt.push(l);
    }
    if (!rebuilt.includes("BEGIN:VCARD")) rebuilt.unshift("BEGIN:VCARD");
    if (!rebuilt.find((l) => l.startsWith("VERSION:"))) rebuilt.splice(1, 0, "VERSION:3.0");

    // FN and N
    if (nextFN) rebuilt.push(`FN:${nextFN}`);
    rebuilt.push(`N:${nextLast || ""};${nextFirst || ""};;;`);

    // Nickname
    if (nextNick) rebuilt.push(`NICKNAME:${nextNick}`);

    // Emails: primary then others
    if (nextPrimary) rebuilt.push(`EMAIL;TYPE=PREF:${nextPrimary}`);
    for (const e of finalOthers) {
      rebuilt.push(`EMAIL:${e}`);
    }

    rebuilt.push("END:VCARD");
    return rebuilt.join("\n");
  } catch (e) {
    log(`[TMDBG Tools] contacts_edit: updateVCard failed: ${e}`, "error");
    throw e;
  }
}


export async function run(args = {}, options = {}) {
  try {
    const norm = normalizeArgs(args);
    
    // Use provided addressbook_id or fall back to default
    let parentId = norm.addressbook_id;
    if (!parentId) {
      parentId = await getDefaultAddressBookId();
      if (!parentId) {
        return { error: "No addressbook_id provided and no default address book configured. Please set it in TabMail Settings." };
      }
    }
    
    const targetId = norm.contact_id || null;
    if (!targetId) {
      log("[TMDBG Tools] contacts_edit: missing contact_id (email lookup disabled by design)", "error");
      return { error: "Provide contact_id to edit." };
    }
    
    const check = await ensureContactInDefaultBook(targetId, parentId);
    if (!check.ok) return { error: check.error || "Contact not in the specified address book." };

    const currentVCard = check.contact?.vCard || check.contact?.vcard || "BEGIN:VCARD\nVERSION:3.0\nEND:VCARD";
    const updatedVCard = updateVCard(currentVCard, norm, check.contact?.properties || {});
    log(`[TMDBG Tools] contacts_edit: updating contact '${targetId}' in address book '${parentId}' (vCard length=${updatedVCard?.length || 0})`);
    // Thunderbird WebExtension API expects a string vCard as the second arg
    await browser.addressBooks.contacts.update(targetId, String(updatedVCard || ""));
    log(`[TMDBG Tools] contacts_edit: updated contact '${targetId}'`);
    return `Contact updated.`;
  } catch (e) {
    log(`[TMDBG Tools] contacts_edit failed: ${e}`, "error");
    return { error: String(e || "unknown error in contacts_edit") };
  }
}


