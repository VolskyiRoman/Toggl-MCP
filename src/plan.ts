import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type { Config, RepoConfig } from './config.ts';
import { buildIntervals, type Interval } from './intervals.ts';
import { addDays, formatDuration, localDate, localTime, startOfLocalDay } from './time.ts';
import type { TogglClient, TogglTimeEntry } from './toggl.ts';
import { readActivity, type TitleChange } from './transcripts.ts';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const PROMPT_DESCRIPTION = 80;

export type EntryStatus = 'new' | 'created' | 'failed';

export interface PlannedEntry {
  index: number;
  repo: string;
  branch: string;
  start: number;
  stop: number;
  description: string;
  projectId: number | null;
  tags: string[];
  status: EntryStatus;
  /** Existing Toggl entries this one was cut around */
  trimmedAround?: string[];
  togglId?: number;
  error?: string;
}

export interface Plan {
  id: string;
  workspaceId: number;
  timezone: string;
  minEntryMs: number;
  from: string;
  to: string;
  entries: PlannedEntry[];
}

export interface Span {
  start: number;
  end: number;
}

const plans = new Map<string, Plan>();

export function getPlan(id: string): Plan | undefined {
  return plans.get(id);
}

export async function buildPlan(
  config: Config,
  client: TogglClient,
  params: { from: string; to: string; repo?: string },
): Promise<Plan> {
  const { timezone } = config;
  const range = {
    start: startOfLocalDay(params.from, timezone),
    end: Math.min(startOfLocalDay(addDays(params.to, 1), timezone), Date.now()),
  };
  if (range.end <= range.start) throw new Error('"to" must not be before "from", and "from" must not be in the future');

  const repos = params.repo ? config.repos.filter((repo) => matchesRepo(repo, params.repo!)) : config.repos;
  if (repos.length === 0) throw new Error(`No repo in the config matches "${params.repo}"`);

  const workspaceId = config.workspaceId ?? (await client.me()).default_workspace_id;
  const minEntryMs = config.minEntryMin * MINUTE;
  const existing = await existingSpans(client, range, timezone);

  const candidates: { repo: RepoConfig; interval: Interval; titles: TitleChange[] }[] = [];
  for (const repo of repos) {
    const { events, titles } = await readActivity(repo.path, range, repo.transcriptsDir);
    const intervals = buildIntervals(events, {
      idleGapMs: config.idleGapMin * MINUTE,
      tailMs: config.tailMin * MINUTE,
      minEntryMs,
    });
    candidates.push(...intervals.map((interval) => ({ repo, interval, titles: titles.get(interval.sessionId) ?? [] })));
  }
  candidates.sort((a, b) => a.interval.start - b.interval.start);

  // Earlier entries (in Toggl, or from another repo in this plan) win, so no minute is counted twice.
  const taken: Span[] = [...existing];
  const entries: Omit<PlannedEntry, 'index'>[] = [];
  for (const { repo, interval, titles } of candidates) {
    const span = { start: interval.start, end: Math.min(interval.end, Date.now()) };
    const hits = existing.filter((entry) => entry.start < span.end && span.start < entry.end);
    for (const piece of subtract(span, taken, minEntryMs)) {
      taken.push(piece);
      entries.push({
        repo: path.basename(repo.path),
        branch: interval.branch,
        start: piece.start,
        stop: piece.end,
        description: describe(interval, titles),
        projectId: repo.projectId,
        tags: repo.tags,
        status: 'new',
        trimmedAround: hits.length > 0 ? hits.map((hit) => hit.label) : undefined,
      });
    }
  }

  const plan: Plan = {
    id: randomUUID().slice(0, 8),
    workspaceId,
    timezone,
    minEntryMs,
    from: params.from,
    to: params.to,
    entries: entries.sort((a, b) => a.start - b.start).map((entry, i) => ({ ...entry, index: i + 1 })),
  };
  plans.set(plan.id, plan);
  return plan;
}

export interface ExistingSpan extends Span {
  label: string;
}

export async function existingSpans(client: TogglClient, range: Span, timezone?: string): Promise<ExistingSpan[]> {
  // Toggl filters by start time, so an entry that began the day before and runs into the range needs a wider query.
  const entries = await client.timeEntries({ start: range.start - DAY, end: range.end });
  return entries
    .map((entry) => toSpan(entry, timezone))
    .filter((span) => span.end > range.start && span.end > span.start);
}

function toSpan(entry: TogglTimeEntry, timezone = 'UTC'): ExistingSpan {
  const start = Date.parse(entry.start);
  const end = entry.stop ? Date.parse(entry.stop) : Date.now();
  return { start, end, label: `${localTime(start, timezone)}–${localTime(end, timezone)} ${entry.description || '(no description)'}` };
}

/** Parts of `span` not covered by `taken`, dropping parts shorter than `minMs` */
export function subtract(span: Span, taken: Span[], minMs: number): Span[] {
  let pieces: Span[] = [span];
  for (const cut of taken) {
    pieces = pieces.flatMap((piece) => {
      if (cut.end <= piece.start || cut.start >= piece.end) return [piece];
      return [
        { start: piece.start, end: Math.min(piece.end, cut.start) },
        { start: Math.max(piece.start, cut.end), end: piece.end },
      ].filter((part) => part.end > part.start);
    });
  }
  return pieces.filter((piece) => piece.end - piece.start >= minMs);
}

function matchesRepo(repo: RepoConfig, query: string): boolean {
  return repo.path === query || path.basename(repo.path) === query;
}

/** The title in effect when the interval ended (a /rename beats generated titles), else its first prompt */
export function describe(interval: Interval, titles: TitleChange[]): string {
  const inEffect = titles.filter((change) => change.time <= interval.end);
  const title = inEffect.findLast((change) => change.kind === 'custom') ?? inEffect.at(-1) ?? titles[0];
  if (title) return title.title;
  const prompt = interval.prompts[0]?.replace(/\s+/g, ' ').trim();
  return prompt ? truncate(prompt, PROMPT_DESCRIPTION) : interval.branch;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function statusLabel(entry: PlannedEntry): string {
  if (entry.status === 'created') return `created #${entry.togglId}`;
  if (entry.status === 'failed') return `failed: ${entry.error}`;
  return entry.trimmedAround ? `new, cut around: ${entry.trimmedAround.join('; ')}` : 'new';
}

function cell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\s+/g, ' ');
}

export function formatPlan(plan: Plan): string {
  if (plan.entries.length === 0) {
    return `Nothing to add between ${plan.from} and ${plan.to}: no Claude Code activity outside existing Toggl entries.`;
  }
  const tz = plan.timezone;
  const rows = plan.entries.map(
    (entry) =>
      `| ${entry.index} | ${localDate(entry.start, tz)} | ${localTime(entry.start, tz)}–${localTime(entry.stop, tz)} | ${formatDuration(entry.stop - entry.start)} | ${entry.repo} | ${cell(entry.branch)} | ${cell(entry.description)} | ${cell(statusLabel(entry))} |`,
  );

  const totals = new Map<string, number>();
  for (const entry of plan.entries) {
    const day = localDate(entry.start, tz);
    totals.set(day, (totals.get(day) ?? 0) + entry.stop - entry.start);
  }

  return [
    `Plan ${plan.id} · ${plan.from} → ${plan.to} · times in ${tz}`,
    '',
    '| # | date | time | duration | repo | branch | description | status |',
    '|---|---|---|---|---|---|---|---|',
    ...rows,
    '',
    'Totals:',
    ...[...totals].map(([day, ms]) => `- ${day}: ${formatDuration(ms)}`),
    ...(plan.entries.some((e) => e.status === 'new')
      ? ['', `"new" entries are not written yet: call create_time_entries with planId "${plan.id}" (optionally exclude or override entries by #).`]
      : []),
  ].join('\n');
}
