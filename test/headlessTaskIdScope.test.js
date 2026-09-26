import { readFileSync } from 'node:fs';
import { resolve, posix } from 'node:path';
import vm from 'node:vm';
import { parse } from 'acorn';
import { it, expect } from 'vitest';

const root = resolve(import.meta.dirname, '..');
function declaration(file, name) {
  const source = readFileSync(resolve(root, file), 'utf8');
  const node = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }).body
    .map(n => n.declaration || n).find(n => n.type === 'FunctionDeclaration' && n.id.name === name);
  return source.slice(node.start, node.end);
}

it('keeps a fresh background task separate from saved chat IDs and resolves its result links', async () => {
  const original = { entries: [[7, 'synthetic-existing-message']], nextNumericId: 8, freeIds: [], refCounts: [[7, 1]] };
  const stored = { chat_id_map: structuredClone(original) }, writes = [], timers = [], executed = [];
  const context = vm.createContext({
    console, Date, Map, Set, JSON,
    setTimeout(fn) { timers.push(fn); return timers.length; }, clearTimeout() {},
    log(message) { if (message.includes('failed')) console.log(message); }, TASK_EVAL_SYSTEM_PROMPT: 'synthetic-task-prompt',
    browser: { messages: { get: async () => ({ subject: 'Synthetic task result', author: 'Synthetic sender', recipients: [] }) }, storage: { local: {
      get: async key => ({ [key]: stored[key] }),
      set: async fields => { Object.assign(stored, structuredClone(fields)); writes.push(structuredClone(fields)); },
    } } },
  });
  const modules = new Map();
  const stubs = {
    'agent/modules/utils.js': 'export function log() {}; export const normalizeUnicode = s => s; export async function resolveUniqueMessageKey(id){return id === "synthetic-task-message" ? {weID:42} : null}',
    'chat/modules/entityResolver.js': 'export async function resolveContactDetails(){}; export async function resolveEventDetails(){}',
    'chat/modules/helpers.js': 'export function getGenericTimezoneAbbr(){return "UTC"}',
    'agent/modules/idbStorage.js': 'export async function get(){}; export async function set(){}; export async function remove(){}; export async function getAllKeys(){return []}',
    'agent/modules/taskScheduler.js': 'export async function getExecutionState(){return {}}; export async function consumeMissed(){}',
    'agent/modules/promptGenerator.js': 'export async function getUserKBPrompt(){return ""}',
    'agent/modules/reminderBuilder.js': 'export async function buildReminderList(){return {reminders:[]}}; export function formatRemindersForSystem(){return "[]"}',
    'agent/modules/llm.js': 'export const sendChat = globalThis.sendChat',
  };
  function load(file) {
    if (modules.has(file) && (file !== 'agent/modules/utils.js' || modules.get(file).status === 'evaluated')) return modules.get(file);
    let code = stubs[file];
    if (file === 'chat/tools/core.js') code = 'export ' + declaration(file, 'executeToolsHeadless');
    code ??= readFileSync(resolve(root, file), 'utf8');
    const mod = new vm.SourceTextModule(code, { context, identifier: file, importModuleDynamically: dynamic });
    modules.set(file, mod);
    return mod;
  }
  const linked = new Map();
  async function ready(file) {
    const mod = load(file);
    if (!linked.has(file)) linked.set(file, (async () => {
      if (mod.status === 'unlinked') await mod.link((s, ref) => load(posix.normalize(posix.join(posix.dirname(ref.identifier), s))));
      if (mod.status === 'linked') await mod.evaluate();
    })());
    await linked.get(file);
    return mod;
  }
  async function dynamic(specifier, ref) {
    return ready(posix.normalize(posix.join(posix.dirname(ref.identifier || "agent/modules/proactiveCheckin.js"), specifier)));
  }
  context.isFsmTool = () => false;
  context.executeToolByName = async (name, args) => {
    executed.push([name, args]);
    return name === 'email_search' ? { unique_id: 'synthetic-task-message' } : { ok: true };
  };
  let turn = 0;
  context.sendChat = async messages => {
    if (turn++ === 0) return { tool_calls: [{ id: 'search', function: { name: 'email_search', arguments: '{}' } }] };
    if (turn === 2) {
      expect(JSON.parse(messages.at(-1).content).unique_id).toBe(1);
      return { tool_calls: [{ id: 'read', function: { name: 'email_read', arguments: '{"unique_id":1}' } }] };
    }
    return { assistant: 'See [Email](1).' };
  };
  await ready('chat/modules/idTranslator.js');
  const code = declaration('agent/modules/proactiveCheckin.js', '_executeTask');
  new vm.Script(code + '\nthis.executeTask = _executeTask;', {
    filename: 'agent/modules/proactiveCheckin.js', importModuleDynamically: dynamic,
  }).runInContext(context);
  const result = await context.executeTask({ instruction: 'Synthetic task' }, 'synthetic-task');
  for (const timer of timers) await timer();
  expect(executed[1]).toEqual(['email_read', { unique_id: 'synthetic-task-message' }]);
  expect.soft(result.content).toBe('See [Email](synthetic-task-message).');
  expect.soft(stored.chat_id_map).toEqual(original);
  expect.soft(writes.filter(w => 'chat_id_map' in w)).toEqual([]);
  // Rendering after task context loss must use durable real IDs, not its numeric map.
  modules.get('chat/modules/context.js').namespace.ctx.idTranslation.idMap.clear();
  const renderer = await ready('chat/modules/markdown.js');
  const html = await renderer.namespace.renderMarkdown(result.content);
  expect(html).toContain('data-tm-id="synthetic-task-message"');
  expect(html).toContain('Synthetic task result');
});
