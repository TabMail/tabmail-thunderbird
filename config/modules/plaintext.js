import { $ } from "./dom.js";

// Plaintext composition functions
export async function checkPlaintextStatus(log) {
  try {
    if (!browser.tmPrefs) {
      $("plaintext-status").textContent = "Error: tmPrefs API not available";
      return { allPlaintext: false, identities: [] };
    }

    // First, dump all mail.identity preferences to see what's actually there
    try {
      if (typeof browser.tmPrefs.dumpBranch === "function") {
        const identityPrefs = await browser.tmPrefs.dumpBranch("mail.identity.");
        log(`[TMDBG Config] All mail.identity.* preferences:`, identityPrefs);
      }
    } catch (e) {
      log(`[TMDBG Config] Failed to dump mail.identity branch: ${e}`, "warn");
    }

    const accounts = await browser.accounts.list();
    const problematicIdentities = [];
    let totalIdentities = 0;

    for (const account of accounts) {
      if (!account.identities || account.identities.length === 0) continue;

      for (const identity of account.identities) {
        totalIdentities++;
        const identityId = identity.id;

        // Check composeHtml preference: false = plaintext, true = HTML
        // Preference name format: mail.identity.<identityId>.compose_html (identityId already includes "id")
        const prefName = `mail.identity.${identityId}.compose_html`;

        try {
          // Default to true (HTML) if pref doesn't exist, as that's Thunderbird's default
          const composeHtml = await browser.tmPrefs.getBoolSafe(prefName, true);
          const identityName = identity.name || identity.email || `Identity ${identityId}`;

          log(
            `[TMDBG Config] Identity ${identityId} (${identityName}): compose_html = ${composeHtml}`,
          );

          // If composeHtml is true, it's set to HTML mode (not plaintext)
          if (composeHtml === true) {
            problematicIdentities.push({
              id: identityId,
              name: identityName,
              email: identity.email || "",
              accountName: account.name || "",
            });
          }
        } catch (e) {
          // If we can't read the pref, assume HTML (Thunderbird's default) - flag as problematic
          const identityName = identity.name || identity.email || `Identity ${identityId}`;
          log(
            `[TMDBG Config] Failed to read compose_html for identity ${identityId}: ${e}`,
            "warn",
          );
          problematicIdentities.push({
            id: identityId,
            name: identityName,
            email: identity.email || "",
            accountName: account.name || "",
            error: e.message || String(e),
          });
        }
      }
    }

    return {
      allPlaintext: problematicIdentities.length === 0,
      totalIdentities,
      problematicIdentities,
    };
  } catch (e) {
    log(`[TMDBG Config] checkPlaintextStatus failed: ${e}`, "error");
    $("plaintext-status").textContent = `Error checking status: ${e.message || e}`;
    return { allPlaintext: false, identities: [], error: e.message || String(e) };
  }
}

export async function updatePlaintextStatusUI(log) {
  const status = await checkPlaintextStatus(log);

  if (status.error) {
    $("plaintext-status").textContent = `Error: ${status.error}`;
    $("plaintext-warning").style.display = "none";
    return;
  }

  if (status.allPlaintext) {
    $("plaintext-status").textContent = `✓ All ${status.totalIdentities} identity(ies) are set to plaintext mode`;
    $("plaintext-status").style.color = "#28a745";
    $("plaintext-warning").style.display = "none";
  } else {
    $("plaintext-status").textContent = `⚠ ${status.problematicIdentities.length} of ${status.totalIdentities} identity(ies) not set to plaintext`;
    $("plaintext-status").style.color = "orange";
    $("plaintext-warning").style.display = "block";

    // List problematic identities
    const identityList = status.problematicIdentities
      .map((ident) => {
        const displayName = ident.name || ident.email || `Identity ${ident.id}`;
        const accountInfo = ident.accountName ? ` (${ident.accountName})` : "";
        return displayName + accountInfo;
      })
      .join(", ");

    $("plaintext-problematic-identities").textContent = identityList || "Unknown";
  }
}

export async function forcePlaintextAll(log) {
  try {
    if (!browser.tmPrefs) {
      $("plaintext-status").textContent = "Error: tmPrefs API not available";
      return;
    }

    const status = await checkPlaintextStatus(log);
    if (status.allPlaintext) {
      $("plaintext-status").textContent =
        "All identities are already set to plaintext mode";
      $("plaintext-status").style.color = "#28a745";
      return;
    }

    $("plaintext-status").textContent = "Setting identities to plaintext mode...";
    $("plaintext-status").style.color = "#666";
    $("force-plaintext-all").disabled = true;

    let successCount = 0;
    let errorCount = 0;

    for (const ident of status.problematicIdentities) {
      try {
        const prefName = `mail.identity.${ident.id}.compose_html`;
        // Set to false to force plaintext (false = plaintext, true = HTML)
        await browser.tmPrefs.setBool(prefName, false);
        successCount++;
        log(
          `[TMDBG Config] Set identity ${ident.id} (${ident.name || ident.email}) to plaintext mode`,
        );
      } catch (e) {
        errorCount++;
        log(
          `[TMDBG Config] Failed to set identity ${ident.id} to plaintext: ${e}`,
          "warn",
        );
      }
    }

    // Refresh status after applying changes
    await updatePlaintextStatusUI(log);

    if (errorCount === 0) {
      $("plaintext-status").textContent = `✓ Successfully set ${successCount} identity(ies) to plaintext mode`;
      $("plaintext-status").style.color = "#28a745";
    } else {
      $("plaintext-status").textContent = `⚠ Set ${successCount} identity(ies) to plaintext, ${errorCount} error(s)`;
      $("plaintext-status").style.color = "orange";
    }
    $("force-plaintext-all").disabled = false;
  } catch (e) {
    log(`[TMDBG Config] forcePlaintextAll failed: ${e}`, "error");
    $("plaintext-status").textContent = `Error: ${e.message || e}`;
    $("plaintext-status").style.color = "red";
    $("force-plaintext-all").disabled = false;
  }
}

