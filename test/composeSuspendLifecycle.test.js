import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';

const source = readFileSync(new URL('../compose/background.js', import.meta.url), 'utf8');

function event() {
  const listeners = new Set();
  return {
    listeners,
    addListener: callback => listeners.add(callback),
    removeListener: callback => listeners.delete(callback),
    emit: (...args) => Promise.all([...listeners].map(callback => callback(...args))),
  };
}

function startBackground() {
  const onMessage = event();
  const onSuspend = event();
  const onSuspendCanceled = event();
  const sendMessage = vi.fn(async () => {});
  const browser = {
    runtime: { onMessage, onSuspend, onSuspendCanceled },
    compose: { onBeforeSend: event(), getComposeDetails: vi.fn(async () => ({ subject: 'Synthetic subject' })) },
    tabs: { sendMessage },
  };
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  let script = source;
  for (const entry of ast.body.filter(node => node.type === 'ImportDeclaration').reverse()) {
    script = script.slice(0, entry.start)
      + script.slice(entry.start, entry.end).replace(/[^\r\n]/g, ' ')
      + script.slice(entry.end);
  }
  vm.runInNewContext(script, {
    browser, messenger: browser, window: {}, setTimeout: () => 1,
    console: { log() {}, warn() {}, error() {} },
    Date, performance, idb: {},
  });
  return {
    onMessage, onSuspend, onSuspendCanceled, sendMessage,
    trigger: () => onMessage.emit({ type: 'initialTriggerCheck' }, { tab: { id: 7 } }),
  };
}

describe('compose background suspend lifecycle', () => {
  it('keeps the same-generation compose handler after a canceled suspend', async () => {
    const background = startBackground();
    await background.trigger();
    expect(background.sendMessage).toHaveBeenCalledTimes(1);
    await background.onSuspend.emit();
    await background.onSuspendCanceled.emit();
    await background.trigger();
    expect(background.sendMessage).toHaveBeenCalledTimes(2);
    expect(background.onMessage.listeners.size).toBe(1);
  });

  it('attaches one handler on each fresh background evaluation', async () => {
    const first = startBackground();
    const second = startBackground();
    expect(first.onMessage.listeners.size).toBe(1);
    expect(second.onMessage.listeners.size).toBe(1);
    await second.trigger();
    expect(second.sendMessage).toHaveBeenCalledTimes(1);
  });
});
