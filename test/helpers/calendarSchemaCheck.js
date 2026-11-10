/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// What a flow sends to the calendar bridge must be what the tmCalendar
// experiment declares: Thunderbird checks a call against schema.json and
// refuses an undeclared property, a missing required one, or a value of
// another type. As Firefox's Schemas.sys.mjs: an integer is a whole number,
// null on an optional property is absent, and an object takes only its
// declared properties unless additionalProperties.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(__dirname, '../../chat/experiments/tmCalendar/schema.json');

export const SCHEMA_FUNCTIONS = JSON.parse(readFileSync(schemaPath, 'utf8')).flatMap((ns) => ns.functions || []);

export function checkAgainst(spec, value, path) {
  const kind = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  const fits = spec.type === 'integer' ? Number.isInteger(value) : spec.type === kind;
  if (spec.type && spec.type !== 'any' && !fits) throw new Error(`${path}: ${kind}, declared ${spec.type}`);
  if (spec.enum && !spec.enum.includes(value)) throw new Error(`${path}: ${value} is not one of ${spec.enum}`);
  if (kind === 'array' && spec.items) value.forEach((v, i) => checkAgainst(spec.items, v, `${path}[${i}]`));
  if (kind === 'object' && spec.type === 'object') {
    const declared = spec.properties || {};
    for (const key of Object.keys(value)) {
      const absent = value[key] === undefined || (value[key] === null && declared[key]?.optional);
      if (key in declared) {
        if (!absent) checkAgainst(declared[key], value[key], `${path}.${key}`);
      } else if (spec.additionalProperties) {
        if (spec.additionalProperties.type !== 'any') checkAgainst(spec.additionalProperties, value[key], `${path}.${key}`);
      } else {
        throw new Error(`${path}.${key}: unexpected property`);
      }
    }
    for (const [key, p] of Object.entries(declared)) {
      if (!p.optional && (value[key] === undefined || value[key] === null)) throw new Error(`${path}.${key}: missing`);
    }
  }
}

// The bridge, with each call checked against its declared parameters first.
// A call that does not fit pushes its message to `errors` and throws, as
// Thunderbird refuses it.
export function checked(api, errors) {
  const out = {};
  for (const fn of SCHEMA_FUNCTIONS) {
    if (typeof api[fn.name] !== 'function') continue;
    out[fn.name] = (...args) => {
      try {
        (fn.parameters || []).forEach((p, i) => {
          if (args[i] === undefined && p.optional) return;
          checkAgainst(p, args[i], `${fn.name}.${p.name}`);
        });
      } catch (e) {
        errors.push(String(e.message));
        throw e;
      }
      return api[fn.name](...args);
    };
  }
  return out;
}
