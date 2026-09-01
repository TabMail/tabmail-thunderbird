/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// calendarServiceAcquisition.test.js — pins the invariant that tmCalendar
// obtains Thunderbird's calendar *services* through the `cal` namespace, never
// through an XPCOM contract ID, and that each consumer receives the service it
// actually needs.
//
// Why this is an invariant and not a style preference: Thunderbird de-XPCOM'd
// the calendar back end. `@mozilla.org/calendar/ics-service;1` is no longer
// registered at all, and `@mozilla.org/calendar/manager;1` /
// `@mozilla.org/calendar/timezone-service;1` now resolve to module-level
// singleton *instances* that XPCOM still tries to `new`, so `getService()`
// throws "… is not a constructor" and surfaces as
// NS_ERROR_XPC_GS_RETURNED_FAILURE. Every calendar feature (listCalendars,
// getCalendars, event create/edit/delete, every date conversion) dies with it.
// `cal.manager` / `cal.timezoneService` / `cal.icsService` resolve correctly on
// both the old and the current Thunderbird layouts.
//
// TWO instruments, deliberately overlapping:
//
//   1. `node:vm` executes the real file AS A CLASSIC SCRIPT, which is the one
//      property of Thunderbird's loader that matters here: top-level function
//      declarations become global-object properties, exactly as
//      SchemaAPIManager reads them back via `this.global[name]`. It is NOT a
//      reproduction of Gecko — it is Node/V8 with a synthetic global, no XPCOM,
//      no privileged sandbox, no `Cu`. What it buys is that the accessors' real
//      return values, null contract, logging and cache-free behaviour are
//      asserted by RUNNING them rather than by reading them.
//   2. `acorn` parses the file so the negative census ("this contract is not
//      reachable from code") is answered structurally.
//
// Both replaced an earlier text-scanning version that could be defeated four
// separate ways, each reproduced during review: a live XPCOM lookup parked
// between two string literals containing `/*` and `*/` was erased by comment
// stripping; a `getService(` call split across lines slipped past a
// line-oriented regex; `getService(globalThis.Ci.calIFoo)` slipped past a regex
// that required `Ci.` immediately after the paren; and a function's own
// declaration satisfied its "has at least one caller" count. Comments are not
// AST nodes and declarations are not CallExpressions, so all four dissolve
// rather than needing another regex.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";
import { parse } from "acorn";

const __dirname = dirname(fileURLToPath(import.meta.url));

const SOURCE_PATH = resolve(
  __dirname,
  "../chat/experiments/tmCalendar/tmCalendar.sys.mjs"
);

const RAW = readFileSync(SOURCE_PATH, "utf-8");

const CAL_UTILS_URL = "resource:///modules/calendar/calUtils.sys.mjs";
const EXT_COMMON_URL = "resource://gre/modules/ExtensionCommon.sys.mjs";

// Thunderbird loads experiment parent scripts as classic scripts, not modules.
function parseScript(source) {
  return parse(source, { ecmaVersion: "latest", sourceType: "script" });
}

// Generic AST walk. Node children are either nodes or arrays of nodes; anything
// without a string `type` (a Literal's `regex` descriptor, a raw number) is not
// a node and is skipped.
function walk(node, visit) {
  if (!node || typeof node.type !== "string") return;
  visit(node);
  for (const key of Object.keys(node)) {
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) walk(item, visit);
    } else if (child && typeof child === "object") {
      walk(child, visit);
    }
  }
}

// Every string value that exists in CODE. Comments are not AST nodes, so a
// contract named in the explanatory block above `getCalNamespace` cannot
// satisfy — or defeat — a census built from this.
function stringLiterals(ast) {
  const out = [];
  walk(ast, node => {
    if (node.type === "Literal" && typeof node.value === "string") {
      out.push(node.value);
    } else if (node.type === "TemplateLiteral") {
      for (const quasi of node.quasis) {
        if (typeof quasi.value.cooked === "string") out.push(quasi.value.cooked);
      }
    }
  });
  return out;
}

// `<anything>.getService(<anything>.calIFoo)` regardless of line breaks or how
// `Ci` is qualified. `createInstance` is deliberately not matched: the object
// construction contracts are still registered and still in use.
//
// ACCEPTED LIMITATION — read this before "hardening" the census. Two things a
// static census structurally cannot do, both measured, both deliberately not
// chased with more patterns:
//
//   a. It matches `<x>.getService(<y>.calI…)` — a contract written as a literal
//      and an interface reached as a member expression. It does NOT catch
//      deliberately computed forms: a contract built by template literal or
//      `Array.join`, an interface bound to a local first,
//      `obj["get" + "Service"](...)`, or
//      `globalThis["sendCalendar" + "Invitations"]()`. Nor does it catch a
//      ZERO-ARGUMENT `Cc[…].getService()`, which is ordinary modern Gecko
//      style rather than an evasion — for the three contracts this fix killed
//      the string census catches that anyway, whatever the `getService` form,
//      but do not read the call census as covering a service added later.
//      Three such mutants survive this file today, by decision.
//   b. A pinned call site proves the accessor is CALLED, never that its result
//      is USED. `getCalendarManager(); const mgr = null;` satisfies every
//      static assertion here.
//
// Chasing either with more regexes or more AST shapes is an arms race the
// census cannot win, and three review rounds were spent learning that. The
// defence is the executed half below: `Cc` is a proxy that throws on any
// property access, so a lookup that actually runs fails however its string was
// built — unless it is wrapped in its own `try`/`catch`, which a HARMFUL
// reintroduction cannot be, because swallowing the throw also swallows the
// service it was trying to fetch — and asserting a consumer's real output
// catches a discarded result.
// Execution covers the four accessors, per-service resolution against a partial
// namespace, `toEpochMsUTC`, `listCalendarsInternal` and the `getCalendars`
// getAPI surface. Still unexecuted: `toCalIDateTime`, `applyRecurrenceToItem`,
// `queryCalendarItemsInternal` and the remaining eight call sites inside
// `getAPI`. **When this matters again, execute one of those — copy the
// `getCalendars` test — rather than adding another pattern here.**
function calendarGetServiceCalls(ast) {
  const out = [];
  walk(ast, node => {
    if (node.type !== "CallExpression") return;
    const callee = node.callee;
    if (callee.type !== "MemberExpression") return;
    const method = callee.property.name ?? callee.property.value;
    if (method !== "getService") return;
    const arg = node.arguments[0];
    if (!arg || arg.type !== "MemberExpression") return;
    const iface = arg.property.name ?? arg.property.value;
    if (typeof iface === "string" && /^calI[A-Z]/.test(iface)) {
      out.push({ interface: iface, start: node.start, end: node.end });
    }
  });
  return out;
}

// Names the region a node sits in: a function declaration, a class method, or a
// function-valued object property (which is how the getAPI method builds the
// experiment's API surface).
function regionName(node) {
  if (node.type === "FunctionDeclaration" && node.id) return node.id.name;
  if (node.type === "MethodDefinition" && node.key) {
    return node.key.name ?? node.key.value;
  }
  if (
    node.type === "Property" &&
    node.value &&
    /^(FunctionExpression|ArrowFunctionExpression)$/.test(node.value.type)
  ) {
    return node.key.name ?? node.key.value;
  }
  return null;
}

// Every accessor call site, as "<enclosing region chain> :: <accessor>". A
// FunctionDeclaration is not a CallExpression, so a function's own declaration
// never counts as a call.
function accessorCallSites(ast) {
  const out = [];
  (function descend(node, chain) {
    if (!node || typeof node.type !== "string") return;
    const name = regionName(node);
    const here = name ? chain.concat(name) : chain;
    if (
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      ACCESSORS.includes(node.callee.name)
    ) {
      const where = here.length ? here.join(" > ") : "<top level>";
      out.push(`${where} :: ${node.callee.name}`);
    }
    for (const key of Object.keys(node)) {
      const child = node[key];
      if (Array.isArray(child)) {
        for (const item of child) descend(item, here);
      } else if (child && typeof child === "object") {
        descend(child, here);
      }
    }
  })(ast, []);
  return out.sort();
}

function findFunctionDeclaration(ast, name) {
  let found = null;
  walk(ast, node => {
    if (node.type === "FunctionDeclaration" && node.id && node.id.name === name) {
      found = node;
    }
  });
  return found;
}

const AST = parseScript(RAW);
const CODE_STRINGS = stringLiterals(AST);
const ACCESSORS = ["getCalendarManager", "getTimezoneService", "getIcsService"];
// The `cal` property each accessor must resolve, and no other.
const SERVICE_OF = {
  getCalendarManager: "manager",
  getTimezoneService: "timezoneService",
  getIcsService: "icsService",
};

// Services that must never be reached through XPCOM again.
const DEAD_SERVICE_CONTRACTS = [
  "@mozilla.org/calendar/manager;1",
  "@mozilla.org/calendar/timezone-service;1",
  "@mozilla.org/calendar/ics-service;1",
];

// Object-construction contracts that still register real constructors in
// Thunderbird and are deliberately still used. Listed so that a future
// de-XPCOM wave that breaks one of these is a deliberate decision, not a
// silent omission from this test.
const LIVE_CONSTRUCTION_CONTRACTS = [
  "@mozilla.org/calendar/event;1",
  "@mozilla.org/calendar/attendee;1",
  "@mozilla.org/calendar/datetime;1",
  "@mozilla.org/calendar/recurrence-rule;1",
  "@mozilla.org/calendar/recurrence-info;1",
  "@mozilla.org/calendar/recurrence-date;1",
  "@mozilla.org/calendar/ics-serializer;1",
];

// EVERY accessor call site, pinned to the consumer that makes it. Exhaustive on
// purpose: an earlier draft listed only the five standalone consumers, which
// left the nine call sites inside the getAPI method body unguarded — and those
// nine ARE the user-facing calendar surface (getCalendars, event create / edit /
// delete, series split). A swapped or nulled accessor there is a one-token slip
// that changes nothing else this file asserts, so a subset map reads as a guard
// while protecting the least important third of the code. Reviewers reproduced
// four such mutants, including all seven getAPI manager sites returning null —
// every calendar feature dead, whole suite green.
//
// This table also subsumes the weaker "each accessor has >= 1 caller" check it
// replaced: that was a global > 0 threshold already satisfied by the standalone
// consumers, so it protected none of the nine.
const EXPECTED_ACCESSOR_CALL_SITES = [
  "applyRecurrenceToItem :: getIcsService",
  "getAPI > createCalendarEvent :: getCalendarManager",
  "getAPI > deleteCalendarEvent :: getCalendarManager",
  "getAPI > getCalendarEventDetails :: getCalendarManager",
  "getAPI > getCalendars :: getCalendarManager",
  "getAPI > modifyCalendarEvent :: getCalendarManager",
  "getAPI > setGoogleInvitePolicy :: getCalendarManager",
  "getAPI > splitRecurringEvent :: getCalendarManager",
  "getAPI > splitRecurringEvent :: getIcsService",
  "getAPI > splitRecurringEvent :: getIcsService",
  "listCalendarsInternal :: getCalendarManager",
  "queryCalendarItemsInternal :: getCalendarManager",
  "sendCalendarInvitations :: getIcsService",
  "toCalIDateTime :: getTimezoneService",
  "toEpochMsUTC :: getTimezoneService",
];

// Executes the real file as a classic script, exactly as Thunderbird's
// experiment loader does. Top-level function declarations become properties of
// the context global, so the accessors and consumers can be called directly.
function runScript({ cal, importCalUtils } = {}) {
  const importUrls = [];
  const consoleErrors = [];
  const ctx = vm.createContext({
    ChromeUtils: {
      importESModule(url) {
        importUrls.push(url);
        if (url === EXT_COMMON_URL) {
          return { ExtensionCommon: { ExtensionAPI: class {} } };
        }
        if (url === CAL_UTILS_URL) {
          if (importCalUtils) return importCalUtils();
          return { cal };
        }
        throw new Error(`unexpected importESModule(${url})`);
      },
    },
    console: {
      log() {},
      warn() {},
      error(...args) {
        consoleErrors.push(args.map(String).join(" "));
      },
    },
    // Any XPCOM contract lookup performed while the script loads, or while a
    // consumer driven below runs, is itself the defect this file pins.
    Cc: new Proxy(
      {},
      {
        get(_target, key) {
          throw new Error(`XPCOM Cc[${String(key)}] lookup`);
        },
      }
    ),
    Ci: new Proxy({}, { get: (_target, key) => `Ci.${String(key)}` }),
  });
  vm.runInContext(RAW, ctx, { filename: "tmCalendar.sys.mjs" });
  return { ctx, importUrls, consoleErrors };
}

const SENTINELS = () => ({
  manager: { __service: "manager" },
  timezoneService: { __service: "timezoneService" },
  icsService: { __service: "icsService" },
});

describe("tmCalendar calendar-service acquisition — instrument controls", () => {
  it("censuses code and ignores comments, including the defeats that broke the previous instrument", () => {
    // Independent of the file under test. Each line is one of the four
    // reproduced ways the earlier text-based instrument could be fooled.
    const sample = [
      'const a = 1;',
      '// @mozilla.org/calendar/manager;1 named in a line comment',
      '/* @mozilla.org/calendar/timezone-service;1 named in a block comment */',
      // A live lookup parked between two string literals that contain the
      // comment delimiters: naive comment stripping deletes it wholesale.
      'const open = "/*"; const live = Cc["@mozilla.org/calendar/ics-service;1"]; const close = "*/";',
      // Split across lines, and `Ci` reached through a qualifier.
      'const svc = someObject',
      '  .getService(',
      '    globalThis.Ci.calIFreeBusyService',
      '  );',
      // Must NOT be flagged: construction contracts are still registered.
      'const dt = Cc["@mozilla.org/calendar/datetime;1"].createInstance(Ci.calIDateTime);',
    ].join("\n");
    const sampleAst = parseScript(sample);
    const literals = stringLiterals(sampleAst);

    // The code-side contract is seen despite the `/*` … `*/` string literals.
    expect(literals).toContain("@mozilla.org/calendar/ics-service;1");
    // The comment-only mentions are not.
    expect(literals).not.toContain("@mozilla.org/calendar/manager;1");
    expect(literals).not.toContain("@mozilla.org/calendar/timezone-service;1");

    // The multi-line, qualified getService call is caught; createInstance is not.
    const offenders = calendarGetServiceCalls(sampleAst).map(o => o.interface);
    expect(offenders).toEqual(["calIFreeBusyService"]);
  });

  it("counts calls, not declarations, and names the enclosing region (control)", () => {
    const declaredOnly = parseScript("function getIcsService() { return null; }");
    expect(accessorCallSites(declaredOnly)).toEqual([]);

    const declaredAndCalled = parseScript(
      "function getIcsService() { return null; }\n" +
        "function consume() { return getIcsService(); }\n" +
        "const api = { split() { return getIcsService(); } };"
    );
    expect(accessorCallSites(declaredAndCalled)).toEqual([
      "consume :: getIcsService",
      "split :: getIcsService",
    ]);
  });

  it("the dead contracts are still named in the source's comments (control)", () => {
    // Two-sided: the explanatory block must still name the dead contracts, so
    // the next reader learns why they are gone, while the executable body must
    // not reference them. If this half ever fails, the negative assertions
    // below have stopped proving anything about a documented decision.
    for (const contract of DEAD_SERVICE_CONTRACTS) {
      expect(RAW).toContain(contract);
    }
    expect(CODE_STRINGS.length).toBeGreaterThan(100);
  });
});

describe("tmCalendar calendar-service acquisition — static census", () => {
  for (const contract of DEAD_SERVICE_CONTRACTS) {
    it(`does not resolve ${contract} through XPCOM`, () => {
      expect(CODE_STRINGS).not.toContain(contract);
    });
  }

  it("no reachable code path resolves a calendar service through XPCOM", () => {
    // sendCalendarInvitations is unreachable WIP whose iMIP lookups
    // (calIItipService, calIItipTransport) are dead in Thunderbird for reasons
    // the source documents; it is exempt only for as long as it stays
    // unreachable, which the next test enforces.
    const imip = findFunctionDeclaration(AST, "sendCalendarInvitations");
    expect(imip, "sendCalendarInvitations declaration not found").not.toBeNull();

    const offenders = calendarGetServiceCalls(AST)
      .filter(call => call.start < imip.start || call.end > imip.end)
      .map(call => call.interface);
    expect(offenders).toEqual([]);
  });

  it("the exempt iMIP function is still unreachable", () => {
    // Counts every reference to the identifier except the declaration's own
    // name, so an alias (`const send = sendCalendarInvitations;`) is a call
    // site too. If iMIP is ever revived this fails first, forcing whoever
    // does it to deal with the dead itip-service/itip-transport contracts.
    const imip = findFunctionDeclaration(AST, "sendCalendarInvitations");
    const references = [];
    walk(AST, node => {
      if (
        node.type === "Identifier" &&
        node.name === "sendCalendarInvitations" &&
        node !== imip.id
      ) {
        references.push(node.start);
      }
    });
    expect(references).toEqual([]);
  });

  it("imports calUtils through exactly one call site, inside getCalNamespace", () => {
    const imports = [];
    walk(AST, node => {
      if (
        node.type === "CallExpression" &&
        node.callee.type === "MemberExpression" &&
        node.callee.property.name === "importESModule" &&
        node.arguments[0] &&
        node.arguments[0].value === CAL_UTILS_URL
      ) {
        imports.push(node);
      }
    });
    expect(imports).toHaveLength(1);

    const chokepoint = findFunctionDeclaration(AST, "getCalNamespace");
    expect(chokepoint).not.toBeNull();
    expect(imports[0].start).toBeGreaterThan(chokepoint.start);
    expect(imports[0].end).toBeLessThan(chokepoint.end);
  });

  it("every accessor call site obtains the service its consumer needs", () => {
    // Exhaustive equality, not a subset check or a threshold: adding, removing,
    // relocating or swapping any accessor call anywhere in the file fails here.
    expect(accessorCallSites(AST)).toEqual(EXPECTED_ACCESSOR_CALL_SITES);
  });

  it("still constructs calendar objects through the contracts that remain registered", () => {
    // Guards the other direction: this fix must not have swept away the
    // createInstance contracts, which Thunderbird still registers.
    for (const contract of LIVE_CONSTRUCTION_CONTRACTS) {
      expect(CODE_STRINGS, `${contract} disappeared`).toContain(contract);
    }
  });
});

describe("tmCalendar calendar-service acquisition — executed behaviour", () => {
  it("loads as a classic script without performing any XPCOM lookup", () => {
    // `Cc` throws on any property access, so merely loading the file proves it
    // resolves nothing through a contract ID at evaluation time.
    const { ctx, importUrls } = runScript({ cal: SENTINELS() });
    expect(typeof ctx.tmCalendar).toBe("function");
    expect(importUrls).toEqual([EXT_COMMON_URL]);
  });

  it("each accessor returns its own service", () => {
    // A swapped body (icsService returned for the timezone service, say) is a
    // one-token slip that leaves every static assertion above green.
    const cal = SENTINELS();
    const { ctx } = runScript({ cal });
    expect(ctx.getCalendarManager()).toBe(cal.manager);
    expect(ctx.getTimezoneService()).toBe(cal.timezoneService);
    expect(ctx.getIcsService()).toBe(cal.icsService);
  });

  it("each accessor returns null AND logs when the namespace lacks the service", () => {
    // Only the getCalendarManager callers branch on null (`if (!mgr)` in
    // listCalendarsInternal / queryCalendarItemsInternal); the timezone and ICS
    // consumers dereference immediately and rely on the enclosing try. So the
    // null contract matters, and so does the log: the Cc[].getService() this
    // replaced THREW on every failure and was therefore always loud. A bare
    // `cal[name] || null` would be strictly quieter than the code it replaced,
    // and a silent empty calendar list is the exact shape that made this outage
    // hard to diagnose. Pin both halves.
    const { ctx, consoleErrors } = runScript({ cal: {} });
    for (const name of ACCESSORS) {
      expect(ctx[name](), `${name} missing-service contract`).toBeNull();
    }
    expect(consoleErrors).toHaveLength(3);
    expect(consoleErrors.join("\n")).toContain("cal.manager");
    expect(consoleErrors.join("\n")).toContain("cal.timezoneService");
    expect(consoleErrors.join("\n")).toContain("cal.icsService");
  });

  // One service absent, the other two present. The all-absent case above cannot
  // see a sibling fallback: `getCalNamespace()[name] ?? getCalNamespace().manager`
  // returns null there too, so it stays green while, on a HEALTHY profile, every
  // timezone and ICS consumer silently receives the CALENDAR MANAGER instead --
  // `manager.UTC` and `manager.defaultTimezone` are undefined, so every ISO
  // conversion mis-anchors or throws, with no log at all. That is strictly worse
  // than the silent null this fix exists to prevent. Assert per-name identity,
  // because a global log count is defeated by any fallback that does not
  // double-log.
  for (const absent of ACCESSORS) {
    const service = SERVICE_OF[absent];
    it(`${absent} returns null while the others still return their own service`, () => {
      const cal = SENTINELS();
      delete cal[service];
      const { ctx, consoleErrors } = runScript({ cal });

      expect(ctx[absent](), `${absent} must not borrow a sibling service`).toBeNull();
      for (const other of ACCESSORS) {
        if (other === absent) continue;
        expect(ctx[other](), `${other} must be unaffected`).toBe(cal[SERVICE_OF[other]]);
      }
      // Exactly the absent one is reported, and by its own name.
      expect(consoleErrors).toHaveLength(1);
      expect(consoleErrors[0]).toContain(`cal.${service}`);
    });
  }

  it("each accessor returns null and logs when the calUtils import throws", () => {
    const { ctx, consoleErrors } = runScript({
      importCalUtils() {
        throw new Error("calUtils unavailable");
      },
    });
    for (const name of ACCESSORS) {
      expect(ctx[name](), `${name} import-failure contract`).toBeNull();
    }
    expect(consoleErrors).toHaveLength(3);
    expect(consoleErrors.join("\n")).toContain("cal.manager");
    expect(consoleErrors.join("\n")).toContain("cal.timezoneService");
    expect(consoleErrors.join("\n")).toContain("cal.icsService");
  });

  it("holds no module-level cache", () => {
    // Deliberate: a top-level cache binding in the experiment loader's shared
    // global is a hazard the source documents, and importESModule already
    // returns the one cached namespace per URL. Pin it so a future "optimise
    // this" edit has to argue with a red test.
    const { ctx, importUrls } = runScript({ cal: SENTINELS() });
    const before = importUrls.filter(url => url === CAL_UTILS_URL).length;
    ctx.getCalendarManager();
    ctx.getCalendarManager();
    ctx.getTimezoneService();
    const after = importUrls.filter(url => url === CAL_UTILS_URL).length;
    expect(after - before).toBe(3);
  });

  it("listCalendarsInternal uses the manager it acquired, and fails closed without one", () => {
    // A pinned call site proves the accessor is CALLED, not that its result is
    // USED: `getCalendarManager(); const mgr = null;` satisfies every static
    // assertion in this file while listCalendars returns empty forever. Only
    // executing the consumer catches that. This is the cheap pattern to copy
    // for the remaining getAPI consumers — a plain object stands in for the
    // manager; no XPCOM fake is needed.
    const cal = SENTINELS();
    cal.manager = {
      getCalendars: () => [
        {
          id: "cal-1",
          name: "Work",
          type: "caldav",
          uri: { spec: "https://example.com/dav" },
          readOnly: false,
        },
        { id: "cal-2", name: "", type: "storage", uri: null, readOnly: true },
      ],
    };
    const { ctx } = runScript({ cal });
    expect(ctx.listCalendarsInternal()).toEqual([
      {
        id: "cal-1",
        name: "Work",
        type: "caldav",
        uri: "https://example.com/dav",
        readOnly: false,
      },
      { id: "cal-2", name: "cal-2", type: "storage", uri: "", readOnly: true },
    ]);

    // No manager: fails closed with an empty list rather than inventing data.
    const { ctx: degraded } = runScript({ cal: {} });
    expect(degraded.listCalendarsInternal()).toEqual([]);
  });

  it("the getCalendars API uses the manager it acquired, and refuses without one", () => {
    // Kills the mutant that a pinned call site cannot see:
    //     getCalendarManager();
    //     const mgr = null;
    // substituted for `const mgr = getCalendarManager()` inside getCalendars.
    // That keeps exactly one accessor call in the same enclosing region, so the
    // exhaustive AST table stays byte-identical and the whole suite stays green,
    // while the live user-facing API reports "calendar manager unavailable" for
    // every valid profile. listCalendars is covered above via
    // listCalendarsInternal; getCalendars is the separate getAPI surface and
    // needs its own execution.
    const cal = SENTINELS();
    cal.manager = {
      getCalendars: () => [
        {
          id: "cal-1",
          name: "Work",
          type: "caldav",
          readOnly: false,
          uri: { spec: "https://example.com/dav" },
          getProperty: key => (key === "color" ? "#112233" : null),
        },
      ],
    };
    const { ctx } = runScript({ cal });
    const api = new ctx.tmCalendar().getAPI({}).tmCalendar;

    return api.getCalendars().then(res => {
      expect(res.ok, "getCalendars must succeed with a live manager").toBe(true);
      expect(res.calendars).toEqual([
        {
          id: "cal-1",
          name: "Work",
          type: "caldav",
          readOnly: false,
          color: "#112233",
          uri: "https://example.com/dav",
          organizer_email: null,
        },
      ]);

      // No manager: an explicit refusal, never a fabricated empty success.
      const { ctx: degraded } = runScript({ cal: {} });
      const degradedApi = new degraded.tmCalendar().getAPI({}).tmCalendar;
      return degradedApi.getCalendars().then(refusal => {
        expect(refusal).toEqual({
          ok: false,
          error: "calendar manager unavailable",
        });
      });
    });
  });

  it("toEpochMsUTC converts through the timezone service's UTC", () => {
    // Behavioural counterpart to the static consumer map: proves the value the
    // conversion actually consumes comes from the timezone service.
    const { ctx } = runScript({ cal: SENTINELS() });
    const utc = { __tz: "UTC" };
    const consulted = [];
    ctx.getTimezoneService = () => {
      consulted.push("timezoneService");
      return { UTC: utc };
    };
    ctx.getIcsService = () => {
      consulted.push("icsService");
      return {};
    };
    ctx.getCalendarManager = () => {
      consulted.push("manager");
      return {};
    };

    let receivedTimezone = null;
    const calDt = {
      getInTimezone(tz) {
        receivedTimezone = tz;
        return { year: 2026, month: 0, day: 2, hour: 3, minute: 4, second: 5 };
      },
    };

    expect(ctx.toEpochMsUTC(calDt)).toBe(Date.UTC(2026, 0, 2, 3, 4, 5));
    expect(consulted).toEqual(["timezoneService"]);
    expect(receivedTimezone).toBe(utc);
  });
});
