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
    const noSubscriber = {
      ...event,
      preventDefault: vi.fn(), stopPropagation: vi.fn(), stopImmediatePropagation: vi.fn(),
    };
    win.dispatch('keydown', noSubscriber);
    expect(resumed).toHaveBeenCalledTimes(2);
    expect(noSubscriber.preventDefault).not.toHaveBeenCalled();
    expect(noSubscriber.stopPropagation).not.toHaveBeenCalled();
    expect(noSubscriber.stopImmediatePropagation).not.toHaveBeenCalled();
    x.instance.onShutdown(false);
  });

  it('independently releases subscriptions and native hooks across repeated owners', () => {
    const { win, hdr } = makeWindow();
    for (let generation = 0; generation < 3; generation++) {
      const x = experiment(keyOverrideExperiment, 'keyOverride', {
        windows: [win],
        moduleOverrides: { getActualSelectedMessages: pane =>
          pane === win.document.getElementById('tabmail').currentAbout3Pane ? [hdr] : [] },
      });
      const received = vi.fn();
      x.context.extension.messageManager.convert = header => ({ id: header.messageKey });
      x.api.onTabPressed.addListener(received);
      x.api.init();
      expect(x.instance._tabSubscriptions.size).toBe(1);
      expect(x.extensionEvents.get('keyOverrideTabPressed')?.size).toBe(1);
      expect(win.handlers.get('keydown')?.size).toBe(1);
      expect(x.windowListeners.size).toBe(1);
      const event = {
        code: 'Tab', key: 'Tab', shiftKey: false,
        preventDefault: vi.fn(), stopPropagation: vi.fn(), stopImmediatePropagation: vi.fn(),
      };
      win.dispatch('keydown', event);
      expect(received).toHaveBeenCalledExactlyOnceWith({ messageIds: [1] });
      expect(event.preventDefault).toHaveBeenCalledOnce();

      x.api.onTabPressed.removeListener(received);
      expect(x.instance._tabSubscriptions.size).toBe(0);
      expect(x.extensionEvents.get('keyOverrideTabPressed')?.size).toBe(0);
      // Removing the background subscriber must not conceal a leaked hook.
      expect(win.handlers.get('keydown')?.size).toBe(1);
      x.instance.onShutdown(false);
      expect(win.handlers.get('keydown')?.size).toBe(0);
      expect(win.__keyOverrideHandler).toBeUndefined();
      expect(x.windowListeners.size).toBe(0);
    }

    const interrupted = experiment(keyOverrideExperiment, 'keyOverride', {
      windows: [win], moduleOverrides: { getActualSelectedMessages: () => [hdr] },
    });
    const stale = vi.fn();
    interrupted.api.onTabPressed.addListener(stale);
    interrupted.api.init();
    expect(interrupted.extensionEvents.get('keyOverrideTabPressed')?.size).toBe(1);
    interrupted.instance.onShutdown(false);
    expect(interrupted.instance._tabSubscriptions.size).toBe(0);
    expect(interrupted.extensionEvents.get('keyOverrideTabPressed')?.size).toBe(0);
    expect(win.handlers.get('keydown')?.size).toBe(0);
    interrupted.api.onTabPressed.removeListener(stale);
  });

  it('refuses an oversized Tab action before synchronous conversion or partial dispatch', () => {
    const { win, cw, hdr } = makeWindow();
    const headers = Array.from({ length: 101 }, (_, index) => ({
      ...hdr, messageKey: index + 1,
    }));
    const getChildHdrAt = vi.fn(index => headers[index]);
    const select = vi.fn(pane => pane.threadTree.selectedIndices.flatMap(index =>
      pane.gDBView.isContainer(index) && !pane.gDBView.isContainerOpen(index)
        ? Array.from({ length: pane.gDBView.getThreadContainingIndex(index).numChildren },
          (_, child) => pane.gDBView.getThreadContainingIndex(index).getChildHdrAt(child))
        : [headers[index]]));
    const x = experiment(keyOverrideExperiment, 'keyOverride', {
      windows: [win],
      moduleOverrides: { getActualSelectedMessages: select },
    });
    const convert = vi.fn(header => ({ id: header.messageKey }));
    x.context.extension.messageManager.convert = convert;
    const received = vi.fn();
    x.api.onTabPressed.addListener(received);
    x.api.init();
    const press = () => ({
      code: 'Tab', key: 'Tab', shiftKey: false,
      preventDefault: vi.fn(), stopPropagation: vi.fn(), stopImmediatePropagation: vi.fn(),
    });
    cw.threadTree.selectedIndices = Array.from({ length: 101 }, (_, index) => index);
    const oversizedSelection = press();
    win.dispatch('keydown', oversizedSelection);
    expect(select).not.toHaveBeenCalled();
    expect(convert).not.toHaveBeenCalled();
    expect(oversizedSelection.preventDefault).not.toHaveBeenCalled();

    cw.threadTree.selectedIndices = [0]; // A collapsed thread can expand past the selection count.
    cw.gDBView.isContainer = () => true;
    cw.gDBView.isContainerOpen = () => false;
    cw.gDBView.getThreadContainingIndex = () => ({ numChildren: headers.length, getChildHdrAt });
    const oversizedThread = press();
    win.dispatch('keydown', oversizedThread);
    expect(select).not.toHaveBeenCalled();
    expect(getChildHdrAt).not.toHaveBeenCalled();
    expect(convert).not.toHaveBeenCalled();
    expect(received).not.toHaveBeenCalled();
    expect(oversizedThread.preventDefault).not.toHaveBeenCalled();

    headers.pop();
    const atLimit = press();
    win.dispatch('keydown', atLimit);
    expect(getChildHdrAt).toHaveBeenCalledTimes(100);
    expect(convert).toHaveBeenCalledTimes(100);
    expect(received).toHaveBeenCalledExactlyOnceWith({
      messageIds: Array.from({ length: 100 }, (_, index) => index + 1),
    });
    expect(atLimit.preventDefault).toHaveBeenCalledOnce();
    x.api.onTabPressed.removeListener(received);
    x.instance.onShutdown(false);
  });

  it('does not enumerate selected messages without a subscriber', () => {
    const { win } = makeWindow();
    const select = vi.fn(() => { throw new Error('selection must stay untouched'); });
    const x = experiment(keyOverrideExperiment, 'keyOverride', {
      windows: [win], moduleOverrides: { getActualSelectedMessages: select },
    });
    x.api.init();
    const event = {
      code: 'Tab', key: 'Tab', shiftKey: false,
      preventDefault: vi.fn(), stopPropagation: vi.fn(), stopImmediatePropagation: vi.fn(),
    };
    win.dispatch('keydown', event);
    expect(select).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
    x.instance.onShutdown(false);
  });

  it('bounds Thunderbird’s suppressed-selection path before native enumeration', () => {
    const { win, cw } = makeWindow();
    cw.threadTree.selectedIndices = [0];
    cw.threadTree._selection = {
      _selectEventsSuppressed: true,
      _invalidIndices: Array.from({ length: 102 }, (_, index) => index + 1),
    };
    const select = vi.fn(() => []);
    const x = experiment(keyOverrideExperiment, 'keyOverride', {
      windows: [win], moduleOverrides: { getActualSelectedMessages: select },
    });
    const received = vi.fn();
    x.api.onTabPressed.addListener(received);
    x.api.init();
    const event = {
      code: 'Tab', key: 'Tab', shiftKey: false,
      preventDefault: vi.fn(), stopPropagation: vi.fn(), stopImmediatePropagation: vi.fn(),
    };
    win.dispatch('keydown', event);
    expect(select).not.toHaveBeenCalled();
    expect(received).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
    x.instance.onShutdown(false);
  });

  it('contains an asynchronous primed-listener failure and accepts the next press', async () => {
    const { win, hdr } = makeWindow();
    const x = experiment(keyOverrideExperiment, 'keyOverride', {
      windows: [win], moduleOverrides: { getActualSelectedMessages: () => [hdr] },
    });
    const resumed = vi.fn(async () => {});
    const registration = x.api.onTabPressed.testPersistentRegistration().prime({
      async: () => Promise.reject(new Error('synthetic wake failure')),
    });
    x.api.init();
    const press = () => ({
      code: 'Tab', key: 'Tab', shiftKey: false,
      preventDefault: vi.fn(), stopPropagation: vi.fn(), stopImmediatePropagation: vi.fn(),
    });
    const first = press(); win.dispatch('keydown', first);
    await new Promise(resolve => setImmediate(resolve));
    expect(first.preventDefault).toHaveBeenCalledOnce();
    expect(x.logs.some(args => args.some(arg => String(arg).includes('Tab subscriber failed')))).toBe(true);
    registration.convert({ async: resumed });
    const second = press(); win.dispatch('keydown', second);
    await new Promise(resolve => setImmediate(resolve));
    expect(second.preventDefault).toHaveBeenCalledOnce();
    expect(resumed).toHaveBeenCalledExactlyOnceWith({ messageIds: [1] });
    registration.unregister();
    x.instance.onShutdown(false);
  });
});
