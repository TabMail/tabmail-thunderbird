/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Experiment parent scripts run in Thunderbird's chrome process, where every
// console.log reaches the user's Error Console in shipped builds. Diagnostic
// output goes through a per-file helper behind a flag that is off; a line that
// reports a real failure stays visible as console.warn/console.error. This
// fence reads every experiment script and pins both halves.

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function experimentScripts() {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.sys.mjs') && path.includes('/experiments/')) found.push(path);
    }
  };
  for (const top of ['agent', 'chat', 'gui', 'theme']) walk(join(ROOT, top));
  return found.sort();
}

// The source with comments, string/template text and regex literals blanked
// (newlines kept, so offsets and line numbers still match the original).
function codeOnly(src) {
  const out = src.split('');
  const blank = (from, to) => { for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' '; };
  const templateDepths = [];
  let depth = 0;
  let lastCode = '';
  let i = 0;
  const scanTemplate = (start) => {
    let k = start;
    while (k < src.length) {
      if (src[k] === '\\') { k += 2; continue; }
      if (src[k] === '`') { blank(start, k); return k + 1; }
      if (src[k] === '$' && src[k + 1] === '{') { blank(start, k); templateDepths.push(depth); depth++; return k + 2; }
      k++;
    }
    blank(start, k);
    return k;
  };
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') { const end = src.indexOf('\n', i); const stop = end < 0 ? src.length : end; blank(i, stop); i = stop; continue; }
    if (c === '/' && d === '*') { const end = src.indexOf('*/', i + 2); const stop = end < 0 ? src.length : end + 2; blank(i, stop); i = stop; continue; }
    if (c === '"' || c === "'") {
      let k = i + 1;
      while (k < src.length && src[k] !== c && src[k] !== '\n') k += src[k] === '\\' ? 2 : 1;
      blank(i + 1, k); i = k + 1; lastCode = c; continue;
    }
    if (c === '`') { i = scanTemplate(i + 1); lastCode = '`'; continue; }
    if (c === '/' && (lastCode === '' || '(,=:[!&|?{};'.includes(lastCode))) {
      let k = i + 1;
      let inClass = false;
      while (k < src.length && src[k] !== '\n') {
        if (src[k] === '\\') { k += 2; continue; }
        if (src[k] === '[') inClass = true;
        else if (src[k] === ']') inClass = false;
        else if (src[k] === '/' && !inClass) break;
        k++;
      }
      blank(i + 1, k); i = k + 1; lastCode = '/'; continue;
    }
    if (c === '{') depth++;
    if (c === '}') {
      depth--;
      if (templateDepths.length && templateDepths[templateDepths.length - 1] === depth) {
        templateDepths.pop();
        i = scanTemplate(i + 1);
        lastCode = '`';
        continue;
      }
    }
    if (!/\s/.test(c)) lastCode = c;
    i++;
  }
  return out.join('');
}

const lineOf = (src, offset) => src.slice(0, offset).split('\n').length;

/** Problems with one experiment script's logging, as readable strings. */
function auditLogging(src, { allowInCatch = [] } = {}) {
  const code = codeOnly(src);
  const problems = [];
  const helpers = [...code.matchAll(/function\s+(\w+)\s*\(\.\.\.args\)\s*\{\s*if\s*\((\w+)\)\s*\{?\s*console\.log\(/g)]
    .map((m) => ({ name: m[1], flag: m[2] }));
  const logCalls = (code.match(/\bconsole\.log\(/g) || []).length;
  if (logCalls !== helpers.length) problems.push(`${logCalls - helpers.length} console.log call(s) outside a flag-gated helper`);
  for (const { flag } of helpers) {
    if (!new RegExp(`\\b(?:var|let|const)\\s+${flag}\\s*=\\s*false\\s*;`).test(code)) problems.push(`flag ${flag} is not initialised to false`);
  }
  // Functions that only forward to a gated helper (e.g. a prefixing tlog).
  const gated = new Set(helpers.map((h) => h.name));
  for (const m of code.matchAll(/function\s+(\w+)\s*\(\.\.\.args\)\s*\{([^}]*)/g)) {
    if ([...gated].some((name) => new RegExp(`\\b${name}\\(`).test(m[2]))) gated.add(m[1]);
  }
  if (gated.size) {
    const call = new RegExp(`\\b(?:${[...gated].join('|')})\\(`, 'g');
    for (const m of code.matchAll(/\bcatch\s*(?:\([^)]*\))?\s*\{/g)) {
      let depth = 1;
      let k = m.index + m[0].length;
      while (k < code.length && depth > 0) {
        if (code[k] === '{') depth++;
        else if (code[k] === '}') depth--;
        k++;
      }
      const start = m.index + m[0].length;
      for (const c of code.slice(start, k).matchAll(call)) {
        const line = lineOf(src, start + c.index);
        const text = src.split('\n')[line - 1].trim();
        if (!allowInCatch.some((s) => text.includes(s))) problems.push(`line ${line}: failure in a catch block is logged only when debugging: ${text}`);
      }
    }
  }
  return problems;
}

// Catch-block lines that deliberately log only when debugging: none reports a
// failure of its own.
const ALLOWED_IN_CATCH = {
  'theme/experiments/threadMessages/threadMessages.sys.mjs': ['Failed to log currentHdr props'],
  // Recovery traces; the failure itself is logged visibly beside them.
  'chat/experiments/tmCalendar/tmCalendar.sys.mjs': ['reverted master cap after new-series creation failure'],
  'theme/experiments/tagSort/tagSort.sys.mjs': ['restoring visibility in catch block due to error'],
};

// Failures reported outside a catch block that must stay visible.
const VISIBLE_FAILURES = [
  ['agent/experiments/tmGmailLabels/tmGmailLabels.sys.mjs', 'getAccessToken failed'],
  ['agent/experiments/tmGmailLabels/tmGmailLabels.sys.mjs', 'gmailFetch ${method} ${path}: HTTP'],
  ['theme/experiments/staleRowFilter/staleRowFilter.sys.mjs', 'Services.wm not available!'],
  ['theme/experiments/tmMessageListCardView/tmMessageListCardView.sys.mjs', 'ThreadCard.fillRow not found'],
  ['theme/experiments/tmMessageListTableView/tmMessageListTableView.sys.mjs', 'ThreadRow.fillRow not found'],
];

describe('experiment logging', () => {
  const scripts = experimentScripts();

  it('finds the experiment scripts', () => {
    expect(scripts.length).toBeGreaterThan(20);
  });

  for (const path of scripts) {
    const rel = relative(ROOT, path);
    it(`${rel} logs diagnostics only behind an off flag, and failures visibly`, () => {
      expect(auditLogging(readFileSync(path, 'utf8'), { allowInCatch: ALLOWED_IN_CATCH[rel] || [] })).toEqual([]);
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
  const header = 'var X_DEBUG = false;\nfunction xDebugLog(...args) { if (X_DEBUG) console.log(...args); }\nfunction tlog(...args) {\n  xDebugLog("[X]", ...args);\n}\n';

  it('accepts gated diagnostics and visible failures', () => {
    const src = `${header}xDebugLog("ok");\ntry { run(); } catch (e) { console.warn("[X] run failed", e); }\nconst s = "console.log(";\n// console.log("commented")\nconst t = \`\${a ? "}" : \`{\`} console.log(\`;\nconst r = /[{"']/g;\n`;
    expect(auditLogging(src)).toEqual([]);
  });

  it('rejects a raw console.log', () => {
    expect(auditLogging(`${header}console.log("raw");\n`)).toEqual(['1 console.log call(s) outside a flag-gated helper']);
  });

  it('rejects a flag that is on', () => {
    expect(auditLogging(header.replace('X_DEBUG = false', 'X_DEBUG = true'))).toEqual(['flag X_DEBUG is not initialised to false']);
  });

  it('rejects a failure logged through the gated helper or a forwarding wrapper in a catch block', () => {
    const direct = auditLogging(`${header}try { run(); } catch (e) {\n  xDebugLog("run failed", e);\n}\n`);
    expect(direct).toEqual(['line 7: failure in a catch block is logged only when debugging: xDebugLog("run failed", e);']);
    const wrapped = auditLogging(`${header}try { run(); } catch {\n  if (ok) { tlog(\`failed \${e}\`); }\n}\n`);
    expect(wrapped).toHaveLength(1);
    expect(auditLogging(`${header}try { run(); } catch (e) {\n  tlog("expected");\n}\n`, { allowInCatch: ['expected'] })).toEqual([]);
  });
});
