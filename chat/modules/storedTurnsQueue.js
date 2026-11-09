/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// storedTurnsQueue.js – the one writer of the stored chat turns (chat_turns).
//
// Runs in the background, and only there. Every change to the stored turns is
// an operation (clear, remove by id, keep from a time, update by id, append):
// the chat window and Chat History send theirs as runtime messages
// (persistentChatStore.changeTurns), the background's own code calls
// enqueueTurnsChange. The changes run one at a time on one in-memory chain, in
// the order they arrive, each as read, change, write, then answer. No writer
// ever replaces the turns with an older copy, so a Clear All is never undone.
//
// Nothing is kept across a restart: a change still running when Thunderbird
// quits or the background unloads is lost, and its caller, if still there, is
// told it failed, so the user can repeat it.

import { log } from "../../agent/modules/utils.js";
import { applyTurnsOperation } from "./persistentChatStore.js";

const TURNS_KEY = "chat_turns";

let _chain = Promise.resolve();

/** Apply one operation to the stored turns: read, change, write. A failed read writes nothing. */
async function _apply(op) {
  const stored = (await browser.storage.local.get(TURNS_KEY))[TURNS_KEY];
  const { turns, removed } = applyTurnsOperation(Array.isArray(stored) ? stored : [], op);
  if (turns.length > 0) await browser.storage.local.set({ [TURNS_KEY]: turns });
  else await browser.storage.local.remove(TURNS_KEY);
  log(`[StoredTurnsQueue] Applied change: ${turns.length} stored, ${removed} removed`, "debug");
  return { removed };
}

/**
 * Apply a change to the stored turns after every change sent before it.
 *
 * @param {{ clear?: boolean, remove?: string[], keepFrom?: number, update?: object[], append?: object[] }} op
 *   see persistentChatStore.applyTurnsOperation
 * @returns {Promise<{ applied: true, removed: number } | { applied: false, error: string }>}
 *   applied, or failed and not applied (a failed write may have stored it;
 *   the user repeats the change, which gives the same turns applied twice)
 */
export function enqueueTurnsChange(op) {
  const run = _chain.then(() => _apply(op));
  _chain = run.catch(() => {});
  return run.then(
    result => ({ applied: true, ...result }),
    e => {
      log(`[StoredTurnsQueue] Change failed: ${e}`, "warn");
      return { applied: false, error: String(e) };
    },
  );
}

/**
 * The background's handler for a change an extension page sends
 * ({ command: "chat-turns-change", op }). Resolves to the reply.
 */
export function handleStoredTurnsMessage(message) {
  return enqueueTurnsChange(message.op);
}
