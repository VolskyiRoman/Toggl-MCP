import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildIntervals } from '../src/intervals.ts';
import { describe, subtract } from '../src/plan.ts';
import { startOfLocalDay, zonedTime } from '../src/time.ts';
import type { ActivityEvent } from '../src/transcripts.ts';

const MIN = 60_000;
const options = { idleGapMs: 20 * MIN, tailMs: 5 * MIN, minEntryMs: 5 * MIN };

function event(minute: number, sessionId = 's1', prompt?: string): ActivityEvent {
  return { time: minute * MIN, branch: 'main', sessionId, prompt };
}

test('splits on idle gaps and adds the tail', () => {
  const intervals = buildIntervals([event(0, 's1', 'start'), event(10), event(15), event(60), event(70)], options);
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

test('parallel sessions do not double-count time', () => {
  const intervals = buildIntervals([event(0, 'a'), event(30, 'a'), event(10, 'b'), event(50, 'b')], {
    ...options,
    idleGapMs: 60 * MIN,
  });
  assert.deepEqual(
    intervals.map((i) => [i.sessionId, i.start / MIN, i.end / MIN]),
    [
      ['a', 0, 35],
      ['b', 35, 55],
    ],
  );
});

test('describes an interval by the title in effect when it ended, then the first prompt', () => {
  const [interval] = buildIntervals([event(0, 's1', 'fix   the\nlogin'), event(10)], options);
  assert.ok(interval);
  const ai = (time: number, title: string) => ({ time: time * MIN, kind: 'ai' as const, title });
  assert.equal(describe(interval, [ai(0, 'Login fix'), ai(60, 'Later task')]), 'Login fix');
  assert.equal(describe(interval, [ai(0, 'Login fix'), { time: 5 * MIN, kind: 'custom', title: 'Renamed' }, ai(6, 'Other')]), 'Renamed');
  assert.equal(describe(interval, [ai(60, 'Only later')]), 'Only later');
  assert.equal(describe(interval, []), 'fix the login');
});

test('subtract cuts around taken spans and drops short leftovers', () => {
  const span = { start: 0, end: 60 * MIN };
  const taken = [
    { start: 10 * MIN, end: 20 * MIN },
    { start: 57 * MIN, end: 90 * MIN },
  ];
  assert.deepEqual(
    subtract(span, taken, 5 * MIN).map((s) => [s.start / MIN, s.end / MIN]),
    [
      [0, 10],
      [20, 57],
    ],
  );
  assert.deepEqual(subtract(span, [{ start: -1, end: 61 * MIN }], 0), []);
});

test('start of a local day respects the timezone and DST', () => {
  assert.equal(new Date(startOfLocalDay('2025-01-15', 'Europe/London')).toISOString(), '2025-01-15T00:00:00.000Z');
  assert.equal(new Date(startOfLocalDay('2025-07-15', 'Europe/London')).toISOString(), '2025-07-14T23:00:00.000Z');
  assert.equal(new Date(startOfLocalDay('2025-03-30', 'Europe/Kyiv')).toISOString(), '2025-03-29T22:00:00.000Z');
});

test('local wall-clock time on a DST day', () => {
  assert.equal(new Date(zonedTime('2025-03-30', 9 * 60, 'Europe/London')).toISOString(), '2025-03-30T08:00:00.000Z');
});
