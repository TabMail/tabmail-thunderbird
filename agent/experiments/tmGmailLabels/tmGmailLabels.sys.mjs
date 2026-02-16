// tmGmailLabels.sys.mjs — Gmail REST API access for label sync.
// Uses XPCOM nsIChannel + asyncOpen for HTTP (same as tmWebFetch pattern,
// extended to support POST/PATCH with upload streams).

const { ExtensionCommon: ExtensionCommonGmailLabels } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
);
const { MailServices: MailServicesGmailLabels } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);
const { OAuth2Module: OAuth2ModuleGmailLabels } = ChromeUtils.importESModule(
  "resource:///modules/OAuth2Module.sys.mjs"
);

// Match tmWebFetch pattern: bare Cc/Ci are globals in .sys.mjs experiment
// modules, but Services must be read from globalThis.
var ServicesGL = globalThis.Services;

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

function _getAccessTokenForServer(server) {
  const oauth2Module = new OAuth2ModuleGmailLabels();
  const initialized = oauth2Module.initFromMail(server);
  if (!initialized) return Promise.resolve("");

  return new Promise((resolve) => {
    oauth2Module.getAccessToken({
      onSuccess(token) { resolve(token); },
      onFailure(error) {
        console.log(`[tmGmailLabels] getAccessToken failed: ${error}`);
        resolve("");
      },
    });
  });
}

function _getGmailServer(accountId) {
  try {
    const account = MailServicesGmailLabels.accounts.getAccount(accountId);
    if (!account?.incomingServer) return null;
    const server = account.incomingServer;
    if (!server.hostName?.includes("gmail")) return null;
    if (server.authMethod !== 10) return null; // 10 = OAuth2
    return server;
  } catch (e) {
    return null;
  }
}

/**
 * HTTP request via XPCOM nsIChannel + asyncOpen.
 * Supports GET/POST/PATCH/PUT with body. Bypasses CORS (system principal).
 */
function _httpRequest(url, method, headers, bodyStr) {
  return new Promise((resolve, reject) => {
    try {
      const uri = ServicesGL.io.newURI(url);
      const channel = ServicesGL.io.newChannelFromURI(
        uri,
        null,
        ServicesGL.scriptSecurityManager.getSystemPrincipal(),
        null,
        Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL,
        Ci.nsIContentPolicy.TYPE_OTHER
      );

      const httpChannel = channel.QueryInterface(Ci.nsIHttpChannel);
      httpChannel.requestMethod = method;
      for (const [k, v] of Object.entries(headers)) {
        httpChannel.setRequestHeader(k, v, false);
      }

      // Attach body for POST/PATCH/PUT
      if (bodyStr && method !== "GET") {
        const inputStream = Cc["@mozilla.org/io/string-input-stream;1"]
          .createInstance(Ci.nsIStringInputStream);
        inputStream.data = bodyStr;
        const uploadChannel = httpChannel.QueryInterface(Ci.nsIUploadChannel);
        uploadChannel.setUploadStream(inputStream, "application/json", -1);
        httpChannel.requestMethod = method; // setUploadStream resets to POST
      }

      // Stream listener collects response chunks
      const listener = {
        _chunks: [],
        QueryInterface: ChromeUtils.generateQI([
          "nsIStreamListener",
          "nsIRequestObserver",
        ]),
        onStartRequest() {},
        onDataAvailable(request, stream, offset, count) {
          const sis = Cc["@mozilla.org/scriptableinputstream;1"]
            .createInstance(Ci.nsIScriptableInputStream);
          sis.init(stream);
          this._chunks.push(sis.read(count));
        },
        onStopRequest(request, status) {
          try {
            const body = this._chunks.join("");
            let httpStatus = 0;
            try {
              httpStatus = request.QueryInterface(Ci.nsIHttpChannel).responseStatus;
            } catch (_) {}
            resolve({ status: httpStatus, body });
          } catch (e) {
            reject(e);
          }
        },
      };

      httpChannel.asyncOpen(listener);
    } catch (e) {
      reject(e);
    }
  });
}

var tmGmailLabels = class extends ExtensionCommonGmailLabels.ExtensionAPI {
  getAPI(context) {
    return {
      tmGmailLabels: {
        async getAccessToken(accountId) {
          try {
            const server = _getGmailServer(accountId);
            if (!server) return "";
            return await _getAccessTokenForServer(server);
          } catch (e) {
            console.log(`[tmGmailLabels] getAccessToken ERROR: ${e}`);
            return "";
          }
        },

        /**
         * Authenticated Gmail API request via XPCOM nsIChannel.
         * @param {string} accountId
         * @param {string} path - API path (e.g. "/labels")
         * @param {string} method - HTTP method
         * @param {string} bodyJson - JSON body string, or empty string for no body
         * @returns {string} JSON response body, or empty string on error
         */
        async gmailFetch(accountId, path, method, bodyJson) {
          try {
            const server = _getGmailServer(accountId);
            if (!server) return "";

            const headers = { "Authorization": "" };
            if (bodyJson) headers["Content-Type"] = "application/json";

            const doRequest = async (token) => {
              headers["Authorization"] = `Bearer ${token}`;
              return _httpRequest(`${GMAIL_API}${path}`, method, headers, bodyJson || null);
            };

            let token = await _getAccessTokenForServer(server);
            if (!token) return "";

            let result = await doRequest(token);

            // 401 → token expired, refresh and retry once
            if (result.status === 401) {
              token = await _getAccessTokenForServer(server);
              if (!token) return "";
              result = await doRequest(token);
            }

            if (result.status < 200 || result.status >= 300) {
              console.log(`[tmGmailLabels] gmailFetch ${method} ${path}: HTTP ${result.status} ${result.body?.substring(0, 200)}`);
              return "";
            }

            return result.body || "";
          } catch (e) {
            console.log(`[tmGmailLabels] gmailFetch ERROR ${method} ${path}: ${e}`);
            return "";
          }
        },
      },
    };
  }
};
