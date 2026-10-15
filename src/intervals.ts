import type { ActivityEvent } from './transcripts.ts';

export interface Interval {
  start: number;
  end: number;
  branch: string;
  prompts: string[];
}

export interface IntervalOptions {
  idleGapMs: number;
  tailMs: number;
  minEntryMs: number;
}

export function buildIntervals(events: ActivityEvent[], options: IntervalOptions): Interval[] {
  const byBranch = new Map<string, ActivityEvent[]>();
  for (const event of events) {
    const list = byBranch.get(event.branch) ?? [];
    list.push(event);
    byBranch.set(event.branch, list);
  }

  const intervals: Interval[] = [];
  for (const [branch, branchEvents] of byBranch) {
    branchEvents.sort((a, b) => a.time - b.time);
    let current: Interval | undefined;
    let lastTime = 0;
    for (const event of branchEvents) {
      if (!current || event.time - lastTime > options.idleGapMs) {
        if (current) intervals.push(close(current, lastTime, options.tailMs));
        current = { start: event.time, end: event.time, branch, prompts: [] };
      }
      if (event.prompt) current.prompts.push(event.prompt);
      lastTime = event.time;
    }
    if (current) intervals.push(close(current, lastTime, options.tailMs));
  }

  return removeOverlaps(intervals).filter((interval) => interval.end - interval.start >= options.minEntryMs);
}

function close(interval: Interval, lastTime: number, tailMs: number): Interval {
  return { ...interval, end: lastTime + tailMs };
}

// Parallel sessions on different branches would double-count time, so a later interval starts where the earlier one ends.
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
