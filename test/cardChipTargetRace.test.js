import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
import { JSDOM } from 'jsdom';
import { experiment, makeWindow } from './helpers/nativeLifecycleHarness.js';

describe('card chip target across background wake', () => {
  it('uses the clicked message even if another row becomes selected before handling', async () => {
    const source = readFileSync(new URL('../theme/background.js', import.meta.url), 'utf8');
    const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
    const node = ast.body.find(entry => entry.type === 'FunctionDeclaration'
      && entry.id?.name === '_onActionChipClick');
    expect(node).toBeTruthy();
    const acted = [];
    let selectedId = 1;
    const context = {
      console: { log() {}, error() {} },
      browser: { messages: { get: vi.fn(async id => ({ id })) } },
      performTaggedAction: vi.fn(async message => acted.push(message.id)),
      triggerTagActionKey: vi.fn(async () => acted.push(selectedId)),
    };
    vm.runInNewContext(`${source.slice(node.start, node.end)}\nthis.handle = _onActionChipClick`, context);
    selectedId = 2;
    await context.handle({ source: 'click', weMsgId: 1 });
    expect(acted).toEqual([1]);
  });

  it('captures the chip source message identity before the event crosses a wake', async () => {
    const dom = new JSDOM('<div id="threadTree"></div><table><tbody></tbody></table>', {
      url: 'https://example.test/',
    });
    try {
      const w = makeWindow();
      const doc = dom.window.document;
      const tree = doc.getElementById('threadTree');
      const hdr = {
        ...w.hdr,
        id: 1,
        folder: { ...w.hdr.folder, flags: 1 },
        getStringProperty: key => key === 'tm-action' ? 'delete' : '',
      };
      let currentHdr = hdr;
      tree.view = { getMsgHdrAt: () => currentHdr, selection: { select() {} } };
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
      const x = experiment('theme/experiments/tmMessageListCardView/tmMessageListCardView.sys.mjs',
        'tmMessageListCardView', { windows: [w.win] });
      x.context.extension.messageManager.convert = header => ({ id: header.id });
      try {
        await x.api.init();
        const acted = [];
        let selectedId = 1;
        const source = readFileSync(new URL('../theme/background.js', import.meta.url), 'utf8');
        const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
        const handler = ast.body.find(entry => entry.type === 'FunctionDeclaration'
          && entry.id?.name === '_onActionChipClick');
        const context = {
          console: { log() {}, error() {} },
          browser: { messages: { get: vi.fn(async id => ({ id })) } },
          performTaggedAction: vi.fn(async message => acted.push(message.id)),
          triggerTagActionKey: vi.fn(async () => acted.push(selectedId)),
        };
        vm.runInNewContext(`${source.slice(handler.start, handler.end)}\nthis.handle = _onActionChipClick`, context);
        const seen = vi.fn(info => context.handle(info));
        x.api.onActionChipClick.addListener(seen);
        const row = doc.createElement('tr');
        row.id = 'threadTree-row0';
        row.setAttribute('is', 'thread-card');
        doc.querySelector('tbody').appendChild(row);
        Row.prototype.fillRow.call(row, 0, null, {}, tree.view);
        const chip = row.querySelector('.tm-action-chip');
        expect(chip?.textContent).toBe('Delete');
        chip.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
        selectedId = 99;
        await vi.waitFor(() => expect(acted).toEqual([1]));
        expect(seen).toHaveBeenCalledWith(expect.objectContaining({ weMsgId: 1 }));
        currentHdr = { ...hdr, id: 2 };
        Row.prototype.fillRow.call(row, 0, null, {}, tree.view);
        row.querySelector('.tm-action-chip').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
        await vi.waitFor(() => expect(acted).toEqual([1, 2]));
        expect(seen).toHaveBeenLastCalledWith(expect.objectContaining({ weMsgId: 2 }));
        currentHdr = { ...hdr, id: 3 };
        const child = {
          ...hdr, id: 4,
          getStringProperty: key => key === 'tm-action' ? 'reply' : '',
        };
        tree.view.dbView = {
          isContainer: () => true,
          isContainerOpen: () => false,
          getThreadContainingIndex: () => ({
            numChildren: 2,
            getChildHdrAt: index => [currentHdr, child][index],
          }),
        };
        Row.prototype.fillRow.call(row, 0, null, {}, tree.view);
        expect(row.querySelector('.tm-action-chip')?.textContent).toBe('Reply');
        row.querySelector('.tm-action-chip').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
        await vi.waitFor(() => expect(acted).toEqual([1, 2, 4]));
        expect(seen).toHaveBeenLastCalledWith(expect.objectContaining({ weMsgId: 4 }));
      } finally {
        x.instance.onShutdown(false);
      }
    } finally {
      dom.window.close();
    }
  });

  it('refreshes the identity on a retained chip when its card shows another message', async () => {
    const dom = new JSDOM('<div id="threadTree"></div><table><tbody></tbody></table>', {
      url: 'https://example.test/',
    });
    const w = makeWindow();
    const doc = dom.window.document;
    const tree = doc.getElementById('threadTree');
    let hdr = {
      ...w.hdr, id: 7,
      folder: { ...w.hdr.folder, flags: 1 },
      getStringProperty: key => key === 'tm-action' ? 'delete' : '',
    };
    tree.view = { getMsgHdrAt: () => hdr, selection: { select() {} } };
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
    const x = experiment('theme/experiments/tmMessageListCardView/tmMessageListCardView.sys.mjs',
      'tmMessageListCardView', { windows: [w.win] });
    x.context.extension.messageManager.convert = header => ({ id: header.id });
    try {
      await x.api.init();
      const row = doc.createElement('tr');
      row.id = 'threadTree-row0';
      row.setAttribute('is', 'thread-card');
      doc.querySelector('tbody').appendChild(row);
      Row.prototype.fillRow.call(row, 0, null, {}, tree.view);
      const chip = row.querySelector('.tm-action-chip');
      expect(chip?.dataset.tmWeMsgId).toBe('7');
      const seen = [];
      x.api.onActionChipClick.addListener(info => seen.push(info.weMsgId));
      chip.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      expect(seen).toEqual([7]);

      hdr = { ...hdr, id: 9 };
      // Repaint the same native card without replacing its existing chip node.
      const source = readFileSync(new URL('../theme/experiments/tmMessageListCardView/tmMessageListCardView.sys.mjs', import.meta.url), 'utf8');
      const start = source.indexOf('    function _paintChipOnCard_MLCV(');
      const end = source.indexOf('    function _paintCardForAction_MLCV(', start);
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      const context = {
        context: x.context,
        _ACTION_LABELS_MLCV: { delete: 'Delete' },
        CHIP_CLASS_MLCV: 'tm-action-chip',
      };
      vm.runInNewContext(`${source.slice(start, end)}\nthis.paint = _paintChipOnCard_MLCV`, context);
      context.paint(row, 'delete', doc, hdr);
      expect(row.querySelector('.tm-action-chip')).toBe(chip);
      expect(row.querySelectorAll('.tm-action-chip')).toHaveLength(1);
      chip.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      expect(seen).toEqual([7, 9]);
    } finally {
      x.instance.onShutdown(false);
      dom.window.close();
    }
  });
});
