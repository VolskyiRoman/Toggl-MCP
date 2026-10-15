import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildIntervals } from '../src/intervals.ts';
import { humaniseBranch } from '../src/plan.ts';
import { startOfLocalDay } from '../src/time.ts';
import type { ActivityEvent } from '../src/transcripts.ts';

const MIN = 60_000;
const options = { idleGapMs: 20 * MIN, tailMs: 5 * MIN, minEntryMs: 5 * MIN };

function event(minute: number, branch = 'feat/a', prompt?: string): ActivityEvent {
  return { time: minute * MIN, branch, sessionId: 's', prompt };
}

test('splits on idle gaps and adds the tail', () => {
  const intervals = buildIntervals([event(0, 'feat/a', 'start'), event(10), event(15), event(60), event(70)], options);
  assert.deepEqual(
    intervals.map((i) => [i.start / MIN, i.end / MIN]),
    [
      [0, 20],
      [60, 75],
    ],
  );
  assert.deepEqual(intervals[0]?.prompts, ['start']);
});

test('drops intervals shorter than the minimum', () => {
  assert.equal(buildIntervals([event(0)], { ...options, tailMs: 0 }).length, 0);
});

test('parallel branches do not double-count time', () => {
  const intervals = buildIntervals([event(0, 'a'), event(30, 'a'), event(10, 'b'), event(50, 'b')], {
    ...options,
    idleGapMs: 60 * MIN,
  });
  assert.deepEqual(
    intervals.map((i) => [i.branch, i.start / MIN, i.end / MIN]),
    [
      ['a', 0, 35],
      ['b', 35, 55],
    ],
  );
});

test('humanises branch names', () => {
  assert.equal(humaniseBranch('feat/face-id'), 'Face id');
  assert.equal(humaniseBranch('fix/your_trades-offset'), 'Your trades offset');
});

test('start of a local day respects the timezone and DST', () => {
  assert.equal(new Date(startOfLocalDay('2025-01-15', 'Europe/London')).toISOString(), '2025-01-15T00:00:00.000Z');
  assert.equal(new Date(startOfLocalDay('2025-07-15', 'Europe/London')).toISOString(), '2025-07-14T23:00:00.000Z');
  assert.equal(new Date(startOfLocalDay('2025-03-30', 'Europe/Kyiv')).toISOString(), '2025-03-29T22:00:00.000Z');
});
