/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// redirectServers.js — two throwaway HTTP servers on 127.0.0.1 ephemeral ports. `first` answers every
// request with `status` and a Location on `second`, and records what it was sent; `second` records what
// reaches it and answers 200 "landed". Close them with `close()`.

import { createServer } from 'node:http';

function recorder(list, answer) {
  return (req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      list.push({ method: req.method, url: req.url, body, auth: req.headers.authorization });
      answer(res);
    });
  };
}

export async function redirectServers(status) {
  const asked = [];
  const reached = [];
  const second = createServer(recorder(reached, (res) => res.end('landed')));
  await new Promise((resolve) => second.listen(0, '127.0.0.1', resolve));
  const secondURL = `http://127.0.0.1:${second.address().port}`;
  const first = createServer(recorder(asked, (res) => { res.writeHead(status, { Location: `${secondURL}/elsewhere` }); res.end(); }));
  await new Promise((resolve) => first.listen(0, '127.0.0.1', resolve));
  const firstOrigin = `http://127.0.0.1:${first.address().port}`;
  const close = () => Promise.all([first, second].map((s) => new Promise((resolve) => s.close(resolve))));
  return { firstOrigin, firstURL: `${firstOrigin}/start`, asked, reached, close };
}
