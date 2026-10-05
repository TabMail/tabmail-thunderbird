/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Experiment parent scripts run in Thunderbird's chrome process, where every
// console.log reaches the Error Console in shipped builds. Diagnostic output
// goes through a per-file helper behind a flag that is off; a line that
// reports a real failure stays visible (console.warn/console.error). This
// fence parses every experiment script the manifest registers and pins both.

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function registeredScripts() {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
  return Object.values(manifest.experiment_apis).map((api) => api.parent.script).sort();
}

function experimentFilesOnDisk() {
  const found = [];
  const walkDir = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walkDir(path);
      else if (entry.name.endsWith('.sys.mjs') && relative(ROOT, path).includes('/experiments/')) found.push(relative(ROOT, path));
    }
  };
  walkDir(ROOT);
  return found.sort();
}

/** Visit every node with its ancestors (outermost first). */
function walk(node, visit, ancestors = []) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, ancestors);
  const next = [...ancestors, node];
  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc') continue;
    if (Array.isArray(value)) value.forEach((child) => walk(child, visit, next));
    else if (value && typeof value === 'object') walk(value, visit, next);
  }
}

const isFunction = (n) => ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(n.type);
const isConsoleLog = (n) => n.type === 'CallExpression' && n.callee.type === 'MemberExpression'
  && n.callee.object.name === 'console' && n.callee.property.name === 'log';
const onlyStatement = (s) => (s?.type === 'BlockStatement' ? (s.body.length === 1 ? s.body[0] : null) : s);
const calledName = (s) => (s?.type === 'ExpressionStatement' && s.expression.type === 'CallExpression'
  && s.expression.callee.type === 'Identifier' ? s.expression.callee.name : null);

/** `function name(...) { if (FLAG) console.log(...); }` → FLAG, else null. */
function gatedHelperFlag(fn) {
  const stmt = onlyStatement(fn.body);
  if (stmt?.type !== 'IfStatement' || stmt.test.type !== 'Identifier' || stmt.alternate) return null;
  const inner = onlyStatement(stmt.consequent);
  return inner?.type === 'ExpressionStatement' && isConsoleLog(inner.expression) ? stmt.test.name : null;
}

/** A function whose body only forwards to `gated` (optionally inside a lone try). */
function forwardsTo(fn, gated) {
  let stmt = onlyStatement(fn.body);
  if (stmt?.type === 'TryStatement') stmt = onlyStatement(stmt.block);
  return gated.has(calledName(stmt));
}

/** Is `node` (with these ancestors) inside code that handles a failure? */
function inFailureHandler(ancestors) {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const a = ancestors[i];
    if (a.type === 'CatchClause') return true;
    if (!isFunction(a)) continue;
    const call = ancestors[i - 1];
    if (call?.type !== 'CallExpression' || call.callee.type !== 'MemberExpression') continue;
    const method = call.callee.property.name;
    if (method === 'catch' && call.arguments[0] === a) return true;
    if (method === 'then' && call.arguments[1] === a) return true;
  }
  return false;
}

/** Problems with one experiment script's logging, as readable strings. */
function auditLogging(src, { allowInFailure = [] } = {}) {
  const ast = parse(src, { ecmaVersion: 'latest', sourceType: 'script', locations: true });
  const lines = src.split('\n');
  const problems = [];

  const helpers = new Map();
  const functions = [];
  walk(ast, (n) => {
    if (n.type !== 'FunctionDeclaration') return;
    functions.push(n);
    const flag = gatedHelperFlag(n);
    if (flag) helpers.set(n, flag);
  });
  const gated = new Set([...helpers.keys()].map((fn) => fn.id.name));
  for (let grew = true; grew;) {
    grew = false;
    for (const fn of functions) {
      if (!gated.has(fn.id.name) && forwardsTo(fn, gated)) { gated.add(fn.id.name); grew = true; }
    }
  }

  const flags = new Set(helpers.values());
  const flagInit = new Map();
  walk(ast, (n, ancestors) => {
    if (isConsoleLog(n) && !ancestors.some((a) => helpers.has(a))) problems.push(`line ${n.loc.start.line}: console.log outside a flag-gated helper`);
    if (n.type === 'VariableDeclarator' && flags.has(n.id.name)) flagInit.set(n.id.name, n.init);
    if (n.type === 'AssignmentExpression' && n.left.type === 'Identifier' && flags.has(n.left.name)) problems.push(`line ${n.loc.start.line}: flag ${n.left.name} is reassigned`);
    if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && gated.has(n.callee.name) && inFailureHandler(ancestors)) {
      const text = lines[n.loc.start.line - 1].trim();
      if (!allowInFailure.some((s) => text.includes(s))) problems.push(`line ${n.loc.start.line}: failure handler logs only when debugging: ${text}`);
    }
  });
  for (const flag of flags) {
    const init = flagInit.get(flag);
    if (!(init?.type === 'Literal' && init.value === false)) problems.push(`flag ${flag} is not initialised to false`);
  }
  return problems;
}

// Failure-handler lines that deliberately log only when debugging; none is the
// only report of a failure.
const ALLOWED_IN_FAILURE = {
  'theme/experiments/threadMessages/threadMessages.sys.mjs': ['Failed to log currentHdr props'],
  // Recovery traces. tagSort logs the failure visibly beside it; tmCalendar
  // returns { ok: false, error } and the calendar edit flow logs it.
  'chat/experiments/tmCalendar/tmCalendar.sys.mjs': ['reverted master cap after new-series creation failure'],
  'theme/experiments/tagSort/tagSort.sys.mjs': ['restoring visibility in catch block due to error'],
};

// Failures reported outside a failure handler that must stay visible.
const VISIBLE_FAILURES = [
  ['agent/experiments/tmGmailLabels/tmGmailLabels.sys.mjs', 'getAccessToken failed'],
  ['agent/experiments/tmGmailLabels/tmGmailLabels.sys.mjs', 'gmailFetch ${method} ${path}: HTTP'],
  ['theme/experiments/staleRowFilter/staleRowFilter.sys.mjs', 'Services.wm not available!'],
  ['theme/experiments/tmMessageListCardView/tmMessageListCardView.sys.mjs', 'ThreadCard.fillRow not found'],
  ['theme/experiments/tmMessageListTableView/tmMessageListTableView.sys.mjs', 'ThreadRow.fillRow not found'],
];

describe('experiment logging', () => {
  const scripts = registeredScripts();

  it('covers every experiment script, and the manifest registers each one', () => {
    expect(scripts).toEqual(experimentFilesOnDisk());
  });

  for (const rel of scripts) {
    it(`${rel} logs diagnostics only behind an off flag, and failures visibly`, () => {
      expect(auditLogging(readFileSync(join(ROOT, rel), 'utf8'), { allowInFailure: ALLOWED_IN_FAILURE[rel] || [] })).toEqual([]);
    });
  }

  for (const [rel, marker] of VISIBLE_FAILURES) {
    it(`${rel} reports "${marker}" visibly`, () => {
      const lines = readFileSync(join(ROOT, rel), 'utf8').split('\n').filter((l) => l.includes(marker));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/console\.(warn|error)\(|\w+Warn\(/);
    });
  }
});

describe('experiment logging audit', () => {
  const header = 'var X_DEBUG = false;\nfunction xDebugLog(...args) { if (X_DEBUG) console.log(...args); }\nfunction tlog(...args) {\n  try {\n    xDebugLog("[X]", ...args);\n  } catch (_) {}\n}\n';
  const after = (body) => `${header}${body}\n`;

  it('accepts gated diagnostics and visible failures', () => {
    const src = after('xDebugLog("ok");\ntry { run(); } catch (e) { console.warn("[X] run failed", e); }\nconst s = "console.log(";\nconst r = /[{"\']/g;\nwork().catch((e) => console.error("[X] work failed", e));');
    expect(auditLogging(src)).toEqual([]);
  });

  it('rejects a raw console.log, including one a regex literal could hide from a lexer', () => {
    expect(auditLogging(after('function f(s) { return /\'/.test(s) && console.log("x"); }'))).toEqual(['line 8: console.log outside a flag-gated helper']);
  });

  it('rejects a flag that starts on or is switched on later', () => {
    expect(auditLogging(header.replace('X_DEBUG = false', 'X_DEBUG = true'))).toEqual(['flag X_DEBUG is not initialised to false']);
    expect(auditLogging(after('X_DEBUG = true;'))).toEqual(['line 8: flag X_DEBUG is reassigned']);
  });

  it('rejects a failure logged through the gated helper or a forwarding wrapper', () => {
    expect(auditLogging(after('try { run(); } catch (e) {\n  xDebugLog("run failed", e);\n}'))).toEqual(['line 9: failure handler logs only when debugging: xDebugLog("run failed", e);']);
    expect(auditLogging(after('try { run(); } catch {\n  if (ok) { tlog("failed"); }\n}'))).toHaveLength(1);
    expect(auditLogging(after('try { run(); } catch (e) {\n  tlog("expected");\n}'), { allowInFailure: ['expected'] })).toEqual([]);
  });

  it('treats promise rejection handlers as failure handlers', () => {
    expect(auditLogging(after('work().catch((e) => tlog("work failed", e));'))).toHaveLength(1);
    expect(auditLogging(after('work().then(() => tlog("done"), function (e) { xDebugLog("work failed", e); });'))).toEqual(['line 8: failure handler logs only when debugging: work().then(() => tlog("done"), function (e) { xDebugLog("work failed", e); });']);
  });
});
