/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Minimal shared buffer to carry the most recent "think" text from the LLM.
// This avoids changing existing call sites and prevents circular imports.

let _lastThink = "";

export function setThink(think) {
	_lastThink = typeof think === "string" ? think : "";
}

export function getAndClearThink() {
	const t = _lastThink || "";
	_lastThink = "";
	return t;
}


