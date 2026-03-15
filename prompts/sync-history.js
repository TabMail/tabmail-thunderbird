/**
 * Sync History — Standalone page for browsing and restoring prompt history.
 */

const SYNC_AUTO_KEY = "p2p_sync_auto_enabled";

function log(msg, level = "log") {
  console[level]?.(msg) || console.log(msg);
}

// ─── Sync Toggle UI ──────────────────────────────────────────────────────

function updateSyncToggleUI(autoEnabled, connected) {
  const btn = document.getElementById("sync-toggle");
  const label = document.getElementById("sync-toggle-label");
  if (!btn) return;
  btn.classList.remove("active", "connecting");
  if (autoEnabled && connected) {
    btn.classList.add("active");
    label.textContent = "Syncing";
  } else if (autoEnabled) {
    btn.classList.add("connecting");
    label.textContent = "Sync";
  } else {
    label.textContent = "Sync Off";
  }
}

// ─── Sync History ────────────────────────────────────────────────────────

async function loadSyncHistory() {
  const container = document.getElementById("sync-history-list");
  if (!container) return;

  container.innerHTML = '<div class="history-loading">Loading sync history...</div>';

  try {
    const response = await browser.runtime.sendMessage({ command: "prompt-history-load" });
    if (!response?.ok || !Array.isArray(response.entries)) {
      container.innerHTML = '<div class="sync-history-empty">Failed to load history.</div>';
      return;
    }

    const entries = response.entries;
    if (entries.length === 0) {
      container.innerHTML = '<div class="sync-history-empty">No history entries yet. History is recorded as you edit prompts, sync with other devices, or reset settings.</div>';
      return;
    }

    container.innerHTML = "";

    // Sort by timestamp ascending; afterEntry = next snapshot (shows what this event changed)
    const sorted = [...entries].sort((a, b) => (a.timestamp || "").localeCompare(b.timestamp || ""));

    // For the newest entry, use current live state as the "after"
    let liveState = null;
    try {
      const KEYS = {
        composition: "user_prompts:user_composition.md",
        action: "user_prompts:user_action.md",
        kb: "user_prompts:user_kb.md",
        templates: "user_templates",
      };
      const live = await browser.storage.local.get(Object.values(KEYS));
      liveState = {
        composition: live[KEYS.composition] || "",
        action: live[KEYS.action] || "",
        kb: live[KEYS.kb] || "",
        templatesJSON: JSON.stringify(live[KEYS.templates] || []),
      };
    } catch { /* ignore */ }

    for (let i = sorted.length - 1; i >= 0; i--) {
      const afterEntry = i < sorted.length - 1 ? sorted[i + 1] : liveState;
      container.appendChild(renderSyncHistoryEntry(sorted[i], afterEntry));
    }
  } catch (e) {
    log(`[SyncHistory] Failed to load: ${e}`, "error");
    container.innerHTML = '<div class="sync-history-empty">Error loading history.</div>';
  }
}

/**
 * Render a git-style line diff between two text values into a container element.
 * Shows removed lines (red), added lines (green), and a few context lines.
 */
function renderFieldDiff(container, oldText, newText) {
  if (!oldText && !newText) {
    container.innerHTML = '<div class="sync-history-diff-empty">(empty)</div>';
    return;
  }
  if (!oldText) {
    // First entry — everything is "added"
    const lines = newText.split("\n").filter((l) => l.trim());
    if (lines.length === 0) {
      container.innerHTML = '<div class="sync-history-diff-empty">(empty)</div>';
      return;
    }
    for (const line of lines) {
      const el = document.createElement("div");
      el.className = "sync-history-diff-line added";
      el.textContent = `+ ${line}`;
      container.appendChild(el);
    }
    return;
  }

  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");

  // Simple line-level diff: find removed and added lines
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);
  const removed = oldLines.filter((l) => !newSet.has(l) && l.trim());
  const added = newLines.filter((l) => !oldSet.has(l) && l.trim());

  if (removed.length === 0 && added.length === 0) {
    container.innerHTML = '<div class="sync-history-diff-empty">No changes</div>';
    return;
  }

  for (const line of removed) {
    const el = document.createElement("div");
    el.className = "sync-history-diff-line removed";
    el.textContent = `- ${line}`;
    container.appendChild(el);
  }
  for (const line of added) {
    const el = document.createElement("div");
    el.className = "sync-history-diff-line added";
    el.textContent = `+ ${line}`;
    container.appendChild(el);
  }
}

function renderSyncHistoryEntry(entry, afterEntry) {
  const div = document.createElement("div");
  div.className = "section-container sync-history-entry";

  const sourceClass = entry.source === "local_edit" ? "edit" : entry.source === "reset" ? "reset" : "sync";
  const sourceLabel = entry.source === "local_edit" ? "Edit" : entry.source === "reset" ? "Reset" : "Sync";

  const fieldLabels = (entry.fields || []).map(f => {
    const labels = { composition: "Composition", action: "Action Rules", kb: "Knowledge Base", templates: "Templates" };
    return labels[f] || f;
  });

  const date = new Date(entry.timestamp);
  const timeStr = date.toLocaleString();
  const relativeStr = formatRelativeTime(date);

  // Section header (clickable to expand)
  const header = document.createElement("div");
  header.className = "section-header sync-history-entry-header";
  header.style.cursor = "pointer";

  const titleArea = document.createElement("div");
  titleArea.style.cssText = "display: flex; align-items: center; gap: 10px; flex: 1;";
  titleArea.innerHTML = `
    <span class="sync-history-badge ${sourceClass}">${sourceLabel}</span>
    <span style="font-size: 14px; opacity: 0.7;">${fieldLabels.join(", ")}</span>
  `;

  const timestampEl = document.createElement("span");
  timestampEl.className = "sync-history-timestamp";
  timestampEl.title = timeStr;
  timestampEl.textContent = relativeStr;

  header.appendChild(titleArea);
  header.appendChild(timestampEl);
  div.appendChild(header);

  // Section content (collapsed by default)
  const content = document.createElement("div");
  content.className = "section-content sync-history-detail";

  const fieldDefs = [
    { key: "composition", label: "Composition", icon: "✏️" },
    { key: "action", label: "Action Rules", icon: "🏷️" },
    { key: "kb", label: "Knowledge Base", icon: "📚" },
    { key: "templatesJSON", label: "Templates", icon: "📋" },
  ];

  for (const fd of fieldDefs) {
    const value = entry[fd.key];
    if (value === undefined || value === null) continue;

    const fieldCard = document.createElement("div");
    fieldCard.className = "sync-history-field-card";

    const fieldHeader = document.createElement("div");
    fieldHeader.className = "sync-history-field-header";

    const curDisplay = fd.key === "templatesJSON" ? formatTemplatesPreview(value) : value;

    fieldHeader.innerHTML = `<span>${fd.icon} ${fd.label}</span>`;

    if (afterEntry) {
      // Has after-state — show diff (before=this entry, after=next snapshot)
      const afterValue = afterEntry[fd.key] || "";
      const afterDisplay = fd.key === "templatesJSON" ? formatTemplatesPreview(afterValue) : afterValue;

      const toggleBtn = document.createElement("button");
      toggleBtn.className = "sync-history-field-toggle";
      toggleBtn.textContent = "Full";
      fieldHeader.appendChild(toggleBtn);
      fieldCard.appendChild(fieldHeader);

      // Diff view (default): old=before event, new=after event
      const diffEl = document.createElement("div");
      diffEl.className = "sync-history-diff";
      renderFieldDiff(diffEl, curDisplay, afterDisplay);
      fieldCard.appendChild(diffEl);

      // Full view (hidden) — shows after-state
      const fullEl = document.createElement("pre");
      fullEl.className = "sync-history-field-pre";
      fullEl.style.display = "none";
      fullEl.textContent = truncate(afterDisplay, 1000);
      fieldCard.appendChild(fullEl);

      toggleBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const showingDiff = diffEl.style.display !== "none";
        diffEl.style.display = showingDiff ? "none" : "";
        fullEl.style.display = showingDiff ? "" : "none";
        toggleBtn.textContent = showingDiff ? "Diff" : "Full";
      });
    } else {
      // No after-state — show full content of this snapshot
      fieldCard.appendChild(fieldHeader);
      const fullEl = document.createElement("pre");
      fullEl.className = "sync-history-field-pre";
      fullEl.textContent = truncate(curDisplay, 1000);
      fieldCard.appendChild(fullEl);
    }

    content.appendChild(fieldCard);
  }

  // Restore button
  const restoreBtn = document.createElement("button");
  restoreBtn.className = "sync-history-restore-btn";
  restoreBtn.textContent = "Restore to This State";
  restoreBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!confirm(`Restore all prompts, rules, KB, and templates to the state from ${timeStr}?\n\nThis will overwrite your current settings.`)) return;

    restoreBtn.textContent = "Restoring...";
    restoreBtn.disabled = true;
    try {
      const resp = await browser.runtime.sendMessage({ command: "prompt-history-restore", entry });
      if (resp?.ok) {
        restoreBtn.textContent = "Restored!";
        setTimeout(() => loadSyncHistory(), 1000);
      } else {
        restoreBtn.textContent = "Failed — try again";
        restoreBtn.disabled = false;
      }
    } catch (err) {
      log(`[SyncHistory] Restore failed: ${err}`, "error");
      restoreBtn.textContent = "Failed — try again";
      restoreBtn.disabled = false;
    }
  });
  content.appendChild(restoreBtn);
  div.appendChild(content);

  // Toggle expand on header click
  header.addEventListener("click", () => {
    div.classList.toggle("expanded");
  });

  return div;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function formatRelativeTime(date) {
  const now = Date.now();
  const diff = now - date.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
}

function formatTemplatesPreview(json) {
  try {
    const templates = JSON.parse(json);
    if (!Array.isArray(templates)) return json;
    return templates.map(t => `- ${t.name} (${t.enabled ? "enabled" : "disabled"})`).join("\n") || "(no templates)";
  } catch {
    return json;
  }
}

function truncate(str, maxLen) {
  if (!str || str.length <= maxLen) return str || "";
  return str.substring(0, maxLen) + "...";
}

// ─── Init ────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  // Load history
  loadSyncHistory();

  // Refresh button
  document.getElementById("refresh-sync-history")?.addEventListener("click", () => {
    loadSyncHistory();
  });

  // Sync Now button
  document.getElementById("sync-now-btn")?.addEventListener("click", async () => {
    const btn = document.getElementById("sync-now-btn");
    btn.disabled = true;
    btn.textContent = "Syncing...";
    try {
      await browser.runtime.sendMessage({ command: "p2p-sync-now" });
      btn.textContent = "Synced!";
      setTimeout(() => { btn.textContent = "Sync Now"; btn.disabled = false; }, 1500);
    } catch (e) {
      log(`[SyncHistory] Sync Now failed: ${e}`, "error");
      btn.textContent = "Sync Now";
      btn.disabled = false;
    }
  });

  // Sync toggle
  (async () => {
    const syncAutoStored = await browser.storage.local.get({ [SYNC_AUTO_KEY]: true });
    let syncAutoEnabled = syncAutoStored[SYNC_AUTO_KEY] !== false;
    const syncStatus = await browser.runtime.sendMessage({ command: "p2p-sync-status" }).catch(() => null);
    updateSyncToggleUI(syncAutoEnabled, syncStatus?.connected || false);

    browser.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes._p2pSyncConnected !== undefined) {
        updateSyncToggleUI(syncAutoEnabled, !!changes._p2pSyncConnected.newValue);
      }
      if (area === "local" && changes[SYNC_AUTO_KEY] !== undefined) {
        syncAutoEnabled = changes[SYNC_AUTO_KEY].newValue !== false;
        updateSyncToggleUI(syncAutoEnabled, false);
      }
    });

    browser.runtime.sendMessage({ command: "p2p-sync-add-listener" }).then((res) => {
      if (res?.ok) updateSyncToggleUI(syncAutoEnabled, res.connected);
    }).catch(() => {});

    let syncPollTimer = null;
    document.getElementById("sync-toggle").addEventListener("click", async () => {
      if (syncPollTimer) { clearInterval(syncPollTimer); syncPollTimer = null; }

      syncAutoEnabled = !syncAutoEnabled;
      await browser.storage.local.set({ [SYNC_AUTO_KEY]: syncAutoEnabled });
      updateSyncToggleUI(syncAutoEnabled, false);

      if (syncAutoEnabled) {
        await browser.runtime.sendMessage({ command: "p2p-sync-enable" }).catch(() => {});
        let attempts = 0;
        syncPollTimer = setInterval(async () => {
          attempts++;
          if (!syncAutoEnabled) { clearInterval(syncPollTimer); syncPollTimer = null; return; }
          const status = await browser.runtime.sendMessage({ command: "p2p-sync-status" }).catch(() => null);
          if (status?.connected) {
            updateSyncToggleUI(syncAutoEnabled, true);
            clearInterval(syncPollTimer); syncPollTimer = null;
          } else if (attempts >= 10) {
            clearInterval(syncPollTimer); syncPollTimer = null;
          }
        }, 500);
      } else {
        await browser.runtime.sendMessage({ command: "p2p-sync-disable" }).catch(() => {});
      }
    });
  })();
});
