// contactsDelete.js – FSM states for contacts_delete (TB 141+, MV3)

import { log } from "../../agent/modules/utils.js";
import { createNewAgentBubble } from "../chat.js";
import { parseVCardBasic } from "../modules/contacts.js";
import { ctx } from "../modules/context.js";
import { awaitUserInput } from "../modules/converse.js";
import { streamText } from "../modules/helpers.js";

async function resolveAddressBookName(parentId) {
  try {
    const books = await browser.addressBooks.list();
    for (const b of books || []) {
      if ((b?.id || "") === parentId) {
        return (
          b?.name || b?.properties?.dirName || parentId || "(Unknown book)"
        );
      }
    }
  } catch (e) {
    log(`[ContactsDelete] resolveAddressBookName failed: ${e}`, "warn");
  }
  return parentId || "(Unknown book)";
}

function formatContactForDisplay(c, bookName) {
  try {
    const props = c?.properties || {};
    const vcard = c?.vCard || c?.vcard || "";
    const parsed = parseVCardBasic(vcard);
    const lines = [];
    if (bookName) lines.push(`Address Book: ${bookName}`);
    const displayName = (props.DisplayName || parsed.fn || "").trim();
    const firstName = (props.FirstName || parsed.firstName || "").trim();
    const lastName = (props.LastName || parsed.lastName || "").trim();
    const nickName = (props.NickName || parsed.nickName || "").trim();
    const primary = (props.PrimaryEmail || parsed.preferredEmail || "").trim();
    const second = (props.SecondEmail || parsed.emails[1] || "").trim();

    if (displayName) lines.push(`Name: ${displayName}`);
    if (firstName) lines.push(`First Name: ${firstName}`);
    if (lastName) lines.push(`Last Name: ${lastName}`);
    if (nickName) lines.push(`Nickname: ${nickName}`);
    if (primary) lines.push(`Primary: ${primary}`);
    if (second) lines.push(`Secondary: ${second}`);
    return lines.join("\n");
  } catch (e) {
    return "(Failed to format contact)";
  }
}

async function getDefaultAddressBookId() {
  try {
    const { defaultAddressBookId } = await browser.storage.local.get({
      defaultAddressBookId: null,
    });
    return defaultAddressBookId || null;
  } catch (e) {
    log(`[ContactsDelete] failed to read defaultAddressBookId: ${e}`, "error");
    return null;
  }
}

async function findContactIdByExactEmailInDefault(defaultParentId, email) {
  try {
    const rows = await browser.addressBooks.contacts.query({
      searchString: email,
      parentId: defaultParentId,
    });
    const lowered = String(email || "").toLowerCase();
    for (const r of rows || []) {
      const props = r?.properties || {};
      const primary = (props.PrimaryEmail || "").toLowerCase();
      const second = (props.SecondEmail || "").toLowerCase();
      if (primary === lowered || second === lowered) return r.id;
    }
    return null;
  } catch (e) {
    log(`[ContactsDelete] query by email failed: ${e}`, "error");
    return null;
  }
}

async function fetchContactDetailsById(contactId) {
  try {
    const c = await browser.addressBooks.contacts.get(contactId);
    return c || null;
  } catch (e) {
    log(`[ContactsDelete] get(${contactId}) failed: ${e}`, "warn");
    return null;
  }
}

export async function runStateDeleteContactsList() {
  const agentBubble = await createNewAgentBubble(
    "Preparing contact preview..."
  );

  // Extract args
  let contactId = null;
  let matchEmail = null;
  try {
    const pid = ctx.activePid || ctx.activeToolCallId || 0;
    const sess = pid ? (ctx.fsmSessions[pid] ||= {}) : {};
    contactId = sess?.deleteArgs?.contact_id || null;
    matchEmail = sess?.deleteArgs?.match_email || null;
  } catch (_) {}

  const parentId = await getDefaultAddressBookId();
  if (!parentId) {
    agentBubble.classList.remove("loading");
    const msg = "Default address book is not configured.";
    streamText(agentBubble, msg);
    try {
      const pid = ctx.activePid || ctx.activeToolCallId || 0;
      if (pid) ctx.fsmSessions[pid].failReason = msg;
    } catch (_) {}
    ctx.state = "exec_fail";
    const core = await import("./core.js");
    await core.executeAgentAction();
    return;
  }

  if (!contactId && matchEmail) {
    contactId = await findContactIdByExactEmailInDefault(parentId, matchEmail);
  }

  if (!contactId) {
    agentBubble.classList.remove("loading");
    const msg = "I cannot find the contact to delete.";
    streamText(agentBubble, msg);
    try {
      const pid = ctx.activePid || ctx.activeToolCallId || 0;
      if (pid)
        ctx.fsmSessions[pid].failReason =
          "Missing contact id or no match by email.";
    } catch (_) {}
    ctx.state = "exec_fail";
    const core = await import("./core.js");
    await core.executeAgentAction();
    return;
  }

  // Save back resolved contactId
  try {
    const pid = ctx.activePid || ctx.activeToolCallId || 0;
    if (pid) (ctx.fsmSessions[pid].deleteArgs ||= {}).contact_id = contactId;
  } catch (_) {}

  const details = await fetchContactDetailsById(contactId);
  try {
    const keys = Object.keys(details || {}).join(",");
    const pkeys = Object.keys(details?.properties || {}).join(",");
    const vlen = (details?.vCard || details?.vcard || "").length;
    log(
      `[ContactsDelete] details keys=${keys} propKeys=${pkeys} vCardLen=${vlen}`
    );
  } catch (_) {}
  const bookName = await resolveAddressBookName(
    details?.parentId || details?.parentid || details?.parent_id || ""
  );

  agentBubble.classList.remove("loading");
  let assistantText = "";
  if (details) {
    const formatted = formatContactForDisplay(details, bookName);
    assistantText = `I found this contact:\n\n${formatted}`;
    streamText(agentBubble, assistantText);
  } else {
    const failMsg = `Failed to read contact details for id ${contactId}.`;
    log(`[ContactsDelete] details fetch failed for id=${contactId}`, "error");
    streamText(agentBubble, failMsg);
    try {
      const pid = ctx.activePid || ctx.activeToolCallId || 0;
      if (pid) ctx.fsmSessions[pid].failReason = failMsg;
    } catch (_) {}
    ctx.state = "exec_fail";
    const core = await import("./core.js");
    await core.executeAgentAction();
    return;
  }

  const confirmBubble = await createNewAgentBubble("Thinking...");
  confirmBubble.classList.remove("loading");
  const bubbleText = "Should I go ahead and delete this contact?";
  streamText(confirmBubble, bubbleText);

  try {
    ctx.pendingSuggestion = "yes";
    if (window.tmShowSuggestion) window.tmShowSuggestion();
  } catch (_) {}
  awaitUserInput();
}

export async function runStateDeleteContactsExecute() {
  const agentBubble = await createNewAgentBubble("Deleting contact...");

  let contactId = null;
  try {
    const pid = ctx.activePid || ctx.activeToolCallId || 0;
    const sess = pid ? (ctx.fsmSessions[pid] ||= {}) : {};
    contactId = sess?.deleteArgs?.contact_id || null;
  } catch (_) {}

  if (!contactId) {
    agentBubble.classList.remove("loading");
    const msg = "Delete failed because contact_id is missing.";
    streamText(agentBubble, msg);
    try {
      const pid = ctx.activePid || ctx.activeToolCallId || 0;
      if (pid) ctx.fsmSessions[pid].failReason = "Missing contact_id in exec.";
    } catch (_) {}
    ctx.state = "exec_fail";
    const core = await import("./core.js");
    await core.executeAgentAction();
    return;
  }

  try {
    await browser.addressBooks.contacts.delete(contactId);
  } catch (e) {
    agentBubble.classList.remove("loading");
    const msg = `Failed to delete the contact: ${e}`;
    streamText(agentBubble, msg);
    try {
      const pid = ctx.activePid || ctx.activeToolCallId || 0;
      if (pid) ctx.fsmSessions[pid].failReason = String(e);
    } catch (_) {}
    ctx.state = "exec_fail";
    const core = await import("./core.js");
    await core.executeAgentAction();
    return;
  }

  agentBubble.classList.remove("loading");
  const resultMsg = "Contact deleted.";
  streamText(agentBubble, resultMsg);

  ctx.state = "exec_success";
  const core = await import("./core.js");
  await core.executeAgentAction();
}
