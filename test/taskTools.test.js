// taskTools.test.js — Tests for task_add ID reference validation and formatting

import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Replicated _checkForIdReferences from task_add.js
// ---------------------------------------------------------------------------

function _checkForIdReferences(text) {
	if (/\[Email\]\(\d+\)/i.test(text)) {
		return "Recurring task instructions must not reference specific emails.";
	}
	if (/\[(Event|Contact)\]\(\d+\)/i.test(text)) {
		return "Recurring task instructions must not reference specific events or contacts by ID.";
	}
	if (/\b(?:unique_id|message_id|event_id|contact_id)\s*[:=]\s*\S+/i.test(text)) {
		return "Recurring task instructions must not include item IDs.";
	}
	return null;
}

// ---------------------------------------------------------------------------
// Replicated formatTaskEntry from task_add.js
// ---------------------------------------------------------------------------

function formatTaskEntry(text, scheduleDays, scheduleDate, scheduleTime, tz) {
	if (scheduleDate) {
		return `[Task] Once ${scheduleDate} ${scheduleTime} [${tz}], ${text}`;
	}
	return `[Task] Schedule ${scheduleDays} ${scheduleTime} [${tz}], ${text}`;
}

// ---------------------------------------------------------------------------
// Replicated validateScheduleDays from task_add.js
// ---------------------------------------------------------------------------

const VALID_DAYS = new Set(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
const VALID_PRESETS = new Set(["daily", "weekdays", "weekends"]);

function validateScheduleDays(raw) {
	const val = raw.toLowerCase().trim();
	if (VALID_PRESETS.has(val)) return val;
	const parts = val.split(",").map(d => d.trim());
	if (parts.length === 0) return null;
	for (const part of parts) {
		if (!VALID_DAYS.has(part)) return null;
	}
	return parts.join(",");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("_checkForIdReferences", () => {
	it("rejects [Email](N) references", () => {
		expect(_checkForIdReferences("follow up on [Email](3) from Bob")).not.toBeNull();
	});

	it("rejects [Email](N) case-insensitive", () => {
		expect(_checkForIdReferences("check [email](5)")).not.toBeNull();
	});

	it("rejects [Event](N) references", () => {
		expect(_checkForIdReferences("cancel [Event](12)")).not.toBeNull();
	});

	it("rejects [Contact](N) references", () => {
		expect(_checkForIdReferences("update [Contact](7)")).not.toBeNull();
	});

	it("rejects unique_id patterns", () => {
		expect(_checkForIdReferences("check unique_id: abc123")).not.toBeNull();
		expect(_checkForIdReferences("read message_id=xyz")).not.toBeNull();
	});

	it("accepts clean instructions", () => {
		expect(_checkForIdReferences("summarize important unread emails")).toBeNull();
		expect(_checkForIdReferences("check for urgent emails from Alice")).toBeNull();
		expect(_checkForIdReferences("give me a daily digest")).toBeNull();
	});

	it("accepts email addresses (not [Email](N))", () => {
		expect(_checkForIdReferences("check emails from bob@test.com")).toBeNull();
	});
});

describe("formatTaskEntry", () => {
	it("formats recurring task", () => {
		const entry = formatTaskEntry("Morning digest", "weekdays", null, "09:00", "America/Vancouver");
		expect(entry).toBe("[Task] Schedule weekdays 09:00 [America/Vancouver], Morning digest");
	});

	it("formats one-off task", () => {
		const entry = formatTaskEntry("Check Bob's reply", null, "2026/03/28", "15:00", "America/Vancouver");
		expect(entry).toBe("[Task] Once 2026/03/28 15:00 [America/Vancouver], Check Bob's reply");
	});
});

describe("validateScheduleDays", () => {
	it("accepts presets", () => {
		expect(validateScheduleDays("daily")).toBe("daily");
		expect(validateScheduleDays("weekdays")).toBe("weekdays");
		expect(validateScheduleDays("weekends")).toBe("weekends");
	});

	it("accepts comma-separated days", () => {
		expect(validateScheduleDays("mon,wed,fri")).toBe("mon,wed,fri");
	});

	it("rejects invalid days", () => {
		expect(validateScheduleDays("xyz")).toBeNull();
		expect(validateScheduleDays("mon,xyz")).toBeNull();
	});

	it("is case-insensitive", () => {
		expect(validateScheduleDays("WEEKDAYS")).toBe("weekdays");
		expect(validateScheduleDays("Mon,Wed")).toBe("mon,wed");
	});

	it("trims whitespace", () => {
		expect(validateScheduleDays("  daily  ")).toBe("daily");
		expect(validateScheduleDays("mon, wed, fri")).toBe("mon,wed,fri");
	});
});
