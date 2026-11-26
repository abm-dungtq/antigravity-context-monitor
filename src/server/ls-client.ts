import { fileURLToPath, pathToFileURL } from 'node:url';

export interface LsConversation {
  id: string;
  title?: string;
  summary?: string;
  runState?: string;
  updateTime?: string;
  projectId?: string;
}

export interface LsPluginMetadata {
  name: string;
  dir: string;
  disabled: boolean;
  skills: Array<{ name: string }>;
  agents: Array<{ name: string }>;
  rules: Array<{ absolutePath: string }>;
  mcpServers: Array<{ name: string }>;
}

export interface LsConversationsResult {
  connected: boolean;
  conversations: LsConversation[];
}

export interface LsPluginsResult {
  connected: boolean;
  plugins: LsPluginMetadata[];
}

export interface LsCredentials {
  baseUrl: string;
  token: string;
}

const LS_TIMEOUT_MS = 4500;

export function getLsCredentials(env: NodeJS.ProcessEnv = process.env): LsCredentials | null {
  const addr = env.ANTIGRAVITY_LS_ADDRESS?.trim();
  const token = env.ANTIGRAVITY_CSRF_TOKEN?.trim();
  if (!addr || !token) {
    return null;
  }
  const cleanAddr = addr.replace(/\/+$/, '');
  const baseUrl = /^https?:\/\//i.test(cleanAddr) ? cleanAddr : `http://${cleanAddr}`;
  return { baseUrl, token };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs = LS_TIMEOUT_MS,
): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    const parsed: unknown = await response.json();
    return asRecord(parsed);
  } catch {
    // Never log request headers, tokens, or raw error objects that could expose credentials.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function normalizePluginDir(raw: string | undefined): string {
  if (!raw) return '';
  if (raw.startsWith('file://')) {
    try {
      return fileURLToPath(raw);
    } catch {
      return raw.replace(/^file:\/\//, '');
    }
  }
  return raw;
}

export async function fetchLsConversations(
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = LS_TIMEOUT_MS,
): Promise<LsConversationsResult> {
  const creds = getLsCredentials(env);
  if (!creds) {
    return { connected: false, conversations: [] };
  }

  const data = await postJson(
    `${creds.baseUrl}/product.v1.ConversationService/ListConversations`,
    {
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1',
      'x-antigravity-csrf-token': creds.token,
    },
    { pageSize: 30, includeArchived: false },
    timeoutMs,
  );

  if (!data) {
    return { connected: false, conversations: [] };
  }

  const rawList = Array.isArray(data.conversations) ? data.conversations : [];
  const conversations: LsConversation[] = [];

  for (const entry of rawList) {
    const item = asRecord(entry);
    if (!item) continue;
    const id = asString(item.id) ?? asString(item.conversationId) ?? asString(item.cascadeId);
    if (!id) continue;

    const metadata = asRecord(item.metadata);
    const annotations = asRecord(item.annotations);
    const state = asRecord(item.state);

    conversations.push({
      id,
      title: asString(annotations?.title) ?? asString(item.title) ?? asString(metadata?.title),
      summary: asString(state?.summary) ?? asString(item.summary),
      runState: asString(state?.runState) ?? asString(item.runState) ?? asString(item.status),
      updateTime: asString(state?.updateTime) ?? asString(item.updateTime) ?? asString(item.updatedAt),
      projectId: asString(metadata?.projectId) ?? asString(item.projectId),
    });
  }

  return { connected: true, conversations };
}

export async function fetchLsPlugins(
  workspacePath?: string,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = LS_TIMEOUT_MS,
): Promise<LsPluginsResult> {
  const creds = getLsCredentials(env);
  if (!creds) {
    return { connected: false, plugins: [] };
  }

  let normalizedUri: string | undefined;
  if (workspacePath) {
    if (workspacePath.startsWith('file://')) {
      normalizedUri = workspacePath;
    } else {
      try {
        normalizedUri = pathToFileURL(workspacePath).href;
      } catch {
        normalizedUri = `file://${workspacePath}`;
      }
    }
  }

  const data = await postJson(
    `${creds.baseUrl}/exa.language_server_pb.LanguageServerService/GetAllPlugins`,
    {
      'Content-Type': 'application/json',
      'x-codeium-csrf-token': creds.token,
    },
    normalizedUri ? { workspaceUris: [normalizedUri] } : {},
    timeoutMs,
  );

  if (!data) {
    return { connected: false, plugins: [] };
  }

  const rawPlugins = Array.isArray(data.plugins) ? data.plugins : [];
  const plugins: LsPluginMetadata[] = [];

  for (const entry of rawPlugins) {
    const item = asRecord(entry);
    if (!item) continue;

    const name = asString(item.name);
    const dir = normalizePluginDir(asString(item.dir) ?? asString(item.pluginDir) ?? asString(item.path));
    if (!name) continue;

    // Extract metadata names/paths only; never retain full skill markdown text in memory.
    const skills = (Array.isArray(item.skills) ? item.skills : [])
      .map((s) => asString(asRecord(s)?.name))
      .filter((s): s is string => Boolean(s))
      .map((s) => ({ name: s }));

    const agents = (Array.isArray(item.agents) ? item.agents : [])
      .map((a) => {
        const rec = asRecord(a);
        const nested = asRecord(rec?.agent);
        return asString(nested?.name) ?? asString(rec?.name);
      })
      .filter((a): a is string => Boolean(a))
      .map((a) => ({ name: a }));

    const rules = (Array.isArray(item.rules) ? item.rules : [])
      .map((r) => {
        const rec = asRecord(r);
        return asString(rec?.absolutePath) ?? asString(rec?.path);
      })
      .filter((p): p is string => Boolean(p))
      .map((absolutePath) => ({ absolutePath }));

    const mcpServers = (Array.isArray(item.mcpServers) ? item.mcpServers : [])
      .map((m) => {
        const rec = asRecord(m);
        return asString(rec?.originalServerName) ?? asString(rec?.name) ?? asString(rec?.serverName);
      })
      .filter((m): m is string => Boolean(m))
      .map((m) => ({ name: m }));

    plugins.push({
      name,
      dir,
      disabled: Boolean(item.disabled),
      skills,
      agents,
      rules,
      mcpServers,
    });
  }

  return { connected: true, plugins };
}
