# Requests to TabMail's own servers never follow a redirect (2026-11-28)

TabMail's own servers (the backend and its `whoami` host, sign-in at `auth.tabmail.ai`, templates, ChatLink)
never answer with a redirect, and most requests to them carry the user's access token, the refresh token or a
session cookie. Every such request goes through `ownServerFetch(url, init)` in
`agent/modules/ownServerFetch.js`, which is `fetch` with `redirect: "error"` (a caller's own `redirect` is
overridden). A redirect answer then rejects the fetch with a `TypeError`, the same as a lost connection, so
nothing the request carries goes to another address.

## What callers see

A rejected fetch lands in each caller's existing network-error path. Notably the token refresh
(`supabaseAuth.js::refreshAccessToken`) treats it as `REFRESH_NETWORK_ERROR`, which is transient: the stored
session is kept and the refresh retries (memory 035). Nothing turns a redirect into a sign-out.

## What stays on plain fetch

- Add-on files loaded with `runtime.getURL` (prompt store, default templates, palette, welcome pages, search
  diagnostics).
- The search helper's update manifest on `cdn.tabmail.ai` (signed, no token).
- The developer page's local backend.
- `web_read`, which reads arbitrary pages through the `tmWebFetch` experiment and must keep following
  redirects (memory 028).

WebSocket connections (Device Sync, ChatLink) are not changed by this.

## The check

`test/ownServerFetch.test.js`:
- the helper's options;
- two loopback servers, 301/302/303/307/308 for a GET and for a POST with a body: the request fails and the
  second server sees nothing, while plain `fetch` follows the same redirect (control);
- a source check (acorn) that counts every call of the global `fetch` per file and expects exactly the list
  above. A new request to our servers must use `ownServerFetch`, or the check fails. A new plain fetch to
  something else gets a line in `BARE_FETCH_ALLOWED` with its reason.
