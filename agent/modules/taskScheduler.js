// taskScheduler.js – Schedule evaluation for [Task] entries
// Determines when task items should fire, detects missed fires,
// and manages per-task execution state.

import { log } from "./utils.js";

const MODULE = "[TaskScheduler]";

// Default pre-fire offset: TB fires 5 minutes before scheduled time.
// Overridable via task.advance_minutes setting (1-30 min).
const DEFAULT_PREFIRE_MINUTES = 5;

// Grace window: 30 minutes after scheduled time
const GRACE_WINDOW_MS = 30 * 60 * 1000;

// Execution state storage key
const EXECUTION_STATE_KEY = "task_execution_state";

// Day-of-week mappings
const DAY_NAMES = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

/**
 * Read the pre-fire offset from task.advance_minutes setting.
 * Falls back to DEFAULT_PREFIRE_MINUTES if not set.
 */
async function _getPrefireMinutes() {
	try {
		const stored = await browser.storage.local.get({ "task.advance_minutes": null });
		const val = stored["task.advance_minutes"];
		if (val !== null && val !== undefined) {
			const n = Number(val);
			if (n >= 1 && n <= 30) return n;
		}
	} catch { /* ignore */ }
	return DEFAULT_PREFIRE_MINUTES;
}

/**
 * Resolve schedule_days string to an array of JS day-of-week numbers (0=Sun, 6=Sat).
 */
export function resolveScheduleDays(scheduleDays) {
	const lower = scheduleDays.toLowerCase().trim();
	if (lower === "daily") return [0, 1, 2, 3, 4, 5, 6];
	if (lower === "weekdays") return [1, 2, 3, 4, 5];
	if (lower === "weekends") return [0, 6];

	// Comma-separated day abbreviations
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

/**
 * Parse schedule_time "HH:MM" into { hours, minutes }.
 */
function parseScheduleTime(scheduleTime) {
	const parts = scheduleTime.split(":");
	if (parts.length !== 2) return null;
	const hours = parseInt(parts[0], 10);
	const minutes = parseInt(parts[1], 10);
	if (isNaN(hours) || isNaN(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
	return { hours, minutes };
}

/**
 * Get current time in a specific timezone as { hours, minutes, dayOfWeek, dateStr }.
 */
function getNowInTimezone(timezone) {
	const now = new Date();
	try {
		const opts = { timeZone: timezone, hour12: false, hour: "2-digit", minute: "2-digit", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit" };
		const parts = new Intl.DateTimeFormat("en-US", opts).formatToParts(now);
		const partsMap = {};
		for (const p of parts) partsMap[p.type] = p.value;

		const hours = parseInt(partsMap.hour, 10);
		const minutes = parseInt(partsMap.minute, 10);
		const year = partsMap.year;
		const month = partsMap.month.padStart(2, "0");
		const day = partsMap.day.padStart(2, "0");
		const dateStr = `${year}-${month}-${day}`;

		// Get day of week in timezone
		const dayFormatter = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" });
		const dayName = dayFormatter.format(now).toLowerCase();
		const dayOfWeek = DAY_NAMES[dayName.slice(0, 3)] ?? now.getDay();

		return { hours, minutes, dayOfWeek, dateStr, now };
	} catch {
		// Fallback to local time
		return {
			hours: now.getHours(),
			minutes: now.getMinutes(),
			dayOfWeek: now.getDay(),
			dateStr: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`,
			now,
		};
	}
}

/**
 * Determine if a task should fire now.
 *
 * @param {Object} task - Parsed task entry { instruction, scheduleDays, scheduleDate, scheduleTime, timezone, kind }
 * @param {string} taskHash - Hash for this task (t:xxx)
 * @param {boolean} isEnabled - From DisabledRemindersStore
 * @param {Object} executionState - { lastFired, lastMissed, consecutiveErrors } or null
 * @returns {{ shouldFire: boolean, isPrefire: boolean, reason: string }}
 */
export async function shouldFire(task, taskHash, isEnabled, executionState) {
	if (!isEnabled) {
		return { shouldFire: false, isPrefire: false, reason: "disabled" };
	}

	// Stop retrying after 3 consecutive errors (prevents infinite timeout retries)
	if (executionState && executionState.consecutiveErrors >= 3) {
		return { shouldFire: false, isPrefire: false, reason: `too many consecutive errors (${executionState.consecutiveErrors})` };
	}

	const timezone = task.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
	const nowTz = getNowInTimezone(timezone);
	const schedTime = parseScheduleTime(task.scheduleTime);
	if (!schedTime) {
		return { shouldFire: false, isPrefire: false, reason: "invalid schedule_time" };
	}

	// One-off tasks: check date match
	if (task.kind === "once" && task.scheduleDate) {
		// scheduleDate is "YYYY/MM/DD", nowTz.dateStr is "YYYY-MM-DD"
		const normalizedScheduleDate = task.scheduleDate.replace(/\//g, "-");
		if (normalizedScheduleDate !== nowTz.dateStr) {
			return { shouldFire: false, isPrefire: false, reason: "not the scheduled date" };
		}
	} else {
		// Recurring tasks: check day of week
		if (!task.scheduleDays) {
			return { shouldFire: false, isPrefire: false, reason: "missing schedule_days" };
		}
		const scheduledDays = resolveScheduleDays(task.scheduleDays);
		if (!scheduledDays.includes(nowTz.dayOfWeek)) {
			return { shouldFire: false, isPrefire: false, reason: "not a scheduled day" };
		}
	}

	// Compute fire window in minutes since midnight (in task's timezone)
	const nowMinutes = nowTz.hours * 60 + nowTz.minutes;
	const schedMinutes = schedTime.hours * 60 + schedTime.minutes;
	const prefireMinutes = await _getPrefireMinutes();
	const graceMinutes = GRACE_WINDOW_MS / 60000;

	// Fire window: (schedMinutes - prefireOffset) to (schedMinutes + graceWindow)
	const windowStart = schedMinutes - prefireMinutes;
	const windowEnd = schedMinutes + graceMinutes;

	if (nowMinutes < windowStart || nowMinutes > windowEnd) {
		log(`${MODULE} shouldFire ${taskHash}: SKIP — now=${nowMinutes} outside [${windowStart},${windowEnd}] (sched=${schedMinutes}, prefire=${prefireMinutes})`, "debug");
		return { shouldFire: false, isPrefire: false, reason: "outside fire window" };
	}

	// Already fired within the dedup window (grace window duration)?
	// Uses timestamp-based dedup instead of date-based, so rescheduled tasks
	// within the same day can fire at their new time.
	if (executionState && executionState.lastFiredTs) {
		const elapsed = Date.now() - executionState.lastFiredTs;
		if (elapsed < GRACE_WINDOW_MS) {
			log(`${MODULE} shouldFire ${taskHash}: SKIP — fired ${Math.round(elapsed/1000)}s ago (dedup ${Math.round(GRACE_WINDOW_MS/1000)}s)`, "debug");
			return { shouldFire: false, isPrefire: false, reason: "fired recently (dedup window)" };
		}
	}

	const isPrefire = nowMinutes < schedMinutes;
	log(`${MODULE} shouldFire ${taskHash}: YES — now=${nowMinutes} in [${windowStart},${windowEnd}], prefire=${isPrefire}`);
	return { shouldFire: true, isPrefire, reason: "within fire window" };
}

/**
 * Detect if a task was missed today.
 *
 * @param {Object} task - Parsed task entry
 * @param {string} taskHash - Hash
 * @param {Object} executionState - Execution state or null
 * @returns {{ missed: boolean, missedDate: string|null }}
 */
export function detectMiss(task, taskHash, executionState) {
	const timezone = task.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
	const nowTz = getNowInTimezone(timezone);
	const schedTime = parseScheduleTime(task.scheduleTime);
	if (!schedTime) return { missed: false, missedDate: null };

	// One-off tasks: check date match
	if (task.kind === "once" && task.scheduleDate) {
		const normalizedScheduleDate = task.scheduleDate.replace(/\//g, "-");
		// For one-off tasks, detect miss if the date has passed or is today but window passed
		if (normalizedScheduleDate !== nowTz.dateStr) {
			// Could be a past date — check if it's before today
			if (normalizedScheduleDate < nowTz.dateStr) {
				// Check if recently fired (within dedup window)
				if (executionState && executionState.lastFiredTs) {
					const elapsed = Date.now() - executionState.lastFiredTs;
					if (elapsed < GRACE_WINDOW_MS) {
						return { missed: false, missedDate: null };
					}
				}
				return { missed: true, missedDate: normalizedScheduleDate };
			}
			return { missed: false, missedDate: null };
		}
	} else {
		// Recurring tasks: check day of week
		if (!task.scheduleDays) return { missed: false, missedDate: null };
		const scheduledDays = resolveScheduleDays(task.scheduleDays);
		if (!scheduledDays.includes(nowTz.dayOfWeek)) {
			return { missed: false, missedDate: null };
		}
	}

	// Is the fire window already passed (beyond grace)?
	const nowMinutes = nowTz.hours * 60 + nowTz.minutes;
	const schedMinutes = schedTime.hours * 60 + schedTime.minutes;
	const graceMinutes = GRACE_WINDOW_MS / 60000;

	if (nowMinutes <= schedMinutes + graceMinutes) {
		return { missed: false, missedDate: null }; // Window not yet passed
	}

	// Was it fired today?
	if (executionState && executionState.lastFiredTs) {
		const elapsed = Date.now() - executionState.lastFiredTs;
		if (elapsed < GRACE_WINDOW_MS) {
			return { missed: false, missedDate: null }; // Fired today
		}
	}

	return { missed: true, missedDate: nowTz.dateStr };
}

// --- Execution State Persistence (device-local, not synced) ---

/**
 * Get execution state for all tasks from storage.
 */
export async function getExecutionStates() {
	try {
		const data = await browser.storage.local.get(EXECUTION_STATE_KEY);
		return data[EXECUTION_STATE_KEY] || {};
	} catch (e) {
		log(`${MODULE} Failed to read execution state: ${e}`, "warn");
		return {};
	}
}

/**
 * Clear execution state for a task hash. Called when a task is created or deleted
 * so that a recreated task with the same instruction fires fresh (not blocked by
 * "already fired today" from a previous schedule).
 */
export async function clearExecutionState(taskHash) {
	try {
		const states = await getExecutionStates();
		if (states[taskHash]) {
			delete states[taskHash];
			await browser.storage.local.set({ [EXECUTION_STATE_KEY]: states });
			log(`${MODULE} Cleared execution state for ${taskHash}`);
		}
	} catch (e) {
		log(`${MODULE} Failed to clear execution state: ${e}`, "warn");
	}
}

/**
 * Get execution state for a single task.
 */
export async function getExecutionState(taskHash) {
	const states = await getExecutionStates();
	return states[taskHash] || null;
}

/**
 * Mark a task as fired. Stores a timestamp for dedup (not a date).
 * The dedup window is GRACE_WINDOW_MS (~30 min) — short enough that
 * rescheduled tasks within the same day can fire at their new time.
 */
export async function markFired(taskHash, success = true, timezone = null) {
	try {
		const states = await getExecutionStates();
		const existing = states[taskHash] || { consecutiveErrors: 0 };
		states[taskHash] = {
			// Only set lastFiredTs on SUCCESS — failed fires should be retryable
			// at the next eval cycle (not blocked by dedup for 30 min)
			lastFiredTs: success ? Date.now() : (existing.lastFiredTs || null),
			lastMissed: null,
			consecutiveErrors: success ? 0 : (existing.consecutiveErrors || 0) + 1,
		};
		await browser.storage.local.set({ [EXECUTION_STATE_KEY]: states });
		log(`${MODULE} Marked ${taskHash} as fired (success=${success})`);
	} catch (e) {
		log(`${MODULE} Failed to mark fired: ${e}`, "warn");
	}
}

/**
 * Mark a task as missed today.
 */
export async function markMissed(taskHash, missedDate) {
	try {
		const states = await getExecutionStates();
		const existing = states[taskHash] || {};
		// Only set if not already marked for this date
		if (existing.lastMissed !== missedDate) {
			states[taskHash] = { ...existing, lastMissed: missedDate };
			await browser.storage.local.set({ [EXECUTION_STATE_KEY]: states });
			log(`${MODULE} Marked ${taskHash} as missed on ${missedDate}`);
		}
	} catch (e) {
		log(`${MODULE} Failed to mark missed: ${e}`, "warn");
	}
}

/**
 * Consume a missed marker (after reporting it to the user).
 */
export async function consumeMissed(taskHash) {
	try {
		const states = await getExecutionStates();
		if (states[taskHash] && states[taskHash].lastMissed) {
			states[taskHash].lastMissed = null;
			await browser.storage.local.set({ [EXECUTION_STATE_KEY]: states });
			log(`${MODULE} Consumed missed marker for ${taskHash}`);
		}
	} catch (e) {
		log(`${MODULE} Failed to consume missed: ${e}`, "warn");
	}
}

/**
 * GC execution states for tasks no longer in KB.
 */
export async function gcOrphanedStates(activeTaskHashes) {
	try {
		const states = await getExecutionStates();
		const activeSet = new Set(activeTaskHashes);
		const now = Date.now();
		const GC_THRESHOLD_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
		let removed = 0;

		for (const hash of Object.keys(states)) {
			if (!activeSet.has(hash)) {
				const lastFired = states[hash].lastFiredTs || 0;
				if (now - lastFired > GC_THRESHOLD_MS) {
					delete states[hash];
					removed++;
				}
			}
		}

		if (removed > 0) {
			await browser.storage.local.set({ [EXECUTION_STATE_KEY]: states });
			log(`${MODULE} GC: removed ${removed} orphaned execution states`);
		}
	} catch (e) {
		log(`${MODULE} GC failed: ${e}`, "warn");
	}
}

// Exported for use by proactiveCheckin.js (timezone-aware date for cache keys)
export { getNowInTimezone };

// Test-only exports
export const _testExports = {
	resolveScheduleDays,
	parseScheduleTime,
	DEFAULT_PREFIRE_MINUTES,
	GRACE_WINDOW_MS,
};
