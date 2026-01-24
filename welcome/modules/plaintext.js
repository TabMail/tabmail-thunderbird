/**
 * Welcome wizard plaintext helpers
 */

/**
 * Check plaintext composition status
 */
export async function checkPlaintextStatus() {
  const statusBox = document.getElementById("plaintext-status");
  const statusText = document.getElementById("plaintext-status-text");
  const actionBtn = document.getElementById("force-plaintext-btn");

  if (!statusBox || !statusText) return;

  try {
    if (typeof browser === "undefined" || !browser.tmPrefs) {
      statusBox.classList.add("warning");
      statusText.textContent = "Cannot check settings (tmPrefs API not available)";
      return;
    }

    const accounts = await browser.accounts.list();
    const problematicIdentities = [];

    for (const account of accounts) {
      if (!account.identities || account.identities.length === 0) continue;

      for (const identity of account.identities) {
        const prefName = `mail.identity.${identity.id}.compose_html`;

        try {
          const composeHtml = await browser.tmPrefs.getBoolSafe(prefName, true);
          const identityName = identity.name || identity.email || `Identity ${identity.id}`;

          if (composeHtml === true) {
            problematicIdentities.push(identityName);
          }
        } catch (e) {
          const identityName = identity.name || identity.email || `Identity ${identity.id}`;
          problematicIdentities.push(identityName);
        }
      }
    }

    if (problematicIdentities.length === 0) {
      statusBox.classList.remove("warning");
      statusBox.classList.add("success");
      statusText.textContent = "All email identities are set to plaintext mode.";
      if (actionBtn) actionBtn.style.display = "none";
    } else {
      statusBox.classList.remove("success");
      statusBox.classList.add("warning");
      statusText.textContent = `${problematicIdentities.length} identit${problematicIdentities.length === 1 ? "y needs" : "ies need"} to be switched to plaintext mode.`;
      if (actionBtn) actionBtn.style.display = "block";
    }

    console.log("[Welcome] Plaintext check complete:", problematicIdentities);
  } catch (e) {
    console.error("[Welcome] Failed to check plaintext status:", e);
    statusBox.classList.add("warning");
    statusText.textContent = "Failed to check email settings.";
  }
}

/**
 * Setup plaintext button handler
 */
export function setupPlaintextButton({ checkPlaintextStatusFn = checkPlaintextStatus } = {}) {
  const btn = document.getElementById("force-plaintext-btn");
  if (!btn) return;

  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "Applying...";

    try {
      if (!browser.tmPrefs) {
        throw new Error("tmPrefs API not available");
      }

      const accounts = await browser.accounts.list();
      let success = 0;
      let total = 0;

      for (const account of accounts) {
        if (!account.identities || account.identities.length === 0) continue;

        for (const identity of account.identities) {
          total++;
          const prefName = `mail.identity.${identity.id}.compose_html`;

          try {
            await browser.tmPrefs.setBool(prefName, false);
            success++;
            console.log(`[Welcome] Set identity ${identity.id} to plaintext`);
          } catch (e) {
            console.warn(`[Welcome] Failed to set plaintext for ${identity.id}:`, e);
          }
        }
      }

      console.log(`[Welcome] Plaintext enforcement: ${success}/${total}`);

      await checkPlaintextStatusFn();

      btn.textContent = "Enable Plaintext for All Identities";
      btn.disabled = false;
    } catch (e) {
      console.error("[Welcome] Failed to force plaintext:", e);
      btn.textContent = "Failed - Try Again";
      btn.disabled = false;
    }
  });
}

