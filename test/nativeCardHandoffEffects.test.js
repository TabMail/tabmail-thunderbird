import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { experiment, makeWindow } from './helpers/nativeLifecycleHarness.js';

describe('card renderer handoff', () => {
  it('keeps sender formatting and the action chip after an API-context replacement', async () => {
    const dom = new JSDOM('<div id="threadTree"></div><table><tbody></tbody></table>', { url: 'https://example.test/' });
    try {
      const w = makeWindow();
      const doc = dom.window.document;
      const tree = doc.getElementById('threadTree');
      const hdr = {
        ...w.hdr,
        folder: { ...w.hdr.folder, flags: 1 },
        getStringProperty: key => key === 'tm-action' ? 'reply' : '',
      };
      tree.view = { getMsgHdrAt: () => hdr };
      const tabmail = w.win.document.getElementById('tabmail');
      tabmail.currentAbout3Pane = dom.window;
      tabmail.tabInfo[0].chromeBrowser = { contentDocument: doc, contentWindow: dom.window };
      class Row {
        fillRow() {
          this.innerHTML = '<td class="card-container"><span class="sender">Synthetic Sender &lt;sender@example.test&gt;</span><span class="subject">Synthetic subject</span><div class="thread-card-dynamic-row"></div></td>';
        }
      }
      Row.ROW_HEIGHT = 46;
      const original = Row.prototype.fillRow;
      Object.defineProperty(dom.window, 'customElements', { value: { get: name => name === 'thread-card' ? Row : undefined } });
      const x = experiment('theme/experiments/tmMessageListCardView/tmMessageListCardView.sys.mjs', 'tmMessageListCardView', { windows: [w.win] });
      await x.api.init();
      await x.instance.getAPI({ extension: x.context.extension }).tmMessageListCardView.init();
      expect(Row.prototype.fillRow).not.toBe(original);
      const row = doc.createElement('tr');
      row.id = 'threadTree-row0';
      row.setAttribute('is', 'thread-card');
      doc.querySelector('tbody').appendChild(row);
      Row.prototype.fillRow.call(row, 0, null, {}, tree.view);
      expect(row.querySelector('.subject')?.textContent).toBe('Synthetic subject');
      expect(row.querySelector('.sender')?.textContent).toBe('Synthetic Sender');
      expect(row.querySelector('.tm-action-chip')?.textContent).toBe('Reply');
      expect(row.classList.contains('tm-action-reply')).toBe(true);
      x.instance.onShutdown(false);
      expect(Row.prototype.fillRow).toBe(original);
    } finally {
      dom.window.close();
    }
  });
});
