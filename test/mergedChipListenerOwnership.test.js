import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';

const source = readFileSync(new URL('../theme/background.js', import.meta.url), 'utf8');
const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });

it.each([
  ['card', 'tmMessageListCardView', '_tmActionChipClickListener', '_ensureActionChipClickListener', '_stopActionChipClickListener', '_onActionChipClick'],
  ['header', 'tmMessageHeaderChip', '_tmHeaderChipClickListener', '_ensureHeaderChipClickListener', '_stopHeaderChipClickListener', '_onHeaderChipClick'],
  ['multi', 'tmMultiMessageChip', '_tmMultiMessageChipClickListener', '_ensureMultiMessageChipClickListener', '_stopMultiMessageChipClickListener', '_onMultiMessageChipClick'],
])('%s chip listener retries failed registration and never stacks across stop/start', (_label, apiName, refName, ensureName, stopName, handlerName) => {
  const listeners = new Set();
  let failAdd = true;
  let failRemove = true;
  const event = {
    addListener: vi.fn(listener => {
      if (failAdd) { failAdd = false; throw new Error('synthetic registration failure'); }
      listeners.add(listener);
    }),
    removeListener: vi.fn(listener => {
      if (failRemove) { failRemove = false; throw new Error('synthetic removal failure'); }
      listeners.delete(listener);
    }),
  };
  const functions = [ensureName, stopName].map(name => {
    const node = ast.body.find(item => item.type === 'FunctionDeclaration' && item.id?.name === name);
    expect(node).toBeDefined();
    return source.slice(node.start, node.end);
  });
  const context = {
    browser: { [apiName]: { onActionChipClick: event } },
    console: { log: vi.fn(), error: vi.fn() },
  };
  vm.createContext(context);
  vm.runInContext(`let ${refName} = null; function ${handlerName}() {}\n${functions.join('\n')}\nthis.ensure = ${ensureName}; this.stop = ${stopName};`, context);

  context.ensure('startup');
  expect(listeners.size).toBe(0);
  context.ensure('retry');
  context.ensure('repeated-init');
  expect(listeners.size).toBe(1);
  expect(event.addListener).toHaveBeenCalledTimes(2);

  context.stop('transient-failure');
  context.ensure('while-still-owned');
  expect(listeners.size).toBe(1);
  expect(event.addListener).toHaveBeenCalledTimes(2);

  context.stop('retry');
  expect(listeners.size).toBe(0);
  context.ensure('restart');
  expect(listeners.size).toBe(1);
  context.stop('final');
  expect(listeners.size).toBe(0);
});
