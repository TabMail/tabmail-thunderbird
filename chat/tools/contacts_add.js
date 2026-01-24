// contacts_add.js – add a contact to the main (default) address book

import { log } from "../../agent/modules/utils.js";

function normalizeArgs(args = {}) {
  const a = args || {};
  const out = {};
  if (typeof a.addressbook_id === "string") out.addressbook_id = a.addressbook_id.trim();
  if (typeof a.name === "string") out.name = a.name.trim();
  if (typeof a.email === "string") out.email = a.email.trim();
  if (typeof a.second_email === "string") out.second_email = a.second_email.trim();
  if (typeof a.first_name === "string") out.first_name = a.first_name.trim();
  if (typeof a.last_name === "string") out.last_name = a.last_name.trim();
  if (typeof a.nickname === "string") out.nickname = a.nickname.trim();
  return out;
}

async function getDefaultAddressBookId() {
  try {
    const { defaultAddressBookId } = await browser.storage.local.get({ defaultAddressBookId: null });
    if (!defaultAddressBookId) {
      log("[TMDBG Tools] contacts_add: no defaultAddressBookId set in storage", "error");
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
        log(`[TMDBG Tools] contacts_add: available address books: ${bookInfo.join(", ")}`);
      } catch (e) {
        log(`[TMDBG Tools] contacts_add: failed to list address books: ${e}`, "warn");
      }
      return null;
    }
    return defaultAddressBookId;
  } catch (e) {
    log(`[TMDBG Tools] contacts_add: failed to read defaultAddressBookId: ${e}`, "error");
    return null;
  }
}

function buildVCardFromFields(fields) {
  const fn = (fields.name || `${fields.first_name || ""} ${fields.last_name || ""}`.trim()).trim();
  const nLast = (fields.last_name || "").trim();
  const nFirst = (fields.first_name || "").trim();
  const nickname = (fields.nickname || "").trim();
  const primary = (fields.email || "").trim();
  const second = (fields.second_email || "").trim();
  const lines = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `FN:${fn}`,
    `N:${nLast};${nFirst};;;`,
  ];
  if (nickname) lines.push(`NICKNAME:${nickname}`);
  if (primary) lines.push(`EMAIL;TYPE=PREF:${primary}`);
  if (second) lines.push(`EMAIL:${second}`);
  lines.push("END:VCARD");
  return lines.join("\n");
}

export async function run(args = {}, options = {}) {
  try {
    const norm = normalizeArgs(args);
    
    // Use provided addressbook_id or fall back to default
    let parentId = norm.addressbook_id;
    if (!parentId) {
      parentId = await getDefaultAddressBookId();
      if (!parentId) {
        return {
          error: "No addressbook_id provided and no default address book configured. Please set a default address book in TabMail Settings.",
        };
      }
    }

    if (!norm.name && !norm.email && !norm.first_name && !norm.last_name) {
      log("[TMDBG Tools] contacts_add: missing required name/email fields", "error");
      return { error: "Provide at least a name or an email to add a contact." };
    }

    const vCard = buildVCardFromFields(norm);
    log(
      `[TMDBG Tools] contacts_add: creating contact in addressbookId='${parentId}' with fields name='${norm.name || ""}' email='${norm.email || ""}' second='${norm.second_email || ""}' first='${norm.first_name || ""}' last='${norm.last_name || ""}' nick='${norm.nickname || ""}'`
    );
    const id = await browser.addressBooks.contacts.create(parentId, vCard);
    log(`[TMDBG Tools] contacts_add: created contact id='${id}'`);
    return `Contact created in address book.`;
  } catch (e) {
    log(`[TMDBG Tools] contacts_add failed: ${e}`, "error");
    return { error: String(e || "unknown error in contacts_add") };
  }
}


