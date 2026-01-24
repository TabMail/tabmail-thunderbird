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


