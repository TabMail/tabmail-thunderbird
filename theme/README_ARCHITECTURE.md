# TabMail Theme Architecture

## System Overview

The TabMail theme system uses a **JSON-based color palette** combined with **static CSS rules** to provide zero-blink, theme-aware styling for Thunderbird's email list views.

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                   SINGLE SOURCE OF TRUTH                     │
│              palette/palette.data.json                       │
│          (All hex colors and opacity values)                 │
└──────────────┬──────────────────────────────────────────────┘
               │
               ├──> MV3/Content Scripts
               │    └─> fetch() → palette.build.js → CSS vars → DOM
               │
               └──> Experiment (Privileged)
                    └─> NetUtil → palette.build.js → CSS vars → AGENT_SHEET
                         + theme.css (static rules)
```

## Core Components

### 1. **Color Palette System** (`palette/`)

**Purpose:** Centralized color management  
**Location:** `theme/palette/`

- **`palette.data.json`** - Single source of truth for all hex colors and opacities
- **`palette.build.js`** - Generates CSS custom properties from JSON
- **`palette.js`** - Async wrapper with helpers for MV3 contexts

**Example from JSON:**
```json
{
  "BASE": {
    "GREEN": "#00a300",
    "TEXT_READ_LIGHT": "#666"
  },
  "OPACITY": {
    "SUBTLE_LIGHT": 0.10
  }
}
```

**Generated CSS:**
```css
:root {
  --tag-tm-reply: #00a300;
  --tm-text-read-light: #666;
  --tm-insert-bg-light: rgba(0,163,0,0.10);
  /* ...and more */
}
```

### 2. **Static Theme Rules** (`theme.css`)

**Purpose:** CSS rules that consume palette variables  
**Location:** `theme/experiments/tmTheme/theme.css`

Contains styling rules for:
- Tag color tints (non-selected, selected)
- Read/unread text colors
- Hover effects
- Flagged items
- Table vs Card view differences

**Key Point:** No color values defined here - only references to palette CSS variables like `var(--tm-insert-bg-light)`.

### 3. **Experiment (MJS)** (`tmTheme.sys.mjs`)

**Purpose:** Privileged integration with Thunderbird  
**Location:** `theme/experiments/tmTheme/tmTheme.sys.mjs`

**Responsibilities:**
1. Load `palette.data.json` via `NetUtil.asyncFetch()` (privileged API)
2. Generate CSS variables using `palette.build.js`
3. Load `theme.css` (static rules)
4. Combine both and register as AGENT_SHEET
5. Apply per-message tag colors via `--tag-color` CSS variable
6. Handle theme changes (light/dark mode switches)

**Key Functions:**
- `loadPaletteJSON()` - Loads JSON via NetUtil
- `loadBuilderModule()` - Loads palette.build.js (with fallback)
- `buildPaletteCSSFromJSON()` - Generates CSS from JSON
- `loadStaticThemeCSS()` - Loads theme.css file
- `registerAgentSheet()` - Combines and registers as AGENT_SHEET

## Data Flow

### At Extension Startup:

```
1. Extension loads
   ↓
2. tmTheme.sys.mjs init() called
   ↓
3. Load palette.data.json (NetUtil.asyncFetch)
   ↓
4. Load palette.build.js (dynamic import or sandbox)
   ↓
5. Generate CSS variables from JSON
   ↓
6. Load theme.css (static rules)
   ↓
7. Combine: palette CSS + theme CSS
   ↓
8. Register as AGENT_SHEET (zero-blink, loaded before content)
   ↓
9. Attach observers for tag color updates
```

### When Theme Changes (Light/Dark Mode):

```
1. matchMedia detects theme change
   ↓
2. Unregister old AGENT_SHEET
   ↓
3. Re-generate CSS with cache-busting timestamp
   ↓
4. Register new AGENT_SHEET
   ↓
5. Force style recalculation on all documents
   ↓
6. Re-prime all visible rows
```

### When Message Tags Change:

```
1. Folder notification fires
   ↓
2. Get tag color from MailServices
   ↓
3. Find row element (light DOM or shadow DOM)
   ↓
4. Update --tag-color CSS variable
   ↓
5. CSS rules automatically update backgrounds
   (No blink - synchronous update before paint)
```

## Why AGENT_SHEET?

**AGENT_SHEET** is a Gecko/Firefox CSS injection mechanism that:
- ✅ Loads **before** content renders (no FOUC)
- ✅ Applies **globally** to all documents
- ✅ **Higher specificity** than user stylesheets
- ✅ Survives DOM rebuilds (TB frequently rebuilds email lists)

Without AGENT_SHEET, every time Thunderbird rebuilds the email list DOM:
- ❌ Brief flash of unstyled content
- ❌ Per-document CSS injection required
- ❌ Race conditions between CSS load and render

## Shadow DOM Handling

Thunderbird's `<mail-message-list>` uses Shadow DOM, which CSS doesn't penetrate.

**Solution:** Early patch of `connectedCallback`:
1. Detect when `<mail-message-list>` instances are created
2. Inject minimal CSS directly into shadowRoot **before** component renders
3. Attach MutationObserver to apply `--tag-color` synchronously as rows are created

This ensures zero blinks even inside Shadow DOM.

## File Structure

```
theme/
├── palette/                         # Color system
│   ├── palette.data.json           # 🎨 SINGLE SOURCE (hex colors)
│   ├── palette.build.js            # Generates CSS from JSON
│   ├── palette.js                  # MV3 wrapper with helpers
│   └── README.md                   # Complete palette documentation
│
├── experiments/tmTheme/
│   ├── tmTheme.sys.mjs             # Experiment integration
│   └── theme.css                   # Static CSS rules
│
├── README.md                        # Theme overview
└── README_ARCHITECTURE.md           # This file
```

## Making Changes

### To Update Colors:
1. Edit `palette/palette.data.json`
2. Reload extension
3. Done! All contexts update automatically

### To Update Styling Rules:
1. Edit `theme/experiments/tmTheme/theme.css`
2. Reload extension
3. Done! AGENT_SHEET re-registers with new content

### To Add New CSS Variables:
1. Add color to `palette/palette.data.json`
2. Update `palette/palette.build.js` to generate CSS var
3. Use the new var in `theme.css`
4. Reload extension

## Benefits of This Architecture

✅ **Zero Code Duplication** - Colors only in JSON  
✅ **Maintainable CSS** - Real CSS file with syntax highlighting  
✅ **Zero Blinks** - AGENT_SHEET loads before content  
✅ **Context-Agnostic** - Same system works in MV3 and Experiments  
✅ **Theme-Aware** - Automatic light/dark mode support  
✅ **Fast Updates** - Tag colors update synchronously  
✅ **Hot Reload Friendly** - Changes apply immediately  

## Related Documentation

- **[theme/README.md](README.md)** - Theme system overview
- **[theme/palette/README.md](palette/README.md)** - Complete palette documentation
- **[WebExtension Experiments](https://firefox-source-docs.mozilla.org/toolkit/components/extensions/webextensions/basics.html)** - Mozilla docs
- **[AGENT_SHEET](https://searchfox.org/mozilla-central/source/layout/style/nsIStyleSheetService.idl)** - Gecko docs

## Troubleshooting

### Colors not updating after JSON change?
- Hard reload extension (not just disable/enable)
- Check console for AGENT_SHEET registration logs

### Theme switch not working?
- Check for cache-buster timestamp in logs
- Verify unregister + re-register cycle

### Styles not applying in shadow DOM?
- Check that shadow style injection logs appear
- Verify shadowRoot exists on `<mail-message-list>`

---

**Last Updated:** After JSON-based palette refactor  
**Architecture Version:** 2.0 (JSON + Static CSS)
