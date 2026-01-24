import { SETTINGS, getBackendUrl } from "../agent/modules/config.js";
import { log } from "../agent/modules/utils.js";
import {
  getPrivacyOptOutAllAiEnabled,
  setPrivacyOptOutAllAiEnabled,
} from "../chat/modules/privacySettings.js";
import { injectPaletteIntoDocument } from "../theme/palette/palette.js";
import { initConfigPage } from "./modules/init.js";

// Inject TabMail palette CSS
injectPaletteIntoDocument(document)
  .then(() => {
    console.log("[Config] Palette CSS injected");
  })
  .catch((e) => {
    console.warn("[Config] Failed to inject palette CSS:", e);
  });

import("../agent/modules/idbStorage.js").then(async () => {
  await initConfigPage({
    SETTINGS,
    getBackendUrl,
    log,
    getPrivacyOptOutAllAiEnabled,
    setPrivacyOptOutAllAiEnabled,
  });
});


