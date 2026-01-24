// tmWebFetch.sys.mjs - Privileged web fetching for TabMail
// TB 141+, MV3

const { ExtensionCommon: ExtensionCommonWebFetch } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");
const { NetUtil: NetUtilWebFetch } = ChromeUtils.importESModule("resource://gre/modules/NetUtil.sys.mjs");

const EXPORTED_SYMBOLS = ["tmWebFetch"];

// Get Services for IO and other utilities
var ServicesWebFetch = globalThis.Services;

var tmWebFetch = class extends ExtensionCommonWebFetch.ExtensionAPI {
  getAPI(context) {
    return {
      tmWebFetch: {
        /**
         * Fetch URL from privileged context, bypassing CORS
         * @param {string} url - The URL to fetch
         * @param {object} options - Options (timeout, etc.)
         * @returns {Promise<object>} - Response object with status, statusText, contentType, and responseText
         */
        async fetch(url, options = {}) {
          const timeout = options.timeout || 30000;
          
          return new Promise((resolve, reject) => {
            try {
              const uri = ServicesWebFetch.io.newURI(url);
              const channel = ServicesWebFetch.io.newChannelFromURI(
                uri,
                null,
                ServicesWebFetch.scriptSecurityManager.getSystemPrincipal(),
                null,
                Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL,
                Ci.nsIContentPolicy.TYPE_OTHER
              );
              
              // Set request headers
              if (channel instanceof Ci.nsIHttpChannel) {
                try {
                  channel.setRequestHeader("User-Agent", "TabMail/1.0 (Thunderbird Extension; +https://tabmail.app)", false);
                  channel.setRequestHeader("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", false);
                } catch (e) {
                  console.warn("tmWebFetch: Could not set request headers:", e);
                }
              }
              
              // Set timeout using XPCOM timer
              let timer = null;
              if (timeout > 0) {
                timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
                timer.initWithCallback(
                  {
                    notify: () => {
                      try {
                        channel.cancel(Components.results.NS_BINDING_ABORTED);
                      } catch (e) {
                        // Ignore
                      }
                      reject(new Error("Request timeout"));
                    }
                  },
                  timeout,
                  Ci.nsITimer.TYPE_ONE_SHOT
                );
              }
              
              NetUtilWebFetch.asyncFetch(channel, (inputStream, status, request) => {
                if (timer) {
                  timer.cancel();
                }
                
                try {
                  if (!Components.isSuccessCode(status)) {
                    reject(new Error(`Network error: ${status}`));
                    return;
                  }
                  
                  // Read response
                  const responseText = NetUtilWebFetch.readInputStreamToString(
                    inputStream,
                    inputStream.available()
                  );
                  
                  // Get status and headers
                  let httpStatus = 200;
                  let httpStatusText = "OK";
                  let contentType = "";
                  
                  if (request instanceof Ci.nsIHttpChannel) {
                    try {
                      httpStatus = request.responseStatus;
                      httpStatusText = request.responseStatusText;
                      contentType = request.getResponseHeader("Content-Type");
                    } catch (e) {
                      // Some headers might not be available
                    }
                  }
                  
                  resolve({
                    status: httpStatus,
                    statusText: httpStatusText,
                    responseText: responseText,
                    contentType: contentType || "",
                  });
                } catch (e) {
                  reject(new Error(`Failed to process response: ${e}`));
                } finally {
                  try {
                    inputStream.close();
                  } catch (e) {
                    // Ignore close errors
                  }
                }
              });
            } catch (e) {
              reject(new Error(`Channel creation failed: ${e}`));
            }
          });
        }
      }
    };
  }
};

