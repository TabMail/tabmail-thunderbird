// folderResolver.js
// Requires "accountsRead" permission

let _byEmail = null;                 // email (lowercased) -> Set<account>
let _byHost  = null;                 // hostname (lowercased) -> Set<account>
const _folderCache = new Map();      // xulUri -> MailFolder

export async function resolveWeFolderFromXulUri(xulUri, { normalize = false } = {}) {
  console.debug(`[folderResolver-DEBUG] resolveWeFolderFromXulUri called with xulUri=${xulUri}`);
  if (!xulUri || typeof xulUri !== "string") return null;

  if (_folderCache.has(xulUri)) {
    console.debug(`[folderResolver-DEBUG] Cache hit for ${xulUri}`);
    const f = _folderCache.get(xulUri);
    return normalize ? toWeFolderRef(f) : f;
  }

  const parsed = parseXulFolderUri(xulUri);
  console.debug(`[folderResolver-DEBUG] Parsed URI=`, parsed);
  if (!parsed) {
    console.warn(`[folderResolver-DEBUG] Failed to parse XUL folder URI: ${xulUri}`);
    return null;
  }
  const { scheme, username, hostname, path: tbPath } = parsed;

  const account = await findAccountByAuthority(username, hostname, scheme);
  if (!account) {
    console.warn(`[folderResolver-DEBUG] No account match for ${username}@${hostname} (${scheme})`);
    return null;
  }
  console.debug(`[folderResolver-DEBUG] Matched accountId=${account.id}, name=${account.name}`);

  // Ensure path starts with "/" to match Thunderbird's folder structure
  const normalizedPath = tbPath.startsWith('/') ? tbPath : ('/' + tbPath);
  console.debug(`[folderResolver-DEBUG] Normalized path from '${tbPath}' to '${normalizedPath}'`);
  
  const hit = findByThunderbirdPath(account.rootFolder, normalizedPath);
  if (!hit) {
    console.warn(`[folderResolver-DEBUG] No folder match for path='${normalizedPath}' under accountId=${account.id}`);
    return null;
  }

  console.debug(`[folderResolver-DEBUG] Found folder path='${hit.path}', accountId=${hit.accountId}, id=${hit.id}`);
  _folderCache.set(xulUri, hit);
  return normalize ? toWeFolderRef(hit) : hit;
}

function parseXulFolderUri(uri) {
  // imap://user%40domain@imap.gmail.com/INBOX/Sub
  // mailbox://nobody@Local%20Folders/Archive
  const m = uri.match(/^([a-z]+):\/\/([^@]+)@([^/]+)\/?(.*)$/i);
  if (!m) return null;
  return {
    scheme:   m[1].toLowerCase(),
    username: decodeURIComponent(m[2]),        // often full email for IMAP
    hostname: m[3].toLowerCase(),              // may include port
    path:     decodeURIComponent(m[4] || ""),   // TB folder path e.g. "INBOX", "[Gmail]/All Mail"
  };
}

async function buildAccountIndexes() {
  const accounts = await browser.accounts.list(true); // include subFolders
  _byEmail = new Map();
  _byHost  = new Map();

  console.debug(`[folderResolver-DEBUG] Building account indexes (${accounts.length} accounts)`);
  for (const a of accounts) {
    // Index by identity emails (most reliable for IMAP)
    for (const ident of (a.identities || [])) {
      const email = String(ident?.email || "").toLowerCase();
      if (!email) continue;
      if (!_byEmail.has(email)) _byEmail.set(email, new Set());
      _byEmail.get(email).add(a);
      console.debug(`[folderResolver-DEBUG] Indexed by email: ${email} -> accountId=${a.id}`);
    }

    // Optional: index by incomingServer.hostname if exposed
    const host = String(a?.incomingServer?.hostname || "").toLowerCase();
    if (host) {
      if (!_byHost.has(host)) _byHost.set(host, new Set());
      _byHost.get(host).add(a);
      console.debug(`[folderResolver-DEBUG] Indexed by host: ${host} -> accountId=${a.id}`);
    } else {
      console.debug(`[folderResolver-DEBUG] incomingServer.hostname not exposed for accountId=${a.id} (ok)`);
    }
  }
}

/**
 * Pick the account using identity email first; refine by hostname if possible.
 */
async function findAccountByAuthority(username, hostname, scheme) {
  if (!_byEmail || !_byHost) await buildAccountIndexes();

  const emailKey = String(username).toLowerCase();
  const hostKey  = String(hostname).toLowerCase();

  const emailCandidates = _byEmail.get(emailKey);
  const hostCandidates  = _byHost.get(hostKey);

  // 1) Strongest: email ∩ host
  if (emailCandidates && hostCandidates) {
    const inter = intersectSets(emailCandidates, hostCandidates);
    if (inter.size === 1) {
      const only = [...inter][0];
      console.debug(`[folderResolver-DEBUG] Account chosen by email+host intersection: accountId=${only.id}`);
      return only;
    }
    if (inter.size > 1) {
      const any = [...inter][0];
      console.debug(`[folderResolver-DEBUG] Multiple email+host matches; picking first accountId=${any.id}`);
      return any;
    }
  }

  // 2) Email only
  if (emailCandidates && emailCandidates.size) {
    const any = [...emailCandidates][0];
    console.debug(`[folderResolver-DEBUG] Account chosen by email only: accountId=${any.id}`);
    return any;
  }

  // 3) Try matching by local part + domain relationship when exact match fails
  const localPart = emailKey.includes('@') ? emailKey.split('@')[0] : emailKey;
  console.debug(`[folderResolver-DEBUG] Trying local part + domain match for '${localPart}' with hostname '${hostKey}'`);
  
  for (const [email, accountSet] of _byEmail.entries()) {
    if (!email.includes('@')) continue;
    
    const [emailLocalPart, emailDomain] = email.split('@');
    
    // Check if local parts match
    if (emailLocalPart === localPart) {
      // Check if hostname is related to email domain
      const isHostnameRelated = hostKey.includes(emailDomain) || 
                               emailDomain.includes(hostKey.replace(/^(mail|imap|smtp)\./, ''));
      
      if (isHostnameRelated) {
        const any = [...accountSet][0];
        console.debug(`[folderResolver-DEBUG] Account chosen by local part + domain match: '${localPart}@${emailDomain}' relates to hostname '${hostKey}' -> accountId=${any.id}`);
        return any;
      } else {
        console.debug(`[folderResolver-DEBUG] Local part '${localPart}' matches but hostname '${hostKey}' doesn't relate to domain '${emailDomain}' - skipping`);
      }
    }
  }

  // 4) Host only (when username wasn't an identity email)
  if (hostCandidates && hostCandidates.size) {
    const any = [...hostCandidates][0];
    console.debug(`[folderResolver-DEBUG] Account chosen by host only: accountId=${any.id}`);
    return any;
  }

  // 5) Local Folders (mailbox://)
  if (scheme === "mailbox") {
    const accounts = await browser.accounts.list();
    for (const a of accounts) {
      if ((a?.incomingServer?.type || "") === "none") {
        console.debug(`[folderResolver-DEBUG] Local Folders fallback: accountId=${a.id}`);
        return a;
      }
    }
  }

  return null;
}

function intersectSets(a, b) {
  const out = new Set();
  for (const x of a) if (b.has(x)) out.add(x);
  return out;
}

/**
 * BFS search by exact Thunderbird path (e.g., "/INBOX", "/INBOX/Sub", "/[Gmail]/All Mail")
 */
function findByThunderbirdPath(root, targetPath) {
  if (!root) return null;
  console.debug(`[folderResolver-DEBUG] Searching for targetPath='${targetPath}' in account folders`);
  
  const q = [root];
  while (q.length) {
    const f = q.shift();
    console.debug(`[folderResolver-DEBUG] Checking folder path='${f.path}', name='${f.name}'`);
    
    if (f.path === targetPath) {
      console.debug(`[folderResolver-DEBUG] Exact match found for path='${targetPath}'`);
      return f;
    }
    
    for (const sub of (f.subFolders || [])) q.push(sub);
  }
  
  console.debug(`[folderResolver-DEBUG] No match found for targetPath='${targetPath}'`);
  return null;
}

export function toWeFolderRef(mailFolder) {
  if (!mailFolder) return null;
  return {
    accountId: mailFolder.accountId, // correct casing
    path: mailFolder.path,
    id: mailFolder.id,
    name: mailFolder.name,
    type: mailFolder.type,
  };
}