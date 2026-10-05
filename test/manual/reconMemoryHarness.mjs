/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Synthetic JS-heap measurement of the folder reconciliation digests (not
// part of `npm test`). Runs the real `_fingerprintStringsCooperatively` and
// `_fingerprintMsgKeysCooperatively` over synthetic folders, one folder at a
// time as the scheduler does, and reports the peak heap seen while they run
// and the heap retained after a forced GC.
//
//   node --expose-gc test/manual/reconMemoryHarness.mjs [folders] [messagesPerFolder] [indexerModulePath]
//
// Defaults: 50 folders x 20000 messages (1M headers) against this checkout.
// To compare with an older revision, extract it to a scratch directory, add
// both functions to its `_testExports`, and pass its fts/incrementalIndexer.js.

import { pathToFileURL } from "node:url";
import path from "node:path";

const folders = Number(process.argv[2] || 50);
const messagesPerFolder = Number(process.argv[3] || 20_000);
const modulePath = path.resolve(process.argv[4] || "fts/incrementalIndexer.js");
const sampleIntervalMs = 5;

if (typeof globalThis.gc !== "function") {
  throw new Error("run with node --expose-gc");
}

// The indexer's imports register WebExtension listeners at load time; an
// inert recursive stub satisfies them. Nothing here touches storage.
const stub = () => new Proxy(function () {}, {
  get: (_target, key) => (key === "then" ? undefined : stub()),
  apply: () => undefined,
});
globalThis.browser = stub();
globalThis.messenger = globalThis.browser;

const { _testExports: exportsUnderTest } = await import(pathToFileURL(modulePath).href);
const fingerprintStrings = exportsUnderTest._fingerprintStringsCooperatively;
const fingerprintMsgKeys = exportsUnderTest._fingerprintMsgKeysCooperatively;
if (typeof fingerprintStrings !== "function" || typeof fingerprintMsgKeys !== "function") {
  throw new Error("the indexer module must export both digest functions in _testExports");
}

const mib = bytes => Math.round((bytes / (1024 * 1024)) * 10) / 10;

globalThis.gc();
const baselineHeap = process.memoryUsage().heapUsed;
let peakHeap = baselineHeap;
const sampler = setInterval(() => {
  peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
}, sampleIntervalMs);

const startedMs = Date.now();
for (let folder = 0; folder < folders; folder++) {
  const keys = new Array(messagesPerFolder);
  const msgKeys = new Array(messagesPerFolder);
  for (let message = 0; message < messagesPerFolder; message++) {
    keys[message] = `account1:/Folder${folder}:message-${message}-${folder}@example.com`;
    // High-bit UIDs included, as the unsigned UID view requires.
    msgKeys[message] = (message * 2654435761) >>> 0;
  }
  await fingerprintStrings(keys, true);
  await fingerprintMsgKeys(msgKeys);
  peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
}
clearInterval(sampler);
const elapsedMs = Date.now() - startedMs;

globalThis.gc();
const retainedHeap = process.memoryUsage().heapUsed;
console.log(JSON.stringify({
  module: path.relative(process.cwd(), modulePath),
  folders,
  messagesPerFolder,
  headers: folders * messagesPerFolder,
  elapsedMs,
  baselineHeapMiB: mib(baselineHeap),
  peakHeapAboveBaselineMiB: mib(peakHeap - baselineHeap),
  retainedHeapAboveBaselineMiB: mib(retainedHeap - baselineHeap),
}));
process.exit(0);
