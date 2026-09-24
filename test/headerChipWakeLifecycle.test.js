import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { parse } from 'acorn';
import vm from 'node:vm';
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
    ['Space', event => new event.view.KeyboardEvent('keydown', { key: ' ', bubbles: true })],
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

  it.each([
    ['mouse', 'click'], ['Enter', 'Enter'], ['Space', ' '],
  ])('replays the first %s action on its original message during startup', async (_name, key) => {
    const { dom, w } = renderedHeaderChip();
    const x = experiment(headerExperiment, 'tmMessageHeaderChip', { windows: [w.win] });
    try {
      await x.api.init();
      const chip = dom.window.document.querySelector('.tm-header-action-chip');
      const queued = [];
      const registration = x.api.onActionChipClick.testPersistentRegistration().prime({
        async: info => new Promise(resolve => queued.push({ info, resolve })),
      });
      chip.dispatchEvent(key === 'click'
        ? new dom.window.MouseEvent('click', { bubbles: true })
        : new dom.window.KeyboardEvent('keydown', { key, bubbles: true }));
      expect(queued).toHaveLength(1);
      expect(queued[0].info).toEqual({
        source: key === 'click' ? 'click' : 'keydown', weMsgId: 1,
      });

      // The displayed message changes while the first native event is queued.
      dom.window.gMessage = { ...dom.window.gMessage, messageKey: 2 };
      chip.dataset.tmWeMsgId = '2';
      const messages = new Map([1, 2].map(id => [id, {
        id, action: 'delete', read: false, folder: { id: 'inbox' },
        headerMessageId: `synthetic-${id}@example.test`,
      }]));
      const get = vi.fn(async id => messages.get(id) ?? null);
      const update = vi.fn(async (id, fields) => {
        messages.set(id, { ...messages.get(id), ...fields });
      });
      const move = vi.fn(async (ids, folder) => {
        for (const id of ids) messages.set(id, { ...messages.get(id), folder: { id: folder } });
      });
      const actionSource = readFileSync(new URL('../agent/modules/action.js', import.meta.url), 'utf8');
      const actionAst = parse(actionSource, { ecmaVersion: 'latest', sourceType: 'module' });
      const actionNode = actionAst.body.find(node => node.type === 'ExportNamedDeclaration'
        && node.declaration?.id?.name === 'performTaggedAction').declaration;
      const globals = {
        console: { log() {}, warn() {}, error() {} }, Date, URL, performance,
        setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
        ACTIONS: { DELETE: 'delete', ARCHIVE: 'archive', REPLY: 'reply' },
        getActionForWeId: async message => message.action,
        getTrashFolderForHeader: async () => ({ id: 'trash', path: '/Trash' }),
        log() {},
      };
      vm.runInNewContext(`${actionSource.slice(actionNode.start, actionNode.end)}\nthis.performTaggedAction = performTaggedAction`, globals);
      const performTaggedAction = vi.fn(globals.performTaggedAction);
      globals.performTaggedAction = performTaggedAction;

      const listeners = new Set();
      let listenersAtFirstAwait;
      let releaseValidation;
      const validation = new Promise(resolve => { releaseValidation = resolve; });
      const event = { addListener: callback => listeners.add(callback),
        removeListener: callback => listeners.delete(callback) };
      const noOpEvent = { addListener() {}, removeListener() {} };
      const generic = new Proxy(() => Promise.resolve({}), {
        get: (_target, name) => name === 'then' ? undefined
          : String(name).startsWith('on') ? noOpEvent : generic,
      });
      globals.browser = new Proxy(generic, {
        get: (_target, name) => name === 'tmMessageHeaderChip'
          ? { onActionChipClick: event }
          : name === 'messages' ? { get, update, move } : generic[name],
      });
      let script = readFileSync(new URL('../theme/background.js', import.meta.url), 'utf8');
      const ast = parse(script, { ecmaVersion: 'latest', sourceType: 'module' });
      for (const entry of ast.body.filter(node => node.type === 'ImportDeclaration').reverse()) {
        for (const specifier of entry.specifiers) {
          const name = specifier.local.name;
          globals[name] = name === 'SETTINGS' ? {}
            : name === 'validateThunderbirdThemeIds' ? () => {
              listenersAtFirstAwait = listeners.size;
              return validation;
            } : name === 'performTaggedAction' ? performTaggedAction
              : () => Promise.resolve({});
        }
        script = script.slice(0, entry.start)
          + script.slice(entry.start, entry.end).replace(/[^\r\n]/g, ' ')
          + script.slice(entry.end);
      }
      vm.runInNewContext(script, globals, { filename: 'theme/background.js' });
      expect(listenersAtFirstAwait).toBe(1);
      expect(listeners.size).toBe(1);
      const resumed = vi.fn(info => Promise.all([...listeners].map(listener => listener(info))));
      registration.convert({ async: resumed });
      await resumed(queued[0].info);
      queued[0].resolve();
      await vi.waitFor(() => expect(move).toHaveBeenCalledTimes(1));
      expect(resumed).toHaveBeenCalledTimes(1);
      expect(get).toHaveBeenNthCalledWith(1, 1);
      expect(get).toHaveBeenNthCalledWith(2, 1);
      expect(update).toHaveBeenCalledExactlyOnceWith(1, { read: true });
      expect(move).toHaveBeenCalledExactlyOnceWith([1], 'trash', { isUserAction: true });
      expect(performTaggedAction).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 1 }));
      expect(messages.get(1)).toMatchObject({ read: true, folder: { id: 'trash' } });
      expect(messages.get(2)).toMatchObject({ read: false, folder: { id: 'inbox' } });
      releaseValidation();
      registration.unregister();
    } finally {
      x.instance.onShutdown(false);
      dom.window.close();
    }
  });

  it.each(['synchronous', 'asynchronous'])('recovers after %s primed delivery failure', async failure => {
    const x = experiment(headerExperiment, 'tmMessageHeaderChip');
    try {
      const registration = x.instance.primeListener('onActionChipClick', {
        async: () => {
          if (failure === 'synchronous') throw new Error('synthetic delivery failure');
          return Promise.reject(new Error('synthetic delivery failure'));
        },
      });
      x.context.extension.emit('tmMessageHeaderChipActionClick', { source: 'click', weMsgId: 1 });
      await vi.waitFor(() => expect(x.logs.some(row => row.some(value =>
        String(value).includes('subscriber failed')))).toBe(true));
      const resumed = vi.fn();
      registration.convert({ async: resumed });
      x.context.extension.emit('tmMessageHeaderChipActionClick', { source: 'click', weMsgId: 1 });
      expect(resumed).toHaveBeenCalledExactlyOnceWith({ source: 'click', weMsgId: 1 });
      registration.unregister();
      expect(x.instance._chipClickSubscriptions.size).toBe(0);
    } finally {
      x.instance.onShutdown(false);
    }
  });

  it('cancels an undelivered activation and accepts the next one', () => {
    const x = experiment(headerExperiment, 'tmMessageHeaderChip');
    try {
      const abandoned = vi.fn();
      const first = x.instance.primeListener('onActionChipClick', { async: abandoned });
      first.unregister();
      const next = vi.fn();
      const second = x.instance.primeListener('onActionChipClick', { async: next });
      x.context.extension.emit('tmMessageHeaderChipActionClick', { source: 'click', weMsgId: 2 });
      expect(abandoned).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledExactlyOnceWith({ source: 'click', weMsgId: 2 });
      second.unregister();
      expect(x.instance._chipClickSubscriptions.size).toBe(0);
    } finally {
      x.instance.onShutdown(false);
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
