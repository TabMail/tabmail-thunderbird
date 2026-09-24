import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const experimentSource = read('../agent/experiments/tmMsgNotify/tmMsgNotify.sys.mjs');
const indexerSource = read('../fts/incrementalIndexer.js');

function makeLifecycle() {
  const nativeListeners = new Set();
  const pending = [];
  const wakeups = [];
  const logs = [];
  const added = vi.fn();
  const removed = vi.fn();
  const extension = {
    startupData: { persistentListeners: {} },
    folderManager: { convert: folder => ({ id: folder.URI, path: '/Inbox', accountId: 'synthetic' }) },
    messageManager: { convert: () => ({ id: 17 }) },
  };
  let startupOpen = true;
  let primed = null;

  class EventManager {
    constructor(options) { this.options = options; }
    api() {
      const { extensionApi, event, module } = this.options;
      const callbacks = new Map();
      return {
        addListener(callback) {
          const fire = { async: payload => callback(payload) };
          if (primed?.event === event) {
            primed.registration.convert(fire);
            for (const payload of primed.payloads) fire.async(payload);
            primed = null;
          } else {
            callbacks.set(callback, extensionApi.PERSISTENT_EVENTS[event]({ fire }));
          }
          if (startupOpen) extension.startupData.persistentListeners[event] = { module, event };
        },
        removeListener(callback) {
          callbacks.get(callback)?.unregister();
          callbacks.delete(callback);
        },
        close() {
          for (const registration of callbacks.values()) registration.unregister();
          callbacks.clear();
        },
      };
    }
  }
  const sandbox = {
    ChromeUtils: { importESModule(path) {
      if (path.includes('ExtensionCommon')) return { ExtensionCommon: {
        ExtensionAPIPersistent: class {
          constructor(value) { this.extension = value; }
          primeListener(event, fire) { return this.PERSISTENT_EVENTS[event]({ fire }); }
        },
        EventManager,
      } };
      if (path.includes('Timer')) return { clearInterval() {}, setInterval: () => 1 };
      if (path.includes('MailServices')) return { MailServices: { mfn: {
        addListener: listener => nativeListeners.add(listener),
        removeListener: listener => nativeListeners.delete(listener),
      } } };
      if (path.includes('MailUtils')) return { MailUtils: {} };
      throw new Error(path);
    } },
    console: { log() {}, error: vi.fn() },
    Ci: { nsMsgMessageFlags: { IMAPDeleted: 1, Expunged: 2 } },
    log(...args) { logs.push(args); },
    onExperimentMessageAdded: added,
    onExperimentMessageRemoved: removed,
  };
  vm.createContext(sandbox);
  vm.runInContext(`${experimentSource}\nthis.Experiment = tmMsgNotify;`, sandbox);
  const indexerAst = parse(indexerSource, { ecmaVersion: 'latest', sourceType: 'module' });
  const setup = indexerAst.body.find(node =>
    node.type === 'ExportNamedDeclaration' && node.declaration?.id?.name === 'setupExperimentListeners'
  )?.declaration;
  expect(setup).toBeTruthy();
  vm.runInContext(`let _experimentListenersActive = false;\n${indexerSource.slice(setup.start, setup.end)}\nthis.setup = setupExperimentListeners;`, sandbox);

  function api(instance) {
    const value = instance.getAPI({ extension }).tmMsgNotify;
    sandbox.browser = { tmMsgNotify: value };
    return value;
  }
  function prime(event, instance) {
    const payloads = [];
    const fire = {
      wakeup: () => { wakeups.push(event); return Promise.resolve(); },
      async: payload => {
        wakeups.push(event);
        payloads.push(payload);
        pending.push(event);
        return Promise.resolve();
      },
    };
    const registration = instance.primeListener(event, fire);
    primed = { event, payloads, registration };
  }
  return { sandbox, extension, nativeListeners, pending, wakeups, logs, added, removed, api, prime,
    closeStartup() { startupOpen = false; },
    newInstance: () => new sandbox.Experiment(extension),
  };
}

const header = {
  folder: { URI: 'mailbox://synthetic/Inbox' }, messageId: 'synthetic@example.test',
  subject: 'Synthetic', author: 'sender@example.test', messageKey: 17, flags: 0,
};

describe('tmMsgNotify persistent background lifecycle', () => {
  it('registers FTS listeners synchronously in the background entry point', () => {
    const source = read('../chat/background.js');
    const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
    expect(ast.body.some(node => node.type === 'ImportDeclaration' &&
      node.source.value === '../fts/incrementalIndexer.js' &&
      node.specifiers.some(spec => spec.imported?.name === 'setupExperimentListeners'))).toBe(true);
    const setupCall = ast.body.findIndex(node => node.type === 'ExpressionStatement' &&
      node.expression?.type === 'CallExpression' &&
      node.expression.callee?.name === 'setupExperimentListeners');
    expect(setupCall).toBeGreaterThan(-1);
    const firstAsyncStart = ast.body.findIndex(node => node.type === 'ExpressionStatement' &&
      source.slice(node.start, node.end).startsWith('browser.storage.local.get('));
    expect(firstAsyncStart).toBeGreaterThan(setupCall);
  });

  it('persists both production event families and replays a cold deletion before getAPI', async () => {
    const lifecycle = makeLifecycle();
    const first = lifecycle.newInstance();
    const initialApi = lifecycle.api(first);
    const agent = vi.fn();
    initialApi.onMessageAdded.addListener(agent);
    expect(await lifecycle.sandbox.setup(), JSON.stringify(lifecycle.logs)).toBe(true);
    expect(Object.keys(lifecycle.extension.startupData.persistentListeners).sort()).toEqual([
      'onMessageAdded', 'onMessageRemoved',
    ]);
    lifecycle.closeStartup();
    initialApi.onMessageAdded.removeListener(agent);
    initialApi.onMessageAdded.close();
    initialApi.onMessageRemoved.close();
    expect(lifecycle.nativeListeners.size).toBe(0);

    // A new parent experiment instance primes from the saved registration
    // before the background module has called getAPI().
    const cold = lifecycle.newInstance();
    lifecycle.prime('onMessageRemoved', cold);
    expect(lifecycle.nativeListeners.size).toBe(1);
    const coldNative = [...lifecycle.nativeListeners][0];
    coldNative.msgsDeleted([header]);
    expect(lifecycle.wakeups).toEqual(['onMessageRemoved']);
    expect(lifecycle.pending).toEqual(['onMessageRemoved']);

    const resumed = lifecycle.api(cold);
    resumed.onMessageRemoved.addListener(lifecycle.removed);
    expect(lifecycle.removed).toHaveBeenCalledTimes(1);
    expect(lifecycle.removed.mock.calls[0][0].headerMessageId).toBe(header.messageId);
    cold.onShutdown(false);
    expect(lifecycle.nativeListeners.size).toBe(0);
    coldNative.msgsDeleted([header]);
    expect(lifecycle.removed).toHaveBeenCalledTimes(1);
  });
});
