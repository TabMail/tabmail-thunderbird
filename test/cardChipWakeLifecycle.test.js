import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { parse } from 'acorn';
import { experiment, makeWindow } from './helpers/nativeLifecycleHarness.js';

const cardExperiment = 'theme/experiments/tmMessageListCardView/tmMessageListCardView.sys.mjs';

function renderedChip() {
  const dom = new JSDOM('<div id="threadTree"></div><table><tbody></tbody></table>', {
    url: 'https://example.test/',
  });
  const w = makeWindow();
  const doc = dom.window.document;
  const tree = doc.getElementById('threadTree');
  const selected = vi.fn();
  const hdr = {
    ...w.hdr,
    folder: { ...w.hdr.folder, flags: 1 },
    getStringProperty: key => key === 'tm-action' ? 'delete' : '',
  };
  tree.view = { getMsgHdrAt: () => hdr, selection: { select: selected } };
  const tabmail = w.win.document.getElementById('tabmail');
  tabmail.currentAbout3Pane = dom.window;
  tabmail.tabInfo[0].chromeBrowser = { contentDocument: doc, contentWindow: dom.window };
  class Row {
    fillRow() {
      this.innerHTML = '<td class="card-container"><span class="sender">Synthetic Sender</span><span class="subject">Synthetic subject</span><div class="thread-card-dynamic-row"></div></td>';
    }
  }
  Row.ROW_HEIGHT = 46;
  Object.defineProperty(dom.window, 'customElements', {
    value: { get: name => name === 'thread-card' ? Row : undefined },
  });
  return { dom, w, doc, tree, Row, selected };
}

describe('card chip first-click wake contract', () => {
  it('registers the chip event before async theme initialization begins', () => {
    const source = readFileSync(new URL('../theme/background.js', import.meta.url), 'utf8');
    const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
    const topLevelCalls = ast.body.filter(node =>
      node.type === 'ExpressionStatement' && node.expression?.type === 'CallExpression'
      && node.expression.callee?.type === 'Identifier'
    ).map(node => node.expression.callee.name);
    const listenerIndex = topLevelCalls.indexOf('_ensureActionChipClickListener');
    const initIndex = topLevelCalls.indexOf('initTheme');
    expect(initIndex).toBeGreaterThan(-1);
    expect(listenerIndex).toBeGreaterThan(-1);
    expect(listenerIndex).toBeLessThan(initIndex);
  });

  it('delivers the first native chip click through a primed listener and converts without duplication', async () => {
    const fixture = renderedChip();
    const { dom, w, doc, tree, Row, selected } = fixture;
    const x = experiment(cardExperiment, 'tmMessageListCardView', { windows: [w.win] });
    try {
      await x.api.init();
      const row = doc.createElement('tr');
      row.id = 'threadTree-row0';
      row.setAttribute('is', 'thread-card');
      doc.querySelector('tbody').appendChild(row);
      Row.prototype.fillRow.call(row, 0, null, {}, tree.view);
      const chip = row.querySelector('.tm-action-chip');
      expect(chip?.textContent).toBe('Delete');
      const click = () => chip.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

      const live = vi.fn();
      x.api.onActionChipClick.addListener(live);
      click();
      expect(selected).toHaveBeenCalledWith(0);
      expect(live).toHaveBeenCalledTimes(1);
      expect(live).toHaveBeenCalledWith({ source: 'click', weMsgId: 1 });
      x.api.onActionChipClick.removeListener(live);

      const wake = vi.fn();
      const persisted = x.api.onActionChipClick.testPersistentRegistration();
      expect(persisted?.module).toBe('tmMessageListCardView');
      expect(persisted?.event).toBe('onActionChipClick');
      const registration = persisted.prime({ async: wake });
      expect(registration?.convert).toBeTypeOf('function');
      click();
      expect(wake).toHaveBeenCalledTimes(1);
      expect(wake).toHaveBeenCalledWith({ source: 'click', weMsgId: 1 });
      expect(live).toHaveBeenCalledTimes(1);

      const resumed = vi.fn();
      registration.convert({ async: resumed });
      click();
      expect(wake).toHaveBeenCalledTimes(1);
      expect(resumed).toHaveBeenCalledTimes(1);
      registration.unregister();
      click();
      expect(resumed).toHaveBeenCalledTimes(1);
      expect(resumed).toHaveBeenCalledWith({ source: 'click', weMsgId: 1 });
    } finally {
      x.instance.onShutdown(false);
      dom.window.close();
    }
  });

  it('detaches a still-live card subscriber on experiment shutdown', async () => {
    const x = experiment(cardExperiment, 'tmMessageListCardView');
    const seen = vi.fn();
    x.api.onActionChipClick.addListener(seen);
    expect(x.instance._chipClickSubscriptions.size).toBe(1);
    x.instance.onShutdown(false);
    expect(x.instance._chipClickSubscriptions.size).toBe(0);
    x.context.extension.emit('onActionChipClick', { source: 'click', weMsgId: 1 });
    expect(seen).not.toHaveBeenCalled();
  });

  it('forwards the snippet-needs payload after the emitter event name', async () => {
    const x = experiment(cardExperiment, 'tmMessageListCardView');
    try {
      const seen = vi.fn();
      x.api.onSnippetsNeeded.addListener(seen);
      x.context.extension.emit('onSnippetsNeeded', { count: 2 });
      expect(seen).toHaveBeenCalledWith({ count: 2 });
    } finally {
      x.instance.onShutdown(false);
    }
  });
});
