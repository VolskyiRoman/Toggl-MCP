const BASE_URL = 'https://api.track.toggl.com/api/v9';
const MAX_RETRIES = 3;

export interface TogglMe {
  id: number;
  email: string;
  fullname: string;
  default_workspace_id: number;
  timezone: string;
}

export interface TogglWorkspace {
  id: number;
  name: string;
}

export interface TogglProject {
  id: number;
  name: string;
  active: boolean;
  client_name?: string | null;
}

export interface TogglTimeEntry {
  id: number;
  workspace_id: number;
  project_id: number | null;
  description: string | null;
  start: string;
  stop: string | null;
  duration: number;
  tags: string[] | null;
}

export interface NewTimeEntry {
  description: string;
  projectId: number | null;
  tags: string[];
  start: number;
  stop: number;
}

export class TogglClient {
  private readonly auth: string;

  constructor(token: string) {
    this.auth = `Basic ${Buffer.from(`${token}:api_token`).toString('base64')}`;
  }

  me(): Promise<TogglMe> {
    return this.request('GET', '/me');
  }

  workspaces(): Promise<TogglWorkspace[]> {
    return this.request('GET', '/me/workspaces');
  }

  projects(workspaceId: number): Promise<TogglProject[]> {
    return this.request('GET', `/workspaces/${workspaceId}/projects?active=true&per_page=200`);
  }

  async timeEntries(range: { start: number; end: number }): Promise<TogglTimeEntry[]> {
    const query = new URLSearchParams({
      start_date: new Date(range.start).toISOString(),
      end_date: new Date(range.end).toISOString(),
    });
    return (await this.request<TogglTimeEntry[] | null>('GET', `/me/time_entries?${query}`)) ?? [];
  }

  createTimeEntry(workspaceId: number, entry: NewTimeEntry): Promise<TogglTimeEntry> {
    return this.request('POST', `/workspaces/${workspaceId}/time_entries`, {
      created_with: 'toggl-mcp',
      workspace_id: workspaceId,
      project_id: entry.projectId ?? undefined,
      description: entry.description,
      tags: entry.tags,
      start: new Date(entry.start).toISOString(),
      stop: new Date(entry.stop).toISOString(),
      duration: Math.round((entry.stop - entry.start) / 1000),
    });
  }

  private async request<T>(method: string, pathname: string, body?: unknown, attempt = 0): Promise<T> {
    const response = await fetch(`${BASE_URL}${pathname}`, {
      method,
      headers: {
        Authorization: this.auth,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    // A 5xx on POST may still have created the entry, so only reads retry on server errors.
    const retryable = response.status === 429 || (response.status >= 500 && method === 'GET');
    if (retryable && attempt < MAX_RETRIES) {
      const retryAfter = Number(response.headers.get('retry-after'));
      await new Promise((resolve) => setTimeout(resolve, retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt));
      return this.request(method, pathname, body, attempt + 1);
    }

    const text = await response.text();
    if (!response.ok) {
      const hint = response.status === 403 ? ' (check TOGGL_API_TOKEN)' : '';
      throw new Error(`Toggl ${method} ${pathname} failed: ${response.status}${hint} ${text}`.trim());
    }
    return (text ? JSON.parse(text) : null) as T;
  }
}
