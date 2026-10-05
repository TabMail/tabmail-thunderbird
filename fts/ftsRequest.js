/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// fts/ftsRequest.js – run one FTS request in the context that owns the native helper.

/**
 * In the background, which owns the native helper's port, calls `direct` with the engine module
 * ({ ftsSearch, memorySearch }). Any other extension page has no port of its own, so it sends
 * { type: "fts", cmd, ...fields } to the background, whose command handler answers. That answer is
 * undefined when nothing handled the message, and { error } when the command threw.
 */
export async function ftsRequest(cmd, fields, direct) {
  const { ownsNativeHelper } = await import("./nativeEngine.js");
  if (ownsNativeHelper()) return direct(await import("./engine.js"));
  return browser.runtime.sendMessage({ type: "fts", cmd, ...fields });
}
