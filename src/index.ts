#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { apiToken, configPath, loadConfig } from './config.ts';
import { buildPlan, formatPlan, getPlan, type PlannedEntry } from './plan.ts';
import { localDate, startOfLocalDay } from './time.ts';
import { TogglClient } from './toggl.ts';

const server = new McpServer({ name: 'toggl-mcp', version: '0.1.0' });

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

function text(value: string) {
  return { content: [{ type: 'text' as const, text: value }] };
}

function failure(error: unknown) {
  return { ...text(error instanceof Error ? error.message : String(error)), isError: true };
}

server.registerTool(
  'toggl_status',
  {
    title: 'Toggl status',
    description:
      'Check the Toggl API token and list workspaces and active projects with their ids, to fill workspaceId / projectId in the config. Also shows where the config is read from.',
    annotations: { readOnlyHint: true },
  },
  async () => {
    try {
      const client = new TogglClient(apiToken());
      const me = await client.me();
      const lines = [`Signed in as ${me.fullname} <${me.email}>, default workspace ${me.default_workspace_id}.`, ''];
      for (const workspace of await client.workspaces()) {
        lines.push(`Workspace ${workspace.id}: ${workspace.name}`);
        for (const project of await client.projects(workspace.id)) {
          lines.push(`  project ${project.id}: ${project.name}${project.client_name ? ` (${project.client_name})` : ''}`);
        }
      }
      lines.push('', `Config: ${configPath()}`);
      try {
        const config = await loadConfig();
        lines.push(...config.repos.map((repo) => `  repo ${repo.path} → project ${repo.projectId ?? 'none'}`));
      } catch (error) {
        lines.push(`  ${error instanceof Error ? error.message : String(error)}`);
      }
      return text(lines.join('\n'));
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  'preview_timesheet',
  {
    title: 'Preview timesheet',
    description:
      'Build proposed Toggl time entries from Claude Code session activity and git commits for a date range (dates in the configured timezone, inclusive). Writes nothing. Entries overlapping existing Toggl entries are marked as skipped. Show the table to the user and ask for confirmation before calling create_time_entries.',
    inputSchema: {
      from: dateSchema.describe('First day, YYYY-MM-DD'),
      to: dateSchema.optional().describe('Last day, YYYY-MM-DD (inclusive); defaults to "from"'),
      repo: z.string().optional().describe('Only this repo: its path or folder name from the config'),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ from, to, repo }) => {
    try {
      const config = await loadConfig();
      const plan = await buildPlan(config, new TogglClient(apiToken()), { from, to: to ?? from, repo });
      return text(formatPlan(plan));
    } catch (error) {
      return failure(error);
    }
  },
);

const overrideSchema = z.object({
  index: z.number().int().positive(),
  description: z.string().min(1).optional(),
  start: z.string().optional().describe('"HH:MM" in the plan timezone on the entry\'s day, or an ISO 8601 timestamp'),
  stop: z.string().optional().describe('"HH:MM" in the plan timezone on the entry\'s day, or an ISO 8601 timestamp'),
});

function parseTime(value: string, entry: PlannedEntry, timezone: string): number {
  const hhmm = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (hhmm) {
    const dayStart = startOfLocalDay(localDate(entry.start, timezone), timezone);
    return dayStart + (+hhmm[1]! * 60 + +hhmm[2]!) * 60_000;
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`Entry #${entry.index}: can't parse time "${value}"`);
  return ms;
}

server.registerTool(
  'create_time_entries',
  {
    title: 'Create time entries',
    description:
      'Write the entries of a plan from preview_timesheet to Toggl. Only call after the user has confirmed the preview. Writes entries with status "new" unless excluded; overlapping ones only when listed in includeOverlapping. Entries already created from this plan are never written twice.',
    inputSchema: {
      planId: z.string().describe('Plan id returned by preview_timesheet'),
      exclude: z.array(z.number().int().positive()).optional().describe('Entry numbers (#) not to write'),
      includeOverlapping: z
        .array(z.number().int().positive())
        .optional()
        .describe('Entry numbers marked as overlapping that should be written anyway'),
      overrides: z.array(overrideSchema).optional().describe('Changes to entries before writing'),
    },
    annotations: { destructiveHint: false, idempotentHint: true },
  },
  async ({ planId, exclude = [], includeOverlapping = [], overrides = [] }) => {
    try {
      const plan = getPlan(planId);
      if (!plan) throw new Error(`Plan ${planId} not found (plans live until the server restarts). Run preview_timesheet again.`);

      for (const override of overrides) {
        const entry = plan.entries.find((e) => e.index === override.index);
        if (!entry) throw new Error(`Plan ${planId} has no entry #${override.index}`);
        if (override.description) entry.description = override.description;
        if (override.start) entry.start = parseTime(override.start, entry, plan.timezone);
        if (override.stop) entry.stop = parseTime(override.stop, entry, plan.timezone);
        if (entry.stop <= entry.start) throw new Error(`Entry #${entry.index}: stop must be after start`);
      }

      const toWrite = plan.entries.filter(
        (entry) =>
          !exclude.includes(entry.index) &&
          (entry.status === 'new' || (entry.status === 'overlaps' && includeOverlapping.includes(entry.index))),
      );
      if (toWrite.length === 0) return text(`Nothing to write.\n\n${formatPlan(plan)}`);

      const client = new TogglClient(apiToken());
      const errors: string[] = [];
      for (const entry of toWrite) {
        try {
          const created = await client.createTimeEntry(plan.workspaceId, entry);
          entry.status = 'created';
          entry.togglId = created.id;
        } catch (error) {
          errors.push(`#${entry.index}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      const created = toWrite.filter((entry) => entry.status === 'created').length;
      const summary = [`Created ${created} of ${toWrite.length} entries.`, ...errors].join('\n');
      return { ...text(`${summary}\n\n${formatPlan(plan)}`), isError: errors.length > 0 };
    } catch (error) {
      return failure(error);
    }
  },
);

await server.connect(new StdioServerTransport());
