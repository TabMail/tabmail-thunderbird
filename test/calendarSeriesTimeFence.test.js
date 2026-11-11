/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// calendarSeriesTimeFence.test.js: the functions that read and write the
// times of an edit keep to one way of reading a time. A stored value is never
// converted into another zone (getInTimezone lands an hour off near a clock
// change); a time given in another zone reaches the event's zone only through
// atInstantInFrameOf, which refuses what it cannot store; lengths are
// measured by the clock (clockSeconds) or by Thunderbird's own elapsed time in
// the few functions named here. Parsed with acorn from the source as it is at
// run time, by whole identifiers.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'acorn';

const BRIDGE = new URL('../chat/experiments/tmCalendar/tmCalendar.sys.mjs', import.meta.url);
const source = () => readFileSync(BRIDGE, 'utf8');

const OWNED = [
  'clockSeconds', 'afterElapsed', 'atInstantInFrameOf', 'intoFrameOf', 'restates', 'timesLeft', 'seriesLength',
  'resolveEditTimes', 'writeSeriesTimes', 'applyNewLength', 'seriesEditTimes', 'shownNaiveIso', 'shownEditTimes',
  'toCalIDateTimeInFrameOf',
];

function walk(node, fn) {
  if (!node || typeof node !== 'object') return;
  fn(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((v) => walk(v, fn));
    else if (value && typeof value === 'object' && typeof value.type === 'string') walk(value, fn);
  }
}

/** Every top-level function declaration of the bridge, by name. */
function declarations() {
  const ast = parse(source(), { ecmaVersion: 'latest', sourceType: 'module' });
  const out = new Map();
  walk(ast, (n) => { if (n.type === 'FunctionDeclaration' && n.id) out.set(n.id.name, n); });
  return { ast, out };
}

/** The names a function's body uses: called functions, called methods, read properties and identifiers. */
function uses(fnNode) {
  const calls = new Set();
  const methods = new Set();
  const names = new Set();
  walk(fnNode.body, (n) => {
    if (n.type === 'CallExpression') {
      if (n.callee.type === 'Identifier') calls.add(n.callee.name);
      if (n.callee.type === 'MemberExpression' && !n.callee.computed) methods.add(n.callee.property.name);
    }
    if (n.type === 'MemberExpression' && !n.computed) names.add(n.property.name);
    if (n.type === 'Identifier') names.add(n.name);
  });
  return { calls, methods, names };
}

function owned() {
  const { out } = declarations();
  const missing = OWNED.filter((name) => !out.has(name));
  expect(missing, 'owned functions missing').toEqual([]);
  return OWNED.map((name) => [name, uses(out.get(name))]);
}

describe('the times of an edit are read one way', () => {
  it('the owned functions never call getInTimezone, .compare( or sameTime(', () => {
    for (const [name, u] of owned()) {
      expect(u.names.has('getInTimezone'), `${name} reads getInTimezone`).toBe(false);
      expect(u.methods.has('compare'), `${name} calls .compare(`).toBe(false);
      expect(u.calls.has('sameTime'), `${name} calls sameTime(`).toBe(false);
    }
  });

  it('nativeTime appears only in shownNaiveIso; subtractDate( and addDuration( only where a length is measured or added', () => {
    const where = (test) => owned().filter(([, u]) => test(u)).map(([name]) => name).sort();
    expect(where((u) => u.names.has('nativeTime'))).toEqual(['shownNaiveIso']);
    expect(where((u) => u.methods.has('subtractDate'))).toEqual(['afterElapsed', 'atInstantInFrameOf', 'restates', 'seriesLength']);
    expect(where((u) => u.methods.has('addDuration'))).toEqual(['afterElapsed', 'applyNewLength', 'atInstantInFrameOf']);
  });

  it('the file has no sameInstantIn, plusLength, inFrameOf, SKIPPED_HOUR_SECONDS or applyEditToNamedOccurrence', () => {
    const text = source();
    for (const name of ['sameInstantIn', 'plusLength', 'inFrameOf', 'SKIPPED_HOUR_SECONDS', 'applyEditToNamedOccurrence']) {
      expect(new RegExp(`\\b${name}\\b`).test(text), name).toBe(false);
    }
  });

  it('applyDurationPreservation is called once', () => {
    const { ast } = declarations();
    let count = 0;
    walk(ast, (n) => { if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'applyDurationPreservation') count += 1; });
    expect(count).toBe(1);
  });
});
