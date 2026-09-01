# Calendar services come from the `cal` namespace, never an XPCOM contract

Thunderbird de-XPCOM'd its calendar back end. `tmCalendar.sys.mjs` reached the calendar *services*
through `Cc[...]` contract IDs, and by Thunderbird 154 all three of those lookups were dead. Every
calendar feature failed with them: `listCalendars`, `getCalendars`, event create/edit/delete, and
every ISO ↔ `calIDateTime` conversion, because those go through `getCalendarManager()` and
`toCalIDateTime()`.

## What broke, exactly

| contract | state in Thunderbird 154 |
|---|---|
| `@mozilla.org/calendar/manager;1` | still registered, but `CalCalendarManager.sys.mjs` now does `export const CalCalendarManager = new (class {...})`. `components.conf` still names `CalCalendarManager` as the *constructor*, so XPCOM's JS component loader calls `new` on a plain object → `TypeError: (...) is not a constructor`, surfaced to the caller as `NS_ERROR_XPC_GS_RETURNED_FAILURE: ServiceManager::GetService returned failure code`. |
| `@mozilla.org/calendar/timezone-service;1` | identical shape, identical failure — `CalTimezoneService` is a singleton instance too. |
| `@mozilla.org/calendar/ics-service;1` | contract removed outright. It is in `calendar/base/src/components.conf` on ESR 128 and absent from current comm-central. |
| `@mozilla.org/calendar/itip-service;1` | contract *and* the `calIItipService` interface are gone (already absent on ESR 128). |
| `@mozilla.org/calendar/itip-transport;1` | never registered bare; only `...;1?type=email` is. Pre-existing, not an update regression. |

ESR 128 shipped `export function CalCalendarManager` / `export function CalTimezoneService`, so the
`getService()` calls genuinely used to work. The flip to singleton instances is what broke them.

## The rule

**Use `cal.manager`, `cal.timezoneService`, `cal.icsService`** from
`ChromeUtils.importESModule("resource:///modules/calendar/calUtils.sys.mjs")`. That URL and the
`cal` export are stable across the whole supported range: on older builds `cal.manager` was an
`XPCOMUtils.defineLazyServiceGetter` onto the same contract, and on current builds it is a
`ChromeUtils.defineESModuleGetters` onto the module. Both resolve, so one code path covers this
add-on's whole declared 140.0–155.* range.

⚠️ Scope this claim precisely. It is true that **no in-tree caller resolves `manager`,
`timezone-service` or `ics-service` through `Cc[...]` any more**. It is NOT true that Thunderbird has
stopped using `Cc[]` for calendar contracts generally: TB 154's `omni.ja` still contains ~38 such
lookups across ~23 files, spanning `ics-serializer;1`, `ics-parser;1`, `import;1?type=ics`,
`alarm-service;1`, `itip-item;1`, `calendar;1?type=memory`, `deleted-items-manager;1`,
`timezone-database;1`, `calendar;1?type=composite` and `alarm-monitor;1` — and two of those
(`alarm-service;1`, `deleted-items-manager;1`) are *services* reached via `getService()`. An earlier
draft of this file stated the absolute; it was wrong, and taking it at face value would invite a
future "sweep away the remaining `Cc[]`" edit that breaks the still-registered construction
contracts below.

Object *construction* contracts (`event;1`, `attendee;1`, `datetime;1`, `recurrence-rule;1`,
`recurrence-info;1`, `recurrence-date;1`, `ics-serializer;1`, `itip-item;1`) still register real
constructors and are deliberately left on `Cc[].createInstance`.

## Diagnosing this class

The tell is a `getService()` failing with `NS_ERROR_XPC_GS_RETURNED_FAILURE` **paired with** a
separate console `TypeError: ({...}) is not a constructor` whose dumped object is the service
singleton itself (it carries `contractID`, `classInfo`, `wrappedJSObject`). That pairing means the
contract is registered but its registered constructor is an instance — not that the service is
missing. To census the class without a running Thunderbird:
`strings -a /Applications/Thunderbird.app/Contents/MacOS/XUL` contains the static component
registry's contract strings one per entry, so an exact-line `grep -x` over it tells you whether a
contract is registered at all; then check the implementing module's `export` shape in
`omni.ja` (`export function X` = constructible, `export const X = new (class` = broken via XPCOM).
Watch the `?type=` suffix — a bare contract and a `contract?type=email` are different registrations.

## No module-level cache

`getCalNamespace()` re-imports on every call on purpose. `ChromeUtils.importESModule` already
returns the one cached namespace object per URL, so a local cache would buy nothing but a mutable
binding — and all 23 experiment parent scripts in this add-on execute into **one shared global**
(`SchemaAPIManager.global`; `loadModule` uses `Services.scriptloader.loadSubScript(module.url,
this.global)` on the sync path and `script.executeInGlobal(this.global)` on the async
`ChromeUtils.compileScript` path — both land in the same global), where every additional top-level
binding is one more thing to collide with a sibling experiment or to break on re-evaluation. Same
concern `theme/experiments/threadMessages/threadMessages.sys.mjs` documents in its "avoid top-level
block-scoped declarations" warning.

Note the honest limit of that argument: `tmCalendar.sys.mjs` **already** carries one top-level
`const` (the `ExtensionCommon` import), so re-evaluation would already throw regardless. "A cache
would break reload" is therefore not the reason — *the platform already caches the import, so the
cache is pure added state* is. `test/calendarServiceAcquisition.test.js` pins the cache-free
behaviour by counting imports across repeated accessor calls.

## Regression coverage

`test/calendarServiceAcquisition.test.js` (18 tests) uses **two overlapping instruments**, and the
reason is worth keeping: the first draft asserted against the source text with comment-stripping and
line-oriented regexes, and review defeated it four separate ways — a live XPCOM lookup parked between
two string literals containing `/*` and `*/` was erased wholesale by the comment stripper; a
`getService(` call split across lines slipped past a per-line regex; `getService(globalThis.Ci.calIFoo)`
slipped past a regex that required `Ci.` immediately after the paren; and a function's own
declaration satisfied its own "has ≥ 1 caller" count. **Do not fix that class with another regex.**

1. **`node:vm`** executes the real file exactly as Thunderbird does — as a classic script, so top-level
   function declarations become properties of the context global and can be called directly — against
   a stubbed `ChromeUtils.importESModule` and a `Cc` proxy that throws on any access. This asserts the
   accessors' actual return values (each returns *its own* service), the `null`-not-`undefined`
   contract, `null`-plus-log when the import throws, the absence of a cache, and that `toEpochMsUTC`
   takes UTC from the timezone service.
2. **`acorn`** (added as a devDependency for this) parses the file so the negative census is answered
   structurally: comments are not AST nodes, and a declaration is not a `CallExpression`, so all four
   defeats above dissolve rather than needing to be enumerated.

It asserts no reachable code path resolves a calendar service through XPCOM, that each consumer gets
the service it needs *and no other*, that `calUtils` is imported exactly once inside `getCalNamespace`,
and — the other direction — that the still-registered construction contracts were not swept away. The
unreachable WIP `sendCalendarInvitations` is the one exemption; a companion test counts every
reference to the identifier other than its own declaration, so an alias counts as a call site too.

⚠️ **Three durable lessons, each paid for with a review round. Do not re-derive them.**

1. **A per-consumer direction map must be EXHAUSTIVE, not a hand-listed subset.** The first map
   named the five standalone consumers and so guarded 5 of 15 accessor call sites; the other **9
   live inside the `getAPI` method body, and those nine are the entire user-facing calendar
   surface**. Four one-token mutants there left the whole suite green, including all seven `getAPI`
   manager sites returning `null` — every calendar feature dead. The companion "each accessor has
   ≥ 1 caller" check did not help: a global `> 0` threshold is already satisfied by the standalone
   consumers. Fix: one sorted table of every `<enclosing region chain> :: <accessor>` pair,
   asserted by equality, which also subsumes and deletes the threshold check.
2. **A pinned call site proves the accessor is CALLED, never that its result is USED.**
   `getCalendarManager(); const mgr = null;` satisfies every static assertion while
   `listCalendars` returns empty forever — and it survived all 3,923 tests. Only executing the
   consumer catches it, and doing so is cheap: a plain object stands in for the manager, no XPCOM
   fake required.
3. **A static census cannot win an arms race against computed forms** — a contract built by
   `Array.join`, `obj["get" + "Service"](…)`, `globalThis["sendCalendar" + "Invitations"]()`. Two
   such mutants survive by decision, recorded in `TESTS.md` and beside the census in the source.
   The answer is to execute one more consumer, never to add another pattern.

Generalisation covering all three: **a subset guard, a shape guard and a call-existence guard all
read exactly like a total guard in a passing run. Assert the whole enumeration, and assert
behaviour, not shape.**

17 mutants, 15 killed, 2 surviving by decision. Red-first against the shipped 1.7.4 bytes:
`11 failed | 7 passed (18)`.
