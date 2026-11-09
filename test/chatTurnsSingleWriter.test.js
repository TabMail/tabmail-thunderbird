/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The stored chat turns (chat_turns) have one writer: the background's queue
// (storedTurnsQueue.js), which applies every change in arrival order. A page
// that wrote the key itself could write back an older copy of the turns,
// undoing a Clear All or Delete Old, or dropping turns another page added;
// one that wrote the queue itself could drop a queued change. This census
// reads every source file of the add-on and fails on any other write of
// either key. The queue starts draining when it is loaded, so only the
// background may load it: a page that did would be a second drainer.
//
// A write is found however its key reaches it: written out, through a
// constant, or in an object or array built up first (in steps, by spread or
// Object.assign), and whatever names browser.storage.local or its methods.
// A load is found through imports, re-exports and a page's script tags, at
// any depth.

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { parse } from 'acorn';

const QUEUE = 'chat/modules/storedTurnsQueue.js';
// Each key and the one function in the writer that writes it.
const WRITERS = { chat_turns: '_apply' };
const WRITE_METHODS = ['set', 'remove', 'clear'];

function sources(patterns = ['*.js', '*.mjs']) {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', ...patterns], { encoding: 'utf8' })
    .split('\n')
    .filter(file => file && !file.startsWith('test/') && file !== 'vitest.config.js');
}

function parseAny(source) {
  try {
    return parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  } catch {
    return parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
  }
}

function walk(node, visit, parents = []) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') visit(node, parents);
  const next = typeof node.type === 'string' ? [...parents, node] : parents;
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(v => walk(v, visit, next));
    else if (value && typeof value === 'object') walk(value, visit, next);
  }
}

const propertyName = node => (node.type === 'Identifier' ? node.name : node.value);
// The name a member expression reads: a.name, a["name"] or a[`name`]; null
// when it is computed from something else.
const memberName = node => {
  if (!node.computed) return node.property.name;
  const p = node.property;
  if (p.type === 'Literal') return String(p.value);
  if (p.type === 'TemplateLiteral' && p.expressions.length === 0) return p.quasis[0].value.cooked;
  return null;
};

// Every browser.storage.local write (set, remove, clear) in `source` whose
// keys may include `KEY`; a clear names every key.
function writesOf(KEY, file, source) {
  if (!source.includes('storage')) return [];
  const ast = parseAny(source);

  const keyNames = new Set(); // identifiers holding the key itself
  const holders = new Set(); // identifiers holding an object or array that names it
  const storages = new Set(); // identifiers holding browser.storage
  const locals = new Set(); // identifiers holding browser.storage.local
  const methods = new Map(); // identifiers holding one of its write methods
  // Identifiers holding a table of keys (KEYS = { turns: KEY }): the names of
  // its entries holding the key (null: an entry set under a computed name).
  const tables = new Map();

  // Read by structure, so dots, brackets and optional chaining all count.
  const isStorage = node => (node?.type === 'Identifier' && storages.has(node.name))
    || (node?.type === 'MemberExpression' && memberName(node) === 'storage');
  const isLocal = node => (node?.type === 'Identifier' && locals.has(node.name))
    || (node?.type === 'MemberExpression' && memberName(node) === 'local' && isStorage(node.object));

  const isKey = node => {
    switch (node?.type) {
      case 'Literal': return node.value === KEY;
      case 'Identifier': return keyNames.has(node.name);
      case 'TemplateLiteral': return node.expressions.length === 0 && node.quasis[0].value.cooked === KEY;
      case 'ConditionalExpression': return isKey(node.consequent) || isKey(node.alternate);
      case 'LogicalExpression': return isKey(node.left) || isKey(node.right);
      case 'MemberExpression': {
        // KEYS.turns, KEYS["turns"]; KEYS[name] may be any of its entries.
        const entries = node.object.type === 'Identifier' ? tables.get(node.object.name) : null;
        if (!entries) return false;
        const name = memberName(node);
        return name === null || entries.has(name) || entries.has(null);
      }
      default: return false;
    }
  };
  const mentions = node => {
    let found = false;
    walk(node, n => {
      if (isKey(n) || (n.type === 'Identifier' && holders.has(n.name))) found = true;
    });
    return found;
  };
  // Whether a value, used as a write's argument, may name the key.
  const holds = node => {
    switch (node?.type) {
      case 'Identifier': return holders.has(node.name) || keyNames.has(node.name);
      case 'Literal':
      case 'TemplateLiteral': return isKey(node);
      case 'ArrayExpression': return node.elements.some(e => e && (e.type === 'SpreadElement' ? holds(e.argument) : holds(e)));
      case 'ObjectExpression':
        return node.properties.some(p => (p.type === 'SpreadElement'
          ? holds(p.argument)
          : p.computed ? isKey(p.key) : propertyName(p.key) === KEY));
      case 'ConditionalExpression': return holds(node.consequent) || holds(node.alternate);
      case 'LogicalExpression': return holds(node.left) || holds(node.right);
      case 'AwaitExpression': return holds(node.argument);
      case 'MemberExpression': return isKey(node) || holds(node.object);
      case 'CallExpression':
      case 'NewExpression': return mentions(node); // what a call returns: anything it was given
      default: return false;
    }
  };
  const writeMethod = node => (node.type === 'MemberExpression' && isLocal(node.object) ? memberName(node) : null);
  const methodOf = node => (node.type === 'Identifier' ? methods.get(node.name) : writeMethod(node));
  const add = (set, name) => {
    if (set.has(name)) return false;
    set.add(name);
    return true;
  };
  const addEntry = (table, name) => {
    if (!tables.has(table)) tables.set(table, new Set());
    return add(tables.get(table), name);
  };
  // What an identifier given `value` (declared with it or assigned it) holds.
  const bind = (name, value) => {
    let changed = false;
    const init = value.type === 'CallExpression' && value.callee.type === 'MemberExpression' && memberName(value.callee) === 'bind' ? value.callee.object : value;
    if (isKey(init)) changed = add(keyNames, name) || changed;
    else if (holds(init)) changed = add(holders, name) || changed;
    if (isStorage(init)) changed = add(storages, name) || changed;
    if (isLocal(init)) changed = add(locals, name) || changed;
    if (init.type === 'ObjectExpression') {
      for (const p of init.properties) {
        if (p.type !== 'Property' || !isKey(p.value)) continue;
        const entry = p.computed ? (p.key.type === 'Literal' ? String(p.key.value) : null) : propertyName(p.key);
        changed = addEntry(name, entry) || changed;
      }
    }
    const method = methodOf(init);
    if (WRITE_METHODS.includes(method) && !methods.has(name)) {
      methods.set(name, method);
      changed = true;
    }
    return changed;
  };
  // What the identifiers destructured from `value` hold, nested patterns,
  // renamed and defaulted bindings included: storage from browser, local from
  // storage, a write method from local.
  const isBrowser = node => (node?.type === 'Identifier' && ['browser', 'messenger'].includes(node.name))
    || (node?.type === 'MemberExpression' && ['browser', 'messenger'].includes(memberName(node)));
  const kindOf = node => (isLocal(node) ? 'local' : isStorage(node) ? 'storage' : isBrowser(node) ? 'browser' : null);
  const bindKind = (pattern, kind) => {
    let changed = false;
    for (const p of pattern.properties) {
      if (p.type !== 'Property') continue;
      const name = p.computed ? (p.key.type === 'Literal' ? String(p.key.value) : null) : propertyName(p.key);
      const target = p.value.type === 'AssignmentPattern' ? p.value.left : p.value;
      const inner = (kind === 'browser' && name === 'storage') ? 'storage' : (kind === 'storage' && name === 'local') ? 'local' : null;
      if (target.type === 'ObjectPattern') {
        if (inner) changed = bindKind(target, inner) || changed;
        continue;
      }
      if (target.type !== 'Identifier') continue;
      if (inner === 'storage') changed = add(storages, target.name) || changed;
      if (inner === 'local') changed = add(locals, target.name) || changed;
      if (kind === 'local' && WRITE_METHODS.includes(name) && !methods.has(target.name)) {
        methods.set(target.name, name);
        changed = true;
      }
    }
    return changed;
  };
  const bindPattern = (pattern, value) => {
    const kind = kindOf(value);
    return kind ? bindKind(pattern, kind) : false;
  };

  // Follow the key into every identifier it reaches, until nothing changes.
  for (let changed = true; changed;) {
    changed = false;
    walk(ast, node => {
      if (node.type === 'VariableDeclarator') {
        if (node.id.type === 'Identifier' && node.init) changed = bind(node.id.name, node.init) || changed;
        else if (node.id.type === 'ObjectPattern' && node.init) changed = bindPattern(node.id, node.init) || changed;
      } else if (node.type === 'AssignmentExpression') {
        const { left, right } = node;
        if (left.type === 'Identifier') {
          changed = bind(left.name, right) || changed;
        } else if (left.type === 'ObjectPattern') {
          changed = bindPattern(left, right) || changed;
        } else if (left.type === 'MemberExpression' && left.object.type === 'Identifier') {
          const namesKey = left.computed ? isKey(left.property) : propertyName(left.property) === KEY;
          if (namesKey || holds(right)) changed = add(holders, left.object.name) || changed;
          if (isKey(right)) changed = addEntry(left.object.name, memberName(left)) || changed; // KEYS.turns = KEY
        }
      } else if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression') {
        const { object, property } = node.callee;
        const name = propertyName(property);
        const target = node.arguments[0];
        if (object.type === 'Identifier' && ['Object', 'Reflect'].includes(object.name) && target?.type === 'Identifier') {
          // Object.assign(x, ...), Object.defineProperty(x, key, ...), Reflect.set(x, key, ...)
          if ((name === 'assign' && node.arguments.slice(1).some(holds)) || (['defineProperty', 'set'].includes(name) && isKey(node.arguments[1]))) {
            changed = add(holders, target.name) || changed;
          }
        } else if (object.type === 'Identifier' && ['push', 'unshift', 'splice', 'concat', 'add', 'set'].includes(name)
          && !isLocal(object) && !locals.has(object.name) && node.arguments.some(a => isKey(a) || holds(a))) {
          changed = add(holders, object.name) || changed; // keys.push(KEY), keys.add(KEY), map.set(KEY, ...)
        }
      }
    });
  }

  const writes = [];
  walk(ast, (node, parents) => {
    if (node.type !== 'CallExpression') return;
    let method = methodOf(node.callee);
    let args = node.arguments;
    // set.call(local, values), remove.apply(local, [keys])
    if (!method && node.callee.type === 'MemberExpression' && ['call', 'apply'].includes(memberName(node.callee))) {
      method = methodOf(node.callee.object);
      args = node.arguments.slice(1);
    }
    if (!WRITE_METHODS.includes(method)) return;
    if (method !== 'clear' && !args.some(holds)) return;
    const owner = [...parents].reverse().find(p => p.type === 'FunctionDeclaration' && p.id)?.id.name;
    writes.push({ file, owner, line: source.slice(0, node.start).split('\n').length });
  });
  return writes;
}

// The files that load `target`: through imports, re-exports and a page's
// script tags, at any depth; and a dynamic import(), where it is.
function loadersOf(target, files, read) {
  // A module specifier is a path only when it starts with ./, ../ or /; a
  // page's script src is a path unless it names a scheme.
  const resolve = (from, spec) => {
    if (from.endsWith('.html') ? /^[a-z][a-z0-9+.-]*:/i.test(spec) : !/^\.{1,2}\/|^\//.test(spec)) return null;
    return spec.startsWith('/') ? spec.slice(1) : posix.normalize(posix.join(posix.dirname(from), spec));
  };
  const loads = new Map(); // file -> { fixed: Set, dynamic: Set }
  for (const file of files) {
    const source = read(file);
    const fixed = new Set();
    const dynamic = new Set();
    if (file.endsWith('.html')) {
      for (const [, src] of source.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) fixed.add(resolve(file, src));
    } else {
      walk(parseAny(source), node => {
        const from = ['ImportDeclaration', 'ExportAllDeclaration', 'ExportNamedDeclaration', 'ImportExpression'].includes(node.type) ? node.source : null;
        if (typeof from?.value !== 'string') return;
        (node.type === 'ImportExpression' ? dynamic : fixed).add(resolve(file, from.value));
      });
    }
    loads.set(file, { fixed, dynamic });
  }
  const reaching = new Set([target]);
  for (let changed = true; changed;) {
    changed = false;
    for (const [file, { fixed }] of loads) {
      if (!reaching.has(file) && [...fixed].some(f => reaching.has(f))) {
        reaching.add(file);
        changed = true;
      }
    }
  }
  const loaders = new Set([...reaching].filter(f => f !== target));
  for (const [file, { dynamic }] of loads) if ([...dynamic].some(f => reaching.has(f))) loaders.add(file);
  return [...loaders].sort();
}

const readFile = file => readFileSync(file, 'utf8');

it.each(Object.entries(WRITERS))('writes %s only in the stored turns\' queue, in %s', (key, writer) => {
  const writes = sources().flatMap(file => writesOf(key, file, readFile(file)));
  const elsewhere = writes.filter(w => !(w.file === QUEUE && w.owner === writer));
  expect(elsewhere).toEqual([]);
  // The census sees the writer's own writes, so it reads what it should.
  expect(writes.filter(w => w.file === QUEUE).map(w => w.owner).length).toBeGreaterThan(0);
});

// The background's own file, and the module whose task delivery runs only
// from the alarm listener the background primes (primeProactiveAlarmListener).
const BACKGROUND_LOADERS = ['agent/background.js', 'agent/modules/proactiveCheckin.js'];
const DELIVERY = 'agent/modules/proactiveCheckin.js';
// The functions that start the task delivery's alarm listener.
const DELIVERY_STARTERS = ['primeProactiveAlarmListener', 'initProactiveCheckin'];

// The files, other than `exempt`, that name any of `names`.
function namersOf(names, exempt, files, read) {
  return files.filter(file => {
    if (file === exempt) return false;
    const source = read(file);
    if (!names.some(name => source.includes(name))) return false;
    let named = false;
    walk(parseAny(source), node => {
      if ((node.type === 'Identifier' && names.includes(node.name)) || (node.type === 'Literal' && names.includes(node.value))) named = true;
    });
    return named;
  }).sort();
}

it('loads the stored turns\' queue only in the background', () => {
  const files = sources(['*.js', '*.mjs', '*.html']);
  expect(loadersOf(QUEUE, files, readFile)).toEqual(BACKGROUND_LOADERS);
});

// proactiveCheckin.js is loaded by pages too; it is a background loader only
// because only the background starts its task delivery, which loads the queue.
it('starts the task delivery, which loads the queue, only in the background', () => {
  expect(namersOf(DELIVERY_STARTERS, DELIVERY, sources(), readFile)).toEqual(['agent/background.js']);
});

describe.each(Object.keys(WRITERS))('the census itself, for %s', key => {
  // Each fixture names chat_turns; it is checked for each key.
  const found = source => writesOf(key, 'fixture.js', source.replaceAll('chat_turns', key)).length;

  it.each([
    ['written out', 'browser.storage.local.set({ chat_turns: [] });'],
    ['through a constant', 'const K = "chat_turns"; browser.storage.local.set({ [K]: [] });'],
    ['in an object built in steps', 'const K = "chat_turns"; const values = {}; values[K] = []; browser.storage.local.set(values);'],
    ['in an object given a property by name', 'const values = {}; values.chat_turns = []; browser.storage.local.set(values);'],
    ['in an object passed on', 'const a = { chat_turns: [] }; const b = a; let c; c = b; browser.storage.local.set(c);'],
    ['by spread', 'const base = { chat_turns: [] }; browser.storage.local.set({ ...base, other: 1 });'],
    ['by Object.assign', 'const values = {}; Object.assign(values, { chat_turns: [] }); browser.storage.local.set(values);'],
    ['in a list of keys built up', 'const keys = []; keys.push("chat_turns"); browser.storage.local.remove(keys);'],
    ['through a conditional key', 'const K = flag ? "chat_turns" : "other"; browser.storage.local.remove(K);'],
    ['through storage.local held in a variable', 'const local = browser.storage.local; local.set({ chat_turns: [] });'],
    ['through storage.local destructured', 'const { local } = browser.storage; local.remove("chat_turns");'],
    ['through a write method held in a variable', 'const remove = browser.storage.local.remove.bind(browser.storage.local); remove(["chat_turns"]);'],
    ['through a write method destructured', 'const { set } = browser.storage.local; set({ chat_turns: [] });'],
    ['through storage.local held in a variable assigned later', 'let local; local = browser.storage.local; local.set({ chat_turns: [] });'],
    ['through storage.local destructured by assignment', 'let local; ({ local } = browser.storage); local.set({ chat_turns: [] });'],
    ['through storage held in a variable', 'const storage = browser.storage; storage.local.remove("chat_turns");'],
    ['through a write method assigned later', 'let set; set = browser.storage.local.set; set({ chat_turns: [] });'],
    ['through brackets', 'browser.storage["local"].set({ chat_turns: [] });'],
    ['through brackets for every name', 'browser["storage"][`local`]["remove"]("chat_turns");'],
    ['through optional chaining', 'browser?.storage?.local?.set({ chat_turns: [] });'],
    ['through call', 'browser.storage.local.set.call(browser.storage.local, { chat_turns: [] });'],
    ['through apply', 'browser.storage.local.remove.apply(browser.storage.local, [["chat_turns"]]);'],
    ['through storage destructured from browser', 'const { storage } = browser; storage.local.set({ chat_turns: [] });'],
    ['through storage destructured from browser and renamed', 'const { storage: s } = browser; s.local.remove("chat_turns");'],
    ['through storage destructured from browser by assignment', 'let storage; ({ storage } = browser); storage.local.set({ chat_turns: [] });'],
    ['through storage.local destructured from browser in one pattern', 'const { storage: { local } } = browser; local.set({ chat_turns: [] });'],
    ['through a write method destructured from browser in one pattern', 'const { storage: { local: { remove } } } = browser; remove("chat_turns");'],
    ['through a table of keys', 'const KEYS = { turns: "chat_turns" }; browser.storage.local.set({ [KEYS.turns]: [] });'],
    ['through a table of keys, removed by name', 'const KEYS = { turns: "chat_turns" }; browser.storage.local.remove(KEYS.turns);'],
    ['through a table of keys, by a computed name', 'const KEYS = { turns: "chat_turns" }; browser.storage.local.remove([KEYS[field]]);'],
    ['through a table of keys filled in later', 'const KEYS = {}; KEYS.turns = "chat_turns"; browser.storage.local.remove(KEYS["turns"]);'],
    ['through a key taken from a table of keys', 'const KEYS = { turns: "chat_turns" }; const k = KEYS.turns; browser.storage.local.remove(k);'],
    ['by clearing everything', 'browser.storage.local.clear();'],
  ])('finds a write %s', (_, source) => {
    expect(found(source)).toBe(1);
  });

  it.each([
    ['of another key', 'browser.storage.local.set({ chat_meta: {} });'],
    ['of a key that only starts the same', 'browser.storage.local.set({ chat_turns_count: 1 });'],
    ['of a value read from the key', 'const stored = await browser.storage.local.get("chat_turns"); browser.storage.local.set({ chat_meta: { n: stored.chat_turns.length } });'],
    ['to another storage area', 'browser.storage.session.set({ chat_turns: [] });'],
    ['to another storage area through brackets', 'browser.storage["session"].set({ chat_turns: [] });'],
    ['to another storage area held in a variable assigned later', 'let area; area = browser.storage.session; area.set({ chat_turns: [] });'],
    ['to another storage area through storage destructured from browser', 'const { storage } = browser; storage.session.set({ chat_turns: [] });'],
    ['through another part of browser destructured', 'const { runtime } = browser; runtime.sendMessage({ chat_turns: [] });'],
    ['of another key in a table of keys', 'const KEYS = { turns: "chat_turns", meta: "chat_meta" }; browser.storage.local.set({ [KEYS.meta]: {} });'],
  ])('finds no write %s', (_, source) => {
    expect(found(source)).toBe(0);
  });
});

describe('the load census itself', () => {
  const loaders = files => loadersOf(QUEUE, Object.keys(files), file => files[file]);

  it('finds a page that loads the queue through a re-export, a script tag or a chain of imports', () => {
    expect(loaders({
      [QUEUE]: '',
      'chat/a.js': 'export * from "./modules/storedTurnsQueue.js";',
      'chat/b.js': 'export { enqueueTurnsChange } from "./modules/storedTurnsQueue.js";',
      'chat/c.js': 'import "./a.js";',
      'chat/chat.html': '<script type="module" src="c.js"></script>',
      'chat/d.js': 'const m = await import("./b.js");',
      'chat/e.js': 'import { x } from "./unrelated.js";',
      'chat/unrelated.js': 'export const x = 1;',
    })).toEqual(['chat/a.js', 'chat/b.js', 'chat/c.js', 'chat/chat.html', 'chat/d.js']);
  });

  it('finds a page that starts the task delivery, by import or through the module', () => {
    const files = {
      [DELIVERY]: 'export function primeProactiveAlarmListener() {}',
      'chat/a.js': 'import { primeProactiveAlarmListener } from "../agent/modules/proactiveCheckin.js"; primeProactiveAlarmListener();',
      'chat/b.js': 'const m = await import("../agent/modules/proactiveCheckin.js"); m.initProactiveCheckin();',
      'chat/c.js': 'import { consumePendingProactiveMessage } from "../agent/modules/proactiveCheckin.js";',
      'chat/d.js': '// primeProactiveAlarmListener is named only in a comment',
      'chat/e.js': 'import * as m from "../agent/modules/proactiveCheckin.js"; m["primeProactiveAlarmListener"]();',
    };
    expect(namersOf(DELIVERY_STARTERS, DELIVERY, Object.keys(files), file => files[file])).toEqual(['chat/a.js', 'chat/b.js', 'chat/e.js']);
  });
});
