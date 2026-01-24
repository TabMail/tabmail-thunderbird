import { SETTINGS } from "./config.js";

const PREFS = {
  ALL_FOLDERS: "mail.check_all_imap_folders_for_new", // poll all subscribed folders
};

export async function enforceMailSyncPrefs({
  minutes = SETTINGS.mailSync.defaultCheckIntervalMinutes,
  oneTimeVerticalNudge = SETTINGS.mailSync.verticalLayoutOnInstall,
} = {}) {
  try {
    if (!browser.tmPrefs) {
      console.error("[TMDBG Prefs] tmPrefs API not available!");
      return;
    }

    // 1) Poll all subscribed folders (Archive/All Mail, Sent, etc.)
    await browser.tmPrefs.setBool("mail.check_all_imap_folders_for_new", true);
    console.log(`[TMDBG Prefs] Enabled checking all IMAP folders`);

    // 2) Periodic checks across existing and future IMAP servers
    await browser.tmPrefs.setPeriodicForAllServers(minutes, true);
    console.log(`[TMDBG Prefs] Set ${minutes}-minute sync for all IMAP servers`);

    // 3) UI tweaks were previously applied automatically on install (appearance + layout).
    // This has been migrated to explicit, apply-only "TabMail UI Tweaks" buttons so we
    // never silently overwrite user customizations.
    console.log(
      "[TMDBG Prefs] UI appearance/layout nudges are now user-triggered via Settings → TabMail UI Tweaks (no auto-apply)."
    );

    // Discovery logs: dump mail.threadpane.* branch to identify view settings in TB 141/142.
    try {
      if (typeof browser.tmPrefs.dumpBranch === "function") {
        const dump = await browser.tmPrefs.dumpBranch("mail.threadpane.");
        console.log(`[TMDBG Prefs] mail.threadpane.* branch dump:`, dump);
      } else {
        console.log(`[TMDBG Prefs] dumpBranch not available on tmPrefs; skipping branch dump`);
      }
    } catch (e) {
      console.warn(`[TMDBG Prefs] Failed dumping mail.threadpane.* branch:`, e);
    }

    console.log(`[TMDBG Prefs] Mail sync preferences configured successfully`);
  } catch (e) {
    console.error("[TMDBG Prefs] Failed to configure mail sync preferences:", e);
  }
}
