import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { parse } from 'acorn';
import { experiment, makeWindow } from './helpers/nativeLifecycleHarness.js';

const multiExperiment = 'theme/experiments/tmMultiMessageChip/tmMultiMessageChip.sys.mjs';

function renderedMultiMessageChip() {
  const dom = new JSDOM(`
    <div id="content"><ul id="messageList">
      <li data-message-id="synthetic@example.test"><div class="item-header"></div></li>
    </ul></div>
  `, { url: 'chrome://messenger/content/multimessageview.xhtml' });
  const w = makeWindow();
  const hdr = {
    ...w.hdr,
    folder: { ...w.hdr.folder, flags: 1 },
    getStringProperty: key => key === 'tm-action' ? 'reply' : '',
  };
  const li = dom.window.document.querySelector('#messageList li');
  dom.window.gMessageSummary = {
    _msgNodes: { [`${hdr.messageKey}${hdr.folder.URI}`]: li },
  };
  w.win.document.getElementById('tabmail').tabInfo[0].chromeBrowser = {
    contentDocument: dom.window.document,
    contentWindow: dom.window,
  };
  const moduleOverrides = {
    MailUtils: { getExistingFolder: () => ({ GetMessageHeader: () => hdr }) },
  };
  return { dom, w, moduleOverrides };
}

describe('multi-message chip first-click wake contract', () => {
  it('registers its consumer before asynchronous theme initialization', () => {
    const source = readFileSync(new URL('../theme/background.js', import.meta.url), 'utf8');
    const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
    const calls = ast.body.filter(node => node.type === 'ExpressionStatement'
      && node.expression?.type === 'CallExpression')
      .map(node => ({ name: node.expression.callee?.name, at: node.start }));
    const register = calls.find(call => call.name === '_ensureMultiMessageChipClickListener');
    const init = calls.find(call => call.name === 'initTheme');
    expect(register).toBeDefined();
    expect(init).toBeDefined();
    expect(register.at).toBeLessThan(init.at);
  });

  it.each([
    ['click', event => new event.view.MouseEvent('click', { bubbles: true })],
    ['Enter', event => new event.view.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })],
  ])('delivers the first %s through a primed native listener without duplication', async (source, makeEvent) => {
    const { dom, w, moduleOverrides } = renderedMultiMessageChip();
    const x = experiment(multiExperiment, 'tmMultiMessageChip', { windows: [w.win], moduleOverrides });
    try {
      await x.api.init();
      const chip = dom.window.document.querySelector('.tm-multi-action-chip');
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
      expect(persisted).toMatchObject({ module: 'tmMultiMessageChip', event: 'onActionChipClick' });
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

  it('isolates its internal event and detaches subscribers on shutdown', () => {
    const x = experiment(multiExperiment, 'tmMultiMessageChip');
    const seen = vi.fn();
    x.api.onActionChipClick.addListener(seen);
    expect(x.instance._chipClickSubscriptions.size).toBe(1);
    x.context.extension.emit('onActionChipClick', { source: 'click', weMsgId: 1 });
    x.context.extension.emit('tmMessageHeaderChipActionClick', { source: 'click', weMsgId: 1 });
    expect(seen).not.toHaveBeenCalled();
    x.instance.onShutdown(false);
    expect(x.instance._chipClickSubscriptions.size).toBe(0);
    x.context.extension.emit('tmMultiMessageChipActionClick', { source: 'click', weMsgId: 1 });
    expect(seen).not.toHaveBeenCalled();
  });
});
