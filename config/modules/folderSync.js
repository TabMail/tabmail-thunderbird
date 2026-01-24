import { $ } from "./dom.js";

// Folder Sync functionality
const FS_PREFS = {
  ALL: "mail.check_all_imap_folders_for_new",
  EN: "mail.server.default.check_new_mail",
  MINS: "mail.server.default.check_time",
  LYT: "mail.pane_config.dynamic",
  CARD: "mail.threadpane.listview", // 1 = table view, 0 = card view
};

export async function fsLoad() {
  try {
    // Test if experiment is working at all
    console.log("[TMDBG Config] Testing tmPrefs availability:", typeof browser.tmPrefs);
    if (!browser.tmPrefs) {
      console.error("[TMDBG Config] tmPrefs not available!");
      return;
    }

    // Test what methods are available
    console.log("[TMDBG Config] Available methods:", Object.keys(browser.tmPrefs));
    console.log("[TMDBG Config] getBoolSafe type:", typeof browser.tmPrefs.getBoolSafe);

    // Test bridge with simple method
    console.log("[TMDBG Config] Testing bridge with test() method");
    try {
      const testResult = await browser.tmPrefs.test();
      console.log("[TMDBG Config] Bridge test successful:", testResult);
    } catch (e) {
      console.error("[TMDBG Config] Bridge test failed:", e);
      return;
    }

    const all = await browser.tmPrefs.getBoolSafe(FS_PREFS.ALL, false);
    const en = (await browser.tmPrefs.getIntSafe(FS_PREFS.EN, 0)) === 1;
    const mn = await browser.tmPrefs.getIntSafe(FS_PREFS.MINS, 5);
    const ly = await browser.tmPrefs.getIntSafe(FS_PREFS.LYT, 2);

    $("fs-val-all").textContent = String(all);
    $("fs-val-periodic").textContent = String(en);
    $("fs-val-mins").textContent = String(mn || 5);
    $("fs-val-layout").textContent =
      ({ 0: "Classic", 1: "Wide", 2: "Vertical" }[ly] ?? String(ly));

    $("fs-in-all").checked = !!all;
    $("fs-in-periodic").checked = !!en;
    $("fs-in-mins").value = mn > 0 ? mn : 5;
    $("fs-in-layout").value = String([0, 1, 2].includes(ly) ? ly : 2);
  } catch (e) {
    console.error("[TMDBG Config] fsLoad failed:", e);
  }
}

export async function fsApply() {
  try {
    const all = $("fs-in-all").checked;
    const en = $("fs-in-periodic").checked;
    const mins = Math.max(1, parseInt($("fs-in-mins").value || "5", 10));
    const lyt = parseInt($("fs-in-layout").value, 10);

    await browser.tmPrefs.setBool(FS_PREFS.ALL, all);
    await browser.tmPrefs.setPeriodicForAllServers(mins, en);

    // We do NOT force layout on every save; only set if user explicitly changes it here.
    try {
      await browser.tmPrefs.setInt(FS_PREFS.LYT, lyt);
    } catch {}

    await fsLoad();
  } catch (e) {
    console.error("[TMDBG Config] fsApply failed:", e);
  }
}

