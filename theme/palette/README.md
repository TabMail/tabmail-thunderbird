# TabMail Color Palette System

**Single Source of Truth** for all TabMail colors.

## 📁 Files in This Directory

- **`palette.data.json`** - 🎨 **ONLY** place where hex color values are defined
- **`palette.build.js`** - CSS generator functions (pure ES module)
- **`palette.js`** - Convenience wrapper with async loaders and helpers

## 🎯 Quick Start

### Content Scripts / ES6 Modules

```javascript
// Inject palette CSS (async)
import { injectPaletteIntoDocument } from '../theme/palette/palette.js';
await injectPaletteIntoDocument(document);

// Then use CSS variables everywhere
const insertBg = getComputedStyle(document.documentElement)
  .getPropertyValue('--tm-insert-bg-light').trim();
```

### Background Scripts / Pure Logic

```javascript
import { getTAG_COLORS, getBASE } from '../theme/palette/palette.js';

// All palette data is async (loaded from JSON)
const TAG_COLORS = await getTAG_COLORS();
const replyColor = TAG_COLORS.tm_reply; // '#00a300'
```

## 🎨 Color Reference

All values defined in `palette.data.json`:

### Base Colors (Metro UI)
```javascript
GREEN:      "#00a300"  // Reply, Insert
RED:        "#ee1111"  // Delete, Keep
YELLOW:     "#ffc40d"  // Archive
LIGHT_BLUE: "#eff4ff"  // None

TEXT_UNREAD_LIGHT: "#111"     // Unread (light mode)
TEXT_UNREAD_DARK:  "#e5e7eb"  // Unread (dark mode)
TEXT_READ_LIGHT:   "#666"     // Read (light mode)
TEXT_READ_DARK:    "#9ca3af"  // Read (dark mode)

SELECTION_BLUE:    "#8aaef5"  // Selection outline
HOVER_LIGHT:       "#888"     // Hover (light)
HOVER_DARK:        "#999"     // Hover (dark)
CURSOR_INDICATOR:  "#0078d4"  // Cursor jump indicators
```

### Opacity Levels
```javascript
SUBTLE_LIGHT:   0.10  // 10% - Non-selected (light)
SUBTLE_DARK:    0.12  // 12% - Non-selected (dark)
SELECTED_LIGHT: 0.40  // 40% - Selected (light)
SELECTED_DARK:  0.30  // 30% - Selected (dark)
```

### Generated CSS Variables

These are automatically generated and injected into the DOM:

#### Tag Colors
```css
--tag-tm-reply: #00a300
--tag-tm-delete: #ee1111
--tag-tm-archive: #ffc40d
--tag-tm-none: #eff4ff
--tag-tm-untagged: #eff4ff
```

#### Diff Colors (Light Mode)
```css
--tm-insert-bg-light: rgba(0,163,0,0.10)
--tm-insert-text-light: #666
--tm-insert-selbg-light: rgba(0,163,0,0.40)
--tm-insert-seltext-light: #666

--tm-delete-bg-light: rgba(238,17,17,0.10)
--tm-delete-text-light: inherit
--tm-delete-selbg-light: rgba(238,17,17,0.40)
--tm-delete-seltext-light: inherit
```

#### Diff Colors (Dark Mode)
```css
--tm-insert-bg-dark: rgba(0,163,0,0.12)
--tm-insert-text-dark: #9ca3af
--tm-insert-selbg-dark: rgba(0,163,0,0.30)
--tm-insert-seltext-dark: #9ca3af

--tm-delete-bg-dark: rgba(238,17,17,0.12)
--tm-delete-text-dark: inherit
--tm-delete-selbg-dark: rgba(238,17,17,0.30)
--tm-delete-seltext-dark: inherit
```

#### UI Colors
```css
--tm-cursor-indicator: #0078d4
--tm-selection-blue: #8aaef5
--tm-hover-light: #888
--tm-hover-dark: #999
--tm-text-unread-light: #111
--tm-text-unread-dark: #e5e7eb
--tm-text-read-light: #666
--tm-text-read-dark: #9ca3af
```

## 📖 Usage Examples

### 1. Content Scripts (Compose, Chat)

```javascript
import { injectPaletteIntoDocument } from '../theme/palette/palette.js';

// Inject CSS variables (async - don't block)
(async () => {
  try {
    const paletteModule = await import(browser.runtime.getURL('theme/palette/palette.js'));
    await paletteModule.injectPaletteIntoDocument(document);
    console.log('Palette CSS injected');
  } catch (err) {
    console.error('Failed to inject palette:', err);
  }
})();

// Then use CSS variables
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

const insertBg = cssVar('--tm-insert-bg-light');
```

### 2. ES6 Modules (Background, Agent)

```javascript
import { getTAG_COLORS, getBASE, getThemeColor } from '../theme/palette/palette.js';

// Load colors (async)
const TAG_COLORS = await getTAG_COLORS();
const BASE = await getBASE();

console.log(TAG_COLORS.tm_reply);  // '#00a300'
console.log(BASE.GREEN);            // '#00a300'

// Theme-aware color lookup
const insertBg = await getThemeColor('insert.bg');
```

### 3. Experiment Parent (Privileged)

```javascript
// In tmTheme.sys.mjs
async function loadPaletteJSON(context) {
  const url = context.extension.getURL("theme/palette/palette.data.json");
  // Load via NetUtil.asyncFetch (see tmTheme.sys.mjs)
  return JSON.parse(text);
}

async function loadBuilderModule(context) {
  const url = context.extension.getURL("theme/palette/palette.build.js");
  try {
    return await import(url);
  } catch (e) {
    // Fallback: sandbox eval (see tmTheme.sys.mjs)
  }
}

// Build CSS for AGENT_SHEET
const P = await loadPaletteJSON(context);
const mod = await loadBuilderModule(context);
const css = mod.buildPaletteCSSFromData(P);
```

## 🏗️ Architecture

### How It Works

```
palette.data.json (hex colors + opacities)
    ↓
    ├─→ MV3/Content Scripts:
    │   └─→ fetch() via browser.runtime.getURL()
    │       └─→ palette.build.js generates CSS vars
    │           └─→ Injected into DOM via <style> tag
    │
    └─→ Experiment (Privileged):
        └─→ NetUtil.asyncFetch() via context.extension.getURL()
            └─→ palette.build.js generates CSS vars
                └─→ Registered as AGENT_SHEET (data URI)
```

### Why JSON + Fetch?

1. **True Single Source** - Only `palette.data.json` has hex values
2. **No Trusted-Scheme Issues** - Works in all contexts (MV3 + Experiments)
3. **Cache-Friendly** - Loaded once, then cached
4. **Extensible** - Easy to add fonts, spacings, etc.
5. **Tooling-Ready** - JSON can be validated, generated, analyzed

### Context Differences

| Context | Load Method | Builder | Injection |
|---------|-------------|---------|-----------|
| **Content Script** | `fetch()` + `browser.runtime.getURL()` | Dynamic `import()` | `<style>` tag |
| **Background** | `fetch()` + `browser.runtime.getURL()` | Dynamic `import()` | N/A (uses JS helpers) |
| **Experiment** | `NetUtil.asyncFetch()` | Sandbox eval (fallback) | AGENT_SHEET |

## 🔧 Maintenance

### Updating Colors

**ONE place to edit: `palette.data.json`**

1. Edit `palette.data.json` - Change hex or opacity
2. Reload extension - All contexts pick up changes
3. No code changes needed!

Example:
```json
{
  "BASE": {
    "GREEN": "#00b300"  // Changed from #00a300
  }
}
```

### Adding New Colors

1. Add to `palette.data.json`:
   ```json
   {
     "BASE": {
       "PURPLE": "#9b59b6"
     }
   }
   ```

2. Update `palette.build.js` if new CSS variables needed:
   ```javascript
   --tm-purple: ${BASE.PURPLE};
   ```

3. Update this README
4. Reload extension!

### Adding New Semantic Colors

1. Define in `palette.build.js`:
   ```javascript
   --tm-purple-bg-light: rgba(155,89,182,${OPACITY.SUBTLE_LIGHT});
   ```

2. Use in your code:
   ```javascript
   const bg = cssVar('--tm-purple-bg-light');
   ```

## ✅ Best Practices

### DO:
✅ Always use CSS variables in UI code  
✅ Load colors async in background scripts  
✅ Edit `palette.data.json` for color changes  
✅ Use semantic names (`--tm-insert-bg-light`)  
✅ Document color mappings in comments  

### DON'T:
❌ Hardcode hex values (`#00a300`)  
❌ Hardcode rgba values (`rgba(0,163,0,0.1)`)  
❌ Duplicate color values in multiple files  
❌ Use inline opacity calculations  
❌ Skip the async loading (background scripts)  

### Good Example
```javascript
// ✅ GOOD: Use CSS variable
element.style.backgroundColor = cssVar('--tm-insert-bg-light');

// ✅ GOOD: Async load
const TAG_COLORS = await getTAG_COLORS();
const color = TAG_COLORS.tm_reply;
```

### Bad Example
```javascript
// ❌ BAD: Hardcoded
element.style.backgroundColor = 'rgba(0, 163, 0, 0.10)';

// ❌ BAD: Sync access (won't work!)
import { TAG_COLORS } from './palette.js';
console.log(TAG_COLORS.tm_reply); // undefined!
```

## 🔍 Color Mapping Reference

### Tag → Base Color
```
tm_reply   → GREEN      (#00a300)
tm_delete  → RED        (#ee1111)
tm_archive → YELLOW     (#ffc40d)
tm_none    → LIGHT_BLUE (#eff4ff)
tm_untagged → LIGHT_BLUE (#eff4ff)
```

### Diff → CSS Variables
```
Insert (light, non-selected) → --tm-insert-bg-light
Insert (light, selected)     → --tm-insert-selbg-light
Insert (dark, non-selected)  → --tm-insert-bg-dark
Insert (dark, selected)      → --tm-insert-selbg-dark

Delete (light, non-selected) → --tm-delete-bg-light
Delete (light, selected)     → --tm-delete-selbg-light
Delete (dark, non-selected)  → --tm-delete-bg-dark
Delete (dark, selected)      → --tm-delete-selbg-dark
```

### Email Row → CSS Variables
```
Non-selected (light) → --tm-opacity-subtle-light (10%)
Non-selected (dark)  → --tm-opacity-subtle-dark  (12%)
Selected (light)     → --tm-opacity-sel-light    (40%)
Selected (dark)      → --tm-opacity-sel-dark     (30%)

Unread text (light)  → --tm-text-unread-light
Unread text (dark)   → --tm-text-unread-dark
Read text (light)    → --tm-text-read-light
Read text (dark)     → --tm-text-read-dark
```

## 🐛 Troubleshooting

### Colors not updating after JSON change
- Reload the extension completely
- Clear any caches (`context.__tmTheme`, etc.)

### "Cannot read property of undefined"
- Make sure you're using `await` with async functions:
  ```javascript
  const TAG_COLORS = await getTAG_COLORS(); // ✅ Correct
  const TAG_COLORS = getTAG_COLORS();       // ❌ Wrong!
  ```

### CSS variables undefined
- Check that palette CSS was injected:
  ```javascript
  document.querySelector('style[data-tabmail="palette"]'); // Should exist
  ```

### Theme switch not working
- Check console for AGENT_SHEET re-registration logs
- Verify cache-buster timestamp is changing
- Force style recalc with `getComputedStyle()`

## 📚 Related Files

- `palette.data.json` - Single source of truth
- `palette.build.js` - CSS builder functions
- `palette.js` - Async loaders and helpers
- `../../experiments/tmTheme/tmTheme.sys.mjs` - Experiment integration
- `../../compose/modules/config.js` - Uses CSS variables

## 🎓 Learning Resources

- [CSS Custom Properties (MDN)](https://developer.mozilla.org/en-US/docs/Web/CSS/--*)
- [WebExtension Experiments (MDN)](https://firefox-source-docs.mozilla.org/toolkit/components/extensions/webextensions/basics.html)
- [NetUtil Documentation](https://firefox-source-docs.mozilla.org/dom/ioutils.html)

## 📝 Changelog

### v2.0 (Current) - JSON-Based Architecture
- Single source: `palette.data.json`
- Async loading everywhere
- Works in MV3 + Experiments
- No code duplication

### v1.0 - JS-Based Architecture
- Colors defined in `palette.js`
- Synchronous exports
- Required keeping Experiment colors in sync manually

