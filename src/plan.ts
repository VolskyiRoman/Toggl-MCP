import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type { Config, RepoConfig } from './config.ts';
import { defaultAuthor, readCommits, type Commit } from './git.ts';
import { buildIntervals, type Interval } from './intervals.ts';
import { addDays, formatDuration, localDate, localTime, startOfLocalDay } from './time.ts';
import type { TogglClient, TogglTimeEntry } from './toggl.ts';
import { readActivity } from './transcripts.ts';

const MINUTE = 60_000;
const MAX_DESCRIPTION = 500;
const PROMPT_DESCRIPTION = 80;

export type EntryStatus = 'new' | 'overlaps' | 'created';

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
  /** Existing Toggl entry this one collides with */
  conflict?: string;
  togglId?: number;
}

export interface Plan {
  id: string;
  workspaceId: number;
  timezone: string;
  from: string;
  to: string;
  entries: PlannedEntry[];
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
  if (range.end <= range.start) throw new Error('"to" must not be before "from"');

  const repos = params.repo ? config.repos.filter((repo) => matchesRepo(repo, params.repo!)) : config.repos;
  if (repos.length === 0) throw new Error(`No repo in the config matches "${params.repo}"`);

  const workspaceId = config.workspaceId ?? (await client.me()).default_workspace_id;
  const existing = (await client.timeEntries(range)).filter((entry) => entry.duration !== 0);

  const entries: Omit<PlannedEntry, 'index'>[] = [];
  for (const repo of repos) {
    const events = await readActivity(repo.path, range, repo.transcriptsDir);
    const intervals = buildIntervals(events, {
      idleGapMs: config.idleGapMin * MINUTE,
      tailMs: config.tailMin * MINUTE,
      minEntryMs: config.minEntryMin * MINUTE,
    }).map((interval) => ({ ...interval, end: Math.min(interval.end, Date.now()) }));

    const commits = await readCommits(
      repo.path,
      { start: range.start, end: range.end + config.commitGraceMin * MINUTE },
      repo.gitAuthor ?? (await defaultAuthor(repo.path)),
    );
    const commitsByInterval = assignCommits(intervals, commits, config.commitGraceMin * MINUTE);

    intervals.forEach((interval, i) => {
      const conflict = existing.find((entry) => overlaps(interval, entry));
      entries.push({
        repo: path.basename(repo.path),
        branch: interval.branch,
        start: interval.start,
        stop: interval.end,
        description: describe(interval, commitsByInterval[i] ?? [], repo),
        projectId: repo.projectId,
        tags: repo.tags,
        status: conflict ? 'overlaps' : 'new',
        conflict: conflict ? describeExisting(conflict, timezone) : undefined,
      });
    });
  }

  const plan: Plan = {
    id: randomUUID().slice(0, 8),
    workspaceId,
    timezone,
    from: params.from,
    to: params.to,
    entries: entries.sort((a, b) => a.start - b.start).map((entry, i) => ({ ...entry, index: i + 1 })),
  };
  plans.set(plan.id, plan);
  return plan;
}

function matchesRepo(repo: RepoConfig, query: string): boolean {
  return repo.path === query || path.basename(repo.path) === query;
}

function assignCommits(intervals: Interval[], commits: Commit[], graceMs: number): Commit[][] {
  const result: Commit[][] = intervals.map(() => []);
  for (const commit of commits) {
    const i = intervals.findIndex((interval) => commit.time >= interval.start && commit.time <= interval.end + graceMs);
    if (i !== -1) result[i]!.push(commit);
  }
  return result;
}

function describe(interval: Interval, commits: Commit[], repo: RepoConfig): string {
  if (commits.length > 0) return truncate(commits.map((commit) => commit.subject).join('; '), MAX_DESCRIPTION);
  if (interval.branch !== 'HEAD' && !repo.defaultBranches.includes(interval.branch)) {
    return humaniseBranch(interval.branch);
  }
  const prompt = interval.prompts[0]?.replace(/\s+/g, ' ').trim();
  return prompt ? truncate(prompt, PROMPT_DESCRIPTION) : interval.branch;
}

export function humaniseBranch(branch: string): string {
  const words = branch.replace(/^[a-z]+\//, '').replace(/[-_/]+/g, ' ').trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : branch;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function overlaps(interval: Interval, entry: TogglTimeEntry): boolean {
  const start = Date.parse(entry.start);
  const stop = entry.stop ? Date.parse(entry.stop) : Date.now();
  return interval.start < stop && start < interval.end;
}

function describeExisting(entry: TogglTimeEntry, timezone: string): string {
  const start = Date.parse(entry.start);
  const stop = entry.stop ? Date.parse(entry.stop) : Date.now();
  return `${localTime(start, timezone)}–${localTime(stop, timezone)} ${entry.description || '(no description)'}`;
}

export function formatPlan(plan: Plan): string {
  if (plan.entries.length === 0) {
    return `No Claude Code activity found between ${plan.from} and ${plan.to}.`;
  }
  const tz = plan.timezone;
  const rows = plan.entries.map((entry) => {
    const status =
      entry.status === 'new' ? 'new' : entry.status === 'created' ? `created #${entry.togglId}` : `skip: overlaps ${entry.conflict}`;
    return `| ${entry.index} | ${localDate(entry.start, tz)} | ${localTime(entry.start, tz)}–${localTime(entry.stop, tz)} | ${formatDuration(entry.stop - entry.start)} | ${entry.repo} | ${entry.branch} | ${entry.description.replace(/\|/g, '\\|')} | ${status} |`;
  });

  const totals = new Map<string, number>();
  for (const entry of plan.entries.filter((e) => e.status !== 'overlaps')) {
    const day = localDate(entry.start, tz);
    totals.set(day, (totals.get(day) ?? 0) + entry.stop - entry.start);
  }
  const totalLines = [...totals].map(([day, ms]) => `- ${day}: ${formatDuration(ms)}`);

  return [
    `Plan ${plan.id} · ${plan.from} → ${plan.to} · times in ${tz}`,
    '',
    '| # | date | time | duration | repo | branch | description | status |',
    '|---|---|---|---|---|---|---|---|',
    ...rows,
    '',
    'Totals (without skipped):',
    ...totalLines,
    ...(plan.entries.some((e) => e.status === 'new')
      ? ['', `"new" entries are not written yet: call create_time_entries with planId "${plan.id}" (optionally exclude or override entries by #).`]
      : []),
  ].join('\n');
}
