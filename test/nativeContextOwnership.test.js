import { expect, it } from 'vitest';
import { experiment, makeWindow } from './helpers/nativeLifecycleHarness.js';

const experiments = [
  ['tagSort', '_cleanups', 'theme'],
  ['staleRowFilter', '_cleanups_SRF', 'theme'],
  ['tmMessageHeaderChip', '_tmCleanups', 'theme'],
  ['tmMultiMessageChip', '_tmCleanups', 'theme'],
  ['tmMessageListCardView', '_tmCleanups', 'theme'],
  ['tmMessageListTableView', '_tmCleanups_MLTV', 'theme'],
  ['messageSelection', '_shutdownHandlers', 'chat'],
];

for (const [name, cleanupField, area] of experiments) {
  it(`${name} transfers native ownership across repeated background contexts`, async () => {
    const w = makeWindow();
    const x = experiment(`${area}/experiments/${name}/${name}.sys.mjs`, name, { windows: [w.win] });
    await x.api.init();
    for (let i = 0; i < 100; i++) {
      const next = x.instance.getAPI({ extension: x.context.extension })[name];
      await next.init();
      expect(x.instance[cleanupField].size).toBe(1);
      expect(x.windowListeners.size).toBe(1);
    }
    await x.api.shutdown();
    expect(x.windowListeners.size).toBe(1);
    if (name === 'tagSort') {
      expect(x.observers.get('tabmail-sort-order-changed')?.size).toBe(1);
      expect(x.columns.size).toBe(1);
    }
    x.instance.onShutdown(false);
    expect(x.instance[cleanupField].size).toBe(0);
    expect(x.windowListeners.size).toBe(0);
    if (name === 'tagSort') {
      expect(x.observers.get('tabmail-sort-order-changed')?.size).toBe(0);
      expect(x.columns.size).toBe(0);
    }
  });
}

for (const [name, rowName] of [
  ['tmMessageListCardView', 'thread-card'],
  ['tmMessageListTableView', 'thread-row'],
]) {
  it(`${name} renders row contents after a background context handoff`, async () => {
    const w = makeWindow();
    class Row {
      fillRow(index, _row, data) {
        this.renderedIndex = index;
        this.renderedSubject = data.subject;
      }
    }
    Row.ROW_HEIGHT = 46;
    const original = Row.prototype.fillRow;
    w.cw.customElements = { get: id => id === rowName ? Row : undefined };
    const x = experiment(`theme/experiments/${name}/${name}.sys.mjs`, name, { windows: [w.win] });
    await x.api.init();
    await x.instance.getAPI({ extension: x.context.extension })[name].init();
    expect(Row.prototype.fillRow).not.toBe(original);
    const row = new Row();
    row.ownerDocument = w.doc;
    row.fillRow(2, null, { subject: 'Synthetic subject' }, w.view);
    expect(row.renderedIndex).toBe(2);
    expect(row.renderedSubject).toBe('Synthetic subject');
    x.instance.onShutdown(false);
    expect(Row.prototype.fillRow).toBe(original);
  });
}
