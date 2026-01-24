// fts/diagnostics.js
// Diagnostic tools for FTS system debugging

export async function runFtsDiagnostics() {
  const results = {
    timestamp: new Date().toISOString(),
    config: null,
    wasmFiles: {},
    workerTest: null,
    engineTest: null,
    messageHandlers: {}
  };

  console.log("[FTS Diagnostics] Starting FTS system diagnostics...");

  // 1. Check configuration (load from storage)
  try {
    const stored = await browser.storage.local.get({
      chat_useFtsSearch: true,
      chat_ftsBatchSize: 250,
      chat_ftsSleepBetweenBatchMs: 250,
    });
    results.config = {
      useFtsSearch: stored.chat_useFtsSearch,
      ftsBatchSize: stored.chat_ftsBatchSize,
      ftsSleepBetweenBatchMs: stored.chat_ftsSleepBetweenBatchMs,
    };
    console.log("[FTS Diagnostics] ✅ Configuration loaded:", results.config);
  } catch (e) {
    results.config = { error: e.message };
    console.error("[FTS Diagnostics] ❌ Configuration load failed:", e);
  }

  // 2. Check WASM files accessibility
  const wasmFiles = [
    'sqlite3.js',
    'sqlite3.wasm', 
    'sqlite3-opfs-async-proxy.js'
  ];

  for (const file of wasmFiles) {
    try {
      const url = browser.runtime.getURL(`fts/${file}`);
      const response = await fetch(url);
      results.wasmFiles[file] = {
        url,
        status: response.status,
        size: response.headers.get('content-length') || 'unknown',
        contentType: response.headers.get('content-type') || 'unknown'
      };
      console.log(`[FTS Diagnostics] ✅ File ${file} accessible:`, results.wasmFiles[file]);
    } catch (e) {
      results.wasmFiles[file] = { error: e.message };
      console.error(`[FTS Diagnostics] ❌ File ${file} failed:`, e);
    }
  }

  // 3. Test worker creation and SQLite initialization
  try {
    const workerUrl = browser.runtime.getURL("fts/worker.js");
    const testWorker = new Worker(workerUrl, { type: "module" });
    
    // Test worker communication
    const testPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Worker timeout")), 10000); // Longer timeout for init
      
      testWorker.onmessage = (e) => {
        clearTimeout(timeout);
        testWorker.terminate();
        resolve(e.data);
      };
      
      testWorker.onerror = (e) => {
        clearTimeout(timeout);
        testWorker.terminate();
        reject(e);
      };
      
      // Test actual SQLite initialization to check OPFS
      testWorker.postMessage({ id: "init-test", method: "init" });
    });

    results.workerTest = await testPromise;
    console.log("[FTS Diagnostics] ✅ Worker + SQLite init test:", results.workerTest);
  } catch (e) {
    results.workerTest = { error: e.message };
    console.error("[FTS Diagnostics] ❌ Worker test failed:", e);
  }

  // 4. Test runtime message handlers
  try {
    // Test chat config handler
    const configResponse = await browser.runtime.sendMessage({ 
      command: "get-chat-config" 
    });
    results.messageHandlers.chatConfig = configResponse;
    console.log("[FTS Diagnostics] ✅ Chat config handler:", configResponse);

    // Test FTS handler (will fail if engine not initialized)
    try {
      const ftsResponse = await browser.runtime.sendMessage({ 
        type: "fts", 
        cmd: "stats" 
      });
      results.messageHandlers.fts = ftsResponse;
      console.log("[FTS Diagnostics] ✅ FTS handler response:", ftsResponse);
    } catch (e) {
      results.messageHandlers.fts = { error: e.message };
      console.log("[FTS Diagnostics] ⚠️ FTS handler not responding:", e.message);
    }
  } catch (e) {
    results.messageHandlers.error = e.message;
    console.error("[FTS Diagnostics] ❌ Message handler test failed:", e);
  }

  // 5. Test FTS engine direct import
  try {
    const { ftsSearch } = await import("./engine.js");
    if (ftsSearch) {
      results.engineTest = { available: true, methods: Object.keys(ftsSearch) };
      console.log("[FTS Diagnostics] ✅ FTS engine import successful:", results.engineTest);
    } else {
      results.engineTest = { available: false, error: "ftsSearch not exported" };
      console.log("[FTS Diagnostics] ❌ FTS engine not available");
    }
  } catch (e) {
    results.engineTest = { error: e.message };
    console.error("[FTS Diagnostics] ❌ FTS engine import failed:", e);
  }

  console.log("[FTS Diagnostics] Complete diagnostic results:", results);
  return results;
}

// Quick diagnostic that can be run from browser console
export async function quickFtsCheck() {
  console.log("=== Quick FTS Status Check ===");
  
  try {
    const configResp = await browser.runtime.sendMessage({ command: "get-chat-config" });
    console.log("Config:", configResp?.config?.useFtsSearch ? "FTS ENABLED" : "FTS DISABLED");
  } catch (e) {
    console.log("Config: ERROR -", e.message);
  }

  try {
    const ftsResp = await browser.runtime.sendMessage({ type: "fts", cmd: "stats" });
    if (ftsResp?.ok) {
      console.log(`FTS Status: ✅ WORKING - ${ftsResp.docs} messages indexed, ${(ftsResp.dbBytes/1024/1024).toFixed(1)}MB`);
    } else {
      console.log("FTS Status: ❌ NOT WORKING -", ftsResp?.error || "No response");
    }
  } catch (e) {
    console.log("FTS Status: ❌ UNREACHABLE -", e.message);
  }

  console.log("=== Run `await runFtsDiagnostics()` for detailed analysis ===");
}

// Expose for console access
if (typeof window !== 'undefined') {
  window.runFtsDiagnostics = runFtsDiagnostics;
  window.quickFtsCheck = quickFtsCheck;
}
