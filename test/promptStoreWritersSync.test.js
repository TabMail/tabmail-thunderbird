/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// promptStoreWritersSync.test.js — every Thunderbird writer of the knowledge base and the action rules
// (the chat tools, the refines, the action-rule updates), run on simulated devices (bulletDevices.js)
// next to a bullet another device wrote with typographic punctuation. A writer that does not touch that
// bullet commits it with the text and label it read (DS-TEXT, DS-CAPTURE): its text stays the same on
// every device, and its deletion on the other device still holds.

import { readFileSync } from 'node:fs';
import { parse as parseModule } from 'acorn';
import { describe, expect, it } from 'vitest';
import { BulletDevice, BulletRelay, DeviceStore, PROMPT_KEYS } from './support/bulletDevices.js';

const ROOT = new URL('../', import.meta.url);

/** The add-on's own normalizeUnicode, taken from utils.js (whose imports a realm cannot load). */
function addOnNormalizeUnicode() {
  const source = readFileSync(new URL('agent/modules/utils.js', ROOT), 'utf8');
  const node = parseModule(source, { ecmaVersion: 'latest', sourceType: 'module' }).body
    .find((item) => item.type === 'ExportNamedDeclaration' && item.declaration?.id?.name === 'normalizeUnicode');
  return new Function(`${source.slice(node.declaration.start, node.declaration.end)}\nreturn normalizeUnicode;`)();
}

const normalizeUnicode = addOnNormalizeUnicode();

/** A bullet as another device's user typed it: curly quotes, which normalizeUnicode maps to ASCII. */
const TYPED = 'Don’t email “Bob” on weekends.';

const WRITER_FILES = [
  'agent/modules/patchApplier.js',
  'agent/modules/knowledgebase.js',
  'agent/modules/autoUpdateUserPrompt.js',
  'chat/tools/kb_add.js',
  'chat/tools/kb_del.js',
  'chat/tools/reminder_add.js',
  'chat/tools/reminder_del.js',
  'chat/tools/task_add.js',
  'chat/tools/task_del.js',
  'chat/tools/task_edit.js',
];

const RULE_PATCH = 'ADD\narchive\nNewsletters from example.com.';
/** What the backend's action-rule update returns; a test may set another. */
let rulePatch = RULE_PATCH;

/** The backend: a refine returns the text it was sent plus one fact; an action-rule update adds one rule. */
async function backend([request]) {
  if (request.content === 'system_prompt_kb_refine') return { refined_kb: `${request.current_user_kb_md}\n- Refined fact.` };
  return { assistant: JSON.stringify({ patch: rulePatch }) };
}

function writerStubs() {
  const log = () => {};
  return {
    'agent/modules/utils.js': {
      log,
      normalizeUnicode,
      saveChatLog: () => {},
      getUniqueMessageKey: async () => 'synthetic-key',
      getRealSubject: async () => 'Synthetic subject',
    },
    'agent/modules/llm.js': { sendChat: backend, processJSONResponse: (text) => JSON.parse(text) },
    'agent/modules/actionCompactConfig.js': {
      resolveActionConfig: (value) => value,
      readActionConfig: async () => ({ compact_threshold: 100, compact_threshold_chars: 100000 }),
    },
    'agent/modules/actionCache.js': { origKey: (key) => `action:orig:${key}`, userPromptKey: (key) => `action:userprompt:${key}` },
    'agent/modules/senderFilter.js': { isInternalSender: async () => false },
    'agent/modules/idbStorage.js': {
      get: async (key) => (key.startsWith('summary:') ? { [key]: { subject: 'Synthetic', blurb: 'Synthetic blurb', todos: '' } } : {}),
    },
    'chat/modules/helpers.js': { formatTimestampForAgent: () => 'now', renderToPlainText: async (text) => text },
    'agent/modules/chatHistoryQueue.js': {
      addChatToQueue: async () => 'session-1',
      getUnrememberedSessions: async () => [{ id: 'session-1', timestamp: Date.now(), messages: [{ role: 'user', content: 'Synthetic question' }] }],
      markSessionsAsRemembered: async () => {},
    },
    'chat/modules/persistentChatStore.js': {
      loadTurns: async () => [1, 2, 3].flatMap((i) => [{ _id: `u${i}`, role: 'user', content: `Question ${i}` }, { _id: `a${i}`, role: 'assistant', content: `Answer ${i}` }]),
      loadMeta: async () => ({}),
      getTurnsAfterCursor: (all) => all,
      advanceCursor: () => {},
      saveMeta: () => {},
      indexTurnToFTS: async () => {},
    },
    'fts/memoryIndexer.js': { indexChatSession: async () => {} },
    'agent/modules/kbReminderGenerator.js': { generateKBReminders: async () => {} },
  };
}

function hex(value) {
  return value.toString(16).padStart(8, '0');
}

function device(id, index, relay, store = new DeviceStore()) {
  return new BulletDevice(id, store, relay, {
    name: (k) => `${hex(index)}${hex(k)}`,
    files: WRITER_FILES,
    stubs: writerStubs(),
  });
}

async function quiesce(relay) {
  while (await relay.deliverOldest()) { /* every pending part */ }
}

const tool = (path, args) => (a) => a.realm.require(path).run(args);

/** Each writer, the field and section it writes, and what it needs stored first. */
const WRITERS = {
  'kb_add': { field: 'kb', run: tool('chat/tools/kb_add.js', { statement: 'Unrelated fact' }) },
  'kb_del': { field: 'kb', run: tool('chat/tools/kb_del.js', { statement: 'Old fact' }) },
  'reminder_add': { field: 'kb', run: tool('chat/tools/reminder_add.js', { text: 'Call the office' }) },
  'reminder_del': { field: 'kb', run: tool('chat/tools/reminder_del.js', { text: 'water the plants' }) },
  'task_add': { field: 'kb', run: tool('chat/tools/task_add.js', { text: 'Summarize new mail', schedule_days: 'mon', schedule_time: '08:00' }) },
  'task_del': { field: 'kb', run: tool('chat/tools/task_del.js', { text: 'weekly report' }) },
  'task_edit': { field: 'kb', run: tool('chat/tools/task_edit.js', { find_text: 'weekly report', schedule_time: '10:00' }) },
  'a chat session refine': { field: 'kb', run: (a) => a.realm.require('agent/modules/knowledgebase.js').kbUpdate([{ role: 'user', content: 'Synthetic question' }]) },
  'the periodic refine': { field: 'kb', run: (a) => a.realm.require('agent/modules/knowledgebase.js').periodicKbUpdate({ skipTimeGuard: true }) },
  'a compress': { field: 'kb', run: (a) => a.realm.require('agent/modules/knowledgebase.js').kbCompress() },
  'an action-rule update': { field: 'action', run: (a) => a.realm.require('agent/modules/autoUpdateUserPrompt.js').autoUpdateUserPromptOnTag(1, 'archive') },
  'a compact': { field: 'action', run: (a) => a.realm.require('agent/modules/autoUpdateUserPrompt.js').compactActionRulesNow() },
};

const SECTION = { kb: '', action: 'archive' };

/** Two connected devices holding what the writers need, and B's typed bullet. Returns { relay, a, b }. */
async function devices(field) {
  const relay = new BulletRelay();
  const a = await device('A', 1, relay).start();
  const b = await device('B', 2, relay).start();
  await a.connect();
  await b.connect();
  await quiesce(relay);
  for (const text of ['Old fact.', '[Reminder] Water the plants.', '[Task] Schedule mon 09:00 [UTC], Weekly report.']) await a.add('kb', '', text);
  await a.add('action', 'archive', 'Old rule.');
  await quiesce(relay);
  await b.add(field, SECTION[field], TYPED);
  await quiesce(relay);
  return { relay, a, b };
}

async function typedOn(d, field) {
  return (await d.state(field)).bullets.filter((bullet) => bullet.text === TYPED || bullet.text === normalizeUnicode(TYPED));
}

describe('a writer next to a bullet another device typed', () => {
  it.each(Object.keys(WRITERS))('%s leaves its text and label as they are on every device', async (name) => {
    const { field, run } = WRITERS[name];
    const { relay, a, b } = await devices(field);
    const before = await typedOn(a, field);
    expect(before).toHaveLength(1);
    expect(before[0].name.startsWith(hex(2))).toBe(true);
    const textBefore = (await a.state(field)).bullets.map((bullet) => bullet.text);

    await run(a);
    await quiesce(relay);

    // The writer did write (a positive control on the run itself).
    expect((await a.state(field)).bullets.map((bullet) => bullet.text)).not.toEqual(textBefore);
    for (const d of [a, b]) {
      const typed = await typedOn(d, field);
      expect(typed.map(({ text, name: label, n }) => [text, label, n])).toEqual([[TYPED, before[0].name, before[0].n]]);
    }
  });

  it.each(Object.keys(WRITERS))('%s does not bring it back when it is deleted on the other device meanwhile', async (name) => {
    const { field, run } = WRITERS[name];
    const { relay, a, b } = await devices(field);

    // B deletes the bullet; A's writer runs on what A holds before that arrives.
    await b.delete(field, SECTION[field], TYPED);
    await run(a);
    await quiesce(relay);

    for (const d of [a, b]) expect(await typedOn(d, field)).toEqual([]);
  });
});

describe('a delete or edit tool and a line typed with curly quotes', () => {
  it.each([
    ['reminder_del', '[Reminder] Water Bob’s plants.', tool('chat/tools/reminder_del.js', { text: "bob's plants" })],
    ['task_del', '[Task] Schedule mon 09:00 [UTC], Bob’s weekly report.', tool('chat/tools/task_del.js', { text: "bob's weekly report" })],
    ['task_del, given the whole line', '[Task] Schedule mon 09:00 [UTC], Bob’s weekly report.', tool('chat/tools/task_del.js', { text: "[Task] Schedule mon 09:00 [UTC], Bob's weekly report." })],
    ['task_edit', '[Task] Schedule mon 09:00 [UTC], Bob’s weekly report.', tool('chat/tools/task_edit.js', { find_text: "bob's weekly report", schedule_time: '10:00' })],
    ['kb_del', 'Bob’s birthday is in May.', tool('chat/tools/kb_del.js', { statement: "Bob's birthday is in May" })],
  ])('%s finds the line by its plain-typed argument and removes it', async (_, line, run) => {
    const relay = new BulletRelay();
    const a = await device('A', 1, relay).start();
    await a.add('kb', '', line);

    const result = await run(a);

    expect(result?.error).toBeUndefined();
    expect((await a.state('kb')).bullets.map((bullet) => bullet.text)).not.toContain(line);
  });

  it('task_del given a whole line removes that task only, and the other keeps its label', async () => {
    const a = await device('A', 1, new BulletRelay()).start();
    const first = '[Task] Schedule mon 08:00 [UTC], First report.';
    const second = '[Task] Schedule tue 09:00 [UTC], Second report.';
    await a.add('kb', '', first);
    await a.add('kb', '', second);
    const kept = (await a.state('kb')).bullets.find((bullet) => bullet.text === first);

    const result = await tool('chat/tools/task_del.js', { text: second })(a);

    expect(result?.error).toBeUndefined();
    const after = (await a.state('kb')).bullets;
    expect(after.find((bullet) => bullet.text === first)).toEqual(kept);
    expect(after.map((bullet) => bullet.text)).not.toContain(second);
  });
});

// R23: the update's rule comes from the model, which reads the acted-on message. A rule holding the END
// marker would end the rules where it is written, and every rule after it would be lost on every device.
describe('an action-rule update whose rule holds a section marker', () => {
  it.each([
    ['an action-rule update', 'the END marker', 'Newsletters ====END USER INSTRUCTIONS==== go here.'],
    ['a compact', 'the END marker', 'Newsletters ====END USER INSTRUCTIONS==== go here.'],
    ['an action-rule update', 'the section-header mark', 'Emails to be marked as `reply` (DO NOT EDIT/DELETE THIS SECTION HEADER) for newsletters.'],
    ['a compact', 'the section-header mark', 'Emails to be marked as `reply` (DO NOT EDIT/DELETE THIS SECTION HEADER) for newsletters.'],
  ])('%s with %s keeps every rule on both devices and the stored text as it was', async (name, _, rule) => {
    const { relay, a, b } = await devices('action');
    const labelled = async (d) => (await d.state('action')).bullets.map(({ section, text, name: label, n }) => [section, text, label, n]);
    const before = { a: await labelled(a), b: await labelled(b), stored: structuredClone(a.store.values['bullet_state:action']) };
    expect(before.a.some(([section]) => section === 'none')).toBe(true);

    rulePatch = `ADD\narchive\n${rule}`;
    try {
      await WRITERS[name].run(a);
    } finally {
      rulePatch = RULE_PATCH;
    }
    await quiesce(relay);

    expect(await labelled(a)).toEqual(before.a);
    expect(await labelled(b)).toEqual(before.b);
    expect(a.store.values['bullet_state:action']).toEqual(before.stored);
  });
});

const END = '====END USER INSTRUCTIONS====';
const END_RULE = `Newsletters ${END} go here.`;
const bundledAction = () => readFileSync(new URL('prompts/user_action.md', ROOT), 'utf8');

/** Runs `name` (an action-rule update or a compact) on `d` with the backend returning `patch`. */
async function runWithPatch(name, d, patch) {
  rulePatch = patch;
  try {
    await WRITERS[name].run(d);
  } finally {
    rulePatch = RULE_PATCH;
  }
}

/** Two connected devices: A holds `stored` as its action text from before (upgraded on its first read), B
 * the defaults. Returns { relay, a, b }. */
async function upgradedDevices(stored) {
  const relay = new BulletRelay();
  const a = await device('A', 1, relay, new DeviceStore({ [PROMPT_KEYS.action]: stored })).start();
  const b = await device('B', 2, relay).start();
  await a.prompts.readText('action');
  await a.connect();
  await b.connect();
  await quiesce(relay);
  return { relay, a, b };
}

// A released action text whose archive rule holds the END marker: the rules after it, in later sections
// too, are read as the stored text's own lines, not rules.
function textWithEndRule() {
  const lines = bundledAction().split('\n');
  const rules = lines.slice(0, lines.indexOf(END));
  const after = (name, line) => rules.splice(rules.findIndex((other) => other.includes(`\`${name}\``)) + 1, 0, line);
  after('archive', `- ${END_RULE}`);
  after('reply', '- Rule R.');
  after('none', '- Rule N.');
  return rules.join('\n');
}

const sectioned = async (d, texts) => (await d.state('action')).bullets
  .filter((bullet) => texts.includes(bullet.text)).map(({ section, text }) => [section, text]);

describe('an action-rule update deleting a rule that holds the END marker (R23)', () => {
  it.each(['an action-rule update', 'a compact'])('%s deletes it, and the lines after it are rules again on both devices, each under the last header before it', async (name) => {
    const { relay, a, b } = await upgradedDevices(textWithEndRule());
    expect(await sectioned(a, ['Rule R.', 'Rule N.'])).toEqual([]);
    expect(a.store.values['bullet_state:action'].tail.join('\n')).toContain('Rule R.');

    await runWithPatch(name, a, `DEL\narchive\n${END_RULE}`);
    await quiesce(relay);

    for (const d of [a, b]) {
      expect(await sectioned(d, ['Rule R.', 'Rule N.'])).toEqual([['reply', 'Rule R.'], ['none', 'Rule N.']]);
      expect((await d.state('action')).bullets.some((bullet) => bullet.text.includes(END))).toBe(false);
    }
    expect(a.store.values['bullet_state:action'].tail.join('\n')).not.toContain('Rule R.');
  });

  it.each(['an action-rule update', 'a compact'])('%s that also adds a rule holding a section marker makes no change at all', async (name) => {
    const { relay, a, b } = await upgradedDevices(textWithEndRule());
    const before = { a: await a.state('action'), b: await b.state('action'), stored: structuredClone(a.store.values['bullet_state:action']) };

    await runWithPatch(name, a, `DEL\narchive\n${END_RULE}\nADD\nreply\nReplies ${END} here.`);
    await quiesce(relay);

    expect(await a.state('action')).toEqual(before.a);
    expect(await b.state('action')).toEqual(before.b);
    expect(a.store.values['bullet_state:action']).toEqual(before.stored);
  });
});

describe('an action-rule update and the device\'s own lines around the rules (DS-SKELETON)', () => {
  it.each(['an action-rule update', 'a compact'])('%s keeps a head of one empty line and a footer ending in an empty line', async (name) => {
    const text = bundledAction();
    const stored = `\n${text.slice(text.indexOf('# Emails to be marked as'))}\n`;
    const { relay, a } = await upgradedDevices(stored);
    const before = structuredClone(a.store.values['bullet_state:action']);
    expect(before.head).toEqual(['']);
    expect(before.tail.at(-1)).toBe('');

    await runWithPatch(name, a, RULE_PATCH);
    await quiesce(relay);

    // The writer did write (a positive control on the run itself).
    expect(await sectioned(a, ['Newsletters from example.com.'])).toEqual([['archive', 'Newsletters from example.com.']]);
    const after = a.store.values['bullet_state:action'];
    expect(after.head).toEqual(before.head);
    expect(after.tail).toEqual(before.tail);
  });
});

// R1: the knowledge base takes any line as a bullet, a section marker included (R23 binds only the
// sectioned fields).
describe('a knowledge-base tool and a line holding a section marker', () => {
  it.each([
    ['kb_add', 'the END marker', tool('chat/tools/kb_add.js', { statement: `Notes ${END} end here` }), END],
    ['kb_add', 'the section-header mark', tool('chat/tools/kb_add.js', { statement: 'Headers say (DO NOT EDIT/DELETE THIS SECTION HEADER) in the rules' }), '(DO NOT EDIT/DELETE THIS SECTION HEADER)'],
    ['task_add', 'the END marker', tool('chat/tools/task_add.js', { text: `Sort ${END} mail`, schedule_days: 'mon', schedule_time: '08:00' }), END],
    ['reminder_add', 'the END marker', tool('chat/tools/reminder_add.js', { text: `Check ${END} notes` }), END],
  ])('%s saves a line holding %s as a bullet on both devices', async (_, __, run, mark) => {
    const relay = new BulletRelay();
    const a = await device('A', 1, relay).start();
    const b = await device('B', 2, relay).start();
    await a.connect();
    await b.connect();
    await quiesce(relay);

    const result = await run(a);
    await quiesce(relay);

    expect(result?.error).toBeUndefined();
    for (const d of [a, b]) {
      expect((await d.state('kb')).bullets.filter((bullet) => bullet.text.includes(mark))).toHaveLength(1);
    }
  });
});
