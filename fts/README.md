# FTS (Full Text Search) Module

This directory contains the extension-side FTS integration for TabMail's local full-text search functionality.

> **Note**: TabMail uses a **native FTS helper** (Rust binary with bundled SQLite + FTS5) for search indexing. WASM-based FTS was deprecated due to deployment difficulties with OPFS and service worker limitations.

## Architecture

```
Thunderbird Extension (JavaScript)
    ↕ Native Messaging API (stdin/stdout)
Rust Native Host Binary (`fts_helper`)
    ↕ Direct SQLite access
FTS Database (per Thunderbird profile)
```

## Module Structure

- **engine.js** - Main orchestrator (RPC to native host, commands, keepalive, hot-reload)
- **indexer.js** - Throttled crawler with backpressure and checkpoints  
- **bodyExtract.js** - MIME to plaintext extractor
- **worker.js** - Legacy WASM worker (deprecated, kept for reference)

## Native FTS Helper

The native helper is a standalone Rust binary that:
- Bundles SQLite with FTS5 support
- Communicates via Thunderbird's native messaging API
- Stores the FTS database in the Thunderbird profile directory
- Supports self-updating from CDN

### Installation

For end users, the native FTS helper is installed automatically by the TabMail installer (macOS .pkg, Windows .exe, Linux package).

On first run, the helper auto-migrates to a user-local directory to enable self-updates.

### Database Location (Per-Profile)

- **macOS**: `~/Library/Thunderbird/Profiles/<profile>/browser-extension-data/thunderbird@tabmail.ai/tabmail_fts/fts.db`
- **Linux**: `~/.thunderbird/<profile>/browser-extension-data/thunderbird@tabmail.ai/tabmail_fts/fts.db`  
- **Windows**: `%APPDATA%\Thunderbird\Profiles\<profile>\browser-extension-data\thunderbird@tabmail.ai\tabmail_fts\fts.db`

## A/B Testing

To enable FTS search, set `useFtsSearch: true` in `chat/modules/chatConfig.js`.
The system will fall back to Gloda search if `useFtsSearch: false`.

## Search Quality Features

The native FTS helper includes:

- **Porter stemmer** for English word stemming ("running" → "run")
- **Email-specific synonyms** (~100 curated synonym groups)
- **BM25 column weights** (subject: 5.0, from: 3.0, to: 2.0, body: 1.0)

The native FTS helper is source-available:
**[github.com/TabMail/tabmail-native-fts](https://github.com/TabMail/tabmail-native-fts)**

## Logs

Native helper logs are written to: `~/.tabmail/logs/fts_helper.log`

Logs automatically rotate at 10MB with 5 backup files.

## Why Native Instead of WASM?

The original WASM-based FTS (SQLite WASM + OPFS) was deprecated due to:

1. **OPFS limitations** - Origin Private File System had inconsistent browser support and reliability issues
2. **Service worker timeouts** - Chrome MV3's ~30s idle timeout made long-running index operations unreliable
3. **Deployment complexity** - Bundling WASM files and handling async initialization was fragile
4. **Performance** - Native SQLite is faster than WASM for large mailboxes

The native helper solves all these issues with a single self-contained binary per OS.
