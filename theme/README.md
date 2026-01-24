# TabMail Theme System

This directory contains the theme and color system for TabMail.

## 📁 Directory Structure

```
theme/
├── palette/                    # 🎨 Color palette system (single source of truth)
│   ├── palette.data.json      # All hex color values defined here
│   ├── palette.build.js       # CSS generator functions
│   ├── palette.js             # Async loaders and helpers
│   └── README.md              # Complete palette documentation
│
└── experiments/
    └── tmTheme/               # Experiment for AGENT_SHEET registration
        ├── tmTheme.sys.mjs    # Loads palette and registers CSS globally
        └── theme.css          # DEPRECATED (kept for reference only)
```

## 🎨 Color Palette System

All colors are defined in **one place**: `palette/palette.data.json`

The system automatically:
- ✅ Loads colors from JSON
- ✅ Generates CSS variables
- ✅ Injects into DOM (content scripts)
- ✅ Registers as AGENT_SHEET (experiment)
- ✅ Adapts to light/dark mode

**See [`palette/README.md`](palette/README.md) for complete documentation.**

## 🚀 Quick Start

### Using Colors in Content Scripts

```javascript
// Palette is auto-injected by compose-autocomplete.js
// Just read CSS variables:
const insertBg = getComputedStyle(document.documentElement)
  .getPropertyValue('--tm-insert-bg-light').trim();
```

### Using Colors in Background Scripts

```javascript
import { getTAG_COLORS } from '../theme/palette/palette.js';

const TAG_COLORS = await getTAG_COLORS();
console.log(TAG_COLORS.tm_reply); // '#00a300'
```

## 📝 Updating Colors

1. Edit `palette/palette.data.json`
2. Reload extension
3. Done!

No code changes needed - everything updates automatically.

## 📚 Documentation

- **[palette/README.md](palette/README.md)** - Complete color system documentation
- **[README_ARCHITECTURE.md](README_ARCHITECTURE.md)** - System architecture and data flow
- **Color Reference** - See palette/README.md
- **Best Practices** - See palette/README.md

## 🔧 Experiment (tmTheme)

The `experiments/tmTheme/` directory contains a Thunderbird WebExtension Experiment
that registers the theme CSS as an AGENT_SHEET for zero-blink rendering.

Key features:
- Loads `palette.data.json` via `NetUtil.asyncFetch()`
- Dynamically generates CSS from JSON using `palette.build.js`
- Loads static styling rules from `theme.css`
- Combines both and registers as AGENT_SHEET with cache-busting
- Handles theme changes (light/dark mode)
- Zero-blink tag color updates

**Architecture:**
```
palette.data.json (colors) + theme.css (rules) → AGENT_SHEET
```

See [README_ARCHITECTURE.md](README_ARCHITECTURE.md) for detailed system design.

## 🎯 Design Goals

1. **Single Source of Truth** - Only `palette.data.json` has hex values
2. **No Duplication** - Colors generated, never copied
3. **Theme-Aware** - Automatic light/dark mode support
4. **Zero Blinks** - AGENT_SHEET prevents FOUC
5. **Maintainable** - Change colors in one place

## 🔗 Related Files

- `compose/compose-autocomplete.js` - Injects palette into compose windows
- `compose/modules/config.js` - Reads colors from CSS variables
- `agent/modules/tagHelper.js` - Uses tag colors for message tagging

---

For complete documentation, see **[palette/README.md](palette/README.md)**

