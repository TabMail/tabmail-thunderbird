// taskScheduler.test.js – Tests for task schedule evaluation
//
// taskScheduler.js imports from ./utils.js which requires browser APIs.
// We replicate the pure logic functions here for direct unit testing
// (matching the pattern used by kbReminderGenerator.test.js).

import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Replicated pure functions from taskScheduler.js
// ---------------------------------------------------------------------------

const DAY_NAMES = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function resolveScheduleDays(scheduleDays) {
	const lower = scheduleDays.toLowerCase().trim();
	if (lower === "daily") return [0, 1, 2, 3, 4, 5, 6];
	if (lower === "weekdays") return [1, 2, 3, 4, 5];
	if (lower === "weekends") return [0, 6];

	const parts = lower.split(",").map((s) => s.trim());
	const days = [];
	for (const part of parts) {
		const dayNum = DAY_NAMES[part];
		if (dayNum !== undefined && !days.includes(dayNum)) {
			days.push(dayNum);
		}
	}
	return days.sort((a, b) => a - b);
}

function parseScheduleTime(scheduleTime) {
	const parts = scheduleTime.split(":");
	if (parts.length !== 2) return null;
	const hours = parseInt(parts[0], 10);
	const minutes = parseInt(parts[1], 10);
	if (isNaN(hours) || isNaN(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
	return { hours, minutes };
}

// ---------------------------------------------------------------------------
// Replicated parseTasksFromKB regex from kbTaskParser.js
// ---------------------------------------------------------------------------

const TASK_SCHEDULE_REGEX = /^-?\s*\[Task\]\s*Schedule\s+(\S+)\s+(\d{2}:\d{2})(?:\s+\[([^\]]+)\])?,\s*(.+)$/i;
const TASK_ONCE_REGEX = /^-?\s*\[Task\]\s*Once\s+(\d{4}\/\d{2}\/\d{2})\s+(\d{2}:\d{2})(?:\s+\[([^\]]+)\])?,\s*(.+)$/i;

function parseTasksFromKB(kbText) {
	if (!kbText || !kbText.trim()) return [];
	const lines = kbText.split("\n");
	const results = [];

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed.includes("[Task]")) continue;

		const scheduleMatch = trimmed.match(TASK_SCHEDULE_REGEX);
		if (scheduleMatch) {
			results.push({
				scheduleDays: scheduleMatch[1],
				scheduleDate: null,
				scheduleTime: scheduleMatch[2],
				timezone: scheduleMatch[3] || null,
				instruction: scheduleMatch[4].trim(),
				rawLine: trimmed,
				kind: "recurring",
			});
			continue;
		}

		const onceMatch = trimmed.match(TASK_ONCE_REGEX);
		if (onceMatch) {
			results.push({
				scheduleDays: null,
				scheduleDate: onceMatch[1],
				scheduleTime: onceMatch[2],
				timezone: onceMatch[3] || null,
				instruction: onceMatch[4].trim(),
				rawLine: trimmed,
				kind: "once",
			});
			continue;
		}
	}
	return results;
}

// ---------------------------------------------------------------------------
// Replicated DJB2 hash from kbTaskParser.js
// ---------------------------------------------------------------------------

function getTaskHash(taskEntry) {
	const content = taskEntry.instruction || "";
	let hash = 0;
	for (let i = 0; i < content.length; i++) {
		const char = content.charCodeAt(i);
		hash = ((hash << 5) - hash) + char;
		hash = hash & hash;
	}
	return `t:${hash.toString(36)}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveScheduleDays", () => {
	it("resolves 'daily' to all 7 days", () => {
		expect(resolveScheduleDays("daily")).toEqual([0, 1, 2, 3, 4, 5, 6]);
	});

	it("resolves 'weekdays' to Mon-Fri", () => {
		expect(resolveScheduleDays("weekdays")).toEqual([1, 2, 3, 4, 5]);
	});

	it("resolves 'weekends' to Sat-Sun", () => {
		expect(resolveScheduleDays("weekends")).toEqual([0, 6]);
	});

	it("resolves comma-separated days", () => {
		expect(resolveScheduleDays("mon,wed,fri")).toEqual([1, 3, 5]);
	});

	it("handles whitespace in comma-separated days", () => {
		expect(resolveScheduleDays("mon, wed, fri")).toEqual([1, 3, 5]);
	});

	it("deduplicates days", () => {
		expect(resolveScheduleDays("mon,mon,tue")).toEqual([1, 2]);
	});

	it("sorts days numerically", () => {
		expect(resolveScheduleDays("fri,mon,wed")).toEqual([1, 3, 5]);
	});

	it("is case-insensitive", () => {
		expect(resolveScheduleDays("MON,WED")).toEqual([1, 3]);
		expect(resolveScheduleDays("Daily")).toEqual([0, 1, 2, 3, 4, 5, 6]);
	});

	it("ignores invalid day names", () => {
		expect(resolveScheduleDays("mon,xyz,fri")).toEqual([1, 5]);
	});

	it("returns empty for all invalid input", () => {
		expect(resolveScheduleDays("xyz,abc")).toEqual([]);
	});
});

describe("parseScheduleTime", () => {
	it("parses valid HH:MM", () => {
		expect(parseScheduleTime("09:00")).toEqual({ hours: 9, minutes: 0 });
		expect(parseScheduleTime("23:59")).toEqual({ hours: 23, minutes: 59 });
		expect(parseScheduleTime("00:00")).toEqual({ hours: 0, minutes: 0 });
	});

	it("parses single-digit hour", () => {
		expect(parseScheduleTime("9:00")).toEqual({ hours: 9, minutes: 0 });
	});

	it("rejects out-of-range values", () => {
		expect(parseScheduleTime("25:00")).toBeNull();
		expect(parseScheduleTime("09:60")).toBeNull();
		expect(parseScheduleTime("-1:00")).toBeNull();
	});

	it("rejects invalid format", () => {
		expect(parseScheduleTime("abc")).toBeNull();
		expect(parseScheduleTime("")).toBeNull();
		expect(parseScheduleTime("09")).toBeNull();
	});
});

describe("parseTasksFromKB", () => {
	it("parses standard [Task] Schedule entry with timezone", () => {
		const kb = "- [Task] Schedule weekdays 09:00 [America/Vancouver], Give me a morning digest";
		const result = parseTasksFromKB(kb);
		expect(result).toHaveLength(1);
		expect(result[0].scheduleDays).toBe("weekdays");
		expect(result[0].scheduleTime).toBe("09:00");
		expect(result[0].timezone).toBe("America/Vancouver");
		expect(result[0].instruction).toBe("Give me a morning digest");
		expect(result[0].kind).toBe("recurring");
	});

	it("parses [Task] Once entry (one-off task)", () => {
		const kb = "- [Task] Once 2026/03/28 15:00 [America/Vancouver], Check if Bob replied to the budget email";
		const result = parseTasksFromKB(kb);
		expect(result).toHaveLength(1);
		expect(result[0].scheduleDate).toBe("2026/03/28");
		expect(result[0].scheduleDays).toBeNull();
		expect(result[0].scheduleTime).toBe("15:00");
		expect(result[0].timezone).toBe("America/Vancouver");
		expect(result[0].instruction).toBe("Check if Bob replied to the budget email");
		expect(result[0].kind).toBe("once");
	});

	it("parses [Task] Once entry without timezone", () => {
		const kb = "[Task] Once 2026/04/01 09:00, Review quarterly report";
		const result = parseTasksFromKB(kb);
		expect(result).toHaveLength(1);
		expect(result[0].timezone).toBeNull();
		expect(result[0].kind).toBe("once");
	});

	it("parses task entry without timezone", () => {
		const kb = "- [Task] Schedule daily 18:00, Check for urgent emails";
		const result = parseTasksFromKB(kb);
		expect(result).toHaveLength(1);
		expect(result[0].timezone).toBeNull();
		expect(result[0].instruction).toBe("Check for urgent emails");
	});

	it("parses task entry without bullet prefix", () => {
		const kb = "[Task] Schedule mon,wed,fri 08:00 [UTC], Summarize new messages";
		const result = parseTasksFromKB(kb);
		expect(result).toHaveLength(1);
		expect(result[0].scheduleDays).toBe("mon,wed,fri");
	});

	it("parses multiple task entries (mixed recurring and one-off)", () => {
		const kb = [
			"- [Task] Schedule weekdays 09:00 [America/Vancouver], Morning digest",
			"- [Reminder] Due 2026/03/27, Call Bob",
			"- [Task] Schedule daily 18:00, Evening check",
			"- [Task] Once 2026/04/01 10:00 [UTC], Review Q1 report",
			"- [Pinned] Important fact",
		].join("\n");
		const result = parseTasksFromKB(kb);
		expect(result).toHaveLength(3);
		expect(result[0].instruction).toBe("Morning digest");
		expect(result[0].kind).toBe("recurring");
		expect(result[1].instruction).toBe("Evening check");
		expect(result[1].kind).toBe("recurring");
		expect(result[2].instruction).toBe("Review Q1 report");
		expect(result[2].kind).toBe("once");
	});

	it("returns empty for no task entries", () => {
		const kb = "- [Reminder] Due 2026/03/27, Call Bob\n- [Pinned] Important fact";
		expect(parseTasksFromKB(kb)).toHaveLength(0);
	});

	it("returns empty for empty input", () => {
		expect(parseTasksFromKB("")).toHaveLength(0);
		expect(parseTasksFromKB(null)).toHaveLength(0);
	});

	it("skips malformed task lines", () => {
		const kb = [
			"- [Task] Missing schedule format",
			"- [Task] Schedule weekdays 09:00 [America/Vancouver], Valid entry",
		].join("\n");
		const result = parseTasksFromKB(kb);
		expect(result).toHaveLength(1);
		expect(result[0].instruction).toBe("Valid entry");
	});
});

describe("getTaskHash", () => {
	it("produces t: prefixed hash", () => {
		const hash = getTaskHash({ instruction: "Morning digest" });
		expect(hash).toMatch(/^t:/);
	});

	it("produces consistent hashes for same content", () => {
		const hash1 = getTaskHash({ instruction: "Morning digest" });
		const hash2 = getTaskHash({ instruction: "Morning digest" });
		expect(hash1).toBe(hash2);
	});

	it("produces different hashes for different content", () => {
		const hash1 = getTaskHash({ instruction: "Morning digest" });
		const hash2 = getTaskHash({ instruction: "Evening check" });
		expect(hash1).not.toBe(hash2);
	});

	it("handles empty instruction", () => {
		const hash = getTaskHash({ instruction: "" });
		expect(hash).toBe("t:0");
	});
});

// ---------------------------------------------------------------------------
// Replicated shouldFire logic from taskScheduler.js (simplified for testing)
// ---------------------------------------------------------------------------

const GRACE_WINDOW_MINUTES = 30;

function shouldFireSync(task, taskHash, isEnabled, executionState, nowMinutes, nowDayOfWeek, todayStr, prefireMinutes = 5) {
	if (!isEnabled) return { shouldFire: false, reason: "disabled" };

	// One-off tasks: check date match
	if (task.kind === "once" && task.scheduleDate) {
		const normalizedScheduleDate = task.scheduleDate.replace(/\//g, "-");
		if (normalizedScheduleDate !== todayStr) return { shouldFire: false, reason: "not the scheduled date" };
	} else {
		// Recurring tasks: check day of week
		const scheduledDays = resolveScheduleDays(task.scheduleDays);
		if (!scheduledDays.includes(nowDayOfWeek)) return { shouldFire: false, reason: "not a scheduled day" };
	}

	const timeParts = task.scheduleTime.split(":");
	const schedMinutes = parseInt(timeParts[0]) * 60 + parseInt(timeParts[1]);
	const windowStart = schedMinutes - prefireMinutes;
	const windowEnd = schedMinutes + GRACE_WINDOW_MINUTES;

	if (nowMinutes < windowStart || nowMinutes > windowEnd) return { shouldFire: false, reason: "outside fire window" };

	if (executionState && executionState.lastFired) {
		const lastFiredDate = executionState.lastFired.slice(0, 10);
		if (lastFiredDate === todayStr) return { shouldFire: false, reason: "already fired today" };
	}

	return { shouldFire: true, isPrefire: nowMinutes < schedMinutes, reason: "within fire window" };
}

describe("shouldFire (sync replica) — recurring tasks", () => {
	const task = { scheduleDays: "weekdays", scheduleTime: "09:00", timezone: null, kind: "recurring" };

	it("fires within pre-fire window", () => {
		// Wed 08:56, prefireMinutes=5, window starts at 08:55 (535)
		const result = shouldFireSync(task, "t:test", true, null, 536, 3, "2026-03-27");
		expect(result.shouldFire).toBe(true);
		expect(result.isPrefire).toBe(true);
	});

	it("fires at exact schedule time", () => {
		const result = shouldFireSync(task, "t:test", true, null, 540, 3, "2026-03-27");
		expect(result.shouldFire).toBe(true);
		expect(result.isPrefire).toBe(false);
	});

	it("fires within grace window", () => {
		// 09:20 = 560 minutes, within 30min grace
		const result = shouldFireSync(task, "t:test", true, null, 560, 3, "2026-03-27");
		expect(result.shouldFire).toBe(true);
	});

	it("does not fire outside grace window", () => {
		// 09:45 = 585, outside 30min grace (window ends at 570)
		const result = shouldFireSync(task, "t:test", true, null, 585, 3, "2026-03-27");
		expect(result.shouldFire).toBe(false);
		expect(result.reason).toBe("outside fire window");
	});

	it("does not fire before pre-fire window", () => {
		// 08:50 = 530, before 08:55 (535)
		const result = shouldFireSync(task, "t:test", true, null, 530, 3, "2026-03-27");
		expect(result.shouldFire).toBe(false);
	});

	it("does not fire on non-scheduled day", () => {
		// Sunday = 0, weekdays = [1,2,3,4,5]
		const result = shouldFireSync(task, "t:test", true, null, 540, 0, "2026-03-27");
		expect(result.shouldFire).toBe(false);
		expect(result.reason).toBe("not a scheduled day");
	});

	it("does not fire when disabled", () => {
		const result = shouldFireSync(task, "t:test", false, null, 540, 3, "2026-03-27");
		expect(result.shouldFire).toBe(false);
		expect(result.reason).toBe("disabled");
	});

	it("does not fire if already fired today", () => {
		const state = { lastFired: "2026-03-27", consecutiveErrors: 0 };
		const result = shouldFireSync(task, "t:test", true, state, 540, 3, "2026-03-27");
		expect(result.shouldFire).toBe(false);
		expect(result.reason).toBe("already fired today");
	});

	it("fires if last fired was yesterday", () => {
		const state = { lastFired: "2026-03-26", consecutiveErrors: 0 };
		const result = shouldFireSync(task, "t:test", true, state, 540, 3, "2026-03-27");
		expect(result.shouldFire).toBe(true);
	});

	it("works with daily schedule on any day", () => {
		const dailyTask = { scheduleDays: "daily", scheduleTime: "12:00", timezone: null, kind: "recurring" };
		// Sunday at noon
		const result = shouldFireSync(dailyTask, "t:test", true, null, 720, 0, "2026-03-27");
		expect(result.shouldFire).toBe(true);
	});
});

describe("shouldFire (sync replica) — one-off tasks", () => {
	const oneOffTask = { scheduleDays: null, scheduleDate: "2026/03/28", scheduleTime: "15:00", timezone: null, kind: "once" };

	it("fires on the scheduled date within fire window", () => {
		// 14:56 = 896 minutes, prefireMinutes=5, window starts at 895
		const result = shouldFireSync(oneOffTask, "t:test", true, null, 896, 6, "2026-03-28");
		expect(result.shouldFire).toBe(true);
		expect(result.isPrefire).toBe(true);
	});

	it("fires at exact schedule time on scheduled date", () => {
		// 15:00 = 900 minutes
		const result = shouldFireSync(oneOffTask, "t:test", true, null, 900, 6, "2026-03-28");
		expect(result.shouldFire).toBe(true);
		expect(result.isPrefire).toBe(false);
	});

	it("does not fire on wrong date", () => {
		const result = shouldFireSync(oneOffTask, "t:test", true, null, 900, 5, "2026-03-27");
		expect(result.shouldFire).toBe(false);
		expect(result.reason).toBe("not the scheduled date");
	});

	it("does not fire if already fired on scheduled date", () => {
		const state = { lastFired: "2026-03-28", consecutiveErrors: 0 };
		const result = shouldFireSync(oneOffTask, "t:test", true, state, 900, 6, "2026-03-28");
		expect(result.shouldFire).toBe(false);
		expect(result.reason).toBe("already fired today");
	});

	it("does not fire when disabled", () => {
		const result = shouldFireSync(oneOffTask, "t:test", false, null, 900, 6, "2026-03-28");
		expect(result.shouldFire).toBe(false);
		expect(result.reason).toBe("disabled");
	});
});

// ---------------------------------------------------------------------------
// Replicated detectMiss logic
// ---------------------------------------------------------------------------

function detectMissSync(task, taskHash, executionState, nowMinutes, nowDayOfWeek, todayStr) {
	// One-off tasks: check date match
	if (task.kind === "once" && task.scheduleDate) {
		const normalizedScheduleDate = task.scheduleDate.replace(/\//g, "-");
		if (normalizedScheduleDate !== todayStr) {
			if (normalizedScheduleDate < todayStr) {
				if (executionState && executionState.lastFired) {
					if (executionState.lastFired.slice(0, 10) === normalizedScheduleDate) {
						return { missed: false };
					}
				}
				return { missed: true, missedDate: normalizedScheduleDate };
			}
			return { missed: false };
		}
	} else {
		const scheduledDays = resolveScheduleDays(task.scheduleDays);
		if (!scheduledDays.includes(nowDayOfWeek)) return { missed: false };
	}

	const timeParts = task.scheduleTime.split(":");
	const schedMinutes = parseInt(timeParts[0]) * 60 + parseInt(timeParts[1]);

	if (nowMinutes <= schedMinutes + GRACE_WINDOW_MINUTES) return { missed: false };

	if (executionState && executionState.lastFired) {
		if (executionState.lastFired.slice(0, 10) === todayStr) return { missed: false };
	}

	return { missed: true, missedDate: todayStr };
}

describe("detectMiss (sync replica) — recurring tasks", () => {
	const task = { scheduleDays: "weekdays", scheduleTime: "09:00", timezone: null, kind: "recurring" };

	it("detects miss when window has passed and not fired", () => {
		// 10:00 = 600, grace ends at 09:30 = 570
		const result = detectMissSync(task, "t:test", null, 600, 3, "2026-03-27");
		expect(result.missed).toBe(true);
		expect(result.missedDate).toBe("2026-03-27");
	});

	it("no miss if still within window", () => {
		// 09:20 = 560, grace ends at 570
		const result = detectMissSync(task, "t:test", null, 560, 3, "2026-03-27");
		expect(result.missed).toBe(false);
	});

	it("no miss if already fired today", () => {
		const state = { lastFired: "2026-03-27" };
		const result = detectMissSync(task, "t:test", state, 600, 3, "2026-03-27");
		expect(result.missed).toBe(false);
	});

	it("no miss on non-scheduled day", () => {
		const result = detectMissSync(task, "t:test", null, 600, 0, "2026-03-27");
		expect(result.missed).toBe(false);
	});
});

describe("detectMiss (sync replica) — one-off tasks", () => {
	const oneOffTask = { scheduleDays: null, scheduleDate: "2026/03/28", scheduleTime: "15:00", timezone: null, kind: "once" };

	it("detects miss for past date one-off task not fired", () => {
		// Today is 2026-03-29, task was for 2026-03-28
		const result = detectMissSync(oneOffTask, "t:test", null, 600, 0, "2026-03-29");
		expect(result.missed).toBe(true);
		expect(result.missedDate).toBe("2026-03-28");
	});

	it("no miss for past date one-off task that was fired", () => {
		const state = { lastFired: "2026-03-28" };
		const result = detectMissSync(oneOffTask, "t:test", state, 600, 0, "2026-03-29");
		expect(result.missed).toBe(false);
	});

	it("no miss for future date one-off task", () => {
		// Today is 2026-03-27, task is for 2026-03-28
		const result = detectMissSync(oneOffTask, "t:test", null, 600, 4, "2026-03-27");
		expect(result.missed).toBe(false);
	});

	it("detects miss on scheduled date after grace window", () => {
		// Today is 2026-03-28, task time 15:00, now 16:00 = 960
		const result = detectMissSync(oneOffTask, "t:test", null, 960, 6, "2026-03-28");
		expect(result.missed).toBe(true);
		expect(result.missedDate).toBe("2026-03-28");
	});
});

// ---------------------------------------------------------------------------
// Replicated formatTaskSchedule from reminderBuilder.js
// ---------------------------------------------------------------------------

function formatTaskSchedule(scheduleDays, scheduleTime) {
	const time = scheduleTime || "??:??";
	const days = (scheduleDays || "").toLowerCase().trim();

	if (days === "daily") return `Daily at ${time}`;
	if (days === "weekdays") return `Weekdays at ${time}`;
	if (days === "weekends") return `Weekends at ${time}`;

	const parts = days.split(",").map((d) => d.trim()).filter(Boolean);
	if (parts.length === 0) return `At ${time}`;
	const dayLabels = parts.map((d) => d.charAt(0).toUpperCase() + d.slice(1));
	return `${dayLabels.join(", ")} at ${time}`;
}

describe("formatTaskSchedule", () => {
	it("formats daily", () => {
		expect(formatTaskSchedule("daily", "09:00")).toBe("Daily at 09:00");
	});

	it("formats weekdays", () => {
		expect(formatTaskSchedule("weekdays", "14:30")).toBe("Weekdays at 14:30");
	});

	it("formats weekends", () => {
		expect(formatTaskSchedule("weekends", "10:00")).toBe("Weekends at 10:00");
	});

	it("formats comma-separated days", () => {
		expect(formatTaskSchedule("mon,wed,fri", "08:00")).toBe("Mon, Wed, Fri at 08:00");
	});

	it("handles empty schedule", () => {
		expect(formatTaskSchedule("", "09:00")).toBe("At 09:00");
	});

	it("handles null time", () => {
		expect(formatTaskSchedule("daily", null)).toBe("Daily at ??:??");
	});
});
