/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// localeDateFence.test.js — no date the add-on shows the assistant or writes
// is formatted in the user's locale. Thunderbird's JS default locale is its UI
// language, so `toLocaleDateString()` (or `toLocaleString`,
// `toLocaleTimeString`, `Intl.DateTimeFormat` with no locale, `undefined` or
// `[]`) prints a Thai Thunderbird's dates in the Buddhist calendar and a
// Persian one's in the Persian calendar and digits. Model-facing and written
// dates go through `formatGregorianDate` (agent/modules/gregorianDate.js) or
// an explicit English locale.
//
// Every such call in the add-on's source, and every one naming a locale that
// is not an English literal (a user locale read at run time), is listed here
// with its function. The list is exact: a new call fails until it is either
// moved to formatGregorianDate or, when it only shows the user a date in
// their own language, added below with the reason.

import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { parse } from 'acorn';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..');
const SKIPPED_DIRS = new Set(['node_modules', 'test', '.git', 'libs']);
const DATE_METHODS = new Set(['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString']);

/** Calls in the user's locale that only the user sees, each with why. */
const ALLOWED = [
  // Settings and history pages: dates the user reads in their own language.
  'prompts/modules/history.js formatSessionTime toLocaleTimeString', // chat history list, "Today at …"
  'prompts/modules/history.js formatSessionTime toLocaleDateString', // weekday in the history list
  'prompts/modules/history.js formatSessionTime toLocaleDateString', // month and day in the history list
  'prompts/modules/history.js deleteOldHistory toLocaleDateString', // status line after a cleanup
  'prompts/sync-history.js renderSyncHistoryEntry toLocaleString', // sync history entry time
  'prompts/sync-history.js formatRelativeTime toLocaleDateString', // sync history entry, older than a week
  'config/modules/welcomeWizard.js updateWelcomeStatusDisplay toLocaleString', // "Completed on …"
  // Chat window: what the user reads, never sent to the assistant.
  'chat/modules/markdown.js renderMarkdown toLocaleString', // event link tooltip start (HTML attribute only)
  'chat/modules/markdown.js renderMarkdown toLocaleString', // event link tooltip end
  'chat/modules/entityResolver.js resolveEventDetails toLocaleDateString', // @-mention list description
  'chat/fsm/emailArchive.js runStateArchiveListEmails toLocaleString', // archive selection list row
  'chat/fsm/emailDelete.js runStateDeleteListEmails toLocaleString', // delete selection list row
  // Message list thread bubble.
  'theme/modules/threadBubble.js formatDate toLocaleTimeString',
  'theme/modules/threadBubble.js formatDate toLocaleDateString',
  'theme/modules/threadBubble.js formatDate toLocaleDateString',
  // Counts, not dates: Number.prototype.toLocaleString.
  'config/modules/fts.js updateFtsStatus toLocaleString', // indexed message count
  'config/modules/fts.js updateFtsStatus toLocaleString', // embedding rebuild progress, three counts
  'config/modules/fts.js updateFtsStatus toLocaleString',
  'config/modules/fts.js updateFtsStatus toLocaleString',
  'config/modules/fts.js updateFtsStatus toLocaleString', // the same three from a progress message
  'config/modules/fts.js updateFtsStatus toLocaleString',
  'config/modules/fts.js updateFtsStatus toLocaleString',
  'marketplace/marketplace.js formatNumber toLocaleString',
  'agent/inbox-archive-prompt.js collectStats toLocaleString',
  'agent/inbox-archive-prompt.js recalculateOldMessages toLocaleString',
  'welcome/modules/inboxOptimizationHandlers.js collectStats toLocaleString',
  'welcome/modules/inboxOptimizationHandlers.js recalculateOldMessages toLocaleString',
];

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return SKIPPED_DIRS.has(entry.name) ? [] : sourceFiles(resolve(dir, entry.name));
    return /\.(js|mjs)$/.test(entry.name) ? [resolve(dir, entry.name)] : [];
  });
}

function parseSource(text) {
  try {
    return parse(text, { ecmaVersion: 'latest', sourceType: 'module' });
  } catch {
    return parse(text, { ecmaVersion: 'latest', sourceType: 'script' });
  }
}

/** Visits every node with the name of the function it is in and its parent. */
function walk(node, visit, fn = '(top level)', parent = null) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit, fn, parent);
    return;
  }
  if (typeof node.type !== 'string') return;
  const name = node.type === 'FunctionDeclaration' ? node.id?.name : node.type === 'MethodDefinition' || node.type === 'Property' ? node.key?.name : undefined;
  const inside = name && (node.type === 'FunctionDeclaration' || node.value?.type?.endsWith('FunctionExpression')) ? name : fn;
  visit(node, fn, parent);
  for (const [key, child] of Object.entries(node)) if (key !== 'type' && child && typeof child === 'object') walk(child, visit, inside, node);
}

const isEnglish = (node) => node?.type === 'Literal' && typeof node.value === 'string' && /^en(-|$)/i.test(node.value);

/** Whether a call's locale argument leaves the locale to the user's settings. */
function usesUserLocale(localeArg) {
  if (!localeArg) return true; // no argument: the default locale
  if (localeArg.type === 'Identifier' && localeArg.name === 'undefined') return true;
  if (localeArg.type === 'ArrayExpression') return localeArg.elements.length === 0 || !localeArg.elements.every(isEnglish);
  return !isEnglish(localeArg); // a locale read at run time, or a non-English one
}

const isIntlDateTimeFormat = (callee) => callee?.type === 'MemberExpression' && callee.object.type === 'Identifier' && callee.object.name === 'Intl' && callee.property.name === 'DateTimeFormat';

/** The calls in one file that format a date in the user's locale: [`<fn> <method>`]. */
export function userLocaleCallsIn(text) {
  const found = [];
  walk(parseSource(text), (node, fn, parent) => {
    if (node.type !== 'CallExpression' && node.type !== 'NewExpression') return;
    const { callee } = node;
    if (isIntlDateTimeFormat(callee)) {
      // `Intl.DateTimeFormat().resolvedOptions()` reads the time zone; it prints no date.
      if (parent?.type === 'MemberExpression' && parent.property.name === 'resolvedOptions') return;
      if (usesUserLocale(node.arguments[0])) found.push(`${fn} Intl.DateTimeFormat`);
      return;
    }
    if (node.type === 'CallExpression' && callee.type === 'MemberExpression' && !callee.computed && DATE_METHODS.has(callee.property.name)) {
      if (usesUserLocale(node.arguments[0])) found.push(`${fn} ${callee.property.name}`);
    }
  });
  return found;
}

describe('dates the assistant reads or the add-on writes are English Gregorian', () => {
  it('formats a date in the user locale only where the user alone reads it', () => {
    const found = [];
    for (const file of sourceFiles(ROOT)) {
      const path = relative(ROOT, file);
      let calls;
      try {
        calls = userLocaleCallsIn(readFileSync(file, 'utf8'));
      } catch (e) {
        throw new Error(`${path}: ${e}`, { cause: e });
      }
      for (const call of calls) found.push(`${path} ${call}`);
    }
    expect(found.sort()).toEqual([...ALLOWED].sort());
  });

  it('finds the shapes it is looking for', () => {
    const shapes = {
      noArgument: 'function f(d) { return d.toLocaleString(); }',
      undefinedLocale: 'function f(d) { return d.toLocaleDateString(undefined, { year: "numeric" }); }',
      emptyList: 'function f(d) { return d.toLocaleTimeString([], { hour: "2-digit" }); }',
      userLocale: 'function f(d) { return d.toLocaleDateString(navigator.language, { year: "numeric" }); }',
      otherLiteral: 'function f(d) { return d.toLocaleDateString("th-TH"); }',
      formatter: 'function f(d) { return new Intl.DateTimeFormat(undefined, { year: "numeric" }).format(d); }',
      formatterNoNew: 'function f(d) { return Intl.DateTimeFormat().format(d); }',
    };
    for (const [shape, text] of Object.entries(shapes)) expect(userLocaleCallsIn(text), shape).toHaveLength(1);
    const allowed = {
      english: 'function f(d) { return d.toLocaleDateString("en-US", { year: "numeric" }); }',
      englishList: 'function f(d) { return d.toLocaleDateString(["en-US"], { year: "numeric" }); }',
      englishFormatter: 'function f(d) { return new Intl.DateTimeFormat("en-CA", { year: "numeric" }).format(d); }',
      timeZone: 'function f() { return Intl.DateTimeFormat().resolvedOptions().timeZone; }',
    };
    for (const [shape, text] of Object.entries(allowed)) expect(userLocaleCallsIn(text), shape).toEqual([]);
  });
});
