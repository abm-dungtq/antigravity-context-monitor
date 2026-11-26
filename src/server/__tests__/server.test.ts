import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { analyzeConversation, listConversationsSummary } from '../../analyzer/index.js';
import type { ContextSnapshot, ConversationSummary } from '../../shared/types.js';
import {
  APP_RESOURCE_URI,
  capStructuredPayload,
  createContextMonitorServer,
  resolveTargetConversationId,
} from '../index.js';
import { fetchLsConversations, fetchLsPlugins, getLsCredentials } from '../ls-client.js';

function makeSnapshot(overrides: Partial<ContextSnapshot> = {}): ContextSnapshot {
  const conv: ConversationSummary = {
    id: 'conv-1',
    title: 'Sample Conversation',
    model: 'gemini-3-pro',
    runState: 'RUN_STATE_RUNNING',
    totalTokens: 123_600,
    contextLimit: 1_000_000,
    usedPercent: 12.4,
    turns: 4,
    updatedAt: '2026-11-26T07:00:00Z',
    workspacePath: '/tmp/workspace',
  };

  return {
    generatedAt: '2026-11-26T07:05:00Z',
    conversation: conv,
    totalUsedTokens: 123_600,
    contextLimit: 1_000_000,
    usedPercent: 12.4,
    autocompactBufferTokens: 33_000,
    autocompactBufferPercent: 3.3,
    freeSpaceTokens: 843_400,
    freeSpacePercent: 84.3,
    cacheHitRate: 0.72,
    latestCacheReadTokens: 88_000,
    latestInputTokens: 34_000,
    latestOutputTokens: 1_600,
    compactionCount: 0,
    turn1BaselineTokens: 52_000,
    categories: [
      { id: 'messages', color: '#2563EB', tokens: 71_600, percent: 7.2, exact: false, calibrated: true },
      { id: 'memory_files', color: '#EA580C', tokens: 12_000, percent: 1.2, exact: false, calibrated: false },
      { id: 'system_prompt', color: '#059669', tokens: 20_000, percent: 2.0, exact: false, calibrated: true },
      { id: 'skills', color: '#EAB308', tokens: 9_000, percent: 0.9, exact: false, calibrated: false },
      { id: 'system_tools', color: '#71717A', tokens: 8_000, percent: 0.8, exact: false, calibrated: true },
      { id: 'custom_agents', color: '#8B8B94', tokens: 2_000, percent: 0.2, exact: false, calibrated: false },
      { id: 'mcp_instructions', color: '#A1A1AA', tokens: 1_000, percent: 0.1, exact: false, calibrated: false },
    ],
    deferred: [
      { id: 'mcp_deferred_tools', tokens: 4_500, count: 12 },
      { id: 'skills_deferred_body', tokens: 45_000, count: 25 },
    ],
    turns: [
      {
        turn: 1,
        stepIndex: 1,
        timestamp: '2026-11-26T07:00:00Z',
        totalTokens: 52_000,
        inputTokens: 51_000,
        cacheReadTokens: 0,
        outputTokens: 1_000,
        cacheHitRate: 0,
        isCompaction: false,
        deltaTokens: 52_000,
      },
    ],
    hints: [],
    accordions: {
      mcpTools: [{ name: 'search', group: 'github', tokens: 500, status: 'lazy' }],
      memoryFiles: [{ name: 'AGENTS.md', path: '/tmp/AGENTS.md', tokens: 3000, status: 'loaded' }],
      skills: [{ name: 'ak-cook', tokens: 800, status: 'indexed' }],
      customAgents: [{ name: 'reviewer', tokens: 400, status: 'eager' }],
      turnMessages: [{ name: 'Turn 1', tokens: 1200, status: 'active' }],
    },
    meta: {
      source: 'transcript_full',
      lsConnected: false,
      workspacePath: '/tmp/workspace',
    },
    ...overrides,
  };
}

describe('ls-client', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns null / disconnected immediately when env vars are missing', async () => {
    expect(getLsCredentials({})).toBeNull();
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const convs = await fetchLsConversations({});
    const plugins = await fetchLsPlugins('/tmp/ws', {});

    expect(convs).toEqual({ connected: false, conversations: [] });
    expect(plugins).toEqual({ connected: false, plugins: [] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('strips skill markdown content and extracts only metadata from GetAllPlugins', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain('/exa.language_server_pb.LanguageServerService/GetAllPlugins');
      expect((init?.headers as Record<string, string>)['x-codeium-csrf-token']).toBe('secret-token');
      return new Response(
        JSON.stringify({
          plugins: [
            {
              name: 'my-plugin',
              dir: '/plugins/my-plugin',
              disabled: false,
              skills: [{ name: 'heavy-skill', content: 'HUGE MARKDOWN TEXT SHOULD NOT BE RETAINED' }],
              agents: [{ agent: { name: 'code-reviewer', systemPrompt: 'SECRET PROMPT' } }],
              rules: [{ absolutePath: '/ws/.rules/style.md', text: 'RULE TEXT' }],
              mcpServers: [{ name: 'github', env: { TOKEN: 'abc' } }],
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await fetchLsPlugins('/tmp/ws', {
      ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:43210',
      ANTIGRAVITY_CSRF_TOKEN: 'secret-token',
    });

    expect(result.connected).toBe(true);
    expect(result.plugins).toEqual([
      {
        name: 'my-plugin',
        dir: '/plugins/my-plugin',
        disabled: false,
        skills: [{ name: 'heavy-skill' }],
        agents: [{ name: 'code-reviewer' }],
        rules: [{ absolutePath: '/ws/.rules/style.md' }],
        mcpServers: [{ name: 'github' }],
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('HUGE MARKDOWN TEXT');
  });

  it('maps ListConversations safely and returns disconnected on timeout/HTTP error', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain('/product.v1.ConversationService/ListConversations');
      const headers = init?.headers as Record<string, string>;
      expect(headers['Connect-Protocol-Version']).toBe('1');
      expect(headers['x-antigravity-csrf-token']).toBe('tok-1');
      return new Response(
        JSON.stringify({
          conversations: [
            {
              id: 'c-1',
              title: 'Alpha',
              runState: 'RUN_STATE_RUNNING',
              updateTime: '2026-11-26T07:00:00Z',
            },
            { invalid: true },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const ok = await fetchLsConversations({
      ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:43210',
      ANTIGRAVITY_CSRF_TOKEN: 'tok-1',
    });
    expect(ok).toEqual({
      connected: true,
      conversations: [
        {
          id: 'c-1',
          title: 'Alpha',
          summary: undefined,
          runState: 'RUN_STATE_RUNNING',
          updateTime: '2026-11-26T07:00:00Z',
          projectId: undefined,
        },
      ],
    });

    globalThis.fetch = vi.fn(async () => new Response('fail', { status: 500 })) as unknown as typeof fetch;
    const errRes = await fetchLsConversations({
      ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:43210',
      ANTIGRAVITY_CSRF_TOKEN: 'tok-1',
    });
    expect(errRes).toEqual({ connected: false, conversations: [] });
  });

  it('extracts nested ListConversations fields (annotations/state/metadata) and live GetAllPlugins file:// path + mcpServers', async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url.includes('ListConversations')) {
        return new Response(
          JSON.stringify({
            conversations: [
              {
                id: 'live-1',
                metadata: { projectId: '/Volumes/2/AGY/AGY-Plugin' },
                annotations: { title: 'Live Title' },
                state: {
                  summary: 'Live Summary',
                  runState: 'RUN_STATE_RUNNING',
                  updateTime: '2026-11-26T07:30:00Z',
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          plugins: [
            {
              name: 'context-monitor',
              path: 'file:///Users/tqd/.gemini/config/plugins/context-monitor',
              disabled: false,
              skills: [{ name: 'context-monitor' }],
              mcpServers: [
                {
                  serverName: 'context-monitor_context-monitor',
                  originalServerName: 'context-monitor',
                },
              ],
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const convs = await fetchLsConversations({
      ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:43210',
      ANTIGRAVITY_CSRF_TOKEN: 'tok-1',
    });
    expect(convs).toEqual({
      connected: true,
      conversations: [
        {
          id: 'live-1',
          title: 'Live Title',
          summary: 'Live Summary',
          runState: 'RUN_STATE_RUNNING',
          updateTime: '2026-11-26T07:30:00Z',
          projectId: '/Volumes/2/AGY/AGY-Plugin',
        },
      ],
    });

    const plugins = await fetchLsPlugins('/Volumes/2/AGY/AGY-Plugin', {
      ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:43210',
      ANTIGRAVITY_CSRF_TOKEN: 'tok-1',
    });
    expect(plugins).toEqual({
      connected: true,
      plugins: [
        {
          name: 'context-monitor',
          dir: '/Users/tqd/.gemini/config/plugins/context-monitor',
          disabled: false,
          skills: [{ name: 'context-monitor' }],
          agents: [],
          rules: [],
          mcpServers: [{ name: 'context-monitor' }],
        },
      ],
    });
  });

  it('aborts hung requests cleanly on timeoutMs and encodes workspacePath with pathToFileURL', async () => {
    globalThis.fetch = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
    }) as unknown as typeof fetch;

    const timedOut = await fetchLsConversations(
      { ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:43210', ANTIGRAVITY_CSRF_TOKEN: 'tok-1' },
      25,
    );
    expect(timedOut).toEqual({ connected: false, conversations: [] });

    let capturedBody = '';
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = String(init?.body ?? '');
      return new Response(JSON.stringify({ plugins: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    await fetchLsPlugins('/tmp/Dự án #1/AGY Plugin', {
      ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:43210',
      ANTIGRAVITY_CSRF_TOKEN: 'tok-1',
    });
    expect(JSON.parse(capturedBody)).toEqual({
      workspaceUris: ['file:///tmp/D%E1%BB%B1%20%C3%A1n%20%231/AGY%20Plugin'],
    });
  });
});

describe('context-monitor MCP server', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ctx-mon-srv-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exposes only open_context_monitor to model, app-only tools to app, and valid UI resource', async () => {
    const sampleSnapshot = makeSnapshot();
    const conversations: ConversationSummary[] = [sampleSnapshot.conversation];

    const analyzeMock = vi.fn(async () => sampleSnapshot);
    const listMock = vi.fn(async () => conversations);

    const server = createContextMonitorServer({
      appDataDir: tmpDir,
      env: {},
      analyzeConversation: analyzeMock,
      listConversationsSummary: listMock,
      fetchLsConversations: async () => ({ connected: false, conversations: [] }),
      fetchLsPlugins: async () => ({ connected: false, plugins: [] }),
      loadAppHtml: () => '<!doctype html><html><body>OK</body></html>',
    });

    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const toolsResult = await client.listTools();
      const toolsByName = new Map(toolsResult.tools.map((t) => [t.name, t]));

      expect(Array.from(toolsByName.keys()).sort()).toEqual([
        'list_conversations',
        'open_context_monitor',
        'refresh_context',
      ]);

      const openTool = toolsByName.get('open_context_monitor')!;
      const openMeta = openTool._meta as Record<string, unknown>;
      const openUiMeta = openMeta?.ui as Record<string, unknown>;
      expect(openUiMeta?.visibility).not.toEqual(['app']);
      expect(openUiMeta?.resourceUri).toBe(APP_RESOURCE_URI);
      expect(openMeta?.['ui/resourceUri']).toBe(APP_RESOURCE_URI);
      expect(openMeta?.['com.google.antigravity/ui']).toEqual({
        entrypoints: [
          { type: 'aux_pane', title: 'Context Monitor' },
          { type: 'global', title: 'Context Monitor' },
        ],
      });

      const refreshMeta = toolsByName.get('refresh_context')?._meta as Record<string, unknown>;
      expect((refreshMeta?.ui as Record<string, unknown>)?.visibility).toEqual(['app']);

      const listMeta = toolsByName.get('list_conversations')?._meta as Record<string, unknown>;
      expect((listMeta?.ui as Record<string, unknown>)?.visibility).toEqual(['app']);

      // Empty {} call succeeds (simulating entrypoint launch)
      const callResult = await client.callTool({ name: 'open_context_monitor', arguments: {} });
      expect(callResult.isError).toBeFalsy();
      expect(analyzeMock).toHaveBeenCalledTimes(1);
      const structured = callResult.structuredContent as {
        snapshot: ContextSnapshot;
        conversations: ConversationSummary[];
      };
      expect(structured.snapshot.totalUsedTokens).toBe(123_600);
      expect(structured.conversations).toHaveLength(1);
      expect(Buffer.byteLength(JSON.stringify(structured), 'utf8')).toBeLessThan(1_048_576);

      // App-only tools work when invoked by app
      const refreshResult = await client.callTool({
        name: 'refresh_context',
        arguments: { conversationId: 'conv-1' },
      });
      expect(refreshResult.isError).toBeFalsy();

      const listResult = await client.callTool({
        name: 'list_conversations',
        arguments: { limit: 10 },
      });
      expect(listResult.isError).toBeFalsy();
      expect((listResult.structuredContent as { conversations: ConversationSummary[] }).conversations).toHaveLength(1);

      // Resource read returns text/html;profile=mcp-app
      const resources = await client.listResources();
      expect(resources.resources.some((r) => r.uri === APP_RESOURCE_URI)).toBe(true);
      const readRes = await client.readResource({ uri: APP_RESOURCE_URI });
      expect(readRes.contents[0].mimeType).toBe('text/html;profile=mcp-app');
      expect((readRes.contents[0] as { text?: string }).text).toContain('OK');
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });

  it('caps oversized structuredContent payloads safely below 900 KB', () => {
    const hugeItems = Array.from({ length: 4000 }, (_, i) => ({
      name: `skill-with-a-very-long-name-number-${i}`,
      sublabel: 'A'.repeat(200),
      path: `/very/long/path/to/skills/skill-${i}/SKILL.md`,
      tokens: 4000 - i,
      status: 'indexed' as const,
    }));

    const bigSnapshot = makeSnapshot({
      accordions: {
        mcpTools: hugeItems,
        memoryFiles: hugeItems.slice(0, 500),
        skills: hugeItems,
        customAgents: hugeItems.slice(0, 500),
        turnMessages: hugeItems,
      },
    });

    const capped = capStructuredPayload({
      snapshot: bigSnapshot,
      conversations: [bigSnapshot.conversation],
    });

    const bytes = Buffer.byteLength(JSON.stringify(capped), 'utf8');
    expect(bytes).toBeLessThan(900_000);
    expect(capped.snapshot.accordions.skills[0].tokens).toBe(4000);
  });

  it('resolves conversationId priority: explicit > env with transcript > running > transcript', () => {
    const appDataDir = tmpDir;
    const mkTranscript = (id: string) => {
      const dir = path.join(appDataDir, 'brain', id, '.system_generated', 'logs');
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'transcript.jsonl'), '{}\n', 'utf-8');
    };

    mkTranscript('env-conv');
    mkTranscript('done-conv');

    const conversations: ConversationSummary[] = [
      {
        id: 'done-conv',
        title: 'Done',
        model: 'gemini-3-pro',
        runState: 'RUN_STATE_IDLE',
        totalTokens: 1000,
        contextLimit: 1_000_000,
        usedPercent: 0.1,
        turns: 1,
        updatedAt: '2026-11-26T07:00:00Z',
      },
      {
        id: 'running-conv',
        title: 'Running',
        model: 'gemini-3-pro',
        runState: 'RUN_STATE_RUNNING',
        totalTokens: 2000,
        contextLimit: 1_000_000,
        usedPercent: 0.2,
        turns: 1,
        updatedAt: '2026-11-26T06:00:00Z',
      },
    ];

    expect(
      resolveTargetConversationId('explicit-id', conversations, appDataDir, {
        ANTIGRAVITY_CONVERSATION_ID: 'env-conv',
      }),
    ).toBe('explicit-id');

    expect(
      resolveTargetConversationId(undefined, conversations, appDataDir, {
        ANTIGRAVITY_CONVERSATION_ID: 'env-conv',
      }),
    ).toBe('env-conv');

    expect(
      resolveTargetConversationId(undefined, conversations, appDataDir, {
        ANTIGRAVITY_CONVERSATION_ID: 'missing-transcript-conv',
      }),
    ).toBe('running-conv');

    expect(
      resolveTargetConversationId(
        undefined,
        [conversations[0]],
        appDataDir,
        {},
      ),
    ).toBe('done-conv');
  });

  it('caches LS conversations/plugins within TTL and bypasses cache on forceRefresh', async () => {
    const sampleSnapshot = makeSnapshot();
    const fetchConvsMock = vi.fn(async () => ({
      connected: true,
      conversations: [{ id: 'conv-1', title: 'Cached Title', runState: 'RUN_STATE_RUNNING' }],
    }));
    const fetchPluginsMock = vi.fn(async () => ({
      connected: true,
      plugins: [],
    }));

    const server = createContextMonitorServer({
      appDataDir: tmpDir,
      env: {},
      analyzeConversation: async () => sampleSnapshot,
      listConversationsSummary: async () => [sampleSnapshot.conversation],
      fetchLsConversations: fetchConvsMock,
      fetchLsPlugins: fetchPluginsMock,
      loadAppHtml: () => '<!doctype html><html><body>OK</body></html>',
    });

    const client = new Client({ name: 'cache-test', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      await client.callTool({ name: 'refresh_context', arguments: { conversationId: 'conv-1' } });
      await client.callTool({ name: 'refresh_context', arguments: { conversationId: 'conv-1' } });
      expect(fetchConvsMock).toHaveBeenCalledTimes(1);
      expect(fetchPluginsMock).toHaveBeenCalledTimes(1);

      await client.callTool({
        name: 'refresh_context',
        arguments: { conversationId: 'conv-1', forceRefresh: true },
      });
      expect(fetchConvsMock).toHaveBeenCalledTimes(2);
      expect(fetchPluginsMock).toHaveBeenCalledTimes(2);
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });

  it('runs real end-to-end integration against analyzeConversation & listConversationsSummary without analyzer mocks', async () => {
    const appDataDir = path.join(tmpDir, 'antigravity');
    const configDir = path.join(tmpDir, 'config');
    const logsDir = path.join(appDataDir, 'brain', 'real-conv-1', '.system_generated', 'logs');
    const workerLogsDir = path.join(appDataDir, 'brain', 'worker-hidden', '.system_generated', 'logs');
    mkdirSync(logsDir, { recursive: true });
    mkdirSync(workerLogsDir, { recursive: true });
    mkdirSync(configDir, { recursive: true });

    writeFileSync(
      path.join(logsDir, 'transcript_full.jsonl'),
      [
        JSON.stringify({
          step_index: 0,
          type: 'USER_INPUT',
          created_at: '2026-11-26T05:00:00Z',
          content: 'Inspect my context usage',
        }),
        JSON.stringify({
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          created_at: '2026-11-26T05:00:05Z',
          model: 'gemini-4-neon-high',
          input_tokens: 34_000,
          cache_read_tokens: 0,
          output_tokens: 300,
        }),
        JSON.stringify({
          step_index: 2,
          type: 'PLANNER_RESPONSE',
          created_at: '2026-11-26T05:00:15Z',
          model: 'gemini-4-neon-high',
          input_tokens: 12_000,
          cache_read_tokens: 34_000,
          output_tokens: 400,
        }),
      ].join('\n'),
      'utf-8',
    );
    writeFileSync(
      path.join(workerLogsDir, 'transcript.jsonl'),
      JSON.stringify({
        step_index: 0,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-26T05:01:00Z',
        model: 'gemini-4-hydrogen-high',
        input_tokens: 20_000,
        cache_read_tokens: 0,
        output_tokens: 100,
      }) + '\n',
      'utf-8',
    );

    const server = createContextMonitorServer({
      appDataDir,
      configDir,
      env: {},
      analyzeConversation,
      listConversationsSummary,
      fetchLsConversations: async () => ({
        connected: true,
        conversations: [
          {
            id: 'real-conv-1',
            title: 'Real E2E Title',
            runState: 'RUN_STATE_RUNNING',
            updateTime: '2026-11-26T05:00:15Z',
          },
        ],
      }),
      fetchLsPlugins: async () => ({ connected: true, plugins: [] }),
      loadAppHtml: () => '<!doctype html><html><body>E2E</body></html>',
    });

    const client = new Client({ name: 'real-e2e', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const res = await client.callTool({ name: 'open_context_monitor', arguments: {} });
      expect(res.isError).toBeFalsy();
      const sc = res.structuredContent as {
        snapshot: ContextSnapshot;
        conversations: ConversationSummary[];
      };
      expect(sc.snapshot.conversation.id).toBe('real-conv-1');
      expect(sc.snapshot.conversation.title).toBe('Real E2E Title');
      expect(sc.snapshot.totalUsedTokens).toBe(46_000);
      expect(sc.snapshot.categories.reduce((a, c) => a + c.tokens, 0)).toBe(46_000);
      // Internal worker folder excluded when LS is connected
      expect(sc.conversations.map((c) => c.id)).toEqual(['real-conv-1']);
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });
});
