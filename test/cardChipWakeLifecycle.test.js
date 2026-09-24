import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { parse } from 'acorn';
import vm from 'node:vm';
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

  it.each([
    ['mouse click', 'click'],
    ['Enter', 'Enter'],
    ['Space', ' '],
  ])('replays the first %s action on its original message after wake', async (_name, activation) => {
    const { dom, w, doc, tree, Row } = renderedChip();
    const x = experiment(cardExperiment, 'tmMessageListCardView', { windows: [w.win] });
    try {
      await x.api.init();
      const row = doc.createElement('tr');
      row.id = 'threadTree-row0';
      row.setAttribute('is', 'thread-card');
      doc.querySelector('tbody').appendChild(row);
      Row.prototype.fillRow.call(row, 0, null, {}, tree.view);
      const chip = row.querySelector('.tm-action-chip');
      expect(chip?.dataset.tmWeMsgId).toBe('1');

      const messages = new Map([
        [1, { id: 1, action: 'delete', read: false,
          folder: { id: 'inbox' }, headerMessageId: 'synthetic-1@example.test' }],
        [2, { id: 2, action: 'delete', read: false,
          folder: { id: 'inbox' }, headerMessageId: 'synthetic-2@example.test' }],
      ]);
      let selectedId = 1;
      const source = readFileSync(new URL('../theme/background.js', import.meta.url), 'utf8');
      const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
      const node = ast.body.find(entry => entry.type === 'FunctionDeclaration'
        && entry.id?.name === '_onActionChipClick');
      const actionSource = readFileSync(new URL('../agent/modules/action.js', import.meta.url), 'utf8');
      const actionAst = parse(actionSource, { ecmaVersion: 'latest', sourceType: 'module' });
      const actionNode = actionAst.body.find(entry =>
        entry.type === 'ExportNamedDeclaration'
        && entry.declaration?.id?.name === 'performTaggedAction').declaration;
      const moves = vi.fn(async (ids, folder) => {
        for (const id of ids) {
          const msg = messages.get(id);
          if (!msg) throw new Error(`missing synthetic message ${id}`);
          messages.set(id, { ...msg, folder: { id: folder } });
        }
      });
      const updates = vi.fn(async (id, fields) => {
        const msg = messages.get(id);
        if (!msg) throw new Error(`missing synthetic message ${id}`);
        messages.set(id, { ...msg, ...fields });
      });
      const context = {
        console: { log() {}, error() {} },
        browser: { messages: {
          get: vi.fn(async id => messages.get(id) ?? null),
          update: updates, move: moves,
        } },
        ACTIONS: { DELETE: 'delete', ARCHIVE: 'archive', REPLY: 'reply' },
        getActionForWeId: async hdr => hdr.action,
        getTrashFolderForHeader: async () => ({ id: 'trash', path: '/Trash' }),
        log() {},
        triggerTagActionKey: vi.fn(async () => {
          const msg = messages.get(selectedId);
          messages.set(selectedId, { ...msg, folder: { id: 'trash' } });
        }),
      };
      vm.runInNewContext(`${actionSource.slice(actionNode.start, actionNode.end)}\nthis.performTaggedAction = performTaggedAction`, context);
      const performTaggedAction = vi.fn(context.performTaggedAction);
      context.performTaggedAction = performTaggedAction;
      vm.runInNewContext(`${source.slice(node.start, node.end)}\nthis.handle = _onActionChipClick`, context);

      const queued = [];
      const persisted = x.api.onActionChipClick.testPersistentRegistration();
      const registration = persisted.prime({
        wakeup: vi.fn(async () => {}),
        async: info => new Promise(resolve => queued.push({ info, resolve })),
      });
      if (activation === 'click') {
        chip.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      } else {
        chip.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: activation, bubbles: true }));
      }
      expect(queued).toHaveLength(1);
      expect(queued[0].info).toEqual({
        source: activation === 'click' ? 'click' : 'keydown', weMsgId: 1,
      });
      expect(messages.get(1).folder.id).toBe('inbox');
      selectedId = 2;
      const resumed = vi.fn(info => context.handle(info));
      registration.convert({ async: resumed });
      // Gecko flushes the queued first event after convert; model that handoff.
      for (const item of queued) item.resolve(await resumed(item.info));
      expect(resumed).toHaveBeenCalledTimes(1);
      expect(performTaggedAction).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
      expect(context.browser.messages.get).toHaveBeenCalledTimes(2);
      expect(context.browser.messages.get).toHaveBeenNthCalledWith(1, 1);
      expect(context.browser.messages.get).toHaveBeenNthCalledWith(2, 1);
      expect(context.triggerTagActionKey).not.toHaveBeenCalled();
      expect(updates).toHaveBeenCalledExactlyOnceWith(1, { read: true });
      expect(moves).toHaveBeenCalledExactlyOnceWith([1], 'trash', { isUserAction: true });
      expect(messages.get(1)).toMatchObject({ id: 1, read: true, folder: { id: 'trash' } });
      expect(messages.get(2)).toMatchObject({ id: 2, read: false, folder: { id: 'inbox' } });
      registration.unregister();
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

  it('releases retired subscriptions across repeated wake registrations', () => {
    const x = experiment(cardExperiment, 'tmMessageListCardView');
    const seen = vi.fn();
    try {
      for (let i = 0; i < 100; i++) {
        const registration = x.instance.primeListener('onActionChipClick', { async: seen });
        x.context.extension.emit('onActionChipClick', { source: 'click', weMsgId: i + 1 });
        registration.unregister();
        expect(x.instance._chipClickSubscriptions.size).toBe(0);
      }
      expect(seen).toHaveBeenCalledTimes(100);
      x.context.extension.emit('onActionChipClick', { source: 'click', weMsgId: 101 });
      expect(seen).toHaveBeenCalledTimes(100);
    } finally {
      x.instance.onShutdown(false);
    }
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
