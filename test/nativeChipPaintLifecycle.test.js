import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { experiment, makeWindow } from './helpers/nativeLifecycleHarness.js';

describe('native chip painting in a loading message window', () => {
  it('defers header refresh until initialization owns the painted chip', async () => {
    const dom = new JSDOM('<div id="messageHeader"><div id="expandedButtonsBox"></div></div>', { url: 'https://example.test/' });
    try {
      const w = makeWindow();
      const doc = dom.window.document;
      dom.window.gMessage = {
        ...w.hdr,
        folder: { ...w.hdr.folder, flags: 1 },
        getStringProperty: key => key === 'tm-action' ? 'reply' : '',
      };
      w.win.document.getElementById('tabmail').tabInfo[0].chromeBrowser.contentDocument = doc;
      const x = experiment('theme/experiments/tmMessageHeaderChip/tmMessageHeaderChip.sys.mjs', 'tmMessageHeaderChip', { windows: [w.win] });
      await x.api.refreshAll();
      expect(doc.querySelectorAll('.tm-action-chip')).toHaveLength(0);
      await x.api.init();
      expect(doc.querySelectorAll('.tm-action-chip')).toHaveLength(1);
      x.instance.onShutdown(false);
      expect(doc.querySelectorAll('.tm-action-chip')).toHaveLength(0);
    } finally {
      dom.window.close();
    }
  });
  for (const name of ['tmMessageHeaderChip', 'tmMultiMessageChip']) {
    it(`${name} paints a clickable action chip and removes it on shutdown`, async () => {
      const header = name === 'tmMessageHeaderChip';
      const html = header
        ? '<div id="messageHeader"><div id="expandedButtonsBox"></div></div>'
        : '<div id="content"><ul id="messageList"><li data-message-id="synthetic@example.test"><div class="item-header"></div></li></ul></div>';
      const dom = new JSDOM(html, { url: 'https://example.test/' });
      try {
        const w = makeWindow();
        const doc = dom.window.document;
        const hdr = {
          ...w.hdr,
          folder: { ...w.hdr.folder, flags: 1 },
          getStringProperty: key => key === 'tm-action' ? 'reply' : '',
        };
        if (header) dom.window.gMessage = hdr;
        else dom.window.gMessageSummary = {
          _msgNodes: { [`1${hdr.folder.URI}`]: doc.querySelector('li') },
        };
        const tabmail = w.win.document.getElementById('tabmail');
        tabmail.tabInfo[0].chromeBrowser.contentDocument = doc;
        const get = w.win.document.getElementById;
        let ready = false;
        w.win.document.getElementById = (...args) => ready ? get(...args) : null;
        w.win.document.readyState = 'loading';

        const x = experiment(`theme/experiments/${name}/${name}.sys.mjs`, name, {
          windows: [w.win],
          moduleOverrides: { MailUtils: { getExistingFolder: () => ({ GetMessageHeader: () => hdr }) } },
        });
        await x.api.init();
        expect(doc.querySelectorAll('.tm-action-chip')).toHaveLength(0);
        const next = x.instance.getAPI({ extension: x.context.extension })[name];
        await next.init();
        await x.api.shutdown();
        expect(w.win.handlers.get('load')?.size).toBe(1);

        ready = true;
        w.win.document.readyState = 'complete';
        w.win.dispatch('load');
        const chips = doc.querySelectorAll('.tm-action-chip');
        expect(chips).toHaveLength(1);
        expect(chips[0].textContent).toContain('Reply');

        const clicked = [];
        next.onActionChipClick.addListener(info => clicked.push(info));
        chips[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
        expect(clicked).toEqual([{ source: 'click', weMsgId: 1 }]);

        x.instance.onShutdown(false);
        expect(doc.querySelectorAll('.tm-action-chip')).toHaveLength(0);
      } finally {
        dom.window.close();
      }
    });
  }
});
