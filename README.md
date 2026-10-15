# toggl-mcp

MCP server that fills Toggl Track from Claude Code sessions and git commits: work time from session activity, descriptions from commits, preview before writing.

Claude Code session transcripts already record when a task started and when it finished; git commits on the same branch say what the task was. `preview_timesheet` turns that into proposed time entries for a date range and skips anything that overlaps entries already in Toggl. `create_time_entries` writes them once you confirm. Runs locally over stdio; the API token is only sent to Toggl.

## How time is counted

1. Activity comes from the Claude Code transcripts of each configured repo (`~/.claude/projects/<repo path with non-alphanumerics replaced by ->*/*.jsonl`): every prompt, reply and tool call has a timestamp, the git branch and the working directory. Subagent activity counts too.
2. Activity is grouped by branch. A pause longer than `idleGapMin` ends an entry; each entry gets `tailMin` extra minutes for reading the last answer. Entries shorter than `minEntryMin` are dropped.
3. If sessions on two branches run at the same time, the later entry starts where the earlier one ends, so time is never counted twice.
4. Description: subjects of your commits made during the entry or up to `commitGraceMin` after it. Without commits: the branch name (`feat/dark-mode` → "Dark mode"), or on the default branch the first prompt of the entry.
5. Any proposed entry that overlaps an existing Toggl entry (in any project) is skipped unless you include it explicitly, so running the preview twice never creates duplicates.

## Setup

Requires Node 22+ and git.

```bash
npm install
npm run build
```

Get the API token in Toggl Track → Profile settings → API Token, then register the server for all your Claude Code projects:

```bash
claude mcp add toggl --scope user -e TOGGL_API_TOKEN=<token> -- node /absolute/path/to/toggl-mcp/dist/index.js
```

Create the config (default `~/.config/toggl-mcp/config.json`, or point `TOGGL_MCP_CONFIG` at another file):

```bash
mkdir -p ~/.config/toggl-mcp
cp config.example.json ~/.config/toggl-mcp/config.json
```

Ask Claude to run `toggl_status`: it checks the token and lists workspace and project ids for the config.

## Config

```json
{
  "workspaceId": 1234567,
  "timezone": "Europe/London",
  "idleGapMin": 20,
  "tailMin": 5,
  "minEntryMin": 5,
  "commitGraceMin": 30,
  "repos": [
    { "path": "~/projects/my-app", "projectId": 7654321, "tags": ["claude"] }
  ]
}
```

| field | default | |
|---|---|---|
| `workspaceId` | your default workspace | Toggl workspace for new entries |
| `timezone` | system timezone | how dates in requests and the preview are read |
| `idleGapMin` | 20 | a pause longer than this ends an entry |
| `tailMin` | 5 | minutes added after the last activity of an entry |
| `minEntryMin` | 5 | shorter entries are dropped |
| `commitGraceMin` | 30 | commits this long after an entry still describe it |
| `repos[].path` | — | repository root; `~` is expanded |
| `repos[].projectId` | none | Toggl project for its entries |
| `repos[].tags` | `["claude"]` | tags for its entries |
| `repos[].gitAuthor` | `git config user.email` | whose commits describe entries |
| `repos[].defaultBranches` | `["main", "master"]` | branches where the first prompt describes an entry |
| `repos[].transcriptsDir` | derived from `path` | Claude Code transcripts folder, if it lives elsewhere |

The config is read on every call, so edits apply without restarting.

## Tools

| tool | |
|---|---|
| `toggl_status` | checks the token, lists workspaces and projects with ids, shows the config |
| `preview_timesheet({ from, to?, repo? })` | proposed entries for the days `from`…`to` (inclusive, `YYYY-MM-DD`), with totals per day; writes nothing |
| `create_time_entries({ planId, exclude?, includeOverlapping?, overrides? })` | writes a previewed plan; `overrides` change an entry's `description`, `start` or `stop` (`"HH:MM"` or ISO) by its `#` |

Typical use in Claude Code:

> Fill Toggl for yesterday

Claude calls `preview_timesheet`, shows the table, and writes after you confirm — or with your edits ("drop #3, make #2 end at 18:30").

Plans live in memory until the server restarts.

## Limits

- Only time spent with Claude Code is visible. Work outside it (meetings, manual coding) is not tracked.
- Activity is attributed by the working directory of the session: a session started in one repo counts for that repo, whatever it works on.
- Toggl returns time entries for roughly the last three months.

## Development

```bash
npm run dev        # tsc --watch
npm test           # node:test on src/ via type stripping
npx @modelcontextprotocol/inspector node dist/index.js
```

## License

MIT
