const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(utcMs)
      .map((part) => [part.type, part.value]),
  );
  const asUtc = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** A local wall-clock time in `timeZone` (`minutes` after midnight), as a UTC timestamp */
export function zonedTime(date: string, minutes: number, timeZone: string): number {
  const match = DATE_RE.exec(date);
  if (!match) throw new Error(`Expected a date like 2025-01-31, got "${date}"`);
  const naive = Date.UTC(+match[1]!, +match[2]! - 1, +match[3]!) + minutes * 60_000;
  // Two passes settle DST transitions.
  let utc = naive - zoneOffsetMs(naive, timeZone);
  utc = naive - zoneOffsetMs(utc, timeZone);
  return utc;
}

/** Start of a local calendar day in `timeZone`, as a UTC timestamp */
export function startOfLocalDay(date: string, timeZone: string): number {
  return zonedTime(date, 0, timeZone);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function localDate(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
}

export function localTime(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);
}

export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}
