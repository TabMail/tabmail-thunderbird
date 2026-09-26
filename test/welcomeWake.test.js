import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
import { expect, it } from 'vitest';

const source = readFileSync(new URL('../agent/background.js', import.meta.url), 'utf8');
const declaration = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }).body
  .find(node => node.type === 'FunctionDeclaration' && node.id.name === 'checkAndShowWelcomeWizard');
const functionSource = source.slice(declaration.start, declaration.end);
const url = 'moz-extension://synthetic/welcome/welcome.html';

function registry({ existing = true, completed = false } = {}) {
  // A wake always has the main 3-pane window; the chat popup is another extension page.
  const windows = [
    { id: 1, type: 'normal', tabs: [{ id: 5, url: 'about:3pane' }] },
    { id: 2, type: 'popup', tabs: [{ id: 6, url: 'moz-extension://synthetic/chat/chat.html' }] },
  ];
  if (existing) windows.push({ id: 3, type: 'popup', tabs: [{ id: 10, url }] });
  const created = [], updates = [], messages = [];
  async function wake() {
    const timers = [];
    const context = vm.createContext({
      _welcomeWizardCheckInProgress: false, SETTINGS: {}, log() {},
      hasEmailAccounts: async () => true, cleanupAccountCreatedListener() {},
      setTimeout: fn => timers.push(fn),
      browser: {
        storage: { local: { get: async () => ({ tabmailWelcomeCompleted: completed }) } },
        runtime: { getURL: () => url },
        windows: {
          getAll: async (options = {}) => windows
            .filter(window => !options.windowTypes || options.windowTypes.includes(window.type))
            .map(window => options.populate ? window : { id: window.id, type: window.type }),
          update: async (id, info) => updates.push([id, info]),
          create: async options => {
            created.push(options);
            windows.push({ id: windows.length + 1, type: options.type, tabs: options.type === 'popup' ? [{ id: 20, url: options.url }] : [{ id: 20, url: 'about:3pane' }] });
          },
        },
        tabs: { sendMessage: async (...args) => messages.push(args) },
      },
    });
    vm.runInContext(functionSource, context);
    await context.checkAndShowWelcomeWizard();
    for (const timer of timers) await timer();
  }
  return { wake, windows, created, updates, messages };
}

it('reuses the retained wizard, not another window, across fresh generations', async () => {
  const h = registry();
  await h.wake();
  await h.wake();
  expect(h.created).toEqual([]);
  expect(h.windows).toHaveLength(3);
  expect(h.updates).toEqual([[3, { focused: true }], [3, { focused: true }]]);
  expect(h.messages).toEqual([]);
});

it('creates the wizard when only non-wizard windows exist, then reuses it', async () => {
  const h = registry({ existing: false });
  await h.wake();
  expect(h.created).toHaveLength(1);
  expect(h.windows.at(-1)).toMatchObject({ type: 'popup', tabs: [{ url }] });
  expect(h.updates).toEqual([]);
  expect(h.messages).toEqual([]);
  await h.wake();
  expect(h.created).toHaveLength(1);
  expect(h.updates).toEqual([[3, { focused: true }]]);
  expect(h.messages).toEqual([]);
});

it('does not open or focus a wizard after onboarding is complete', async () => {
  const h = registry({ completed: true });
  await h.wake();
  expect(h.created).toEqual([]);
  expect(h.updates).toEqual([]);
  expect(h.messages).toEqual([]);
});
