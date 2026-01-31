// schedule_proactive_alarm.js – schedule a proactive check-in alarm (TB 145, MV3)
// Supports relative (delay_minutes) and absolute (anchor_time + offset_minutes) modes.
// Timezone-aware: anchor_time interpreted in user's local TZ by default (see ADR-013).

import { log } from "../../agent/modules/utils.js";

const ALARM_NAME = "tabmail-proactive-checkin";

/**
 * Parse an anchor_time string in the given IANA timezone.
 * Naive ISO strings (no Z, no offset) are interpreted in the specified timezone.
 * Strings with an explicit offset or Z are respected as-is.
 */
function parseAnchorTime(anchorTimeStr, tz) {
  // If the string already has a timezone indicator, parse directly
  if (/Z$|[+-]\d{2}:\d{2}$|[+-]\d{4}$/.test(anchorTimeStr)) {
    return new Date(anchorTimeStr);
  }

  // Naive ISO string — interpret in the user's timezone.
  // Use Intl to get the UTC offset for the given timezone at the approximate time,
  // then construct the Date accordingly.
  try {
    // First parse naively to get an approximate local date
    const naive = new Date(anchorTimeStr);
    if (isNaN(naive.getTime())) return naive; // invalid, caller will handle

    // Get the UTC offset for this timezone at this date by formatting
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false,
    });

    // Create a reference point: what does "now" look like in the target TZ?
    // We use the naive date's epoch to get the offset at that approximate time.
    const parts = formatter.formatToParts(naive);
    const get = (type) => parts.find(p => p.type === type)?.value || "0";
    const tzLocalStr = `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;
    const tzLocal = new Date(tzLocalStr);

    // The offset is the difference between UTC interpretation and TZ interpretation
    const offsetMs = tzLocal.getTime() - naive.getTime();

    // Apply the offset: if naive was parsed as UTC-ish, adjust to get the correct UTC time
    // that represents this naive time in the target TZ
    return new Date(naive.getTime() - offsetMs);
  } catch (e) {
    log(`[TMDBG Tools] schedule_proactive_alarm: TZ-aware parsing failed for "${anchorTimeStr}" in ${tz}, falling back to default: ${e}`, "warn");
    return new Date(anchorTimeStr);
  }
}

export async function run(args = {}, options = {}) {
  try {
    const reason = typeof args?.reason === "string" ? args.reason.trim() : "";
    if (!reason) {
      log(`[TMDBG Tools] schedule_proactive_alarm: missing reason`, "error");
      return { error: "reason is required" };
    }

    // Resolve timezone: explicit param or browser default
    const userTz = (typeof args?.timezone === "string" && args.timezone.trim())
      ? args.timezone.trim()
      : Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

    const hasDelay = args?.delay_minutes != null;
    const hasAnchor = args?.anchor_time != null;

    if (hasDelay && hasAnchor) {
      log(`[TMDBG Tools] schedule_proactive_alarm: both delay_minutes and anchor_time provided`, "error");
      return { error: "Provide either delay_minutes OR anchor_time, not both." };
    }

    let delayMinutes;

    if (hasAnchor) {
      // Absolute mode: compute delay from anchor_time + offset_minutes
      const anchorDate = parseAnchorTime(String(args.anchor_time), userTz);
      if (isNaN(anchorDate.getTime())) {
        log(`[TMDBG Tools] schedule_proactive_alarm: invalid anchor_time=${args.anchor_time}`, "error");
        return { error: `Invalid anchor_time: ${args.anchor_time}. Must be a valid ISO 8601 timestamp.` };
      }

      const offsetMinutes = Number(args?.offset_minutes) || 0;
      const targetMs = anchorDate.getTime() + offsetMinutes * 60 * 1000;
      delayMinutes = (targetMs - Date.now()) / (60 * 1000);

      log(`[TMDBG Tools] schedule_proactive_alarm: anchor=${anchorDate.toISOString()}, offset=${offsetMinutes}min, tz=${userTz}, computed_delay=${delayMinutes.toFixed(1)}min`);

      if (delayMinutes < 1) {
        log(`[TMDBG Tools] schedule_proactive_alarm: computed delay ${delayMinutes.toFixed(1)}min is in the past, clamping to 1min`, "warn");
        delayMinutes = 1;
      }
    } else if (hasDelay) {
      // Relative mode: use delay_minutes directly (timezone irrelevant)
      delayMinutes = Number(args.delay_minutes);
      if (!Number.isFinite(delayMinutes) || delayMinutes < 1) {
        log(`[TMDBG Tools] schedule_proactive_alarm: invalid delay_minutes=${args.delay_minutes}`, "error");
        return { error: "delay_minutes must be a number >= 1" };
      }
    } else {
      log(`[TMDBG Tools] schedule_proactive_alarm: neither delay_minutes nor anchor_time provided`, "error");
      return { error: "Provide either delay_minutes or anchor_time." };
    }

    // Create or replace the proactive check-in alarm
    await browser.alarms.create(ALARM_NAME, { delayInMinutes: delayMinutes });

    const scheduledAt = new Date(Date.now() + delayMinutes * 60 * 1000).toISOString();

    log(`[TMDBG Tools] schedule_proactive_alarm: scheduled in ${Math.round(delayMinutes)}min, reason="${reason}", tz=${userTz}, at=${scheduledAt}`);

    return {
      ok: true,
      alarm_name: ALARM_NAME,
      delay_minutes: Math.round(delayMinutes),
      scheduled_at: scheduledAt,
      timezone: userTz,
      reason,
    };
  } catch (e) {
    log(`[TMDBG Tools] schedule_proactive_alarm failed: ${e}`, "error");
    return { error: String(e || "unknown error in schedule_proactive_alarm") };
  }
}
