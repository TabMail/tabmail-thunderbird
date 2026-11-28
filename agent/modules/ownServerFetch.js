/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// TabMail's own servers (the backend, sign-in, templates, ChatLink) never answer with a redirect, and most
// requests to them carry the user's access token, refresh token or session cookie. A request to one of them
// therefore never follows a redirect: with `redirect: "error"` a redirect answer fails the request (fetch
// rejects with a TypeError, the same as a lost connection), so nothing the request carries goes to another
// address. Callers already handle a failed request.
//
// Requests to other addresses keep fetch's default handling: local add-on files, the signed helper update
// manifest, and the pages the web_read tool reads through its own experiment.

/**
 * `fetch` for a request to one of TabMail's own servers: the same arguments, and a redirect is never followed
 * (a `redirect` in `init` is overridden).
 * @param {string | URL} url
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
export function ownServerFetch(url, init = {}) {
  return fetch(url, { ...init, redirect: "error" });
}
