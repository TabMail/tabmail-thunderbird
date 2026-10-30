/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// deviceRealm.js — loads the add-on's ES modules into one vm context per simulated Thunderbird
// process, so several devices (each with its own `browser`, storage and module state) run side by side
// in one test. Static and dynamic imports between the loaded files resolve inside the realm; any other
// import must be given as a stub, by its path from the add-on's root.

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';

const ROOT = new URL('../../', import.meta.url);

function resolvePath(from, specifier) {
  return new URL(specifier, new URL(from, ROOT)).href.slice(ROOT.href.length);
}

const transformed = new Map();

/** `file` as a factory registered with `__define`: imports read from `__require`, `import()` from
 * `__import`, its exports (declarations and local export lists) and the module-level names in
 * `exposed`, for tests to inspect, returned as live getters. */
function transform(file, exposed = []) {
  const cacheKey = JSON.stringify([file, exposed]);
  if (transformed.has(cacheKey)) return transformed.get(cacheKey);
  let source = readFileSync(new URL(file, ROOT), 'utf8');
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const edits = [];
  const exported = [];
  for (const node of ast.body) {
    if (node.type === 'ImportDeclaration') {
      const path = JSON.stringify(resolvePath(file, node.source.value));
      const named = [];
      let namespace = null;
      for (const spec of node.specifiers) {
        if (spec.type === 'ImportSpecifier') named.push(spec.imported.name === spec.local.name ? spec.local.name : `${spec.imported.name}: ${spec.local.name}`);
        else if (spec.type === 'ImportNamespaceSpecifier') namespace = spec.local.name;
        else throw new Error(`${file}: default imports are not supported`);
      }
      const lines = [];
      if (named.length > 0) lines.push(`const { ${named.join(', ')} } = __require(${path});`);
      if (namespace) lines.push(`const ${namespace} = __require(${path});`);
      edits.push([node.start, node.end, lines.join(' ')]);
    } else if (node.type === 'ExportNamedDeclaration' && !node.declaration) {
      if (node.source) throw new Error(`${file}: re-exports are not supported`);
      for (const spec of node.specifiers) exported.push([spec.exported.name, spec.local.name]);
      edits.push([node.start, node.end, '']);
    } else if (node.type === 'ExportNamedDeclaration') {
      const declaration = node.declaration;
      if (declaration.type === 'VariableDeclaration') for (const d of declaration.declarations) exported.push([d.id.name, d.id.name]);
      else exported.push([declaration.id.name, declaration.id.name]);
      edits.push([node.start, declaration.start, '']);
    } else if (node.type === 'ExportDefaultDeclaration' || node.type === 'ExportAllDeclaration') {
      throw new Error(`${file}: ${node.type} is not supported`);
    }
  }
  for (const [start, end, text] of edits.reverse()) source = source.slice(0, start) + text + source.slice(end);
  source = source.replace(/\bimport\(\s*(["'])([^"']+)\1\s*\)/g, (_, quote, specifier) => `__import(${JSON.stringify(resolvePath(file, specifier))})`);
  if (/\bimport\(/.test(source)) throw new Error(`${file}: a dynamic import with a computed specifier`);
  const getters = [...exported, ...exposed.map((name) => [name, name])].map(([name, local]) => `get ${name}() { return ${local}; }`).join(', ');
  const wrapped = `__define(${JSON.stringify(file)}, function () {\n${source}\nreturn { ${getters} };\n});`;
  transformed.set(cacheKey, wrapped);
  return wrapped;
}

/**
 * A new realm running `files` (paths from the add-on's root), evaluated on first use. `stubs` maps
 * other module paths to their exports; `globals` are the realm's globals (browser, crypto, fetch,
 * timers, ...); `expose` maps a file to module-level names its module object also returns.
 * Returns { require(path), context }.
 */
export function createRealm({ files, stubs = {}, globals = {}, expose = {} }) {
  const factories = new Map();
  const modules = new Map();
  const context = vm.createContext({ ...globals });
  const require = (path) => {
    if (Object.hasOwn(stubs, path)) return stubs[path];
    if (!modules.has(path)) {
      const factory = factories.get(path);
      if (!factory) throw new Error(`Unexpected import ${path}`);
      modules.set(path, factory());
    }
    return modules.get(path);
  };
  context.__define = (path, factory) => factories.set(path, factory);
  context.__require = require;
  context.__import = async (path) => require(path);
  for (const file of files) vm.runInContext(transform(file, expose[file]), context, { filename: file });
  return { require, context };
}
