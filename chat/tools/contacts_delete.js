// contacts_delete.js – delete a contact from the main (default) address book

import { log } from "../../agent/modules/utils.js";
import { createNewAgentBubble } from "../chat.js";
import { ctx, initFsmSession } from "../modules/context.js";

function normalizeArgs(args = {}) {
  const a = args || {};
  const out = {};
  if (typeof a.contact_id === "string") out.contact_id = a.contact_id.trim();
  if (typeof a.addressbook_id === "string")
    out.addressbook_id = a.addressbook_id.trim();
  // Email matching is intentionally disabled; require contact_id
  return out;
}

async function getDefaultAddressBookId() {
  try {
    const { defaultAddressBookId } = await browser.storage.local.get({
      defaultAddressBookId: null,
    });
    if (!defaultAddressBookId) {
      log(
        "[TMDBG Tools] contacts_delete: no defaultAddressBookId set in storage",
        "error"
      );
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
        log(
          `[TMDBG Tools] contacts_delete: available address books: ${bookInfo.join(
            ", "
          )}`
        );
      } catch (e) {
        log(
          `[TMDBG Tools] contacts_delete: failed to list address books: ${e}`,
          "warn"
        );
      }
      return null;
    }
    return defaultAddressBookId;
  } catch (e) {
    log(
      `[TMDBG Tools] contacts_delete: failed to read defaultAddressBookId: ${e}`,
      "error"
    );
    return null;
  }
}

async function ensureContactInDefaultBook(contactId, defaultParentId) {
  try {
    const c = await browser.addressBooks.contacts.get(contactId);
    const parentId = c?.parentId || c?.parentid || c?.parent_id || null;
    if (parentId !== defaultParentId) {
      log(
        `[TMDBG Tools] contacts_delete: contact '${contactId}' not in default book. parentId='${parentId}' default='${defaultParentId}'`,
        "error"
      );
      return {
        ok: false,
        error: "Contact is not in the default address book.",
      };
    }
    return { ok: true, contact: c };
  } catch (e) {
    log(
      `[TMDBG Tools] contacts_delete: failed to load contact '${contactId}': ${e}`,
      "error"
    );
    return { ok: false, error: String(e) };
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
    log(`[TMDBG Tools] contacts_delete: query by email failed: ${e}`, "error");
    return null;
  }
}

export async function run(args = {}, options = {}) {
  try {
    log(
      `[TMDBG Tools] contacts_delete: Tool called with args: ${JSON.stringify(
        args
      )}`
    );
    try {
      requestAnimationFrame(() => {
        _runDeleteContact(args, options).catch((e) => {
          try {
            log(
              `[TMDBG Tools] contacts_delete scheduled run failed: ${e}`,
              "error"
            );
          } catch (_) {}
        });
      });
      log(
        `[TMDBG Tools] contacts_delete: scheduled _runDeleteContact for next frame`
      );
    } catch (e) {
      log(
        `[TMDBG Tools] contacts_delete: failed to schedule _runDeleteContact: ${e}`,
        "error"
      );
    }
    const pid =
      options && typeof options.callId === "string"
        ? options.callId
        : options.callId || null;
    return { fsm: true, tool: "contacts_delete", pid, startedAt: Date.now() };
  } catch (e) {
    log(`[TMDBG Tools] contacts_delete failed: ${e}`, "error");
    return { error: String(e || "unknown error in contacts_delete") };
  }
}

async function _runDeleteContact(args = {}, options = {}) {
  const norm = normalizeArgs(args);

  // Use provided addressbook_id or fall back to default
  let parentId = norm.addressbook_id;
  if (!parentId) {
    parentId = await getDefaultAddressBookId();
    if (!parentId) {
      log(
        "[TMDBG Tools] contacts_delete: no addressbook_id provided and no default address book configured; aborting",
        "error"
      );
      return;
    }
  }

  try {
    ctx.activeToolCallId = options?.callId || ctx.activeToolCallId || null;
  } catch (_) {}
  ctx.toolExecutionMode = "contacts_delete";
  ctx.state = "contacts_delete_list";

  try {
    const pid = ctx.activeToolCallId || 0;
    if (pid) {
      initFsmSession(pid, "contacts_delete");
      // Store delete args in session
      ctx.fsmSessions[pid].deleteArgs = norm;
      log(
        `[TMDBG Tools] contacts_delete: Initialized FSM session with system prompt for pid=${pid}`
      );
      ctx.activePid = pid;
      ctx.awaitingPid = pid;
    }
  } catch (_) {}

  try {
    const pid = ctx.activePid || ctx.activeToolCallId || 0;
    if (pid) {
      ctx.fsmSessions[pid].fsmPrevState = "contacts_delete_list";
    }
  } catch (_) {}

  // Diagnose matching by logging exact candidates from the default book
  // Email matching disabled; require exact contact_id from search results

  // Use the agent bubble from wsTools
  let agentBubble = options.agentBubble;
  if (!agentBubble) {
    log(
      `[TMDBG Tools] contacts_delete: No agent bubble provided, creating fallback`,
      "warn"
    );
    agentBubble = await createNewAgentBubble("Preparing delete preview...");
  }

  const core = await import("../fsm/core.js");
  await core.executeAgentAction();
}

export async function completeExecution(currentState, prevState) {
  const pid = ctx.activePid || ctx.activeToolCallId || 0;
  const failReason =
    (pid &&
      ctx.fsmSessions &&
      ctx.fsmSessions[pid] &&
      ctx.fsmSessions[pid].failReason) ||
    "";
  if (failReason) {
    log(
      `[TMDBG Tools] contacts_delete.completeExecution: failed – ${failReason}`
    );
    return `Failed: ${failReason}`;
  }
  if (prevState === "contacts_delete_execute") {
    log(`[TMDBG Tools] contacts_delete.completeExecution: deleted via FSM`);
    return "Selected contact(s) deleted.";
  }
  log(`[TMDBG Tools] contacts_delete.completeExecution: completed`);
  return "Delete workflow completed.";
}
