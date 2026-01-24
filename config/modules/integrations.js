import { $ } from "./dom.js";

/**
 * Load calendars into a select element
 * @param {string|HTMLElement} selector - Element ID string or HTMLElement (defaults to "default-calendar")
 */
export async function loadCalendars(selector = "default-calendar") {
  try {
    const select = typeof selector === "string" ? $(selector) : selector;
    if (!select) return;

    // Clear existing options
    select.innerHTML = '<option value="">Loading calendars...</option>';

    // Get calendars from tmCalendar API
    if (!browser?.tmCalendar?.getCalendars) {
      select.innerHTML = '<option value="">Calendar API not available</option>';
      return;
    }

    const result = await browser.tmCalendar.getCalendars();

    if (!result?.ok || !result?.calendars) {
      select.innerHTML = '<option value="">No calendars found</option>';
      return;
    }

    // Clear and populate with available calendars
    select.innerHTML = '<option value="">Select a calendar...</option>';

    // Sort calendars by name
    const sortedCalendars = [...result.calendars].sort((a, b) => {
      return (a.name || "").localeCompare(b.name || "");
    });

    sortedCalendars.forEach((cal) => {
      const option = document.createElement("option");
      option.value = cal.id;

      // Display calendar name with read-only indicator and organizer email
      const displayName = cal.name || cal.id;
      let label = displayName;
      if (cal.readOnly) {
        label += " (Read-only)";
      } else if (cal.organizer_email) {
        label += ` (${cal.organizer_email})`;
      }
      option.textContent = label;
      option.title = `${displayName} (${cal.type || "unknown type"})${
        cal.organizer_email ? ` - ${cal.organizer_email}` : ""
      }${cal.readOnly ? " - Read-only" : ""}`;

      // Disable read-only calendars for selection
      if (cal.readOnly) {
        option.disabled = true;
      }

      select.appendChild(option);
    });

    // Load and set the current default (auto-detection is done on addon startup in background.js)
    const { defaultCalendarId } = await browser.storage.local.get({
      defaultCalendarId: null,
    });
    if (defaultCalendarId) {
      select.value = defaultCalendarId;
    }
  } catch (e) {
    console.warn("[TMDBG Config] loadCalendars failed", e);
    const select = typeof selector === "string" ? $(selector) : selector;
    if (select) {
      select.innerHTML = '<option value="">Error loading calendars</option>';
    }
  }
}

/**
 * Load address books into a select element
 * @param {string|HTMLElement} selector - Element ID string or HTMLElement (defaults to "default-addressbook")
 */
export async function loadAddressBooks(selector = "default-addressbook") {
  try {
    const select = typeof selector === "string" ? $(selector) : selector;
    if (!select) return;
    select.innerHTML = '<option value="">Loading address books...</option>';

    const books = await browser.addressBooks.list();

    // Log all address book properties for debugging
    console.log("[TMDBG Config] Address books raw data:", books);
    for (const ab of books || []) {
      console.log(
        `[TMDBG Config] Address book: id=${ab?.id}, name=${ab?.name}, type=${ab?.type}, remote=${ab?.remote}, readOnly=${ab?.readOnly}`,
        ab,
      );
    }

    // Try to get address book preferences via tmPrefs experiment
    // Address book config is stored under ldap_2.servers.* in Thunderbird prefs
    let addressBookPrefs = {};
    try {
      if (browser.tmPrefs?.dumpBranch) {
        addressBookPrefs = await browser.tmPrefs.dumpBranch("ldap_2.servers.");
        console.log(
          "[TMDBG Config] Address book preferences (ldap_2.servers.*):",
          addressBookPrefs,
        );
      }
    } catch (e) {
      console.warn("[TMDBG Config] Failed to dump address book prefs:", e);
    }

    // Build a map from address book internal name to properties
    // Prefs are like: ldap_2.servers.<internalName>.carddav.url, ldap_2.servers.<internalName>.uid
    const abInfoByInternalName = new Map();
    for (const [key, prefData] of Object.entries(addressBookPrefs)) {
      // Extract internal name from key like "ldap_2.servers.AddressBook.carddav.url"
      const match = key.match(/^ldap_2\.servers\.([^.]+)\.(.+)$/);
      if (match) {
        const internalName = match[1];
        const propName = match[2];
        if (!abInfoByInternalName.has(internalName)) {
          abInfoByInternalName.set(internalName, {});
        }
        abInfoByInternalName.get(internalName)[propName] = prefData?.value;
      }
    }
    console.log(
      "[TMDBG Config] Parsed address book info by internal name:",
      Object.fromEntries(abInfoByInternalName),
    );

    // Now build a map from WebExtension API ID (UUID) to account info
    // The .uid property in prefs should match the address book ID from WebExtension API
    const abInfoByUuid = new Map();
    for (const [internalName, props] of abInfoByInternalName.entries()) {
      const uuid = props.uid;
      if (uuid) {
        abInfoByUuid.set(uuid, { ...props, _internalName: internalName });
        console.log(
          `[TMDBG Config] Mapped UUID ${uuid} -> internal name ${internalName}`,
          props,
        );
      }
    }
    console.log(
      "[TMDBG Config] Address book info by UUID:",
      Object.fromEntries(abInfoByUuid),
    );

    select.innerHTML = '<option value="">Select an address book...</option>';

    // Sort address books for better display order
    const sortedBooks = [...(books || [])].sort((a, b) => {
      const aName = (a?.name || "").toLowerCase();
      const bName = (b?.name || "").toLowerCase();

      // Put "Collected Addresses" at the end
      if (aName.includes("collected") && !bName.includes("collected")) return 1;
      if (!aName.includes("collected") && bName.includes("collected")) return -1;

      return aName.localeCompare(bName);
    });

    // Count occurrences of each name to detect duplicates
    const nameCounts = new Map();
    const nameIndexes = new Map();
    for (const ab of sortedBooks) {
      const name = ab?.name || ab?.id || "";
      nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
      nameIndexes.set(name, 0);
    }

    sortedBooks.forEach((ab) => {
      const option = document.createElement("option");
      const id = ab?.id || "";
      const name = ab?.name || ab?.id || "";
      const type = ab?.type || "";
      const isRemote = ab?.remote === true;

      // Build display label
      let label = name;
      let suffix = "";
      const tooltipParts = [name];

      // Try to find account info from preferences
      // Match the WebExtension API's UUID to the .uid property in prefs
      const abInfo = abInfoByUuid.get(id);
      if (abInfo) {
        console.log(`[TMDBG Config] Found pref info for ${id}:`, abInfo);
        // Check for CardDAV URL which often contains the account
        const carddavUrl = abInfo["carddav.url"] || abInfo["carddav.uri"] || "";
        const username = abInfo["carddav.username"] || abInfo["auth.dn"] || "";

        if (username) {
          suffix = username;
          tooltipParts.push(`Account: ${username}`);
        } else if (carddavUrl) {
          // Extract domain or account from URL
          try {
            const url = new URL(carddavUrl);
            // For Google: carddav.googleapis.com
            // For iCloud: contacts.icloud.com
            // For others: use hostname
            suffix = url.hostname
              .replace("carddav.", "")
              .replace("contacts.", "");
            tooltipParts.push(`URL: ${carddavUrl}`);
          } catch (_) {
            suffix = carddavUrl.substring(0, 30);
          }
        }
      }

      // If still no suffix and there are duplicates, number them
      const count = nameCounts.get(name) || 1;
      if (!suffix && count > 1) {
        const currentIdx = nameIndexes.get(name) + 1;
        nameIndexes.set(name, currentIdx);
        suffix = `#${currentIdx}`;
      }

      // For local (non-remote) address books, show "(Local)"
      if (!suffix && !isRemote) {
        suffix = "Local";
      }

      // For remote/CardDAV types, show type if no better suffix
      if (!suffix && (isRemote || (type && type !== "addressBook"))) {
        suffix = type || "remote";
      }

      // Apply suffix
      if (suffix) {
        label = `${name} (${suffix})`;
      }

      if (type) tooltipParts.push(`Type: ${type}`);
      if (isRemote) tooltipParts.push("Remote");
      else tooltipParts.push("Local");
      tooltipParts.push(`ID: ${id}`);

      option.value = id;
      option.textContent = label;
      option.title = tooltipParts.join(" - ");
      select.appendChild(option);
    });

    // Load current default - don't auto-select, let user configure manually
    const { defaultAddressBookId } = await browser.storage.local.get({
      defaultAddressBookId: null,
    });
    if (defaultAddressBookId) {
      select.value = defaultAddressBookId;
    }
  } catch (e) {
    console.warn("[TMDBG Config] loadAddressBooks failed", e);
    const select = typeof selector === "string" ? $(selector) : selector;
    if (select) select.innerHTML = '<option value="">Error loading address books</option>';
  }
}

export async function saveAddressBookConfig() {
  try {
    const select = $("default-addressbook");
    const selectedId = select?.value || null;
    await browser.storage.local.set({ defaultAddressBookId: selectedId });
    const abName = selectedId
      ? select.selectedOptions[0]?.textContent || selectedId
      : "None";
    console.log(`[TMDBG Config] Default address book saved: ${abName}`);
    // Don't show status message for auto-save to avoid UI clutter
  } catch (e) {
    console.warn("[TMDBG Config] saveAddressBookConfig failed", e);
    $("status").textContent = "Error saving address book configuration";
  }
}

export async function saveCalendarConfig() {
  try {
    const select = $("default-calendar");
    const selectedId = select?.value || null;

    await browser.storage.local.set({ defaultCalendarId: selectedId });

    const calendarName = selectedId
      ? select.selectedOptions[0]?.textContent || selectedId
      : "None";

    console.log(`[TMDBG Config] Default calendar saved: ${calendarName}`);
    // Don't show status message for auto-save to avoid UI clutter
  } catch (e) {
    console.warn("[TMDBG Config] saveCalendarConfig failed", e);
    $("status").textContent = "Error saving calendar configuration";
  }
}

