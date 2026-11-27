export const MIN_SCHEDULE_LEAD_MS = 60_000;
export const MAX_SCHEDULE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export type SchedulePreset = {
  id: string;
  label: string;
  hint: string;
  sendAt: number;
};

/**
 * Pure schedule presets bounded strictly within `(now + 1 min, now + 30 days]`.
 */
export function buildSchedulePresets(nowMs = Date.now()): SchedulePreset[] {
  const now = new Date(nowMs);
  const presets: SchedulePreset[] = [];

  const in30m = nowMs + 30 * 60_000;
  presets.push({
    id: "30m",
    label: "In 30 minutes",
    hint: formatScheduledTime(in30m, nowMs),
    sendAt: in30m,
  });

  const in1h = nowMs + 60 * 60_000;
  presets.push({
    id: "1h",
    label: "In 1 hour",
    hint: formatScheduledTime(in1h, nowMs),
    sendAt: in1h,
  });

  // Offer "Later today · 6:00 PM" only if it is at least 90 minutes away.
  const todayEvening = new Date(now);
  todayEvening.setHours(18, 0, 0, 0);
  if (todayEvening.getTime() >= nowMs + 90 * 60_000) {
    presets.push({
      id: "evening",
      label: "Later today",
      hint: formatScheduledTime(todayEvening.getTime(), nowMs),
      sendAt: todayEvening.getTime(),
    });
  }

  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  presets.push({
    id: "tomorrow",
    label: "Tomorrow morning",
    hint: formatScheduledTime(tomorrow.getTime(), nowMs),
    sendAt: tomorrow.getTime(),
  });

  // Next Monday at 9:00 AM (always strictly after tomorrow).
  const day = now.getDay(); // 0 = Sun, 1 = Mon, ...
  let daysUntilMonday = (8 - day) % 7;
  if (daysUntilMonday <= 1) daysUntilMonday += 7;
  const nextMonday = new Date(now);
  nextMonday.setDate(nextMonday.getDate() + daysUntilMonday);
  nextMonday.setHours(9, 0, 0, 0);
  if (nextMonday.getTime() <= nowMs + MAX_SCHEDULE_WINDOW_MS) {
    presets.push({
      id: "monday",
      label: "Next Monday",
      hint: formatScheduledTime(nextMonday.getTime(), nowMs),
      sendAt: nextMonday.getTime(),
    });
  }

  return presets;
}

export function computeCustomSendAt(
  offsetMinutes: number,
  nowMs = Date.now(),
): number {
  const safeMinutes = Math.max(2, Math.round(offsetMinutes));
  return Math.round(nowMs + safeMinutes * 60_000);
}

export function validateSendAt(
  sendAt: number,
  nowMs = Date.now(),
): { ok: true } | { ok: false; error: string } {
  if (!Number.isFinite(sendAt) || !Number.isInteger(sendAt)) {
    return { ok: false, error: "Choose a valid send time." };
  }
  if (sendAt <= nowMs + MIN_SCHEDULE_LEAD_MS) {
    return {
      ok: false,
      error: "Choose a send time at least 1 minute from now.",
    };
  }
  if (sendAt > nowMs + MAX_SCHEDULE_WINDOW_MS) {
    return {
      ok: false,
      error: "Choose a send time within the next 30 days.",
    };
  }
  return { ok: true };
}

function sameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function formatClock(date: Date): string {
  const h24 = date.getHours();
  const mins = String(date.getMinutes()).padStart(2, "0");
  const period = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 % 12 || 12;
  return `${h12}:${mins} ${period}`;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

export function formatScheduledTime(
  sendAt: number,
  nowMs = Date.now(),
): string {
  if (!Number.isFinite(sendAt)) return "";
  const target = new Date(sendAt);
  const now = new Date(nowMs);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const clock = formatClock(target);

  if (sameLocalDay(target, now)) {
    return `Today · ${clock}`;
  }
  if (sameLocalDay(target, tomorrow)) {
    return `Tomorrow · ${clock}`;
  }
  return `${WEEKDAYS[target.getDay()]}, ${MONTHS[target.getMonth()]} ${target.getDate()} · ${clock}`;
}

export function formatVoiceDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const whole = Math.floor(seconds);
  const mins = Math.floor(whole / 60);
  const secs = whole % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

export function buildVoiceRecordingFilename(nowMs = Date.now()): string {
  const d = new Date(nowMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `voice-${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}.m4a`;
}
