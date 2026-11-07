/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The background's runtime-message listener (setupRuntimeMessageListener from
// agent/background.js, as the background registers it) with its stored-turns
// import bound to `queue`, the test's instance of
// chat/modules/storedTurnsQueue.js. Returns `send(message)` → the reply.

import { experimentFunctions } from '../helpers/experimentFunctions.js';

const BACKGROUND = new URL('../../agent/background.js', import.meta.url);
const routes = new WeakMap();

export function storedTurnsRoute(queue) {
  if (routes.has(queue)) return routes.get(queue);
  let listener;
  const { setupRuntimeMessageListener } = experimentFunctions(BACKGROUND, ['setupRuntimeMessageListener'], {
    agentRuntimeMessageListener: null, cleanupRuntimeListeners() {}, log() {},
    browser: { runtime: { onMessage: { addListener: fn => { listener = fn; } } } },
  }, { '../chat/modules/storedTurnsQueue.js': queue });
  setupRuntimeMessageListener();
  const send = message => listener(structuredClone(message), {}, () => {});
  routes.set(queue, send);
  return send;
}

/** An alarms API for pages whose background test double runs the queue. */
export function quietAlarms() {
  return { onAlarm: { addListener() {} }, create: async () => {}, clear: async () => {}, get: async () => undefined };
}

/** Answer `message` as the background does, from the current module registry's queue. */
export async function sendToBackground(message) {
  const queue = await import('../../chat/modules/storedTurnsQueue.js');
  return storedTurnsRoute(queue)(message);
}
