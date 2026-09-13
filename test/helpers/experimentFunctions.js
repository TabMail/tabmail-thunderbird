import { readFileSync } from 'node:fs';
import { parse } from 'acorn';
import { runInNewContext } from 'node:vm';

/** Execute selected real experiment functions without importing privileged APIs. */
export function experimentFunctions(url, names, globals = {}) {
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
  visit(parse(source, { ecmaVersion: 'latest', sourceType: 'module' }));
  for (const name of names) if (!found.has(name)) throw new Error(`Missing production function: ${name}`);
  // Extracted scripts are behavioral probes, not original-file coverage evidence.
  return runInNewContext(`${[...found.values()].join('\n')}\n({${names.join(',')}})`, globals, {
    filename: `tabmail-extracted-${names.join('-')}.js`,
  });
}
