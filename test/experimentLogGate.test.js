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
const consoleMethod = (callee) => (callee?.type === 'MemberExpression' && !callee.computed
  && callee.object.type === 'Identifier' && callee.object.name === 'console' ? callee.property.name : null);
const isConsoleLog = (n) => n.type === 'CallExpression' && consoleMethod(n.callee) === 'log';
const onlyStatement = (s) => (s?.type === 'BlockStatement' ? (s.body.length === 1 ? s.body[0] : null) : s);
const isDebugFlagName = (name, flags) => flags.has(name) || /(^|_)DEBUG(_|$)/.test(name);

/** `function name(...) { if (FLAG) console.log(...); }` → FLAG, else null. */
function gatedHelperFlag(fn) {
  const stmt = onlyStatement(fn.body);
  if (stmt?.type !== 'IfStatement' || stmt.test.type !== 'Identifier' || stmt.alternate) return null;
  const inner = onlyStatement(stmt.consequent);
  return inner?.type === 'ExpressionStatement' && isConsoleLog(inner.expression) ? stmt.test.name : null;
}

function mentionsFlag(expr, flags) {
  let hit = false;
  walk(expr, (n) => { if (n.type === 'Identifier' && isDebugFlagName(n.name, flags)) hit = true; });
  return hit;
}

/** Does `node` run only when a debug flag is on, judged up to (not including) `root`? */
function flagConditioned(node, ancestors, root, flags) {
  let child = node;
  for (let i = ancestors.length - 1; i >= 0 && ancestors[i] !== root; i--) {
    const a = ancestors[i];
    if ((a.type === 'IfStatement' || a.type === 'ConditionalExpression') && child !== a.test && mentionsFlag(a.test, flags)) return true;
    if (a.type === 'LogicalExpression' && child === a.right && mentionsFlag(a.left, flags)) return true;
    child = a;
  }
  return false;
}

/**
 * The calls of a function that only logs (statements nested in blocks, ifs
 * and trys are all console.* or identifier calls), else null.
 */
function loggingCalls(fn) {
  const calls = [];
  const visit = (stmt) => {
    if (!stmt || stmt.type === 'EmptyStatement') return true;
    if (stmt.type === 'BlockStatement') return stmt.body.every(visit);
    if (stmt.type === 'IfStatement') return visit(stmt.consequent) && visit(stmt.alternate);
    if (stmt.type === 'TryStatement') return visit(stmt.block) && (!stmt.handler || visit(stmt.handler.body));
    if (stmt.type !== 'ExpressionStatement' || stmt.expression.type !== 'CallExpression') return false;
    const { callee } = stmt.expression;
    if (!consoleMethod(callee) && callee.type !== 'Identifier') return false;
    calls.push(stmt.expression);
    return true;
  };
  return visit(fn.body) && calls.length ? calls : null;
}

/** Where a failure handler starts, if `ancestors` put the node inside one. */
function failureHandlerRoot(ancestors) {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const a = ancestors[i];
    if (a.type === 'CatchClause') return a;
    const call = ancestors[i - 1];
    if (!isFunction(a) || call?.type !== 'CallExpression' || call.callee.type !== 'MemberExpression') continue;
    if (call.callee.property.name === 'catch' && call.arguments[0] === a) return a;
    if (call.callee.property.name === 'then' && call.arguments[1] === a) return a;
  }
  return null;
}

/**
 * The script's logging, as { problems, visibleOnLine }. A logger is visible
 * only if every path reaches console.warn or console.error without a debug
 * flag condition; anything else is gated.
 */
function analyseLogging(src, { allowInFailure = [] } = {}) {
  const ast = parse(src, { ecmaVersion: 'latest', sourceType: 'script', locations: true });
  const lines = src.split('\n');
  const problems = [];

  const diagnosticHelpers = new Map();
  const declarations = [];
  walk(ast, (n, ancestors) => {
    if (n.type !== 'FunctionDeclaration') return;
    declarations.push({ fn: n, ancestors });
    const flag = gatedHelperFlag(n);
    if (flag) diagnosticHelpers.set(n, flag);
  });
  const flags = new Set(diagnosticHelpers.values());

  // Logging helpers: functions that only log, through console.* or each other.
  const helpers = new Map();
  for (const { fn } of declarations) {
    const calls = loggingCalls(fn);
    if (calls) helpers.set(fn.id.name, { fn, calls });
  }
  for (let shrunk = true; shrunk;) {
    shrunk = false;
    for (const [name, { calls }] of helpers) {
      if (calls.some((c) => c.callee.type === 'Identifier' && !helpers.has(c.callee.name))) { helpers.delete(name); shrunk = true; }
    }
  }
  const callAncestors = new Map();
  walk(ast, (n, ancestors) => { if (n.type === 'CallExpression') callAncestors.set(n, ancestors); });
  const visible = new Set();
  const reachesVisibly = (call, root) => !flagConditioned(call, callAncestors.get(call), root, flags)
    && (['warn', 'error'].includes(consoleMethod(call.callee)) || visible.has(call.callee.name));
  for (let grew = true; grew;) {
    grew = false;
    for (const [name, { fn, calls }] of helpers) {
      if (!visible.has(name) && calls.every((c) => reachesVisibly(c, fn))) { visible.add(name); grew = true; }
    }
  }
  const isLoggingCall = (n) => consoleMethod(n.callee) || (n.callee.type === 'Identifier' && helpers.has(n.callee.name));
  const nearestFunction = (ancestors) => [...ancestors].reverse().find(isFunction) || null;

  const flagInit = new Map();
  walk(ast, (n, ancestors) => {
    if (isConsoleLog(n) && !ancestors.some((a) => diagnosticHelpers.has(a))) problems.push(`line ${n.loc.start.line}: console.log outside a flag-gated helper`);
    if (n.type === 'VariableDeclarator' && flags.has(n.id.name)) flagInit.set(n.id.name, n.init);
    if (n.type === 'AssignmentExpression' && n.left.type === 'Identifier' && flags.has(n.left.name)) problems.push(`line ${n.loc.start.line}: flag ${n.left.name} is reassigned`);
    if (n.type !== 'CallExpression') return;
    const text = lines[n.loc.start.line - 1].trim();
    const report = () => { if (!allowInFailure.some((s) => text.includes(s))) problems.push(`line ${n.loc.start.line}: failure handler logs only when debugging: ${text}`); };
    const root = failureHandlerRoot(ancestors);
    if (root && isLoggingCall(n) && !reachesVisibly(n, root)) report();
    // A logger passed by reference as a rejection handler.
    const method = n.callee.type === 'MemberExpression' ? n.callee.property.name : null;
    const handler = method === 'catch' ? n.arguments[0] : method === 'then' ? n.arguments[1] : null;
    if (handler && ((handler.type === 'Identifier' && helpers.has(handler.name) && !visible.has(handler.name))
      || (consoleMethod(handler) && !['warn', 'error'].includes(consoleMethod(handler))))) report();
  });
  for (const flag of flags) {
    const init = flagInit.get(flag);
    if (!(init?.type === 'Literal' && init.value === false)) problems.push(`flag ${flag} is not initialised to false`);
  }

  const visibleOnLine = (line) => [...callAncestors].some(([call, ancestors]) => call.loc.start.line === line
    && isLoggingCall(call) && reachesVisibly(call, nearestFunction(ancestors)));
  return { problems, visibleOnLine };
}

const auditLogging = (src, options) => analyseLogging(src, options).problems;

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
  ['chat/experiments/tmCalendar/tmCalendar.sys.mjs', 'duration preservation failed:'],
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
      const src = readFileSync(join(ROOT, rel), 'utf8');
      const lines = src.split('\n').map((l, i) => (l.includes(marker) ? i + 1 : 0)).filter(Boolean);
      expect(lines).toHaveLength(1);
      expect(analyseLogging(src).visibleOnLine(lines[0])).toBe(true);
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

  it('judges a logger by what it reaches, not by its name', () => {
    const warnHelper = 'function xWarn(...args) { console.warn("[X]", ...args); }\n';
    expect(auditLogging(after(`${warnHelper}try { run(); } catch (e) { xWarn("run failed", e); }`))).toEqual([]);
    const gatedWarn = after('function xWarn(...args) { if (X_DEBUG) console.warn("[X]", ...args); }\ntry { run(); } catch (e) { xWarn("run failed", e); }');
    expect(auditLogging(gatedWarn)).toHaveLength(1);
    expect(analyseLogging(gatedWarn).visibleOnLine(8)).toBe(false);
    expect(auditLogging(after('try { run(); } catch (e) {\n  if (X_DEBUG) console.warn("run failed", e);\n}'))).toHaveLength(1);
    expect(auditLogging(after('try { run(); } catch (e) {\n  if (e.name !== "AbortError") console.warn("run failed", e);\n}'))).toEqual([]);
  });

  it('treats promise rejection handlers as failure handlers', () => {
    expect(auditLogging(after('work().catch(tlog);'))).toHaveLength(1);
    expect(auditLogging(after('work().catch(console.log);'))).toHaveLength(1);
    expect(auditLogging(after('work().then(null, console.error);'))).toEqual([]);
    expect(auditLogging(after('work().catch((e) => tlog("work failed", e));'))).toHaveLength(1);
    expect(auditLogging(after('work().then(() => tlog("done"), function (e) { xDebugLog("work failed", e); });'))).toEqual(['line 8: failure handler logs only when debugging: work().then(() => tlog("done"), function (e) { xDebugLog("work failed", e); });']);
  });
});
