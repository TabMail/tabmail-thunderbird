# TabMail Thunderbird Add-on - Project Structure

> **Directory tree, entry points, and sub-component map.** Update when the structure changes.

**Last updated:** 2026-02-16

---

## Directory Tree

```
tabmail-thunderbird/
├── manifest.json                # MV3 WebExtension manifest (version source of truth)
│
├── agent/                       # Background agent: email processing & actions
│   ├── background.js           # Agent init & message routing
│   ├── experiments/            # Experiment APIs (tmHdr, tmMsgNotify)
│   ├── modules/                # 46 core modules (LLM, message processing, auth, storage)
│   └── pages/                  # Agent UI pages
│
├── chat/                        # Chat interface & AI interaction
│   ├── background.js           # Chat background message routing
│   ├── chat.html / .js / .css  # Main chat window
│   ├── experiments/            # Experiment APIs (glodaSearch, tmCalendar, tmWebFetch, messageSelection)
│   ├── fsm/                    # Finite State Machines (email, calendar, contacts actions)
│   ├── tools/                  # 31 chat tool implementations
│   │   └── core.js             # Tool registry — update when adding tools
│   └── modules/                # 20+ support modules (converse, persistence, context, markdown)
│
├── chatlink/                    # ChatLink integration (WhatsApp bridge)
│   ├── background.js           # ChatLink background routing
│   └── modules/                # ChatLink modules
│
├── compose/                     # Email composition enhancement
│   ├── background.js           # Compose background routing
│   ├── compose-autocomplete.js # Autocomplete for compose window
│   ├── libs/                   # Utility libraries
│   └── modules/                # 16 modules (core, edit, diff, undo, caret, state)
│
├── config/                      # Settings UI & configuration
│   ├── config.html / .js / .css # Full settings page
│   ├── modules/                # 22 settings modules (storage, UI, privacy)
│   └── tweaks/                 # Tweak configurations
│
├── fts/                         # Full-Text Search engine
│   ├── engine.js               # Search engine
│   ├── indexer.js              # Main indexer
│   ├── incrementalIndexer.js   # Incremental indexing
│   ├── nativeEngine.js         # Native messaging bridge to tabmail-native-fts
│   ├── memoryIndexer.js        # In-memory indexing
│   └── maintenanceScheduler.js # Index maintenance
│
├── gui/                         # GUI tweaks & preferences
│   ├── tweaks.js               # GUI tweaks implementation
│   ├── experiments/            # Experiment APIs (tmPrefs, tmTweaks, tmUpdates)
│   └── modules/                # 10 GUI modules
│
├── keepalive/                   # Background keepalive mechanism
│   ├── background.js           # Keepalive service
│   ├── relay.html / .js        # Relay page
│   ├── content/                # Content scripts
│   └── experiments/            # tmKeepAlive experiment
│
├── popup/                       # Action popup UI
│   ├── popup.html / .js / .css # Popup interface
│   └── auth/                   # Auth window management
│
├── prompts/                     # User prompt management UI
│   ├── prompts.html / .js / .css # Prompts settings page
│   ├── user_action.md          # Action prompt template
│   ├── user_composition.md     # Composition prompt template
│   ├── user_kb.md              # Knowledge base prompt template
│   └── modules/                # 6 prompt modules (history, storage, reminders)
│
├── templates/                   # Email template management
│   ├── templates.html / .js / .css
│   └── default_templates.json  # Default template definitions
│
├── theme/                       # Visual theming & styling
│   ├── background.js           # Theme initialization
│   ├── palette/                # Color palette system
│   │   ├── palette.data.json   # Color definitions (single source of truth)
│   │   ├── palette.js          # Palette runtime
│   │   └── palette.build.js    # Palette builder
│   ├── experiments/            # 13+ experiments (card/table view, tooltips, keyboard, etc.)
│   └── modules/                # 17 modules (bubble renderers, theme switcher, snippets)
│
├── welcome/                     # Onboarding flow
│   ├── welcome.html / .js / .css
│   ├── assets/                 # 19 asset directories
│   ├── pages/                  # 16 welcome pages
│   └── modules/                # 16 welcome modules
│
├── icons/                       # SVG icon assets
└── marketplace/                 # Marketplace UI
```

---

## Background Script Load Order

From `manifest.json`, these background scripts initialize in order:
1. `keepalive/background.js` — Keeps service worker alive
2. `theme/background.js` — Theme system
3. `agent/background.js` — Email agent
4. `compose/background.js` — Compose features
5. `chat/background.js` — Chat interface
6. `chatlink/background.js` — Chat linking

---

## Sub-Component Documentation

For detailed documentation on complex sub-components, see:
- [chat/ARCHITECTURE.md](chat/ARCHITECTURE.md) — Chat system, tools, FSM
- [agent/ARCHITECTURE.md](agent/ARCHITECTURE.md) — Agent modules and processing pipeline
- [theme/README.md](theme/README.md) — Theme system (existing)
- [theme/README_ARCHITECTURE.md](theme/README_ARCHITECTURE.md) — Theme architecture (existing)
- [theme/palette/README.md](theme/palette/README.md) — Palette system (existing)
- [fts/README.md](fts/README.md) — FTS engine (existing)

---

## File Statistics

| Directory | JS Files | HTML | CSS | Purpose |
|-----------|----------|------|-----|---------|
| agent/ | 46+ | — | — | Email agent, LLM, processing |
| chat/ | 50+ | 1 | 1 | Chat UI, tools, FSM |
| compose/ | 16+ | — | — | Compose enhancement |
| theme/ | 17+ | — | — | Theming, rendering |
| config/ | 22+ | 1 | 1 | Settings UI |
| fts/ | 11 | — | — | Full-text search |
| welcome/ | 31+ | 1 | 1 | Onboarding |
| **Total** | **~220** | **28** | **10** | |
