import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
import { runInNewContext } from 'node:vm';

/** Execute selected real experiment functions without importing privileged APIs. */
export function experimentFunctions(url, names, globals = {}) {
  const source = readFileSync(url, 'utf8');
  const found = new Map();
  const ranges = [];
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'FunctionDeclaration' && names.includes(node.id?.name)) {
      found.set(node.id.name, source.slice(node.start, node.end));
      ranges.push([node.start, node.end]);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  }
  visit(parse(source, { ecmaVersion: 'latest', sourceType: 'module' }));
  for (const name of names) if (!found.has(name)) throw new Error(`Missing production function: ${name}`);
  // Preserve source offsets so coverage points at the executed production lines.
  const retained = source.split('').map((char, index) =>
    ranges.some(([start, end]) => index >= start && index < end) || char === '\n'
      ? char : ' '
  ).join('');
  return runInNewContext(`${retained}\n({${names.join(',')}})`, globals, {
    filename: fileURLToPath(url),
  });
}
