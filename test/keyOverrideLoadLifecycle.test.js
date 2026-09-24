import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'acorn';
import { experiment, makeWindow } from './helpers/nativeLifecycleHarness.js';

const keyOverrideExperiment = 'theme/experiments/keyOverride/keyOverride.sys.mjs';

describe('keyOverride parent experiment lifecycle', () => {
  it('keeps its top-level names distinct from the other manifest parent scripts', () => {
    const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
    const names = new Map();
    const bindings = (pattern, result) => {
      if (pattern.type === 'Identifier') result.push(pattern.name);
      else if (pattern.type === 'ObjectPattern') {
        for (const property of pattern.properties) bindings(property.value, result);
      } else if (pattern.type === 'ArrayPattern') {
        for (const element of pattern.elements) if (element) bindings(element, result);
      }
    };
    for (const [apiName, api] of Object.entries(manifest.experiment_apis)) {
      const path = api.parent?.script;
      if (!path) continue;
      const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
      const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
      const declared = [];
      const loadable = [];
      for (const node of ast.body) {
        if (node.type === 'VariableDeclaration') {
          for (const declarator of node.declarations) {
            bindings(declarator.id, declared);
            if (node.kind === 'var') bindings(declarator.id, loadable);
          }
        } else if (node.type === 'ClassDeclaration' || node.type === 'FunctionDeclaration') {
          if (node.id) declared.push(node.id.name);
          if (node.type === 'FunctionDeclaration' && node.id) loadable.push(node.id.name);
        }
      }
      // Gecko retrieves the API constructor from the classic-script global.
      // Lexical const/let/class bindings load but do not become properties there.
      expect(loadable).toContain(apiName);
      names.set(apiName, declared);
    }
    expect(names.size).toBe(Object.keys(manifest.experiment_apis).length);
    const own = names.get('keyOverride');
    expect(own).toEqual(expect.arrayContaining([
      'ExtensionSupportKO', 'ExtensionCommonKO', 'EventManagerKO', 'ServicesKO', 'keyOverride',
    ]));
    const others = new Set([...names.entries()]
      .filter(([name]) => name !== 'keyOverride')
      .flatMap(([, declared]) => declared));
    expect(own.filter(name => others.has(name))).toEqual([]);
    // These older collisions are tracked separately; this test rejects any
    // new parent-script collision without blocking removal of an old one.
    const knownOwners = new Map([
      ['tlog', new Set(['tagSort', 'threadMessages'])],
      ['forEach3Pane', new Set(['tmPrefs', 'tmTweaks', 'threadPaneDisplayToggle', 'tmUpdates'])],
      ['_isActionInbox', new Set(['tmMessageHeaderChip', 'tmMultiMessageChip'])],
    ]);
    const ownersByName = new Map();
    for (const [apiName, declared] of names) {
      for (const name of declared) {
        if (!ownersByName.has(name)) ownersByName.set(name, new Set());
        ownersByName.get(name).add(apiName);
      }
    }
    const unexpected = [...ownersByName].filter(([name, owners]) =>
      owners.size > 1 && (!knownOwners.has(name)
        || [...owners].some(owner => !knownOwners.get(name).has(owner))));
    expect(unexpected).toEqual([]);
  });

  it('captures Tab once and removes its native hook on shutdown', () => {
    const { win, hdr } = makeWindow();
    let selected = [hdr];
    const x = experiment(keyOverrideExperiment, 'keyOverride', {
      windows: [win], moduleOverrides: { getActualSelectedMessages: () => selected },
    });
    const received = vi.fn();
    x.api.onTabPressed.addListener(received);
    const persisted = x.api.onTabPressed.testPersistentRegistration();
    expect(persisted?.module).toBe('keyOverride');
    expect(persisted?.event).toBe('onTabPressed');
    x.api.init();
    const event = {
      code: 'Tab', key: 'Tab', shiftKey: false,
      preventDefault: vi.fn(), stopPropagation: vi.fn(), stopImmediatePropagation: vi.fn(),
    };
    win.dispatch('keydown', event);
    expect(received).toHaveBeenCalledTimes(1);
    expect(received).toHaveBeenCalledWith({ messageIds: [1] });
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
    expect(event.stopImmediatePropagation).toHaveBeenCalledTimes(1);
    selected = [];
    const empty = { ...event, preventDefault: vi.fn() };
    win.dispatch('keydown', empty);
    expect(empty.preventDefault).not.toHaveBeenCalled();
    selected = [hdr];
    const reverse = {
      ...event, shiftKey: true,
      preventDefault: vi.fn(), stopPropagation: vi.fn(), stopImmediatePropagation: vi.fn(),
    };
    win.dispatch('keydown', reverse);
    expect(received).toHaveBeenCalledTimes(1);
    expect(reverse.preventDefault).not.toHaveBeenCalled();
    expect(reverse.stopPropagation).not.toHaveBeenCalled();
    expect(reverse.stopImmediatePropagation).not.toHaveBeenCalled();
    for (const modifier of ['ctrlKey', 'altKey', 'metaKey']) {
      const chord = {
        ...event, [modifier]: true,
        preventDefault: vi.fn(), stopPropagation: vi.fn(), stopImmediatePropagation: vi.fn(),
      };
      win.dispatch('keydown', chord);
      expect(received).toHaveBeenCalledTimes(1);
      expect(chord.preventDefault).not.toHaveBeenCalled();
      expect(chord.stopPropagation).not.toHaveBeenCalled();
      expect(chord.stopImmediatePropagation).not.toHaveBeenCalled();
    }
    const openedWhileEnabled = makeWindow().win;
    x.openWindow(openedWhileEnabled);
    const laterTab = {
      ...event,
      preventDefault: vi.fn(), stopPropagation: vi.fn(), stopImmediatePropagation: vi.fn(),
    };
    openedWhileEnabled.dispatch('keydown', laterTab);
    expect(received).toHaveBeenCalledTimes(2);
    expect(laterTab.preventDefault).toHaveBeenCalledTimes(1);
    expect(laterTab.stopPropagation).toHaveBeenCalledTimes(1);
    expect(laterTab.stopImmediatePropagation).toHaveBeenCalledTimes(1);
    x.instance.onShutdown(false);
    win.dispatch('keydown', event);
    openedWhileEnabled.dispatch('keydown', laterTab);
    expect(received).toHaveBeenCalledTimes(2);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    x.api.onTabPressed.removeListener(received);
    expect(x.instance._tabSubscriptions.size).toBe(0);
    const later = makeWindow().win;
    x.openWindow(later);
    expect(later.__keyOverrideHandler).toBeUndefined();

    const reopened = experiment(keyOverrideExperiment, 'keyOverride', {
      windows: [win], moduleOverrides: { getActualSelectedMessages: () => [hdr] },
    });
    const again = vi.fn();
    reopened.api.onTabPressed.addListener(again);
    reopened.api.init();
    win.dispatch('keydown', {
      ...event, preventDefault: vi.fn(), stopPropagation: vi.fn(), stopImmediatePropagation: vi.fn(),
    });
    expect(again).toHaveBeenCalledTimes(1);
    reopened.instance.onShutdown(false);
    reopened.api.onTabPressed.removeListener(again);
  });

  it('queues the press-time target through a primed listener and converts once', async () => {
    const { win, hdr } = makeWindow();
    let selected = [hdr];
    const x = experiment(keyOverrideExperiment, 'keyOverride', {
      windows: [win], moduleOverrides: { getActualSelectedMessages: () => selected },
    });
    x.context.extension.messageManager.convert = message => ({ id: message.messageKey });
    x.api.init();
    const queued = [];
    const registration = x.api.onTabPressed.testPersistentRegistration().prime({
      wakeup: vi.fn(async () => {}),
      async: info => new Promise(resolve => queued.push({ info, resolve })),
    });
    const event = {
      code: 'Tab', key: 'Tab', shiftKey: false,
      preventDefault: vi.fn(), stopPropagation: vi.fn(), stopImmediatePropagation: vi.fn(),
    };
    win.dispatch('keydown', event);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(queued).toHaveLength(1);
    expect(queued[0].info).toEqual({ messageIds: [1] });
    selected = [{ ...hdr, messageKey: 2 }];
    const resumed = vi.fn(async () => {});
    registration.convert({ async: resumed });
    for (const item of queued) item.resolve(await resumed(item.info));
    expect(resumed).toHaveBeenCalledExactlyOnceWith({ messageIds: [1] });
    win.dispatch('keydown', { ...event, preventDefault: vi.fn() });
    expect(resumed).toHaveBeenNthCalledWith(2, { messageIds: [2] });
    registration.unregister();
    win.dispatch('keydown', { ...event, preventDefault: vi.fn() });
    expect(resumed).toHaveBeenCalledTimes(2);
    x.instance.onShutdown(false);
  });
});
