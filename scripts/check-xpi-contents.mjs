/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Checks a built XPI: nothing web-ext-config.mjs leaves out is in it, and the
// manifest and the license notices are (rules in scripts/xpi-contents.mjs).
//
//   node scripts/check-xpi-contents.mjs <path/to/addon.xpi>
//
// Exits 0 when the XPI is clean, 1 with one line per problem otherwise (or
// when the XPI cannot be read), and 2 without an XPI path. This file only runs
// the check; nothing imports it.

import { listXpi, xpiProblems } from "./xpi-contents.mjs";

function main(argv) {
  const xpiPath = argv[0];
  if (!xpiPath) {
    console.error("usage: node scripts/check-xpi-contents.mjs <path/to/addon.xpi>");
    return 2;
  }
  // An XPI unzip cannot list throws here, and node exits 1.
  const entries = listXpi(xpiPath);
  const problems = xpiProblems(entries);
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    console.error(`${xpiPath}: ${problems.length} problem(s)`);
    return 1;
  }
  console.log(`${xpiPath}: ${entries.length} entries, none excluded, notices present`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
