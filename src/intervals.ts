import type { ActivityEvent } from './transcripts.ts';

export interface Interval {
  start: number;
  end: number;
  sessionId: string;
  /** Branch at the end of the interval */
  branch: string;
  prompts: string[];
}

export interface IntervalOptions {
  idleGapMs: number;
  tailMs: number;
  minEntryMs: number;
}

export function buildIntervals(events: ActivityEvent[], options: IntervalOptions): Interval[] {
  const bySession = new Map<string, ActivityEvent[]>();
  for (const event of events) {
    const list = bySession.get(event.sessionId) ?? [];
    list.push(event);
    bySession.set(event.sessionId, list);
  }

  const intervals: Interval[] = [];
  for (const [sessionId, sessionEvents] of bySession) {
    sessionEvents.sort((a, b) => a.time - b.time);
    let current: Interval | undefined;
    let lastTime = 0;
    for (const event of sessionEvents) {
      if (!current || event.time - lastTime > options.idleGapMs) {
        if (current) intervals.push(close(current, lastTime, options.tailMs));
        current = { start: event.time, end: event.time, sessionId, branch: event.branch, prompts: [] };
      }
      if (event.prompt) current.prompts.push(event.prompt);
      current.branch = event.branch;
      lastTime = event.time;
    }
    if (current) intervals.push(close(current, lastTime, options.tailMs));
  }

  return removeOverlaps(intervals).filter((interval) => interval.end - interval.start >= options.minEntryMs);
}

function close(interval: Interval, lastTime: number, tailMs: number): Interval {
  return { ...interval, end: lastTime + tailMs };
}

// Parallel sessions would double-count time, so a later interval starts where the earlier one ends.
function removeOverlaps(intervals: Interval[]): Interval[] {
  const sorted = [...intervals].sort((a, b) => a.start - b.start || a.end - b.end);
  const result: Interval[] = [];
  let cursor = -Infinity;
  for (const interval of sorted) {
    const start = Math.max(interval.start, cursor);
    if (start < interval.end) {
      result.push({ ...interval, start });
      cursor = interval.end;
    }
  }
  return result;
}
