# Agent System Architecture

> Sub-component documentation for `tabmail-thunderbird/agent/`.

---

## Overview

The agent is the background processing engine. It handles email classification, LLM interaction, knowledge base management, proactive notifications, and authentication. It runs as a background script and communicates with the chat system via `runtime.onMessage`.

---

## Directory Structure

```
agent/
├── background.js           # Agent init, message routing (main entry point)
│
├── experiments/            # Experiment APIs
│   ├── tmHdr/              # Email header inspection
│   └── tmMsgNotify/        # Message notification events
│
├── modules/                # 46 core modules
│   ├── llm.js              # LLM API calls (sendChat, sendChatWithTools, sendChatRaw)
│   ├── messageProcessor.js # Email processing & classification
│   ├── action.js           # Action execution
│   ├── supabaseAuth.js     # Supabase authentication
│   ├── folderResolver.js   # Folder name/ID resolution
│   ├── knowledgebase.js    # KB operations (update, compress, query)
│   ├── kbReminderGenerator.js # Reminder extraction from KB
│   ├── proactiveCheckin.js # Deterministic proactive notifications
│   ├── config.js           # Module configuration (notifications section)
│   ├── init.js             # Session initialization, chat history serialization
│   └── [35+ more modules]
│
└── pages/                  # Agent UI pages
```

---

## Key Modules

### `llm.js` — LLM Communication
- `sendChat()` — Chat with optional server-side tool execution
- `sendChatWithTools()` — Chat with client-side tool support
- `sendChatRaw()` — Raw LLM call (for KB operations)
- Includes `client_timezone` in payload when tools enabled

### `knowledgebase.js` — Knowledge Base
- **CRITICAL:** Every KB operation making an LLM call must call `saveChatLog()` afterward
- Operations: `kbUpdate`, `periodicKbUpdate`, `kbCompress`
- Uses `sendChatRaw()` for LLM calls

### `proactiveCheckin.js` — Proactive Notifications
- Deterministic (no LLM calls) — see ADR-015
- Two triggers: new reminder formed, due date approaching
- Deduplication via `reached_out` IDs per reminder hash
- Config in `config.js` → `notifications` section

### `init.js` — Session Initialization
- Serializes prior-session messages into text for system prompt injection
- Session breaks tracked for grey-out rendering but not sent as conversation turns

---

## Communication Pattern

```
agent/background.js
    ↕ runtime.onMessage (NEVER async handlers — ADR-007)
chat/background.js
    ↕ runtime.onMessage
chat/chat.js (UI)
```
