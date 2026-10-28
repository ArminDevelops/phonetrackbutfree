export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

const TIME_ZONE = "Europe/Zurich";

const timeFormat = new Intl.DateTimeFormat("de-CH", {
  timeZone: TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const dateFormat = new Intl.DateTimeFormat("de-CH", {
  timeZone: TIME_ZONE,
  day: "2-digit",
  month: "2-digit",
});

/** "14:05" in Swiss local time. */
export function formatTime(ms: number): string {
  return timeFormat.format(ms);
}

/** "28.10. 14:05" in Swiss local time. */
export function formatDateTime(ms: number): string {
  const date = dateFormat.format(ms).replace(/\.?$/, ".");
  return `${date} ${formatTime(ms)}`;
}

/** "6 h 12 min", "2 h", "23 min", "45 s". */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds} s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} min`;
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
}

/** "12 s ago", "5 min ago", "3 h ago". */
export function ago(then: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.floor(minutes / 60)} h ago`;
}
