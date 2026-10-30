/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// promptStoreFence.test.js — only the prompt store writes the knowledge base and the rules
// (`bullet_state:<field>` and `user_prompts:user_<field>.md`): a write anywhere else would bypass its
// lock and labels, and a peer's bullet would be lost or never sent. Every storage.local set/remove in
// the add-on's source is read for those keys, named directly, through a constant, or through a table
// of them.

import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { parse } from 'acorn';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..');
const SKIPPED_DIRS = new Set(['node_modules', 'test', '.git']);
const OWNER = 'agent/modules/promptStore.js';

/** Writes outside the prompt store, each with why it is safe. */
const ALLOWED = [
  // A prompt_state field's write (a local edit, a received value, a reset, a history restore) by a holder
  // of the prompt store; it refuses the three bullet fields before writing.
  'agent/modules/deviceSync.js writeField',
];

function isSyncKey(value) {
  return typeof value === 'string' && (value.startsWith('bullet_state:') || /^user_prompts:user_(kb|composition|action)\.md$/.test(value));
}

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

/** Visits every node with the name of the function it is in. */
function walk(node, visit, fn = '(top level)') {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit, fn);
    return;
  }
  if (typeof node.type !== 'string') return;
  const name = node.type === 'FunctionDeclaration' ? node.id?.name : node.type === 'MethodDefinition' || node.type === 'Property' ? node.key?.name : undefined;
  const inside = name && (node.type === 'FunctionDeclaration' || node.value?.type?.endsWith('FunctionExpression')) ? name : fn;
  visit(node, fn);
  for (const [key, child] of Object.entries(node)) if (key !== 'type' && child && typeof child === 'object') walk(child, visit, inside);
}

/** The sync-key writes in one file: [{ fn, what }]. */
function writesIn(text) {
  const ast = parseSource(text);
  const constants = new Map();
  const tables = new Map();
  const declared = new Map();
  walk(ast, (node) => {
    if (node.type !== 'VariableDeclarator' || node.id.type !== 'Identifier' || !node.init) return;
    declared.set(node.id.name, node.init);
    if (node.init.type === 'Literal' && isSyncKey(node.init.value)) constants.set(node.id.name, node.init.value);
    if (node.init.type === 'ObjectExpression' && node.init.properties.some((p) => p.value?.type === 'Literal' && isSyncKey(p.value.value))) tables.set(node.id.name, node.init);
  });

  /** A key looked up in a table of them: a named entry is resolved, an index computed at run time
   * counts as a sync key. */
  const isTableLookup = (node) => {
    if (node?.type !== 'MemberExpression' || node.object.type !== 'Identifier' || !tables.has(node.object.name)) return false;
    const entry = node.computed ? (node.property.type === 'Literal' ? node.property.value : undefined) : node.property.name;
    if (entry === undefined) return true;
    const property = tables.get(node.object.name).properties.find((p) => (p.key.name ?? p.key.value) === entry);
    return property?.value.type === 'Literal' && isSyncKey(property.value.value);
  };
  /** Whether `node`, a key or a list/object of keys, names a sync key. */
  const names = (node, depth = 0) => {
    if (!node || depth > 4) return false;
    switch (node.type) {
      case 'Literal': return isSyncKey(node.value);
      case 'TemplateLiteral': return node.quasis.some((quasi) => quasi.value.raw.startsWith('bullet_state:'));
      case 'Identifier': return constants.has(node.name) || (declared.has(node.name) && names(declared.get(node.name), depth + 1));
      case 'MemberExpression': return isTableLookup(node);
      case 'ArrayExpression': return node.elements.some((element) => names(element, depth + 1));
      case 'SpreadElement': return names(node.argument, depth + 1);
      case 'CallExpression': return node.arguments.some((arg) => arg.type === 'Identifier' && tables.has(arg.name));
      case 'ObjectExpression': return node.properties.some((p) => (p.type === 'SpreadElement' ? names(p.argument, depth + 1) : p.computed ? names(p.key, depth + 1) : p.key.type === 'Literal' && isSyncKey(p.key.value)));
      default: return false;
    }
  };

  const writes = [];
  walk(ast, (node, fn) => {
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && ['set', 'remove'].includes(node.callee.property.name) && node.callee.object.property?.name === 'local') {
      if (node.arguments.some((arg) => names(arg))) writes.push({ fn, what: `storage.local.${node.callee.property.name}` });
    }
    // A key filled into an object written later: `values[KEYS[field]] = …`.
    if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression' && node.left.computed && names(node.left.property)) {
      writes.push({ fn, what: 'assignment' });
    }
  });
  return writes;
}

describe('the prompt store owns the bullet fields', () => {
  it('is the only writer of bullet_state and the three texts', () => {
    const found = [];
    for (const file of sourceFiles(ROOT)) {
      const path = relative(ROOT, file);
      if (path === OWNER) continue;
      let writes;
      try {
        writes = writesIn(readFileSync(file, 'utf8'));
      } catch (e) {
        throw new Error(`${path}: ${e}`, { cause: e });
      }
      for (const { fn } of writes) found.push(`${path} ${fn}`);
    }
    expect([...new Set(found)].sort()).toEqual([...ALLOWED].sort());
  });

  it('finds the writes it is looking for', () => {
    const own = writesIn(readFileSync(resolve(ROOT, OWNER), 'utf8')).map(({ fn, what }) => `${fn} ${what}`);
    expect(own).toEqual(expect.arrayContaining(['writeStates assignment']));
    // The shapes a stray writer takes.
    const shapes = {
      constant: 'const key = "user_prompts:user_kb.md"; async function save(text) { await browser.storage.local.set({ [key]: text }); }',
      literal: 'async function save(text) { await browser.storage.local.set({ "user_prompts:user_action.md": text }); }',
      table: 'const KEYS = { kb: "bullet_state:kb" }; async function save(field, value) { await browser.storage.local.set({ [KEYS[field]]: value }); }',
      list: 'async function clear() { await browser.storage.local.remove(["bullet_state:composition"]); }',
      template: 'async function save(field, value) { await browser.storage.local.set({ [`bullet_state:${field}`]: value }); }',
    };
    for (const [shape, text] of Object.entries(shapes)) expect(writesIn(text), shape).not.toEqual([]);
    expect(writesIn('async function save(text) { await browser.storage.local.set({ user_templates: text }); }')).toEqual([]);
    expect(writesIn('const KEYS = { kb: "bullet_state:kb", templates: "user_templates" }; async function save(value) { await browser.storage.local.set({ [KEYS.templates]: value }); }')).toEqual([]);
    expect(writesIn('const KEYS = { kb: "bullet_state:kb", templates: "user_templates" }; async function save(value) { await browser.storage.local.set({ [KEYS.kb]: value }); }')).not.toEqual([]);
  });
});

describe('every page reaches the prompt store through the background', () => {
  /** The `prompt-store` branches of background.js: [{ answered, async }], where `answered` is whether the
   * branch returns `handlePromptStoreMessage(message)` (the reply the page awaits), and `async` whether
   * the function it is in is async (an async runtime.onMessage listener breaks the other listeners). */
  function routes(text) {
    const found = [];
    const visit = (node, enclosing) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const child of node) visit(child, enclosing);
        return;
      }
      if (typeof node.type !== 'string') return;
      const fn = node.type.endsWith('FunctionExpression') || node.type === 'FunctionDeclaration' ? node : enclosing;
      if (node.type === 'IfStatement' && node.test.type === 'BinaryExpression' && node.test.right?.value === 'prompt-store'
        && node.test.left.type === 'MemberExpression' && node.test.left.property.name === 'command') {
        const body = node.consequent.type === 'BlockStatement' ? node.consequent.body : [node.consequent];
        const answered = body.some((statement) => statement.type === 'ReturnStatement' && statement.argument?.type === 'CallExpression'
          && statement.argument.callee.name === 'handlePromptStoreMessage' && statement.argument.arguments[0]?.name === node.test.left.object.name);
        found.push({ answered, async: Boolean(fn?.async) });
      }
      for (const [key, child] of Object.entries(node)) if (key !== 'type' && child && typeof child === 'object') visit(child, fn);
    };
    visit(parseSource(text), null);
    return found;
  }

  it('background.js answers a prompt-store message with the store\'s reply, from a listener that is not async', () => {
    expect(routes(readFileSync(resolve(ROOT, 'agent/background.js'), 'utf8'))).toEqual([{ answered: true, async: false }]);
    // The shapes it must tell apart.
    const route = (body, async = '') => `browser.runtime.onMessage.addListener(${async}(message) => { if (message.command === "prompt-store") { ${body} } });`;
    expect(routes(route('return handlePromptStoreMessage(message);'))).toEqual([{ answered: true, async: false }]);
    expect(routes(route('handlePromptStoreMessage(message);'))).toEqual([{ answered: false, async: false }]);
    expect(routes(route('return handlePromptStoreMessage(message);', 'async '))).toEqual([{ answered: true, async: true }]);
  });
});
