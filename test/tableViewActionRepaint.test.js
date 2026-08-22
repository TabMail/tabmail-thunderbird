/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const TM_HDR_SOURCE = new URL(
  "../agent/experiments/tmHdr/tmHdr.sys.mjs",
  import.meta.url
);
const TABLE_VIEW_SOURCE = new URL(
  "../theme/experiments/tmMessageListTableView/tmMessageListTableView.sys.mjs",
  import.meta.url
);

const ACTION_COLORS = {
  reply: "#2e7d32",
  archive: "#1565c0",
  delete: "#c62828",
  none: "#757575",
};

class MockClassList {
  constructor() {
    this.values = new Set();
  }

  add(value) {
    this.values.add(value);
  }

  remove(value) {
    this.values.delete(value);
  }

  contains(value) {
    return this.values.has(value);
  }
}

class MockStyle {
  constructor() {
    this.values = new Map();
  }

  setProperty(name, value, priority = "") {
    this.values.set(name, { value, priority });
  }

  removeProperty(name) {
    this.values.delete(name);
  }

  getPropertyValue(name) {
    return this.values.get(name)?.value || "";
  }

  getPropertyPriority(name) {
    return this.values.get(name)?.priority || "";
  }
}

function makeHeader(messageKey, folderOverrides = {}) {
  const properties = new Map();
  const folder = {
    URI: "mailbox://account/Inbox",
    flags: 0,
    getUriForMsg: hdr => `mailbox-message://${hdr.messageKey}`,
    ...folderOverrides,
  };
  const hdr = {
    messageKey,
    messageId: `<message-${messageKey}@example.test>`,
    folder,
    setStringProperty(name, value) {
      properties.set(name, String(value));
    },
    getStringProperty(name) {
      return properties.get(name) || "";
    },
  };
  return hdr;
}

function makeView({
  headersByIndex,
  findIndexOfMsgHdr,
  findIndexForMsgURI,
  findKey,
  selectionIndex = 0,
}) {
  const rowsByIndex = new Map();
  const view = {
    rowCount: Math.max(...headersByIndex.keys()) + 1,
    msgFolder: { URI: "mailbox://account/Inbox" },
    selection: { currentIndex: selectionIndex },
    rowsByIndex,
    getMsgHdrAt(index) {
      return headersByIndex.get(index) || null;
    },
    getMessageHdrAt(index) {
      return headersByIndex.get(index) || null;
    },
    findIndexOfMsgHdr,
    findIndexForMsgURI,
    FindKey: findKey,
    NoteChange(index, count, notificationCode) {
      // Model Thunderbird's critical distinction: structural code 1 shifts
      // selection, while body-changed code 2 only repaints.
      if (notificationCode === 1 && index <= this.selection.currentIndex) {
        this.selection.currentIndex += count;
      }
      for (let i = index; i < index + count; i++) {
        rowsByIndex.get(i)?.fillRow();
      }
    },
  };
  return view;
}

function makeTableDocument(view, renderedIndices) {
  class ThreadRow {
    constructor(index) {
      this._index = index;
      this.view = view;
      this.nodeType = 1;
      this.classList = new MockClassList();
      this.style = new MockStyle();
      this.nativeFillCount = 0;
    }

    fillRow() {
      this.nativeFillCount++;
    }

    querySelector() {
      return null;
    }

    matches(selector) {
      return selector.includes("thread-row") || selector.includes("threadTree-row");
    }

    closest() {
      return this;
    }
  }

  const rows = renderedIndices.map(index => new ThreadRow(index));
  for (const row of rows) {
    view.rowsByIndex.set(row._index, row);
  }

  const scheduledFrames = new Map();
  let nextFrameId = 1;
  const tree = {
    querySelectorAll() {
      return rows;
    },
  };
  const doc = {
    readyState: "complete",
    observer: null,
    getElementById(id) {
      return id === "threadTree" ? tree : null;
    },
    querySelector(selector) {
      if (selector === '[is="thread-card"]') return null;
      if (selector === '[is="thread-row"]') return rows[0] || null;
      return null;
    },
  };
  const contentWindow = {
    document: doc,
    gDBView: view,
    customElements: {
      get(name) {
        return name === "thread-row" ? ThreadRow : null;
      },
    },
    MutationObserver: class {
      constructor(callback) {
        this.callback = callback;
        this.connected = false;
        doc.observer = this;
      }

      observe() {
        this.connected = true;
      }

      disconnect() {
        this.connected = false;
      }
    },
    requestAnimationFrame(callback) {
      const id = nextFrameId++;
      scheduledFrames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) {
      scheduledFrames.delete(id);
    },
    addEventListener() {},
    removeEventListener() {},
  };
  doc.defaultView = contentWindow;
  doc.fireInsertion = node => {
    if (!doc.observer?.connected) return;
    doc.observer.callback([{ target: tree, addedNodes: node ? [node] : [] }]);
  };
  doc.flushAnimationFrames = () => {
    const callbacks = [...scheduledFrames.values()];
    scheduledFrames.clear();
    for (const callback of callbacks) callback();
  };
  doc.pendingAnimationFrameCount = () => scheduledFrames.size;

  return { contentWindow, doc, rows, ThreadRow };
}

function makeOuterWindow(contentWindows, currentIndex = 0) {
  const tabmail = {
    currentAbout3Pane: contentWindows[currentIndex],
    currentTabInfo: {
      chromeBrowser: { contentWindow: contentWindows[currentIndex] },
    },
    tabInfo: contentWindows.map(contentWindow => ({
      chromeBrowser: { contentWindow },
    })),
    tabContainer: {
      addEventListener() {},
      removeEventListener() {},
    },
  };
  return {
    document: {
      readyState: "complete",
      getElementById(id) {
        return id === "tabmail" ? tabmail : null;
      },
      querySelector() {
        return null;
      },
    },
    addEventListener() {},
  };
}

function makeServices(windows) {
  return {
    wm: {
      getEnumerator() {
        let index = 0;
        return {
          hasMoreElements() {
            return index < windows.length;
          },
          getNext() {
            return windows[index++];
          },
        };
      },
    },
  };
}

function makeExperimentSandbox(Services) {
  class ExtensionAPI {
    constructor(extension) {
      this.extension = extension;
    }
  }
  class EventManager {
    api() {
      return {};
    }
  }
  const ExtensionCommon = { ExtensionAPI, EventManager };
  const ExtensionSupport = {
    registerWindowListener() {},
    unregisterWindowListener() {},
  };
  const MailServices = {
    tags: {
      getColorForKey(key) {
        return ACTION_COLORS[key.replace(/^tm_/, "")] || null;
      },
    },
  };
  const silentConsole = {
    log() {},
    warn() {},
    error() {},
  };
  return {
    Services,
    Components: {
      interfaces: {
        nsMsgMessageFlags: {
          Replied: 1,
          Forwarded: 2,
          Read: 4,
        },
      },
    },
    Ci: { nsMsgFolderFlags: { Inbox: 1, Virtual: 2 } },
    ChromeUtils: {
      importESModule(uri) {
        if (uri.includes("ExtensionCommon")) return { ExtensionCommon };
        if (uri.includes("ExtensionSupport")) return { ExtensionSupport };
        if (uri.includes("MailServices")) return { MailServices };
        if (uri.includes("MailUtils")) return { MailUtils: {} };
        throw new Error(`Unexpected import: ${uri}`);
      },
    },
    console: silentConsole,
  };
}

function loadExperiment(sourceUrl, className, sandbox) {
  const source = readFileSync(sourceUrl, "utf8");
  runInNewContext(
    `${source}\nglobalThis.__ExperimentClass = ${className};`,
    sandbox,
    { filename: fileURLToPath(sourceUrl) }
  );
  return sandbox.__ExperimentClass;
}

async function startExperiments(Services, headersByWebExtensionId) {
  const extension = {
    id: "table-repaint-test@example.test",
    messageManager: {
      get(id) {
        return headersByWebExtensionId.get(id) || null;
      },
      convert(hdr) {
        return { id: hdr.messageKey };
      },
    },
  };
  const context = { extension };

  const tableSandbox = makeExperimentSandbox(Services);
  const TableExperiment = loadExperiment(
    TABLE_VIEW_SOURCE,
    "tmMessageListTableView",
    tableSandbox
  );
  const tableExperiment = new TableExperiment(extension);
  const tableApi = tableExperiment.getAPI(context).tmMessageListTableView;
  await tableApi.init();

  const hdrSandbox = makeExperimentSandbox(Services);
  const HdrExperiment = loadExperiment(TM_HDR_SOURCE, "tmHdr", hdrSandbox);
  const hdrApi = new HdrExperiment(extension).getAPI(context).tmHdr;

  return { hdrApi, tableApi, tableExperiment };
}

function expectPainted(row, action) {
  expect(row.classList.contains(`tm-action-${action}`)).toBe(true);
  expect(row.style.getPropertyValue("background-color")).toContain(ACTION_COLORS[action]);
  expect(row.style.getPropertyPriority("background-color")).toBe("important");
}

function expectUnpainted(row) {
  for (const action of Object.keys(ACTION_COLORS)) {
    expect(row.classList.contains(`tm-action-${action}`)).toBe(false);
  }
  expect(row.style.getPropertyValue("background-color")).toBe("");
}

describe("Table-view action repaint integration", () => {
  it("paints and clears the rendered row in every open 3-pane tab without moving selection", async () => {
    const hdr = makeHeader(101);
    const currentView = makeView({
      headersByIndex: new Map([[0, hdr]]),
      findIndexOfMsgHdr: candidate => candidate === hdr ? 0 : -1,
      findIndexForMsgURI: () => -1,
      findKey: () => -1,
      selectionIndex: 0,
    });
    const backgroundView = makeView({
      headersByIndex: new Map([[0, hdr]]),
      findIndexOfMsgHdr: candidate => candidate === hdr ? 0 : -1,
      findIndexForMsgURI: () => -1,
      findKey: () => -1,
      selectionIndex: 0,
    });
    const currentDoc = makeTableDocument(currentView, [0]);
    const backgroundDoc = makeTableDocument(backgroundView, [0]);
    const outerWindow = makeOuterWindow([
      currentDoc.contentWindow,
      backgroundDoc.contentWindow,
    ]);
    const Services = makeServices([outerWindow]);
    const { hdrApi } = await startExperiments(Services, new Map([[7001, hdr]]));

    expectUnpainted(currentDoc.rows[0]);
    expectUnpainted(backgroundDoc.rows[0]);
    expect(await hdrApi.setAction(7001, "reply")).toBe(true);
    expect(hdr.getStringProperty("tm-action")).toBe("reply");
    expect(hdr.getStringProperty("keywords")).toBe("");
    expectPainted(currentDoc.rows[0], "reply");
    expectPainted(backgroundDoc.rows[0], "reply");
    expect(currentView.selection.currentIndex).toBe(0);
    expect(backgroundView.selection.currentIndex).toBe(0);

    expect(await hdrApi.clearAction(7001)).toBe(true);
    expect(hdr.getStringProperty("tm-action")).toBe("");
    expect(hdr.getStringProperty("keywords")).toBe("");
    expectUnpainted(currentDoc.rows[0]);
    expectUnpainted(backgroundDoc.rows[0]);
    expect(currentView.selection.currentIndex).toBe(0);
    expect(backgroundView.selection.currentIndex).toBe(0);
  });

  it("bulk backfill repaints rendered rows in background 3-pane tabs", async () => {
    const hdr = makeHeader(102);
    const currentView = makeView({
      headersByIndex: new Map([[0, hdr]]),
      findIndexOfMsgHdr: () => 0,
      findIndexForMsgURI: () => -1,
      findKey: () => -1,
    });
    const backgroundView = makeView({
      headersByIndex: new Map([[0, hdr]]),
      findIndexOfMsgHdr: () => 0,
      findIndexForMsgURI: () => -1,
      findKey: () => -1,
    });
    const currentDoc = makeTableDocument(currentView, [0]);
    const backgroundDoc = makeTableDocument(backgroundView, [0]);
    const Services = makeServices([
      makeOuterWindow([currentDoc.contentWindow, backgroundDoc.contentWindow]),
    ]);
    const { hdrApi } = await startExperiments(Services, new Map([[7002, hdr]]));

    expectUnpainted(backgroundDoc.rows[0]);
    expect(await hdrApi.setActionsBulk([{ weMsgId: 7002, action: "archive" }])).toBe(1);
    expectPainted(currentDoc.rows[0], "archive");
    expectPainted(backgroundDoc.rows[0], "archive");
  });

  it("aggregates hidden child actions onto the visible collapsed-thread root", async () => {
    const visibleRoot = makeHeader(201);
    const target = makeHeader(202);
    const competingChild = makeHeader(203);
    const thread = {
      numChildren: 3,
      getChildHdrAt(index) {
        return [visibleRoot, target, competingChild][index] || null;
      },
    };
    const view = makeView({
      // The visible row owns the root hdr. Hidden children exist only in the
      // nsIMsgThread and map back to that root through Thunderbird's URI
      // lookup; getMsgHdrAt(rootIndex) must never return the hidden target.
      headersByIndex: new Map([[1, visibleRoot]]),
      findIndexOfMsgHdr: candidate => candidate === visibleRoot ? 1 : -1,
      findIndexForMsgURI: uri => (
        uri === "mailbox-message://202" || uri === "mailbox-message://203"
          ? 1
          : -1
      ),
      findKey: () => -1,
    });
    view.isContainer = index => index === 1;
    view.isContainerOpen = () => false;
    view.getThreadContainingIndex = index => index === 1 ? thread : null;
    const tableDoc = makeTableDocument(view, [1]);
    const Services = makeServices([makeOuterWindow([tableDoc.contentWindow])]);
    const { hdrApi } = await startExperiments(Services, new Map([
      [7003, target],
      [7004, competingChild],
    ]));
    const rootRow = view.rowsByIndex.get(1);

    expect(view.getMsgHdrAt(1)).toBe(visibleRoot);
    expect(view.getMsgHdrAt(1)).not.toBe(target);
    expectUnpainted(rootRow);
    expect(await hdrApi.setAction(7003, "delete")).toBe(true);
    expectPainted(rootRow, "delete");

    // Card-view priority is reply > none > archive > delete. The table row
    // must use the same thread aggregation semantics.
    expect(await hdrApi.setAction(7004, "archive")).toBe(true);
    expectPainted(rootRow, "archive");
    expect(await hdrApi.setAction(7003, "reply")).toBe(true);
    expectPainted(rootRow, "reply");

    expect(await hdrApi.clearAction(7003)).toBe(true);
    expectPainted(rootRow, "archive");
    expect(await hdrApi.clearAction(7004)).toBe(true);
    expectUnpainted(rootRow);
  });

  it("limits thread aggregation to closed multi-message containers", async () => {
    const visibleRoot = makeHeader(211);
    const child = makeHeader(212);
    visibleRoot.setStringProperty("tm-action", "archive");
    child.setStringProperty("tm-action", "reply");

    let isContainer = false;
    let isOpen = false;
    const threadResult = {
      numChildren: 2,
      getChildHdrAt(index) {
        return [visibleRoot, child][index] || null;
      },
    };
    const view = makeView({
      headersByIndex: new Map([[0, visibleRoot]]),
      findIndexOfMsgHdr: candidate => candidate === visibleRoot ? 0 : -1,
      findIndexForMsgURI: () => -1,
      findKey: () => -1,
    });
    view.isContainer = () => isContainer;
    view.isContainerOpen = () => isOpen;
    view.getThreadContainingIndex = () => threadResult;

    const tableDoc = makeTableDocument(view, [0]);
    const Services = makeServices([makeOuterWindow([tableDoc.contentWindow])]);
    await startExperiments(Services, new Map());
    const row = tableDoc.rows[0];

    row.fillRow();
    expectPainted(row, "archive");

    isContainer = true;
    isOpen = true;
    row.fillRow();
    expectPainted(row, "archive");

    isOpen = false;
    view.getThreadContainingIndex = undefined;
    row.fillRow();
    expectPainted(row, "archive");

    view.getThreadContainingIndex = () => ({
      numChildren: 1,
      getChildHdrAt: () => visibleRoot,
    });
    row.fillRow();
    expectPainted(row, "archive");

    view.getThreadContainingIndex = () => ({
      numChildren: 2,
      getChildHdrAt(index) {
        if (index === 0) throw new Error("unavailable child");
        return makeHeader(213);
      },
    });
    row.fillRow();
    expectPainted(row, "archive");

    const invalidChild = makeHeader(214);
    invalidChild.setStringProperty("tm-action", "unexpected");
    view.getThreadContainingIndex = () => ({
      numChildren: 2,
      getChildHdrAt: () => invalidChild,
    });
    row.fillRow();
    expectPainted(row, "archive");

    view.getThreadContainingIndex = () => {
      throw new Error("thread unavailable");
    };
    row.fillRow();
    expectPainted(row, "archive");

    view.isContainerOpen = undefined;
    view.getThreadContainingIndex = () => threadResult;
    row.fillRow();
    expectPainted(row, "reply");
  });

  it("self-heals a direct invalidation miss when the rendered row is inserted", async () => {
    const hdr = makeHeader(301);
    const view = makeView({
      headersByIndex: new Map([[0, hdr]]),
      findIndexOfMsgHdr: () => -1,
      findIndexForMsgURI: () => -1,
      findKey: () => -1,
    });
    const tableDoc = makeTableDocument(view, [0]);
    const Services = makeServices([makeOuterWindow([tableDoc.contentWindow])]);
    const { hdrApi } = await startExperiments(Services, new Map([[7004, hdr]]));
    const row = tableDoc.rows[0];

    expectUnpainted(row);
    expect(await hdrApi.setAction(7004, "none")).toBe(true);
    // Prove the fixture holds the direct-miss precondition before insertion.
    expectUnpainted(row);

    tableDoc.doc.fireInsertion(row);
    tableDoc.doc.flushAnimationFrames();
    expectPainted(row, "none");
  });

  it("cancels pending self-heal work and restores the pristine row renderer on shutdown", async () => {
    const hdr = makeHeader(401);
    const view = makeView({
      headersByIndex: new Map([[0, hdr]]),
      findIndexOfMsgHdr: () => -1,
      findIndexForMsgURI: () => -1,
      findKey: () => -1,
    });
    const tableDoc = makeTableDocument(view, [0]);
    const pristineFillRow = tableDoc.ThreadRow.prototype.fillRow;
    const Services = makeServices([makeOuterWindow([tableDoc.contentWindow])]);
    const { hdrApi, tableApi } = await startExperiments(
      Services,
      new Map([[7005, hdr]])
    );
    const row = tableDoc.rows[0];

    expect(await hdrApi.setAction(7005, "reply")).toBe(true);
    expectUnpainted(row);
    tableDoc.doc.fireInsertion(row);
    expect(tableDoc.doc.pendingAnimationFrameCount()).toBe(1);

    await tableApi.shutdown();
    expect(tableDoc.doc.pendingAnimationFrameCount()).toBe(0);
    expect(tableDoc.doc.observer.connected).toBe(false);
    expect(tableDoc.ThreadRow.prototype.fillRow).toBe(pristineFillRow);
    tableDoc.doc.flushAnimationFrames();
    expectUnpainted(row);
  });

  it("keeps a newer hot-reload wrapper functional when the stale instance shuts down", async () => {
    const hdr = makeHeader(501);
    const view = makeView({
      headersByIndex: new Map([[0, hdr]]),
      findIndexOfMsgHdr: candidate => candidate === hdr ? 0 : -1,
      findIndexForMsgURI: () => -1,
      findKey: () => -1,
    });
    const tableDoc = makeTableDocument(view, [0]);
    const pristineFillRow = tableDoc.ThreadRow.prototype.fillRow;
    const Services = makeServices([makeOuterWindow([tableDoc.contentWindow])]);
    const instanceA = await startExperiments(Services, new Map([[7006, hdr]]));
    const wrapperA = tableDoc.ThreadRow.prototype.fillRow;
    const instanceB = await startExperiments(Services, new Map([[7006, hdr]]));
    const wrapperB = tableDoc.ThreadRow.prototype.fillRow;
    const row = tableDoc.rows[0];

    expect(wrapperA).not.toBe(pristineFillRow);
    expect(wrapperB).not.toBe(wrapperA);
    expect(wrapperB).not.toBe(pristineFillRow);

    await instanceA.tableApi.shutdown();
    expect(tableDoc.ThreadRow.prototype.fillRow).toBe(wrapperB);
    expect(tableDoc.doc.observer.connected).toBe(true);
    expect(await instanceB.hdrApi.setAction(7006, "reply")).toBe(true);
    expectPainted(row, "reply");

    await instanceB.tableApi.shutdown();
    expect(tableDoc.ThreadRow.prototype.fillRow).toBe(pristineFillRow);
    expect(tableDoc.doc.observer.connected).toBe(false);
  });
});
