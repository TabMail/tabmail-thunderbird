# Chat System Architecture

> Sub-component documentation for `tabmail-thunderbird/chat/`.

---

## Overview

The chat system is the AI assistant interface. It handles user conversation, tool execution, finite state machines for multi-step actions, and experiment APIs for privileged operations.

---

## Directory Structure

```
chat/
├── background.js           # Message routing between chat UI and agent
├── chat.html               # Main chat window HTML
├── chat.js                 # Chat UI logic (rendering, input, scrolling)
├── chat.css                # Chat styling
│
├── experiments/            # Experiment APIs (privileged operations)
│   ├── glodaSearch/        # Thunderbird full-text search (Gloda)
│   ├── messageSelection/   # Get currently selected messages
│   ├── tmCalendar/         # Calendar read/write operations
│   └── tmWebFetch/         # Web page fetching
│
├── fsm/                    # Finite State Machines for multi-step actions
│   ├── core.js             # FSM engine (state transitions, validation)
│   ├── fsmExec.js          # FSM execution coordinator
│   ├── emailCompose.js     # Email compose flow
│   ├── emailArchive.js     # Email archive flow
│   ├── emailDelete.js      # Email delete flow
│   ├── calendarCreate.js   # Calendar event creation
│   ├── calendarDelete.js   # Calendar event deletion
│   ├── calendarEdit.js     # Calendar event editing
│   └── contactsDelete.js   # Contact deletion
│
├── tools/                  # Tool implementations (31 tools)
│   ├── core.js             # Tool registry: TOOL_IMPL map + getToolActivityLabel()
│   ├── email_search.js     # Search emails
│   ├── email_reply.js      # Reply to email
│   ├── email_forward.js    # Forward email
│   ├── email_delete.js     # Delete emails
│   ├── email_archive.js    # Archive emails
│   ├── email_compose.js    # Compose new email
│   ├── calendar_read.js    # Read calendar events
│   ├── calendar_create.js  # Create calendar event
│   ├── calendar_edit.js    # Edit calendar event
│   ├── calendar_delete.js  # Delete calendar event
│   ├── contacts_search.js  # Search contacts
│   ├── contacts_add.js     # Add contact
│   ├── contacts_edit.js    # Edit contact
│   ├── reminder_add.js     # Add reminder (v1.1.0+)
│   ├── reminder_del.js     # Delete reminder (v1.1.0+)
│   ├── change_setting.js   # Change notification settings (v1.1.0+)
│   ├── kb_*.js             # Knowledge base operations
│   ├── memory_*.js         # Memory/context operations
│   └── web_read.js         # Web page reading
│
└── modules/                # Support modules
    ├── converse.js         # Main conversation engine (LLM interaction)
    ├── persistentChatStore.js # Chat history persistence
    ├── context.js          # Context management (selected messages, etc.)
    ├── contacts.js         # Contact integration
    ├── markdown.js         # Markdown rendering
    ├── mentionAutocomplete.js # @mention autocomplete
    ├── wsTools.js          # WebSocket tool communication
    ├── sseTools.js         # Server-sent events handling
    └── [15+ more modules]
```

---

## Key Patterns

### Tool Registration
Every tool must be registered in `tools/core.js`:
1. Import the tool module
2. Add to `TOOL_IMPL` map (key = tool name from schema)
3. Add activity label in `getToolActivityLabel()`

### FSM Pattern
Complex user actions (email compose, calendar create, etc.) use a Finite State Machine:
- `fsm/core.js` — Engine: state transitions, user confirmation, validation
- `fsm/fsmExec.js` — Coordinator: dispatches FSM based on tool call
- Each FSM file defines states: list → preview → confirm → execute

### Experiment APIs
Custom privileged APIs that extend WebExtension capabilities:
- Each in its own subdirectory under `experiments/`
- Registered in `manifest.json` under `experiment_apis`
- Global names must be unique (ADR in thunderbird DECISIONS.md)
