# TabMail Thunderbird Add-on - Claude Code Rules

> **STOP. Before answering, I must read ALL companion files listed below — both global and project-specific. I must also update them when I discover something new. This is mandatory for every task, every time — no exceptions. You MUST always state in your response that you have read the companion files, so you are reminded of this obligation in every answer.**

## Companion Files (READ BEFORE EVERY TASK)

Before starting any task in this project, read these files and update them when you learn something new:

**Global (parent directory):**
- **`../CLAUDE.md`** — Global rules that apply to all subprojects.
- **`../PROJECT_STRUCTURE.md`** — Monorepo layout, tech stack, component relationships.
- **`../PROJECT_MEMORY.md`** — Cross-cutting knowledge and workflows.
- **`../DECISIONS.md`** — Cross-cutting architectural decisions.

**This project:**
- **`PROJECT_STRUCTURE.md`** — Directory tree, entry points, sub-component map.
- **`PROJECT_MEMORY.md`** — Thunderbird add-on specific knowledge, patterns, quirks.
- **`DECISIONS.md`** — Thunderbird add-on specific architectural decisions.

**You MUST read all companion files before every task. Update them when you discover something new.**

---

## Development Rules

1. **TB 145 + MV3 only** — All code must target Thunderbird 145 API and Manifest V3.
2. **No inline code strings** — Use separate `.js` files.
3. **WebExtension API first** — Use Experiment APIs only when WebExtension API is insufficient.
4. **NEVER async `runtime.onMessage` handlers** — Breaks other listeners in Thunderbird.
5. **Clean up listeners and timers** — Always clean up on suspend/uninstall for hot-reload support.
6. **Logs, not console** — Add structured logs; never suggest using the browser console.
7. **Dark/light mode** — All CSS must respect both themes.
8. **Palette system** — All colors from `theme/palette/palette.data.json`.
9. **No fallback colors** — Theming issues must be visible, not silently degraded.
10. **Unique experiment globals** — Experiment API global names must not collide. Follow existing experiment patterns for syntax.

---

## Message Body Fetching

- **NEVER call `browser.messages.getFull()` directly** — always use `safeGetFull()` from `agent/modules/utils.js`.
- `safeGetFull()` provides: in-memory cache, native FTS lookup before IMAP, and concurrency control (`MAX_CONCURRENT_GETFULL`).
- Direct `getFull()` bypasses all of this and can starve the main thread when multiple callers compete for IMAP.
- The only place `browser.messages.getFull()` should appear is inside `safeGetFull()` itself (the final fallback).
- When `safeGetFull()` returns a synthetic result (`full.__tmSynthetic === true`), the body is already plain text in `full.body` — no MIME part traversal needed.

---

## Chat Agent Tools (Client-Side)

When creating a new client-side chat tool:

1. Create JSON schema: `../tabmail-backend/src/toolsThunderbird/<name>-v<version>.json`
2. Register in backend: update `../tabmail-backend/src/toolsThunderbird/index.ts`
3. Add to `allowed_tools` in `../tabmail-backend/src/config/systemPromptTiers.json`
4. Implement in `chat/tools/<name>.js` (export `run(args, options)`)
5. Register in `chat/tools/core.js`: import, add to `TOOL_IMPL`, add activity label in `getToolActivityLabel`

> **CRITICAL:** The version in the schema filename IS the minimum client version. Clients with version < that version won't see the tool.
