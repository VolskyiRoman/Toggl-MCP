import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

export interface ActivityEvent {
  time: number;
  branch: string;
  sessionId: string;
  /** Text of a prompt the user typed; absent for Claude's own activity */
  prompt?: string;
}

interface TranscriptLine {
  type?: string;
  timestamp?: string;
  gitBranch?: string;
  cwd?: string;
  sessionId?: string;
  isSidechain?: boolean;
  origin?: { kind?: string };
  message?: { content?: unknown };
}

function claudeProjectsDir(): string {
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude'), 'projects');
}

// Claude Code names a project folder after its cwd with every non-alphanumeric character replaced by "-".
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

async function transcriptDirs(repoPath: string, override?: string): Promise<string[]> {
  if (override) return [override];
  const root = claudeProjectsDir();
  const encoded = encodeProjectDir(repoPath);
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  // Prefix match picks up worktrees and subfolders; the cwd check below drops look-alike repos.
  return names.filter((name) => name === encoded || name.startsWith(`${encoded}-`)).map((name) => path.join(root, name));
}

function isInside(cwd: string, repoPath: string): boolean {
  return cwd === repoPath || cwd.startsWith(`${repoPath}${path.sep}`);
}

function promptText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = content
      .filter((block): block is { type: 'text'; text: string } => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join(' ');
    return text || undefined;
  }
  return undefined;
}

export async function readActivity(
  repoPath: string,
  range: { start: number; end: number },
  transcriptsDir?: string,
): Promise<ActivityEvent[]> {
  const events: ActivityEvent[] = [];
  for (const dir of await transcriptDirs(repoPath, transcriptsDir)) {
    const files = (await readdir(dir)).filter((name) => name.endsWith('.jsonl'));
    for (const name of files) {
      const file = path.join(dir, name);
      if ((await stat(file)).mtimeMs < range.start) continue;
      await readTranscript(file, repoPath, range, events);
    }
  }
  return events.sort((a, b) => a.time - b.time);
}

async function readTranscript(
  file: string,
  repoPath: string,
  range: { start: number; end: number },
  events: ActivityEvent[],
): Promise<void> {
  const lines = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const raw of lines) {
    if (!raw.includes('"timestamp"') || !raw.includes('"cwd"')) continue;
    let line: TranscriptLine;
    try {
      line = JSON.parse(raw) as TranscriptLine;
    } catch {
      continue;
    }
    if ((line.type !== 'user' && line.type !== 'assistant') || !line.timestamp || !line.cwd) continue;
    if (!isInside(line.cwd, repoPath)) continue;
    const time = Date.parse(line.timestamp);
    if (Number.isNaN(time) || time < range.start || time >= range.end) continue;

    const isHumanPrompt = line.type === 'user' && !line.isSidechain && line.origin?.kind === 'human';
    events.push({
      time,
      branch: line.gitBranch || 'HEAD',
      sessionId: line.sessionId ?? path.basename(file, '.jsonl'),
      prompt: isHumanPrompt ? promptText(line.message?.content) : undefined,
    });
  }
}
