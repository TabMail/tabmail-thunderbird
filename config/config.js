/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

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


