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
  const windows = existing ? [{ id: 1, tabs: [{ id: 10, url }] }] : [];
  const created = [], focused = [], messages = [];
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
          // The real API omits tabs unless population is requested.
          getAll: async options => windows.map(window => options?.populate ? window : { id: window.id }),
          update: async id => focused.push(id),
          create: async options => {
            created.push(options);
            windows.push({ id: windows.length + 1, tabs: [{ id: 20, url: options.url }] });
          },
        },
        tabs: { sendMessage: async (...args) => messages.push(args) },
      },
    });
    vm.runInContext(functionSource, context);
    await context.checkAndShowWelcomeWizard();
    for (const timer of timers) await timer();
  }
  return { wake, windows, created, focused, messages };
}

it('reuses a retained wizard across fresh background generations', async () => {
  const h = registry();
  await h.wake();
  await h.wake();
  expect(h.created).toEqual([]);
  expect(h.windows).toHaveLength(1);
  expect(h.focused).toEqual([1, 1]);
  expect(h.messages).toEqual([
    [10, { command: 'welcome-reset-to-initial' }],
    [10, { command: 'welcome-reset-to-initial' }],
  ]);
});

it('creates the missing wizard once and finds it on the next wake', async () => {
  const h = registry({ existing: false });
  await h.wake();
  await h.wake();
  expect(h.created).toHaveLength(1);
  expect(h.created[0]).toMatchObject({ url, type: 'popup' });
  expect(h.windows).toHaveLength(1);
  expect(h.focused).toEqual([1]);
});

it('does not open or focus a wizard after onboarding is complete', async () => {
  const h = registry({ completed: true });
  await h.wake();
  expect(h.created).toEqual([]);
  expect(h.focused).toEqual([]);
  expect(h.messages).toEqual([]);
});
