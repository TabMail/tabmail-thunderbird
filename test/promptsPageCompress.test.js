/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// promptsPageCompress.test.js — the real prompts page and the real knowledge-base compress on simulated
// devices (bulletDevices.js): a bullet that arrives while the knowledge base is compressed is shown, and
// the page's next edit keeps it on every device (DS-CAPTURE, DS-REFINE). The developer tab's raw texts
// are a view only: the page writes them and never reads them back.

import { readFileSync } from 'node:fs';
import { parse as parseModule } from 'acorn';
import { describe, expect, it } from 'vitest';
import { BulletDevice, BulletRelay, DeviceStore } from './support/bulletDevices.js';
import { openPage, settleMany } from './support/promptsPage.js';

const ROOT = new URL('../', import.meta.url);
const PAGE = readFileSync(new URL('prompts/prompts.js', ROOT), 'utf8');
const PAGE_HTML = readFileSync(new URL('prompts/prompts.html', ROOT), 'utf8');

/** The add-on's own normalizeUnicode, taken from utils.js (whose imports a realm cannot load). */
function addOnNormalizeUnicode() {
  const source = readFileSync(new URL('agent/modules/utils.js', ROOT), 'utf8');
  const node = parseModule(source, { ecmaVersion: 'latest', sourceType: 'module' }).body
    .find((item) => item.type === 'ExportNamedDeclaration' && item.declaration?.id?.name === 'normalizeUnicode');
  return new Function(`${source.slice(node.declaration.start, node.declaration.end)}\nreturn normalizeUnicode;`)();
}

const normalizeUnicode = addOnNormalizeUnicode();

/** Runs while the backend compresses, once. */
const hooks = { duringBackend: async () => {} };

/** The backend: a compress returns the knowledge base it was sent without its last line. */
async function backend([request]) {
  if (request.content !== 'system_prompt_kb_refine') throw new Error(`unexpected request ${request.content}`);
  const during = hooks.duringBackend;
  hooks.duringBackend = async () => {};
  await during();
  return { refined_kb: request.current_user_kb_md.split('\n').slice(0, -1).join('\n') };
}

function writerStubs() {
  return {
    'agent/modules/utils.js': { log: () => {}, normalizeUnicode, saveChatLog: () => {} },
    'agent/modules/llm.js': { sendChat: backend, processJSONResponse: (text) => JSON.parse(text) },
    'chat/modules/helpers.js': { formatTimestampForAgent: () => 'now', renderToPlainText: async (text) => text },
    'agent/modules/chatHistoryQueue.js': { addChatToQueue: async () => 'session-1', getUnrememberedSessions: async () => [], markSessionsAsRemembered: async () => {} },
    'chat/modules/persistentChatStore.js': { loadTurns: async () => [], loadMeta: async () => ({}), getTurnsAfterCursor: (all) => all, advanceCursor: () => {}, saveMeta: () => {}, indexTurnToFTS: async () => {} },
    'fts/memoryIndexer.js': { indexChatSession: async () => {} },
    'agent/modules/kbReminderGenerator.js': { generateKBReminders: async () => {} },
  };
}

function hex(value) {
  return value.toString(16).padStart(8, '0');
}

function device(id, index, relay) {
  return new BulletDevice(id, new DeviceStore(), relay, {
    name: (k) => `${hex(index)}${hex(k)}`,
    files: ['agent/modules/patchApplier.js', 'agent/modules/knowledgebase.js'],
    stubs: writerStubs(),
  });
}

async function quiesce(relay) {
  while (await relay.deliverOldest()) { /* every pending part */ }
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

const texts = async (device) => (await device.state('kb')).bullets.map((bullet) => bullet.text);

describe('the prompts page and a compress', () => {
  it('drops a compress when a bullet arrives during it, says so, and keeps every bullet on every device', async () => {
    const relay = new BulletRelay();
    const a = await device('A', 1, relay).start();
    const b = await device('B', 2, relay).start();
    await a.connect();
    await b.connect();
    await quiesce(relay);
    for (const text of ['Fact one.', 'Fact two.', 'Fact three.']) await a.add('kb', '', text);
    await quiesce(relay);
    const ui = await openPage(a, { commands: { 'kb-compress': () => a.realm.require('agent/modules/knowledgebase.js').kbCompress() } });
    expect(ui.shown('kb')).toContainEqual(['', 'Fact three.']);

    // While the backend compresses, B adds a bullet and A merges it: the compress read an older text, so
    // saving it would delete that bullet. It is dropped, and the user is told to try again.
    hooks.duringBackend = async () => {
      await b.add('kb', '', 'Peer fact.');
      await quiesce(relay);
      await settle();
    };
    await ui.click('#compress-kb');
    expect(ui.commands).toContain('kb-compress');
    expect(ui.lastStatus()).toEqual([expect.stringContaining('changed while it was being compressed, so nothing was saved. Try again.'), true]);
    for (const text of ['Fact one.', 'Fact two.', 'Fact three.', 'Peer fact.']) {
      expect(await texts(a)).toContain(text);
      expect(ui.shown('kb')).toContainEqual(['', text]);
    }

    // The user adds a line; it is saved at once, and nothing is lost on either device.
    await ui.enter('kb', '', 'Own fact.');
    await quiesce(relay);
    await settleMany();
    for (const one of [a, b]) {
      for (const text of ['Fact one.', 'Fact two.', 'Fact three.', 'Peer fact.', 'Own fact.']) expect(await texts(one)).toContain(text);
    }
    expect(ui.shown('kb').map(([, text]) => text).sort()).toEqual((await texts(a)).sort());

    // Tried again with nothing arriving, the compress is saved.
    const before = await texts(a);
    await ui.click('#compress-kb');
    expect(ui.lastStatus()).toEqual(['Knowledge base compressed successfully!']);
    expect(await texts(a)).toEqual(before.slice(0, -1));
    ui.dom.window.close();
  });
});

describe("the developer tab's raw texts", () => {
  it('are a view only: nothing saves what they show', () => {
    for (const field of ['composition', 'action', 'kb']) {
      expect(PAGE_HTML).not.toContain(`id="save-raw-${field}"`);
      expect(PAGE_HTML).toMatch(new RegExp(`<textarea id="raw-${field}-content"[^>]*\\breadonly\\b`));
      // Each raw text is only ever written by the page, never read back from it.
      const reads = PAGE.match(/\braw\.value(?!\s*=[^=])/g) ?? [];
      expect(reads).toEqual([]);
    }
  });
});
