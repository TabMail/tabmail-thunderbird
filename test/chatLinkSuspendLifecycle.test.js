import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';

function event() {
  const listeners = new Set();
  return {
    listeners,
    addListener: callback => listeners.add(callback),
    removeListener: callback => listeners.delete(callback),
    emit: (...args) => Promise.all([...listeners].map(callback => callback(...args))),
  };
}

function startChatLink() {
  const source = readFileSync(new URL('../chatlink/background.js', import.meta.url), 'utf8');
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  let script = source;
  for (const entry of ast.body.filter(node => node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration').reverse()) {
    script = script.slice(0, entry.start) + script.slice(entry.start, entry.end).replace(/[^\r\n]/g, ' ') + script.slice(entry.end);
  }
  const onChanged = event();
  const onSuspend = event();
  const set = vi.fn(async () => {});
  const browser = { storage: { onChanged, local: { set } }, runtime: { onSuspend } };
  vm.runInNewContext(script, {
    browser, setTimeout: () => 1, clearTimeout() {}, clearInterval() {},
    log() {}, getChatLinkUrl: () => 'wss://synthetic.example.test',
    isChatWindowOpen() {}, openOrFocusChatWindow() {},
    console: { log() {}, warn() {}, error() {} },
  });
  return { onChanged, onSuspend, set };
}

describe('ChatLink storage listener lifetime', () => {
  it('keeps the real startup subscription after a canceled suspend', async () => {
    const app = startChatLink();
    expect(app.onChanged.listeners.size).toBe(1);
    await app.onChanged.emit({ chatlink_enabled: { newValue: false } }, 'local');
    expect(app.set).toHaveBeenCalledTimes(1);
    await app.onSuspend.emit();
    await app.onChanged.emit({ chatlink_enabled: { newValue: false } }, 'local');
    expect(app.set).toHaveBeenCalledTimes(2);
    expect(app.onChanged.listeners.size).toBe(1);
  });
});
