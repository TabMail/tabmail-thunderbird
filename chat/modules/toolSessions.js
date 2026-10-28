/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// toolSessions.js – where a search tool keeps the results it fetched, so the
// next page of the same call comes from the same results.

/**
 * A search tool's sessions. The chat window's turn has one set, cleared by
 * `resetTurn` when a new user turn starts. Each headless run (proactive
 * check-in, reply generation, compose edit) has its own set, kept under the
 * run's isolated context that executeToolsHeadless passes as `headlessRun`:
 * runs overlap (reply generations run alongside each other and check-ins), so
 * none may be answered from, or clear, another's results. A run's set goes
 * away with its context (#171).
 */
export function createToolSessions() {
  let turn = {};
  const runs = new WeakMap();
  return {
    of(headlessRun) {
      if (!headlessRun) return turn;
      let sessions = runs.get(headlessRun);
      if (!sessions) {
        sessions = {};
        runs.set(headlessRun, sessions);
      }
      return sessions;
    },
    resetTurn() {
      turn = {};
    },
  };
}
