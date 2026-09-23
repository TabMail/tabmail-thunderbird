import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { experiment, makeWindow } from './helpers/nativeLifecycleHarness.js';

const row = index => `<div id="threadTree-row${index}"><span data-column-name="subjectcol" title=""></span><span data-column-name="correspondentcol" title=""></span><span data-column-name="sendercol" title=""></span></div>`;

function header(messageId, effects, subject = '') {
  return {
    messageId, subject, author: '', date: 0, isRead: false,
    markRead(value) { this.isRead = value; effects.push(['read', messageId, value]); },
    folder: { deleteMessages(messages) { effects.push(['delete', messages.items[0].messageId]); } },
  };
}

describe('stale-row native DOM lifecycle', () => {
  it('observes the replacement document and stops processing after shutdown', async () => {
    const outer = new JSDOM('<html><body></body></html>');
    const first = new JSDOM('<html><body><div id="threadTree"></div></body></html>');
    const next = new JSDOM('<html><body><div id="threadTree"></div></body></html>');
    const effects = [];
    const w = makeWindow();
    w.win.document.documentElement = outer.window.document.documentElement;
    w.cw.document = first.window.document;
    first.window.document.getElementById('threadTree').innerHTML = row(0);
    let headers = [header('first@example.test', effects)];
    w.view.getMsgHdrAt = index => headers[index];
    const x = experiment('theme/experiments/staleRowFilter/staleRowFilter.sys.mjs', 'staleRowFilter', { windows: [w.win] });
    x.sandbox.Cc = {
      '@mozilla.org/array;1': { createInstance: () => ({ items: [], appendElement(item) { this.items.push(item); } }) },
    };
    try {
      x.api.init();
      expect(effects).toContainEqual(['read', 'first@example.test', true]);
      expect(effects).toContainEqual(['delete', 'first@example.test']);
      effects.length = 0;
      w.cw.document = next.window.document;
      w.cw.dispatch('folderURIChanged');
      await new Promise(resolve => setTimeout(resolve, 70));
      expect(effects).toEqual([]);
      headers = [header('replacement@example.test', effects), header('ordinary@example.test', effects, 'Ordinary subject')];
      next.window.document.getElementById('threadTree').innerHTML = row(0) + row(1);
      await new Promise(resolve => setImmediate(resolve));
      expect(effects).toEqual([
        ['read', 'replacement@example.test', true],
        ['delete', 'replacement@example.test'],
      ]);
      x.instance.onShutdown(false);
      effects.length = 0;
      headers = [header('after-shutdown@example.test', effects)];
      next.window.document.getElementById('threadTree').innerHTML = row(0);
      await new Promise(resolve => setTimeout(resolve, 110));
      expect(effects).toEqual([]);
    } finally {
      x.instance.onShutdown(false);
      outer.window.close();first.window.close();next.window.close();
    }
  });
});
