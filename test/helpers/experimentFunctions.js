import { readFileSync } from 'node:fs';
import { parse } from 'acorn';
import { runInNewContext } from 'node:vm';

/** Execute selected real experiment functions without importing privileged APIs. */
export function experimentFunctions(url, names, globals = {}, imports = {}) {
  const source = readFileSync(url, 'utf8');
  const found = new Map();
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'FunctionDeclaration' && names.includes(node.id?.name)) {
      found.set(node.id.name, source.slice(node.start, node.end));
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  }
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  // Bind supplied namespaces only through the source's actual named imports.
  for (const node of ast.body) {
    if (node.type !== 'ImportDeclaration') continue;
    const namespace = imports[node.source.value];
    if (!namespace) continue;
    for (const specifier of node.specifiers) {
      if (specifier.type === 'ImportSpecifier') globals[specifier.local.name] = namespace[specifier.imported.name];
    }
  }
  visit(ast);
  for (const name of names) if (!found.has(name)) throw new Error(`Missing production function: ${name}`);
  // Extracted scripts are behavioral probes, not original-file coverage evidence.
  return runInNewContext(`${[...found.values()].join('\n')}\n({${names.join(',')}})`, globals, {
    filename: `tabmail-extracted-${names.join('-')}.js`,
  });
}
