import { injectPaletteIntoDocument, isDarkMode, onThemeChange } from "../theme/palette/palette.js";

async function initTheme() {
  try {
    await injectPaletteIntoDocument(document);
  } catch (_) {}

  // Best-effort set basic vars for this simple window (avoid hardcoded colors).
  // If palette injection fails, we intentionally do not provide fallback colors.
  try {
    const dark = isDarkMode();
    document.documentElement.style.setProperty("--tm-bg", dark ? "var(--theme-bg)" : "var(--theme-bg)");
    document.documentElement.style.setProperty("--tm-fg", dark ? "var(--theme-fg)" : "var(--theme-fg)");
    document.documentElement.style.setProperty("--tm-border", "var(--theme-border)");
  } catch (_) {}

  try {
    onThemeChange(async () => {
      try { await injectPaletteIntoDocument(document); } catch (_) {}
    });
  } catch (_) {}
}

function qs(name) {
  try {
    return new URL(window.location.href).searchParams.get(name);
  } catch (_) {
    return null;
  }
}

async function main() {
  await initTheme();

  const count = Number(qs("count") || "1");
  const msg =
    count > 1
      ? `These ${count} messages are from you! TabMail does not classify your own emails — you already know best!`
      : "This message is from you! TabMail does not classify your own emails — you already know best!";

  const el = document.getElementById("msg");
  if (el) el.textContent = msg;

  const ok = document.getElementById("ok");
  if (ok) ok.addEventListener("click", () => window.close());
}

main();


