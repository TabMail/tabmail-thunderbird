// Shared storage usage reporting that includes FTS database size
// Used by both config.js and popup.js for consistent reporting

// Cache for FTS database size to avoid repeated slow queries
let ftsSizeCache = { size: 0, timestamp: 0 };
const FTS_CACHE_TTL_MS = 1000; // 1 second cache

/**
 * Get fast storage usage for percentage calculations (avoids slow FTS queries)
 * @returns {Promise<{usage: number, quota: number, percent: number, totalMB: number, quotaMB: number}>}
 */
export async function getFastStorageUsage() {
  const { estimateUsage } = await import("./idbStorage.js");
  const { usage, quota } = await estimateUsage();
  
  if (!quota) {
    return { usage: 0, quota: 0, percent: 0, totalMB: 0, quotaMB: 0 };
  }
  
  const percent = ((usage / quota) * 100).toFixed(1);
  const totalMB = (usage / (1024 * 1024)).toFixed(1);
  const quotaMB = (quota / (1024 * 1024)).toFixed(0);
  
  return {
    usage: Number(usage),
    quota: Number(quota),
    percent: Number(percent),
    totalMB: Number(totalMB),
    quotaMB: Number(quotaMB)
  };
}

/**
 * Get FTS database size with caching to avoid repeated slow queries
 * @returns {Promise<number>}
 */
async function getCachedFtsSize() {
  const now = Date.now();
  
  // Return cached value if still valid
  if (now - ftsSizeCache.timestamp < FTS_CACHE_TTL_MS) {
    return ftsSizeCache.size;
  }
  
  // Fetch fresh FTS size
  let ftsSize = 0;
  try {
    const ftsResponse = await browser.runtime.sendMessage({
      type: "fts",
      cmd: "stats"
    });
    if (ftsResponse?.ok && ftsResponse.dbBytes) {
      ftsSize = ftsResponse.dbBytes;
    }
  } catch (e) {
    console.warn("[StorageUsage] Failed to get FTS stats", e);
  }
  
  // Update cache
  ftsSizeCache = { size: ftsSize, timestamp: now };
  return ftsSize;
}

/**
 * Get comprehensive storage usage including FTS database size (with caching)
 * @returns {Promise<{usage: number, quota: number, ftsSize: number, breakdown: string}>}
 */
export async function getStorageUsage() {
  const { estimateUsage } = await import("./idbStorage.js");
  const { usage, quota } = await estimateUsage();
  
  if (!quota) {
    return { usage: 0, quota: 0, ftsSize: 0, breakdown: "Storage quota unavailable" };
  }
  
  // Get FTS database size with caching
  const ftsSize = await getCachedFtsSize();
  
  const percent = ((usage / quota) * 100).toFixed(1);
  const totalMB = (usage / (1024 * 1024)).toFixed(1);
  const quotaMB = (quota / (1024 * 1024)).toFixed(0);
  const cacheMB = ((usage - ftsSize) / (1024 * 1024)).toFixed(1);
  const ftsMB = (ftsSize / (1024 * 1024)).toFixed(1);
  
  // Create breakdown string
  let breakdown;
  if (ftsSize > 0) {
    breakdown = `Storage: ${totalMB} MB / ${quotaMB} MB (${percent}%) - Cache: ${cacheMB} MB, FTS: ${ftsMB} MB`;
  } else {
    breakdown = `Storage: ${totalMB} MB / ${quotaMB} MB (${percent}%)`;
  }
  
  return {
    usage: Number(usage),
    quota: Number(quota),
    ftsSize: Number(ftsSize),
    breakdown,
    percent: Number(percent),
    totalMB: Number(totalMB),
    quotaMB: Number(quotaMB),
    cacheMB: Number(cacheMB),
    ftsMB: Number(ftsMB)
  };
}

/**
 * Update storage usage display on a DOM element (fast version for popup)
 * @param {string} progressBarId - ID of progress bar element
 * @param {string} labelId - ID of label element 
 * @param {object} options - Display options
 */
export async function updateStorageDisplayFast(progressBarId, labelId, options = {}) {
  try {
    const storageInfo = await getFastStorageUsage();
    
    const progressBar = document.getElementById(progressBarId);
    const label = document.getElementById(labelId);
    
    if (progressBar) {
      progressBar.value = storageInfo.percent;
    }
    
    if (label) {
      // Use simple format for popup, detailed format for config page
      if (options.simpleFormat) {
        label.textContent = `Storage: ${storageInfo.totalMB} MB / ${storageInfo.quotaMB} MB`;
      } else {
        label.textContent = `Storage: ${storageInfo.totalMB} MB / ${storageInfo.quotaMB} MB (${storageInfo.percent}%)`;
      }
      
      // Add color warnings if enabled
      if (options.colorWarnings !== false) {
        if (storageInfo.percent > 80) {
          label.style.color = "orange";
          if (storageInfo.percent > 95) {
            label.style.color = "red";
          }
        } else {
          label.style.color = "";
        }
      }
    }
    
    return storageInfo;
  } catch (e) {
    console.warn("[StorageUsage] Failed to update storage display (fast)", e);
    
    const label = document.getElementById(labelId);
    if (label) {
      label.textContent = "Storage usage unavailable";
    }
    
    return null;
  }
}

/**
 * Update storage usage display on a DOM element
 * @param {string} progressBarId - ID of progress bar element
 * @param {string} labelId - ID of label element 
 * @param {object} options - Display options
 */
export async function updateStorageDisplay(progressBarId, labelId, options = {}) {
  try {
    const storageInfo = await getStorageUsage();
    
    const progressBar = document.getElementById(progressBarId);
    const label = document.getElementById(labelId);
    
    if (progressBar) {
      progressBar.value = storageInfo.percent;
    }
    
    if (label) {
      // Use simple format for popup, detailed format for config page
      if (options.simpleFormat) {
        label.textContent = `Storage: ${storageInfo.totalMB} MB / ${storageInfo.quotaMB} MB`;
      } else {
        label.textContent = storageInfo.breakdown;
      }
      
      // Add color warnings if enabled
      if (options.colorWarnings !== false) {
        if (storageInfo.percent > 80) {
          label.style.color = "orange";
          if (storageInfo.percent > 95) {
            label.style.color = "red";
          }
        } else {
          label.style.color = "";
        }
      }
    }
    
    return storageInfo;
  } catch (e) {
    console.warn("[StorageUsage] Failed to update storage display", e);
    
    const label = document.getElementById(labelId);
    if (label) {
      label.textContent = "Storage usage unavailable";
    }
    
    return null;
  }
}
