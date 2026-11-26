import { existsSync, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RESOURCE_MIME_TYPE, RESOURCE_URI_META_KEY } from '@modelcontextprotocol/ext-apps/server';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  analyzeConversation,
  listConversationsSummary,
  type AnalyzerOptions,
  type LsConversationInput,
  type LsPluginInput,
} from '../analyzer/index.js';
import type { ContextCategory, ContextSnapshot, ConversationSummary, DetailItem } from '../shared/types.js';
import { fetchLsConversations, fetchLsPlugins } from './ls-client.js';

export const APP_RESOURCE_URI = 'ui://context-monitor/app.html';
export const MAX_STRUCTURED_PAYLOAD_BYTES = 850_000;

export interface ServerDeps {
  appDataDir?: string;
  configDir?: string;
  env?: NodeJS.ProcessEnv;
  analyzeConversation?: (opts?: AnalyzerOptions) => Promise<ContextSnapshot>;
  listConversationsSummary?: (opts?: {
    appDataDir?: string;
    limit?: number;
    lsConversations?: LsConversationInput[];
  }) => Promise<ConversationSummary[]>;
  fetchLsConversations?: (
    env?: NodeJS.ProcessEnv,
  ) => Promise<{ connected: boolean; conversations: LsConversationInput[] }>;
  fetchLsPlugins?: (
    workspacePath?: string,
    env?: NodeJS.ProcessEnv,
  ) => Promise<{ connected: boolean; plugins: LsPluginInput[] }>;
  loadAppHtml?: () => string;
}

const MISSING_UI_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Context Monitor UI Not Built</title>
    <style>
      body { font-family: system-ui, -apple-system, sans-serif; padding: 24px; color: #18181b; background: #fafafa; }
      code { background: #e4e4e7; padding: 2px 6px; border-radius: 4px; }
    </style>
  </head>
  <body>
    <h2>Context Monitor UI bundle missing</h2>
    <p>Run <code>npm run build:ui</code> in the plugin directory to build <code>dist/ui/app.html</code>.</p>
  </body>
</html>`;

export function defaultAppHtmlLoader(env: NodeJS.ProcessEnv = process.env): string {
  const overridePath = env.CONTEXT_MONITOR_APP_HTML?.trim();
  if (overridePath && existsSync(overridePath)) {
    try {
      return readFileSync(overridePath, 'utf-8');
    } catch {
      return MISSING_UI_HTML;
    }
  }

  const serverDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(serverDir, '..', '..', 'dist', 'ui', 'app.html'),
    path.resolve(serverDir, '..', 'dist', 'ui', 'app.html'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        return readFileSync(candidate, 'utf-8');
      } catch {
        // Continue to next candidate
      }
    }
  }

  return MISSING_UI_HTML;
}

function getDefaultAppDataDir(env: NodeJS.ProcessEnv): string {
  return env.ANTIGRAVITY_APP_DATA_DIR?.trim() || path.join(os.homedir(), '.gemini', 'antigravity');
}

function conversationHasTranscript(appDataDir: string, conversationId: string): boolean {
  const logsDir = path.join(appDataDir, 'brain', conversationId, '.system_generated', 'logs');
  return (
    existsSync(path.join(logsDir, 'transcript_full.jsonl')) ||
    existsSync(path.join(logsDir, 'transcript.jsonl'))
  );
}

export function resolveTargetConversationId(
  requestedId: string | undefined,
  conversations: ConversationSummary[],
  appDataDir: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const explicit = requestedId?.trim();
  if (explicit) {
    return explicit;
  }

  const envId = env.ANTIGRAVITY_CONVERSATION_ID?.trim();
  if (envId && conversationHasTranscript(appDataDir, envId)) {
    return envId;
  }

  const running = conversations.find((c) => c.runState === 'RUN_STATE_RUNNING');
  if (running) {
    return running.id;
  }

  const withTranscript = conversations.find((c) => conversationHasTranscript(appDataDir, c.id));
  if (withTranscript) {
    return withTranscript.id;
  }

  return conversations[0]?.id;
}

function topItemsByTokens(items: DetailItem[], limit: number): DetailItem[] {
  if (items.length <= limit) return items;
  return [...items].sort((a, b) => b.tokens - a.tokens).slice(0, limit);
}

export function capStructuredPayload(
  payload: { snapshot: ContextSnapshot; conversations: ConversationSummary[] },
  maxBytes = MAX_STRUCTURED_PAYLOAD_BYTES,
): { snapshot: ContextSnapshot; conversations: ConversationSummary[] } {
  const serializedSize = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (serializedSize(payload) <= maxBytes) {
    return payload;
  }

  let snapshot: ContextSnapshot = {
    ...payload.snapshot,
    accordions: { ...payload.snapshot.accordions },
  };
  let conversations = payload.conversations;

  const itemCaps = [150, 60, 25, 10, 5];
  for (const cap of itemCaps) {
    snapshot = {
      ...snapshot,
      accordions: {
        mcpTools: topItemsByTokens(snapshot.accordions.mcpTools, cap),
        memoryFiles: topItemsByTokens(snapshot.accordions.memoryFiles, cap),
        skills: topItemsByTokens(snapshot.accordions.skills, cap),
        customAgents: topItemsByTokens(snapshot.accordions.customAgents, cap),
        turnMessages: topItemsByTokens(snapshot.accordions.turnMessages, cap),
      },
    };
    if (serializedSize({ snapshot, conversations }) <= maxBytes) {
      return { snapshot, conversations };
    }
  }

  if (snapshot.turns.length > 80) {
    snapshot = {
      ...snapshot,
      turns: snapshot.turns.slice(-80),
    };
    if (serializedSize({ snapshot, conversations }) <= maxBytes) {
      return { snapshot, conversations };
    }
  }

  if (conversations.length > 15) {
    conversations = conversations.slice(0, 15);
  }

  return { snapshot, conversations };
}

function formatCompactTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    const val = (tokens / 1_000_000).toFixed(1).replace(/\.0$/, '');
    return `${val}M`;
  }
  if (tokens >= 1_000) {
    const val = (tokens / 1_000).toFixed(1).replace(/\.0$/, '');
    return `${val}K`;
  }
  return String(tokens);
}

const CATEGORY_LABELS: Record<ContextCategory['id'], string> = {
  messages: 'Messages',
  memory_files: 'Memory files',
  system_prompt: 'System prompt',
  skills: 'Skills',
  system_tools: 'System tools',
  custom_agents: 'Custom agents',
  mcp_instructions: 'MCP instructions',
};

function formatSummaryText(snapshot: ContextSnapshot): string {
  const title = snapshot.conversation.title || snapshot.conversation.id || 'No conversation';
  const topCats = [...snapshot.categories]
    .filter((c) => c.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 2)
    .map((c) => `${CATEGORY_LABELS[c.id]} (${formatCompactTokens(c.tokens)})`);

  const line1 = `Context Monitor: ${snapshot.usedPercent}% used (${formatCompactTokens(snapshot.totalUsedTokens)} / ${formatCompactTokens(snapshot.contextLimit)} tokens) — ${title}`;
  const topPart = topCats.length > 0 ? `Top: ${topCats.join(', ')}` : 'Top: none';
  const line2 = `${topPart} | Cache hit: ${Math.round(snapshot.cacheHitRate * 100)}%`;
  return `${line1}\n${line2}`;
}

const ContextToolArgsSchema = z.object({
  conversationId: z.string().optional(),
  workspacePath: z.string().optional(),
  windowOverride: z.number().positive().optional(),
});

const ListConversationsArgsSchema = z.object({
  limit: z.number().int().positive().max(100).optional(),
});

export function createContextMonitorServer(deps: ServerDeps = {}): McpServer {
  const env = deps.env ?? process.env;
  const appDataDir = deps.appDataDir ?? getDefaultAppDataDir(env);
  const runAnalyze = deps.analyzeConversation ?? analyzeConversation;
  const runListConversations = deps.listConversationsSummary ?? listConversationsSummary;
  const runFetchLsConversations = deps.fetchLsConversations ?? ((e) => fetchLsConversations(e));
  const runFetchLsPlugins = deps.fetchLsPlugins ?? ((ws, e) => fetchLsPlugins(ws, e));
  const readAppHtml = deps.loadAppHtml ?? (() => defaultAppHtmlLoader(env));

  const server = new McpServer({
    name: 'context-monitor',
    version: '1.0.0',
  });

  server.registerResource(
    'Context Monitor UI',
    APP_RESOURCE_URI,
    {
      description: 'Interactive Antigravity Context Monitor MCP App UI',
      mimeType: RESOURCE_MIME_TYPE,
      _meta: {
        ui: {
          prefersBorder: false,
        },
      },
    },
    async () => ({
      contents: [
        {
          uri: APP_RESOURCE_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: readAppHtml(),
          _meta: {
            ui: {
              prefersBorder: false,
            },
          },
        },
      ],
    }),
  );

  async function buildContextPayload(args: {
    conversationId?: string;
    workspacePath?: string;
    windowOverride?: number;
  }): Promise<{ snapshot: ContextSnapshot; conversations: ConversationSummary[] }> {
    const [lsConvRes, lsPluginsRes] = await Promise.all([
      runFetchLsConversations(env),
      runFetchLsPlugins(args.workspacePath, env),
    ]);

    const lsConversations = lsConvRes.connected ? lsConvRes.conversations : undefined;
    const lsPlugins = lsPluginsRes.connected ? lsPluginsRes.plugins : undefined;

    const conversations = await runListConversations({
      appDataDir,
      limit: 30,
      lsConversations,
    });

    const resolvedConversationId = resolveTargetConversationId(
      args.conversationId,
      conversations,
      appDataDir,
      env,
    );

    const matchedConv = resolvedConversationId
      ? conversations.find((c) => c.id === resolvedConversationId)
      : undefined;

    const snapshot = await runAnalyze({
      appDataDir,
      configDir: deps.configDir,
      workspacePath: args.workspacePath ?? matchedConv?.workspacePath,
      conversationId: resolvedConversationId,
      windowOverride: args.windowOverride,
      lsConversations,
      lsPlugins,
    });

    return capStructuredPayload({ snapshot, conversations });
  }

  server.registerTool(
    'open_context_monitor',
    {
      title: 'Context Monitor',
      description:
        'Open the interactive Antigravity context window monitor showing token breakdown by component (messages, memory files, system prompt, skills, tools, custom agents, MCP).',
      inputSchema: ContextToolArgsSchema,
      _meta: {
        ui: {
          resourceUri: APP_RESOURCE_URI,
        },
        [RESOURCE_URI_META_KEY]: APP_RESOURCE_URI,
        'com.google.antigravity/ui': {
          entrypoints: [
            { type: 'aux_pane', title: 'Context Monitor' },
            { type: 'global', title: 'Context Monitor' },
          ],
        },
      },
    },
    async (args) => {
      const payload = await buildContextPayload(args ?? {});
      return {
        content: [
          {
            type: 'text',
            text: formatSummaryText(payload.snapshot),
          },
        ],
        structuredContent: payload as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    'refresh_context',
    {
      title: 'Refresh Context Snapshot',
      description: 'Fetch updated context usage snapshot and conversation list for the Context Monitor UI.',
      inputSchema: ContextToolArgsSchema,
      _meta: {
        ui: {
          visibility: ['app'],
        },
      },
    },
    async (args) => {
      const payload = await buildContextPayload(args ?? {});
      return {
        content: [
          {
            type: 'text',
            text: formatSummaryText(payload.snapshot),
          },
        ],
        structuredContent: payload as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    'list_conversations',
    {
      title: 'List Conversations',
      description: 'List recent Antigravity conversations for the Context Monitor UI switcher.',
      inputSchema: ListConversationsArgsSchema,
      _meta: {
        ui: {
          visibility: ['app'],
        },
      },
    },
    async (args) => {
      const lsConvRes = await runFetchLsConversations(env);
      const conversations = await runListConversations({
        appDataDir,
        limit: args?.limit ?? 30,
        lsConversations: lsConvRes.connected ? lsConvRes.conversations : undefined,
      });
      return {
        content: [
          {
            type: 'text',
            text: `Found ${conversations.length} conversations.`,
          },
        ],
        structuredContent: { conversations } as unknown as Record<string, unknown>,
      };
    },
  );

  return server;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);
  } catch {
    return import.meta.url === pathToFileURL(entry).href;
  }
}

async function main(): Promise<void> {
  const server = createContextMonitorServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (isMainModule()) {
  main().catch((err) => {
    console.error('[context-monitor] Fatal server error:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
