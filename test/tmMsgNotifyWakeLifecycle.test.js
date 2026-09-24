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
    startupData: { persistentListeners: [] },
    folderManager: { convert: folder => ({ id: folder.URI, path: '/Inbox', accountId: 'synthetic' }) },
    messageManager: { convert: () => ({ id: 17 }) },
  };
  let startupOpen = true;
  const primed = [];

  class EventManager {
    constructor(options) { this.options = options; }
    api() {
      const { extensionApi, event, module } = this.options;
      const callbacks = new Map();
      return {
        addListener(callback) {
          if (callbacks.has(callback)) return;
          const fire = { async: payload => callback(payload) };
          const waiting = primed.find(entry => entry.event === event && !entry.converted);
          let registration;
          if (waiting) {
            waiting.converted = true;
            waiting.registration.convert(fire);
            for (const payload of waiting.payloads) fire.async(payload);
            registration = waiting.registration;
          } else {
            registration = extensionApi.PERSISTENT_EVENTS[event]({ fire });
          }
          callbacks.set(callback, registration);
          if (startupOpen && !waiting) {
            extension.startupData.persistentListeners.push({ module, event });
          }
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
  vm.runInContext(`let _experimentListenersActive = false;\n${indexerSource.slice(setup.start, setup.end)}\nthis.setup = setupExperimentListeners;\nthis.resetSetup = () => { _experimentListenersActive = false; };`, sandbox);

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
    const entry = { event, payloads, registration, converted: false };
    primed.push(entry);
    return entry;
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

  it('persists both event families before the first yield and owns every subscriber across wakes', async () => {
    const lifecycle = makeLifecycle();
    const first = lifecycle.newInstance();
    const initialApi = lifecycle.api(first);
    const agent = vi.fn();
    initialApi.onMessageAdded.addListener(agent);
    const initialSetup = lifecycle.sandbox.setup();
    // Gecko closes listener persistence after document load and pending
    // registrations settle; this stricter cutoff catches an added early await.
    lifecycle.closeStartup();
    expect(await initialSetup, JSON.stringify(lifecycle.logs)).toBe(true);
    expect(lifecycle.extension.startupData.persistentListeners.map(entry => entry.event).sort()).toEqual([
      'onMessageAdded', 'onMessageAdded', 'onMessageRemoved',
    ]);
    initialApi.onMessageAdded.close();
    initialApi.onMessageRemoved.close();
    expect(lifecycle.nativeListeners.size).toBe(0);

    // Gecko primes each saved listener independently before getAPI runs.
    const cold = lifecycle.newInstance();
    lifecycle.prime('onMessageAdded', cold);
    lifecycle.prime('onMessageAdded', cold);
    lifecycle.prime('onMessageRemoved', cold);
    expect(lifecycle.nativeListeners.size).toBe(1);
    expect(cold._onAddedFires.size).toBe(2);
    expect(cold._onRemovedFires.size).toBe(1);
    const coldNative = [...lifecycle.nativeListeners][0];
    coldNative.msgAdded(header);
    coldNative.msgsDeleted([header]);
    expect(lifecycle.wakeups).toEqual([
      'onMessageAdded', 'onMessageAdded', 'onMessageRemoved',
    ]);
    expect(lifecycle.pending).toEqual(lifecycle.wakeups);

    const resumed = lifecycle.api(cold);
    const resumedAgent = vi.fn();
    resumed.onMessageAdded.addListener(resumedAgent);
    lifecycle.sandbox.resetSetup();
    expect(await lifecycle.sandbox.setup()).toBe(true);
    expect(resumedAgent).toHaveBeenCalledTimes(1);
    expect(lifecycle.added).toHaveBeenCalledTimes(1);
    expect(lifecycle.removed).toHaveBeenCalledTimes(1);
    expect(lifecycle.removed.mock.calls[0][0].headerMessageId).toBe(header.messageId);

    coldNative.msgAdded(header);
    coldNative.msgsDeleted([header]);
    expect(resumedAgent).toHaveBeenCalledTimes(2);
    expect(lifecycle.added).toHaveBeenCalledTimes(2);
    expect(lifecycle.removed).toHaveBeenCalledTimes(2);
    resumed.onMessageAdded.close();
    resumed.onMessageRemoved.close();
    expect(lifecycle.nativeListeners.size).toBe(0);
    expect(cold._onAddedFires.size).toBe(0);
    expect(cold._onRemovedFires.size).toBe(0);

    // A later suspension primes all three again; clearing primed ownership
    // must remove the shared native listener without leaving a retained fire.
    const next = lifecycle.newInstance();
    const nextRegistrations = [
      lifecycle.prime('onMessageAdded', next),
      lifecycle.prime('onMessageAdded', next),
      lifecycle.prime('onMessageRemoved', next),
    ];
    expect(lifecycle.nativeListeners.size).toBe(1);
    for (const entry of nextRegistrations) entry.registration.unregister();
    expect(lifecycle.nativeListeners.size).toBe(0);
    expect(next._onAddedFires.size).toBe(0);
    expect(next._onRemovedFires.size).toBe(0);

    cold.onShutdown(false);
    coldNative.msgsDeleted([header]);
    expect(lifecycle.removed).toHaveBeenCalledTimes(2);
  });
});
