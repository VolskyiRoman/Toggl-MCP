import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { z } from 'zod';

const repoSchema = z.object({
  path: z.string().min(1),
  projectId: z.number().int().positive().nullable().default(null),
  tags: z.array(z.string()).default(['claude']),
  transcriptsDir: z.string().optional(),
});

const configSchema = z.object({
  workspaceId: z.number().int().positive().optional(),
  timezone: z
    .string()
    .refine(isTimeZone, 'Unknown IANA timezone, e.g. "Europe/London"')
    .default(Intl.DateTimeFormat().resolvedOptions().timeZone),
  idleGapMin: z.number().positive().default(20),
  tailMin: z.number().min(0).default(5),
  minEntryMin: z.number().min(0).default(5),
  repos: z.array(repoSchema).min(1),
});

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export type RepoConfig = z.infer<typeof repoSchema>;
export type Config = z.infer<typeof configSchema>;

export function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(homedir(), p.slice(1)) : p;
}

export function configPath(): string {
  return expandHome(process.env.TOGGL_MCP_CONFIG || '~/.config/toggl-mcp/config.json');
}

export function apiToken(): string {
  const token = process.env.TOGGL_API_TOKEN;
  if (!token) {
    throw new Error('TOGGL_API_TOKEN is not set. Add it to the MCP server env (Toggl → Profile settings → API Token).');
  }
  return token;
}

export async function loadConfig(): Promise<Config> {
  const file = configPath();
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    throw new Error(`Config not found at ${file}. Copy config.example.json there, or set TOGGL_MCP_CONFIG.`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Config ${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = configSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`Invalid config ${file}:\n${z.prettifyError(parsed.error)}`);
  }
  const config = parsed.data;
  config.repos = config.repos.map((repo) => ({
    ...repo,
    path: path.resolve(expandHome(repo.path)),
    transcriptsDir: repo.transcriptsDir ? path.resolve(expandHome(repo.transcriptsDir)) : undefined,
  }));
  return config;
}
