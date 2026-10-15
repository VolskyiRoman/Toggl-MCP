import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface Commit {
  hash: string;
  time: number;
  subject: string;
}

async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', repoPath, ...args], { maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

export async function defaultAuthor(repoPath: string): Promise<string | undefined> {
  try {
    return (await git(repoPath, ['config', 'user.email'])).trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function readCommits(
  repoPath: string,
  range: { start: number; end: number },
  author?: string,
): Promise<Commit[]> {
  const args = [
    'log',
    '--all',
    '--no-merges',
    `--since=${new Date(range.start).toISOString()}`,
    '--format=%H%x09%aI%x09%s',
  ];
  if (author) args.push(`--author=${author}`);
  const output = await git(repoPath, args);
  const seen = new Set<string>();
  const commits: Commit[] = [];
  for (const line of output.split('\n')) {
    const [hash, date, ...subject] = line.split('\t');
    if (!hash || !date) continue;
    // Rebased copies of a commit keep the author date and subject, so they count once.
    const key = `${date}\t${subject.join('\t')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // --since filters by committer date; a rebase moves that but keeps the author date, which is when the work happened.
    const time = Date.parse(date);
    if (time < range.start || time >= range.end) continue;
    commits.push({ hash, time, subject: subject.join('\t') });
  }
  return commits.sort((a, b) => a.time - b.time);
}
