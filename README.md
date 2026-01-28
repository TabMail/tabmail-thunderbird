# TabMail Thunderbird Add-on (MV3, Thunderbird 145+)

TabMail is a Thunderbird add-on that adds:
- A chat-based assistant for email + calendar workflows
- Smart compose/autocomplete in the composer
- Local full-text search (native FTS helper) for fast retrieval

This add-on targets **Thunderbird MV3** and uses **experiments sparingly** for Thunderbird-specific integration points.

---

## Architecture (high level)

```
Thunderbird (local mail + calendars)
  ├─ chat/        (UI + tool orchestration + FSM workflows)
  ├─ agent/       (message workflows, tagging, summarization, reminders)
  ├─ compose/     (autocomplete + editing UX)
  ├─ fts/         (local search index + memory; native host required)
  ├─ theme/       (palette-based theming + UI tweaks)
  ├─ config/      (options UI)
  ├─ prompts/     (custom user prompts)
  ├─ templates/   (email templates)
  ├─ marketplace/ (community template marketplace)
  ├─ welcome/     (onboarding wizard)
  └─ popup/       (browser action popup + auth)
        │
        │ Supabase auth (OAuth popup → `tabmail.ai/auth/tb-callback`)
        ▼
Cloudflare Worker backend (`api.tabmail.ai` / `dev.tabmail.ai`)
  ├─ Bearer token auth + consent gate
  ├─ Entitlements from KV + quota/throttle via usage worker
  └─ LLM completions + server tools
```

---

## Key directories

The add-on is split into several MV3 “background modules” (see `manifest.json` → `background.scripts`):

### Core modules

- **`agent/`**: Message workflows (processing, tagging, summaries, reminders), plus some privileged integrations via experiments.
- **`chat/`**: Chat window UI (`chat.html`/`chat.js`/`chat.css`), tool orchestration, and chat-specific modules.
  - `chat/tools/` — Tool implementations for email, calendar, contacts, web, and knowledge base operations.
  - `chat/fsm/` — Finite state machines for multi-step workflows (compose, delete, archive, calendar CRUD, etc.).
  - `chat/modules/` — Core chat functionality (context, converse, markdown, SSE/WS tools, etc.).
- **`compose/`**: Composer integration for smart compose and inline edits.
- **`fts/`**: Local search/indexing via native FTS helper (required); see `fts/README.md`.

### UI and configuration

- **`theme/`**: Theme system + palette; see `theme/README.md` and `theme/palette/README.md`.
- **`config/`**: Options UI and settings modules.
- **`gui/`**: UI tweaks and layout helpers (some via experiments).
- **`popup/`**: The extension popup and auth helpers.
- **`welcome/`**: Onboarding wizard with multi-page setup flow.

### User customization

- **`prompts/`**: Custom user prompts UI — allows users to define custom action, composition, and knowledge base prompts.
- **`templates/`**: Email templates system — user-defined email templates with variable substitution.
- **`marketplace/`**: Community template marketplace — browse and install shared templates.

### Support

- **`keepalive/`**: Keep-alive and lifecycle helpers (via experiment `tmKeepAlive`).
- **`icons/`**: SVG icons used by the add-on (tab icon, sort icons, view mode icons).

---

## Experiments

Experiments are defined in `manifest.json` under `experiment_apis` and implemented under the corresponding `*/experiments/` folders.

Use experiments only when the Thunderbird WebExtension API cannot provide the needed integration point.

Current experiments by module:

| Module | Experiments |
|--------|-------------|
| `keepalive/` | `tmKeepAlive` |
| `chat/` | `tmCalendar`, `glodaSearch`, `messageSelection`, `tmWebFetch` |
| `agent/` | `tmMsgNotify`, `tmHdr` |
| `theme/` | `keyOverride`, `threadTooltip`, `tagSort`, `threadPaneDisplayToggle`, `tmTheme`, `tmMessageListCardView`, `tmMessageListTableView`, `tmPreviewGate`, `threadMessages` |
| `gui/` | `tmPrefs`, `tmTweaks`, `tmUpdates` |

---

## Theming

All colors come from the palette system:
- **Source of truth**: `theme/palette/palette.data.json`
- **Docs**: `theme/palette/README.md`
- **Theme system overview**: `theme/README.md`
- **Architecture deep dive**: `theme/README_ARCHITECTURE.md`

---

## Full-text search (FTS)

FTS is implemented in `fts/` and uses a **native messaging host** (Rust binary with bundled SQLite + FTS5) for fast local indexing.

**The native FTS helper is required** — it powers both email search and chat memory features.

The native FTS helper is source-available: **[github.com/TabMail/tabmail-native-fts](https://github.com/TabMail/tabmail-native-fts)**

### Features

- **Email search** — Fast full-text search across all indexed emails with stemming, synonyms, and BM25 ranking. Also provides fast access to email content and metadata.
- **Memory search** — Chat history is indexed locally, allowing the agent to recall past conversations
- **Memory read** — Retrieve full chat sessions by timestamp for context continuity

See `fts/README.md` for architecture and operational notes.

---

## Backend integration

The add-on calls the TabMail backend at:
- Production: `https://api.tabmail.ai`
- Development: `https://dev.tabmail.ai`

Authentication is via Supabase access tokens; the add-on uses the hosted TB callback page:
- `https://tabmail.ai/auth/tb-callback`

Backend details (routing, auth, quota/throttle, endpoints) are to be released later as API docs.

---

## Development

- **Load temporarily**: Thunderbird → Tools → Developer Tools → Debug Add-ons → “Load Temporary Add-on” → select `tabmail-thunderbird/manifest.json`
- **Options page**: `config/config.html`
- **Chat shortcut**: see `manifest.json` → `commands.open-chat-window`

---

## License

This project is source-available and licensed under the
[PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0/).

- Free for non-commercial use
- Commercial use is not permitted without a separate license

Commercial licenses are available from Lisem AI Ltd.

See:
- [LICENSE](./LICENSE)
- [COMMERCIAL-LICENSE.md](./COMMERCIAL-LICENSE.md)

---

## Contributing

We welcome contributions! By submitting a pull request or other contribution,
you agree to our Contributor License Agreement.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for details.

---

## Trademarks

"TabMail" is a trademark of Lisem AI Ltd.
This license does not grant permission to use the TabMail name or branding.

See [TRADEMARKS.md](./TRADEMARKS.md).

