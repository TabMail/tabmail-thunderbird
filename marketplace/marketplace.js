/**
 * TabMail Marketplace Page
 *
 * Full-page marketplace for browsing and installing templates.
 * Communicates with background script for template installation.
 */

import { getTemplateWorkerUrl } from "../agent/modules/config.js";
import { log } from "../agent/modules/utils.js";
import { injectPaletteIntoDocument } from "../theme/palette/palette.js";

// Inject TabMail palette CSS
injectPaletteIntoDocument(document)
    .then(() => {
        console.log("[Marketplace] Palette CSS injected");
    })
    .catch((e) => {
        console.warn("[Marketplace] Failed to inject palette CSS:", e);
    });

const PFX = "[Marketplace] ";

// State
let marketplaceTemplates = [];
let marketplaceOffset = 0;
let marketplaceHasMore = false;
let marketplaceSearchTerm = "";
let marketplaceSort = "popular";
let installedTemplateIds = new Set();
let currentModalTemplate = null;
let currentTab = "browse";
let myTemplates = [];
let myTemplatesLimits = null;

/**
 * Get auth token from storage
 */
async function getAuthToken() {
    try {
        const result = await browser.storage.local.get("supabaseSession");
        const session = result.supabaseSession;
        if (session && session.access_token) {
            return session.access_token;
        }
        return null;
    } catch (e) {
        log(`${PFX}Failed to get auth token: ${e}`, "error");
        return null;
    }
}

/**
 * Get installed template IDs from storage
 */
async function getInstalledTemplateIds() {
    try {
        const response = await browser.runtime.sendMessage({ command: "templates-load" });
        if (response && response.ok && response.templates) {
            return new Set(response.templates.map((t) => t.id));
        }
        return new Set();
    } catch (e) {
        log(`${PFX}Failed to get installed templates: ${e}`, "error");
        return new Set();
    }
}

/**
 * Show status message
 */
function showStatus(message, isError = false) {
    const statusEl = document.getElementById("status-message");
    statusEl.textContent = message;
    statusEl.className = isError ? "visible error" : "visible";
    
    setTimeout(() => {
        statusEl.className = "";
    }, 3000);
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Format number with commas
 */
function formatNumber(num) {
    return num.toLocaleString();
}

/**
 * Load marketplace templates from API
 */
async function loadMarketplaceTemplates() {
    const listEl = document.getElementById("marketplace-list");
    const loadingEl = document.getElementById("marketplace-loading");
    const errorEl = document.getElementById("marketplace-error");
    const emptyEl = document.getElementById("marketplace-empty");
    const paginationEl = document.getElementById("marketplace-pagination");

    // Reset state for new load
    marketplaceOffset = 0;
    marketplaceTemplates = [];

    // Show loading
    listEl.style.display = "none";
    errorEl.style.display = "none";
    emptyEl.style.display = "none";
    paginationEl.style.display = "none";
    loadingEl.style.display = "block";

    try {
        const token = await getAuthToken();
        if (!token) {
            throw new Error("Please sign in to access the template marketplace");
        }

        const baseUrl = await getTemplateWorkerUrl();
        const params = new URLSearchParams({
            sort: marketplaceSort,
            limit: "20",
            offset: "0",
        });
        if (marketplaceSearchTerm) {
            params.set("search", marketplaceSearchTerm);
        }

        const response = await fetch(`${baseUrl}/list?${params}`, {
            method: "GET",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
            },
        });

        if (!response.ok) {
            throw new Error(`Failed to load templates (${response.status})`);
        }

        const data = await response.json();
        marketplaceTemplates = data.templates || [];
        marketplaceHasMore = data.pagination?.has_more || false;
        marketplaceOffset = data.pagination?.offset || 0;

        loadingEl.style.display = "none";

        if (marketplaceTemplates.length === 0) {
            emptyEl.style.display = "block";
        } else {
            renderMarketplaceList();
            listEl.style.display = "grid";
            paginationEl.style.display = marketplaceHasMore ? "block" : "none";
        }

        log(`${PFX}Loaded ${marketplaceTemplates.length} templates`);
    } catch (e) {
        log(`${PFX}Failed to load templates: ${e}`, "error");
        loadingEl.style.display = "none";
        document.getElementById("marketplace-error-text").textContent = e.message || "Failed to load templates";
        errorEl.style.display = "block";
    }
}

/**
 * Load more marketplace templates
 */
async function loadMoreMarketplaceTemplates() {
    const loadMoreBtn = document.getElementById("marketplace-load-more");
    loadMoreBtn.disabled = true;
    loadMoreBtn.textContent = "Loading...";

    try {
        const token = await getAuthToken();
        if (!token) {
            throw new Error("Please sign in");
        }

        const baseUrl = await getTemplateWorkerUrl();
        const newOffset = marketplaceOffset + 20;
        const params = new URLSearchParams({
            sort: marketplaceSort,
            limit: "20",
            offset: String(newOffset),
        });
        if (marketplaceSearchTerm) {
            params.set("search", marketplaceSearchTerm);
        }

        const response = await fetch(`${baseUrl}/list?${params}`, {
            method: "GET",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
            },
        });

        if (!response.ok) {
            throw new Error(`Failed to load more templates (${response.status})`);
        }

        const data = await response.json();
        const newTemplates = data.templates || [];
        marketplaceTemplates.push(...newTemplates);
        marketplaceHasMore = data.pagination?.has_more || false;
        marketplaceOffset = data.pagination?.offset || 0;

        renderMarketplaceList();
        const paginationEl = document.getElementById("marketplace-pagination");
        paginationEl.style.display = marketplaceHasMore ? "block" : "none";

        log(`${PFX}Loaded ${newTemplates.length} more templates`);
    } catch (e) {
        log(`${PFX}Failed to load more templates: ${e}`, "error");
        showStatus(`Failed to load more templates: ${e.message}`, true);
    } finally {
        loadMoreBtn.disabled = false;
        loadMoreBtn.textContent = "Load More";
    }
}

/**
 * Render marketplace template list
 */
function renderMarketplaceList() {
    const listEl = document.getElementById("marketplace-list");
    listEl.innerHTML = "";

    for (const template of marketplaceTemplates) {
        const card = createMarketplaceCard(template);
        listEl.appendChild(card);
    }
}

/**
 * Create a marketplace template card
 */
function createMarketplaceCard(template) {
    const card = document.createElement("div");
    card.className = "marketplace-card";
    card.dataset.id = template.id;

    const isInstalled = installedTemplateIds.has(template.id);
    const previewText = template.example_reply || "";
    const truncatedPreview = previewText.length > 120 ? previewText.substring(0, 120) + "..." : previewText;

    card.innerHTML = `
        <div class="marketplace-card-header">
            <div class="marketplace-card-info">
                <h4 class="marketplace-card-name">${escapeHtml(template.name)}</h4>
                <span class="marketplace-card-expand-hint">Click for details</span>
            </div>
            <div class="marketplace-card-stats">
                <span class="marketplace-card-stat" title="Downloads">
                    ↓ ${formatNumber(template.download_count || 0)}
                </span>
            </div>
        </div>
        ${template.description ? `<p class="marketplace-card-description">${escapeHtml(template.description)}</p>` : ""}
        <div class="marketplace-card-preview">${escapeHtml(truncatedPreview)}</div>
        <div class="marketplace-card-actions">
            <button class="install-btn ${isInstalled ? "installed" : ""}" data-id="${template.id}" ${isInstalled ? "disabled" : ""}>
                ${isInstalled ? "✓ Installed" : "Install"}
            </button>
        </div>
    `;

    // Add click handler to open modal
    card.addEventListener("click", (e) => {
        if (e.target.closest(".install-btn")) {
            return;
        }
        openTemplateModal(template);
    });

    // Add install button handler
    const installBtn = card.querySelector(".install-btn");
    if (!isInstalled) {
        installBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            installTemplate(template, installBtn);
        });
    }

    return card;
}

/**
 * Open template detail modal
 */
function openTemplateModal(template, isOwner = false) {
    currentModalTemplate = template;
    const modal = document.getElementById("template-modal");
    const content = document.getElementById("modal-body");
    
    const isInstalled = installedTemplateIds.has(template.id);
    const previewText = template.example_reply || "";

    const instructionsHtml = template.instructions && template.instructions.length > 0
        ? `<div class="modal-section">
             <h4 class="modal-section-title">Instructions</h4>
             <ul class="modal-instructions">
               ${template.instructions.map(inst => `<li>${escapeHtml(inst)}</li>`).join("")}
             </ul>
           </div>`
        : "";

    // Status info for owner's templates
    let statusHtml = "";
    if (isOwner) {
        statusHtml = `<div class="modal-status">${getStatusBadgeHtml(template.status)}</div>`;
        if (template.status === "rejected" && template.rejection_reason) {
            statusHtml += `<div class="modal-rejection-reason">Rejection reason: ${escapeHtml(template.rejection_reason)}</div>`;
        }
    }

    // Determine button text - owners can download their own pending templates
    const canDownload = isOwner || template.status === "approved" || template.status === "auto_approved";

    content.innerHTML = `
        <div class="modal-header">
            <h3 class="modal-title">${escapeHtml(template.name)}</h3>
            ${statusHtml}
            ${template.description ? `<p class="modal-description">${escapeHtml(template.description)}</p>` : ""}
            <div class="marketplace-card-stats" style="margin-top: 8px;">
                <span class="marketplace-card-stat">↓ ${formatNumber(template.download_count || 0)} downloads</span>
            </div>
        </div>
        ${instructionsHtml}
        <div class="modal-section">
            <h4 class="modal-section-title">Example Reply</h4>
            <div class="modal-preview">${escapeHtml(previewText)}</div>
        </div>
        <div class="modal-actions">
            <button class="secondary-button" id="modal-cancel-btn">Close</button>
            ${canDownload ? `
                <button class="install-btn modal-install-btn ${isInstalled ? "installed" : ""}" id="modal-install-btn" ${isInstalled ? "disabled" : ""}>
                    ${isInstalled ? "✓ Installed" : "Install Template"}
                </button>
            ` : ""}
        </div>
    `;

    // Add button handlers
    document.getElementById("modal-cancel-btn").addEventListener("click", closeTemplateModal);
    
    const installBtn = document.getElementById("modal-install-btn");
    if (installBtn && !isInstalled && canDownload) {
        installBtn.addEventListener("click", () => {
            installTemplate(template, installBtn);
        });
    }

    modal.style.display = "flex";
}

/**
 * Close template detail modal
 */
function closeTemplateModal() {
    document.getElementById("template-modal").style.display = "none";
    currentModalTemplate = null;
}

/**
 * Install a template
 */
async function installTemplate(template, button) {
    button.disabled = true;
    button.textContent = "Installing...";

    try {
        const token = await getAuthToken();
        if (!token) {
            throw new Error("Please sign in");
        }

        const baseUrl = await getTemplateWorkerUrl();
        const response = await fetch(`${baseUrl}/download/${template.id}`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
            },
        });

        if (!response.ok) {
            throw new Error(`Failed to download template (${response.status})`);
        }

        const data = await response.json();
        const downloadedTemplate = data.template;

        // Install via background script
        const importResponse = await browser.runtime.sendMessage({
            command: "templates-add",
            template: {
                id: downloadedTemplate.id,
                name: downloadedTemplate.name,
                instructions: downloadedTemplate.instructions,
                exampleReply: downloadedTemplate.exampleReply,
                enabled: true,
            },
        });

        if (importResponse && importResponse.ok) {
            installedTemplateIds.add(template.id);
            showStatus(`Installed "${template.name}"`);
            log(`${PFX}Installed template: ${template.id}`);

            // Update button state
            button.textContent = "✓ Installed";
            button.classList.add("installed");
            
            // Also update the card button if we're in modal
            const cardBtn = document.querySelector(`.marketplace-card[data-id="${template.id}"] .install-btn`);
            if (cardBtn && cardBtn !== button) {
                cardBtn.textContent = "✓ Installed";
                cardBtn.classList.add("installed");
                cardBtn.disabled = true;
            }
        } else {
            throw new Error(importResponse?.error || "Failed to import template");
        }
    } catch (e) {
        log(`${PFX}Failed to install template: ${e}`, "error");
        showStatus(`Failed to install: ${e.message}`, true);
        button.textContent = "Install";
        button.disabled = false;
    }
}

/**
 * Switch between tabs
 */
function switchTab(tabName) {
    currentTab = tabName;

    // Update tab buttons
    document.querySelectorAll(".tab-btn").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.tab === tabName);
    });

    // Update tab content
    document.getElementById("browse-tab").style.display = tabName === "browse" ? "block" : "none";
    document.getElementById("my-templates-tab").style.display = tabName === "my-templates" ? "block" : "none";

    // Load data if needed
    if (tabName === "my-templates" && myTemplates.length === 0) {
        loadMyTemplates();
    }
}

/**
 * Load user's own templates
 */
async function loadMyTemplates() {
    const listEl = document.getElementById("my-templates-list");
    const loadingEl = document.getElementById("my-templates-loading");
    const errorEl = document.getElementById("my-templates-error");
    const emptyEl = document.getElementById("my-templates-empty");
    const limitsEl = document.getElementById("my-templates-limits");

    listEl.style.display = "none";
    errorEl.style.display = "none";
    emptyEl.style.display = "none";
    loadingEl.style.display = "block";

    try {
        const token = await getAuthToken();
        if (!token) {
            throw new Error("Please sign in to view your templates");
        }

        const baseUrl = await getTemplateWorkerUrl();
        const response = await fetch(`${baseUrl}/my-templates`, {
            method: "GET",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
            },
        });

        if (!response.ok) {
            throw new Error(`Failed to load your templates (${response.status})`);
        }

        const data = await response.json();
        myTemplates = data.templates || [];
        myTemplatesLimits = data.limits || null;

        loadingEl.style.display = "none";

        // Update limits display
        if (myTemplatesLimits) {
            limitsEl.textContent = `${myTemplatesLimits.current_count} of ${myTemplatesLimits.max_templates} templates used`;
        }

        if (myTemplates.length === 0) {
            emptyEl.style.display = "block";
        } else {
            renderMyTemplatesList();
            listEl.style.display = "grid";
        }

        log(`${PFX}Loaded ${myTemplates.length} user templates`);
    } catch (e) {
        log(`${PFX}Failed to load user templates: ${e}`, "error");
        loadingEl.style.display = "none";
        document.getElementById("my-templates-error-text").textContent = e.message || "Failed to load your templates";
        errorEl.style.display = "block";
    }
}

/**
 * Unshare a template (remove from marketplace, free up quota)
 */
async function unshareTemplate(templateId, templateName) {
    if (!confirm(`Are you sure you want to unshare "${templateName}"?\n\nThis will remove it from the marketplace and free up your template quota.`)) {
        return;
    }

    try {
        const token = await getAuthToken();
        if (!token) {
            showStatus("Please sign in to unshare templates", true);
            return;
        }

        const baseUrl = await getTemplateWorkerUrl();
        const response = await fetch(`${baseUrl}/unshare/${templateId}`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
            },
        });

        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.error || `Failed to unshare template (${response.status})`);
        }

        showStatus(`"${templateName}" has been unshared`);
        log(`${PFX}Template unshared: ${templateId}`);

        // Reload the list
        await loadMyTemplates();
    } catch (e) {
        log(`${PFX}Failed to unshare template: ${e}`, "error");
        showStatus(e.message || "Failed to unshare template", true);
    }
}

/**
 * Render user's templates list
 */
function renderMyTemplatesList() {
    const listEl = document.getElementById("my-templates-list");
    listEl.innerHTML = "";

    for (const template of myTemplates) {
        const card = createMyTemplateCard(template);
        listEl.appendChild(card);
    }
}

/**
 * Get status badge HTML
 * Note: Users see "Approved" for both approved and auto_approved (admin-only distinction)
 */
function getStatusBadgeHtml(status) {
    const statusLabels = {
        pending_review: "Under Review",
        approved: "Approved",
        auto_approved: "Approved", // Same label as approved for users
        rejected: "Rejected",
    };
    const statusClasses = {
        pending_review: "status-pending",
        approved: "status-approved",
        auto_approved: "status-approved", // Same style as approved for users
        rejected: "status-rejected",
    };
    return `<span class="status-badge ${statusClasses[status] || ""}">${statusLabels[status] || status}</span>`;
}

/**
 * Create a card for user's own template
 */
function createMyTemplateCard(template) {
    const card = document.createElement("div");
    card.className = "marketplace-card my-template-card";
    card.dataset.id = template.id;

    const previewText = template.example_reply || "";
    const truncatedPreview = previewText.length > 120 ? previewText.substring(0, 120) + "..." : previewText;

    let rejectionHtml = "";
    if (template.status === "rejected" && template.rejection_reason) {
        rejectionHtml = `<div class="rejection-reason">Reason: ${escapeHtml(template.rejection_reason)}</div>`;
    }

    // Show unshare button only for templates that are not already removed
    const showUnshareBtn = template.status !== "removed";

    card.innerHTML = `
        <div class="marketplace-card-header">
            <div class="marketplace-card-info">
                <h4 class="marketplace-card-name">${escapeHtml(template.name)}</h4>
            </div>
            <div class="marketplace-card-stats">
                <span class="marketplace-card-stat" title="Downloads">
                    ↓ ${formatNumber(template.download_count || 0)}
                </span>
            </div>
        </div>
        ${template.description ? `<p class="marketplace-card-description">${escapeHtml(template.description)}</p>` : ""}
        ${rejectionHtml}
        <div class="marketplace-card-preview">${escapeHtml(truncatedPreview)}</div>
        <div class="my-template-card-footer">
            ${getStatusBadgeHtml(template.status)}
            ${showUnshareBtn ? `<button class="unshare-btn" data-template-id="${template.id}" title="Remove from marketplace and free up quota">Unshare</button>` : ""}
        </div>
    `;

    // Add click handler to open modal (but not on unshare button)
    card.addEventListener("click", (e) => {
        if (!e.target.classList.contains("unshare-btn")) {
            openTemplateModal(template, true);
        }
    });

    // Add unshare button handler
    const unshareBtn = card.querySelector(".unshare-btn");
    if (unshareBtn) {
        unshareBtn.addEventListener("click", async (e) => {
            e.stopPropagation();
            await unshareTemplate(template.id, template.name);
        });
    }

    return card;
}

/**
 * Setup event listeners
 */
function setupEventListeners() {
    // Tab switching
    document.querySelectorAll(".tab-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
            switchTab(btn.dataset.tab);
        });
    });

    // Search
    const searchInput = document.getElementById("marketplace-search");
    let searchTimeout;
    searchInput.addEventListener("input", (e) => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => {
            marketplaceSearchTerm = e.target.value.trim();
            loadMarketplaceTemplates();
        }, 500);
    });

    // Sort
    document.getElementById("marketplace-sort").addEventListener("change", (e) => {
        marketplaceSort = e.target.value;
        loadMarketplaceTemplates();
    });

    // Retry
    document.getElementById("marketplace-retry-btn").addEventListener("click", loadMarketplaceTemplates);

    // Refresh button
    document.getElementById("marketplace-refresh-btn").addEventListener("click", loadMarketplaceTemplates);

    // Load more
    document.getElementById("marketplace-load-more").addEventListener("click", loadMoreMarketplaceTemplates);

    // My templates refresh/retry
    document.getElementById("my-templates-refresh-btn")?.addEventListener("click", loadMyTemplates);
    document.getElementById("my-templates-retry-btn")?.addEventListener("click", loadMyTemplates);

    // Modal close
    document.getElementById("modal-close-btn").addEventListener("click", closeTemplateModal);
    
    // Close modal on overlay click
    document.getElementById("template-modal").addEventListener("click", (e) => {
        if (e.target.id === "template-modal") {
            closeTemplateModal();
        }
    });

    // Close modal on escape
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && document.getElementById("template-modal").style.display !== "none") {
            closeTemplateModal();
        }
    });
}

/**
 * Initialize marketplace
 */
async function init() {
    log(`${PFX}Initializing marketplace page`);

    // Get installed template IDs
    installedTemplateIds = await getInstalledTemplateIds();

    // Setup event listeners
    setupEventListeners();

    // Load templates
    await loadMarketplaceTemplates();
}

// Initialize when DOM is ready
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
} else {
    init();
}
