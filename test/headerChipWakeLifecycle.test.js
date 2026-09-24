import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { parse } from 'acorn';
import { experiment, makeWindow } from './helpers/nativeLifecycleHarness.js';

const headerExperiment = 'theme/experiments/tmMessageHeaderChip/tmMessageHeaderChip.sys.mjs';

function renderedHeaderChip() {
  const dom = new JSDOM(`
    <div id="messageHeader">
      <div id="headerSubjectSecurityContainer"><div id="expandedButtonsBox"></div></div>
    </div>
  `, { url: 'https://example.test/' });
  const w = makeWindow();
  const hdr = {
    ...w.hdr,
    folder: { ...w.hdr.folder, flags: 1 },
    getStringProperty: key => key === 'tm-action' ? 'reply' : '',
  };
  dom.window.gMessage = hdr;
  w.win.document.getElementById('tabmail').tabInfo[0].chromeBrowser = {
    contentDocument: dom.window.document,
    contentWindow: dom.window,
  };
  return { dom, w };
}

describe('header chip first-click wake contract', () => {
  it('registers its consumer before the first asynchronous theme initialization', () => {
    const source = readFileSync(new URL('../theme/background.js', import.meta.url), 'utf8');
    const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
    const calls = ast.body.filter(node => node.type === 'ExpressionStatement'
      && node.expression?.type === 'CallExpression')
      .map(node => ({ name: node.expression.callee?.name, at: node.start }));
    const register = calls.find(call => call.name === '_ensureHeaderChipClickListener');
    const init = calls.find(call => call.name === 'initTheme');
    expect(register).toBeDefined();
    expect(init).toBeDefined();
    expect(register.at).toBeLessThan(init.at);
  });

  it.each([
    ['click', event => new event.view.MouseEvent('click', { bubbles: true })],
    ['Enter', event => new event.view.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })],
  ])('delivers the first %s through a primed listener and converts without duplication', async (source, makeEvent) => {
    const { dom, w } = renderedHeaderChip();
    const x = experiment(headerExperiment, 'tmMessageHeaderChip', { windows: [w.win] });
    try {
      await x.api.init();
      const chip = dom.window.document.querySelector('.tm-header-action-chip');
      expect(chip?.textContent).toBe('Reply');
      expect(chip?.dataset.tmWeMsgId).toBe('1');
      const activate = () => chip.dispatchEvent(makeEvent({ view: dom.window }));

      const live = vi.fn();
      x.api.onActionChipClick.addListener(live);
      activate();
      expect(live).toHaveBeenCalledExactlyOnceWith({
        source: source === 'click' ? 'click' : 'keydown', weMsgId: 1,
      });
      x.api.onActionChipClick.removeListener(live);

      const wake = vi.fn();
      const persisted = x.api.onActionChipClick.testPersistentRegistration();
      expect(persisted).toMatchObject({ module: 'tmMessageHeaderChip', event: 'onActionChipClick' });
      const registration = persisted.prime({ async: wake });
      activate();
      expect(wake).toHaveBeenCalledExactlyOnceWith({
        source: source === 'click' ? 'click' : 'keydown', weMsgId: 1,
      });
      const resumed = vi.fn();
      registration.convert({ async: resumed });
      activate();
      expect(wake).toHaveBeenCalledTimes(1);
      expect(resumed).toHaveBeenCalledTimes(1);
      registration.unregister();
      activate();
      expect(resumed).toHaveBeenCalledTimes(1);
      expect(x.instance._chipClickSubscriptions.size).toBe(0);
    } finally {
      x.instance.onShutdown(false);
      dom.window.close();
    }
  });

  it('detaches a live native subscriber on extension shutdown', () => {
    const x = experiment(headerExperiment, 'tmMessageHeaderChip');
    const seen = vi.fn();
    x.api.onActionChipClick.addListener(seen);
    expect(x.instance._chipClickSubscriptions.size).toBe(1);
    // The card experiment uses the generic internal name on the same extension.
    // A card click must never be mistaken for a header click.
    x.context.extension.emit('onActionChipClick', { source: 'click', weMsgId: 1 });
    expect(seen).not.toHaveBeenCalled();
    x.instance.onShutdown(false);
    expect(x.instance._chipClickSubscriptions.size).toBe(0);
    x.context.extension.emit('tmMessageHeaderChipActionClick', { source: 'click', weMsgId: 1 });
    expect(seen).not.toHaveBeenCalled();
  });
});
