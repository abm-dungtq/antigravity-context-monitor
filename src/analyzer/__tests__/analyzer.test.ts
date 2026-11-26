import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_AUTOCOMPACT_BUFFER_RATIO,
  getModelContextConfig,
  getModelContextLimit,
} from '../models.js';
import { estimateTokens } from '../tokenizer.js';
import {
  clearTranscriptCache,
  parseTranscript,
  readConversationQuickStats,
} from '../transcript.js';
import { clearScannerCache, scanWorkspaceContext } from '../scanner.js';
import { analyzeConversation, listConversationsSummary } from '../index.js';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  clearScannerCache();
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('models', () => {
  it('resolves model context limits accurately', () => {
    expect(getModelContextLimit('gemini-4-neon-high')).toBe(1_000_000);
    expect(getModelContextLimit('gemini-3-pro')).toBe(1_000_000);
    expect(getModelContextLimit('gemini-2.5-flash')).toBe(1_000_000);

    expect(getModelContextLimit('claude-3-7-sonnet')).toBe(200_000);
    expect(getModelContextLimit('claude-opus-4-6-1m')).toBe(1_000_000);

    expect(getModelContextLimit('gpt-4o')).toBe(200_000);
    expect(getModelContextLimit('gpt-5')).toBe(200_000);
    expect(getModelContextLimit('o1-preview')).toBe(200_000);
    expect(getModelContextLimit('o3-mini')).toBe(200_000);
    expect(getModelContextLimit('o4-mini')).toBe(200_000);
    expect(getModelContextLimit('gpt-4.1')).toBe(1_000_000);
    expect(getModelContextLimit('gpt-4.1-mini')).toBe(1_000_000);

    expect(getModelContextLimit('custom-unknown-model')).toBe(1_000_000);
    expect(getModelContextLimit(undefined)).toBe(1_000_000);
  });

  it('honors windowOverride and buffer ratio', () => {
    expect(getModelContextLimit('gemini-4-neon-high', 128_000)).toBe(128_000);
    const cfg = getModelContextConfig('claude-sonnet-4', 500_000);
    expect(cfg.contextLimit).toBe(500_000);
    expect(cfg.bufferRatio).toBe(DEFAULT_AUTOCOMPACT_BUFFER_RATIO);
  });
});

describe('tokenizer', () => {
  it('handles empty strings and calibrated ratios for VI, EN, JSON, and code', () => {
    expect(estimateTokens('')).toBe(0);

    const viText =
      'Hệ thống kiểm tra ngữ cảnh giúp theo dõi số lượng token tiêu thụ theo từng lượt hội thoại tiếng Việt có dấu đầy đủ.';
    const viTokens = estimateTokens(viText, 'prose');
    const viCharsPerToken = viText.length / viTokens;
    expect(viCharsPerToken).toBeGreaterThanOrEqual(2.6);
    expect(viCharsPerToken).toBeLessThanOrEqual(3.25);

    const enText =
      'The context analyzer measures prompt overhead, conversation growth, and cache efficiency across turns without external dependencies.';
    const enTokens = estimateTokens(enText, 'prose');
    const enCharsPerToken = enText.length / enTokens;
    expect(enCharsPerToken).toBeGreaterThanOrEqual(3.75);
    expect(enCharsPerToken).toBeLessThanOrEqual(4.05);

    const jsonText = JSON.stringify({
      name: 'inspect_context',
      description: 'Inspect current conversation context usage',
      parameters: { type: 'object', properties: { conversationId: { type: 'string' } } },
    });
    const jsonTokens = estimateTokens(jsonText, 'json');
    const jsonCharsPerToken = jsonText.length / jsonTokens;
    expect(jsonCharsPerToken).toBeGreaterThanOrEqual(3.15);
    expect(jsonCharsPerToken).toBeLessThanOrEqual(3.55);

    const codeText =
      'export function sumTokens(items: Array<{ tokens: number }>): number { return items.reduce((a, b) => a + b.tokens, 0); }';
    const codeTokens = estimateTokens(codeText, 'code');
    const codeCharsPerToken = codeText.length / codeTokens;
    expect(codeCharsPerToken).toBeGreaterThanOrEqual(3.15);
    expect(codeCharsPerToken).toBeLessThanOrEqual(3.55);
  });
});

describe('transcript parser', () => {
  it('parses normal turns, checkpoint compaction, sharp drop compaction, and loaded skills', async () => {
    const appDataDir = makeTempDir('agy-app-');
    const convId = 'conv-test-1';
    const logsDir = path.join(appDataDir, 'brain', convId, '.system_generated', 'logs');
    fs.mkdirSync(logsDir, { recursive: true });

    const skillPath = '/tmp/mock/skills/ak-cook/SKILL.md';
    const lines = [
      JSON.stringify({
        step_index: 0,
        type: 'USER_INPUT',
        created_at: '2026-11-26T01:00:00Z',
        content: '<USER_REQUEST>\nBuild a context monitor plugin\n</USER_REQUEST>',
      }),
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-26T01:00:05Z',
        model: 'gemini-4-neon-high',
        input_tokens: 30_000,
        cache_read_tokens: 0,
        output_tokens: 400,
        thinking: 'Checking requirements',
        tool_calls: [{ name: 'read_file', args: { Path: skillPath } }],
      }),
      JSON.stringify({
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-26T01:00:20Z',
        model: 'gemini-4-neon-high',
        input_tokens: 15_000,
        cache_read_tokens: 35_000,
        output_tokens: 800,
        thinking: 'Implementing modules',
      }),
      JSON.stringify({
        step_index: 3,
        type: 'CHECKPOINT',
        created_at: '2026-11-26T01:01:00Z',
        content: '# Resuming from a compaction',
      }),
      JSON.stringify({
        step_index: 4,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-26T01:01:10Z',
        model: 'gemini-4-neon-high',
        input_tokens: 28_000,
        cache_read_tokens: 0,
        output_tokens: 300,
      }),
      JSON.stringify({
        step_index: 5,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-26T01:02:00Z',
        model: 'gemini-4-neon-high',
        input_tokens: 10_000,
        cache_read_tokens: 40_000,
        output_tokens: 500,
      }),
      // Sharp drop > 30% without CHECKPOINT
      JSON.stringify({
        step_index: 6,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-26T01:03:00Z',
        model: 'gemini-4-neon-high',
        input_tokens: 18_000,
        cache_read_tokens: 5_000,
        output_tokens: 250,
      }),
    ];

    fs.writeFileSync(path.join(logsDir, 'transcript.jsonl'), lines.join('\n'));

    const quick = readConversationQuickStats(path.join(appDataDir, 'brain'), convId);
    expect(quick).not.toBeNull();
    expect(quick!.model).toBe('gemini-4-neon-high');
    expect(quick!.totalTokens).toBe(23_000);
    expect(quick!.turns).toBe(5);
    expect(quick!.firstUserContent).toContain('Build a context monitor plugin');

    const parsed = await parseTranscript(appDataDir, convId);
    expect(parsed.source).toBe('transcript');
    expect(parsed.turns).toHaveLength(5);
    expect(parsed.compactionCount).toBe(2);
    expect(parsed.turn1BaselineTokens).toBe(30_000);
    expect(parsed.latestBaselineTokens).toBe(23_000);
    expect(parsed.turns[2].isCompaction).toBe(true);
    expect(parsed.turns[4].isCompaction).toBe(true);
    expect(parsed.turns[1].cacheHitRate).toBeCloseTo(0.7, 2);
    expect(parsed.loadedSkillNames.has('ak-cook')).toBe(true);
    expect(parsed.turnMessages).toHaveLength(5);
  });

  it('returns empty transcript safely when file is missing or empty', async () => {
    const appDataDir = makeTempDir('agy-empty-');
    const logsDir = path.join(appDataDir, 'brain', 'empty-conv', '.system_generated', 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(path.join(logsDir, 'transcript.jsonl'), '');

    const parsed = await parseTranscript(appDataDir, 'empty-conv');
    expect(parsed.source).toBe('transcript');
    expect(parsed.turns).toHaveLength(0);
    expect(parsed.totalUsedTokens).toBe(0);

    const missing = await parseTranscript(appDataDir, 'does-not-exist');
    expect(missing.source).toBe('empty');
    expect(missing.turns).toHaveLength(0);
  });
});

describe('analyzer & reconciliation', () => {
  it('enforces exact category sum invariant, handles static scanning & hints', async () => {
    const root = makeTempDir('agy-full-');
    const appDataDir = path.join(root, 'antigravity');
    const configDir = path.join(root, 'config');
    const workspaceDir = path.join(root, 'workspace');

    // Memory files
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(path.join(root, 'GEMINI.md'), 'Global user instructions for Antigravity.');
    fs.writeFileSync(path.join(workspaceDir, 'AGENTS.md'), 'Workspace agent rules and standards.');

    // Sensitive config.json should NEVER leak userSettings
    fs.writeFileSync(
      path.join(configDir, 'config.json'),
      JSON.stringify({
        userSettings: { apiKey: 'SUPER_SECRET_TOKEN' },
        plugins: {
          'my-plugin': { enabled: true },
          'disabled-plugin': { enabled: false },
        },
      })
    );

    // Enabled plugin with skill, rule, mcp
    const enabledPluginDir = path.join(configDir, 'plugins', 'my-plugin');
    fs.mkdirSync(path.join(enabledPluginDir, 'skills', 'demo-skill'), { recursive: true });
    fs.mkdirSync(path.join(enabledPluginDir, 'rules'), { recursive: true });
    fs.writeFileSync(
      path.join(enabledPluginDir, 'plugin.json'),
      JSON.stringify({ name: 'my-plugin' })
    );
    fs.writeFileSync(
      path.join(enabledPluginDir, 'skills', 'demo-skill', 'SKILL.md'),
      '---\nname: demo-skill\ndescription: Short skill index description\n---\n\n' +
        'Detailed body instructions '.repeat(120)
    );
    fs.writeFileSync(path.join(enabledPluginDir, 'rules', 'plugin-rule.md'), 'Plugin rule text.');
    fs.writeFileSync(
      path.join(enabledPluginDir, 'mcp_config.json'),
      JSON.stringify({ mcpServers: { srv: { command: 'node', env: { SECRET: '123' } } } })
    );

    // Disabled plugin should be ignored
    const disabledPluginDir = path.join(configDir, 'plugins', 'disabled-plugin');
    fs.mkdirSync(path.join(disabledPluginDir, 'skills', 'hidden-skill'), { recursive: true });
    fs.writeFileSync(
      path.join(disabledPluginDir, 'skills', 'hidden-skill', 'SKILL.md'),
      '---\nname: hidden-skill\ndescription: Should not appear\n---\nBody'
    );

    // MCP instructions & deferred tool JSON
    const mcpSrvDir = path.join(appDataDir, 'mcp', 'my-plugin_srv');
    fs.mkdirSync(mcpSrvDir, { recursive: true });
    fs.writeFileSync(path.join(mcpSrvDir, 'instructions.md'), 'Use srv carefully.');
    fs.writeFileSync(
      path.join(mcpSrvDir, 'query_data.json'),
      JSON.stringify({ name: 'query_data', parameters: { type: 'object' } })
    );

    // Transcript with 2 turns (high usage on claude-sonnet-4 200k)
    const convId = 'conv-reconcile';
    const logsDir = path.join(appDataDir, 'brain', convId, '.system_generated', 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(
      path.join(logsDir, 'transcript_full.jsonl'),
      [
        JSON.stringify({
          step_index: 0,
          type: 'USER_INPUT',
          created_at: '2026-11-26T02:00:00Z',
          content: 'Analyze this repository',
        }),
        JSON.stringify({
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          created_at: '2026-11-26T02:00:05Z',
          model: 'claude-sonnet-4',
          input_tokens: 25_000,
          cache_read_tokens: 0,
          output_tokens: 500,
        }),
        JSON.stringify({
          step_index: 2,
          type: 'PLANNER_RESPONSE',
          created_at: '2026-11-26T02:01:00Z',
          model: 'claude-sonnet-4',
          input_tokens: 135_000,
          cache_read_tokens: 10_000,
          output_tokens: 900,
        }),
      ].join('\n')
    );

    const scan = scanWorkspaceContext({ appDataDir, configDir, workspacePath: workspaceDir });
    expect(scan.skills.map((s) => s.name)).toContain('demo-skill');
    expect(scan.skills.map((s) => s.name)).not.toContain('hidden-skill');
    expect(JSON.stringify(scan)).not.toContain('SUPER_SECRET_TOKEN');
    expect(JSON.stringify(scan)).not.toContain('123');

    const snapshot = await analyzeConversation({
      appDataDir,
      configDir,
      workspacePath: workspaceDir,
      conversationId: convId,
    });

    expect(snapshot.meta.source).toBe('transcript_full');
    expect(snapshot.contextLimit).toBe(200_000);
    expect(snapshot.totalUsedTokens).toBe(145_000);
    expect(snapshot.usedPercent).toBe(72.5);
    expect(snapshot.autocompactBufferTokens).toBe(Math.round(200_000 * 0.033));
    expect(snapshot.freeSpaceTokens).toBe(
      200_000 - 145_000 - snapshot.autocompactBufferTokens
    );

    // Exact sum invariant
    const catSum = snapshot.categories.reduce((acc, c) => acc + c.tokens, 0);
    expect(catSum).toBe(snapshot.totalUsedTokens);

    // Hints should trigger high usage (>=65%) and low cache hit (<40%)
    expect(snapshot.hints.some((h) => h.code === 'HIGH_CONTEXT_USAGE')).toBe(true);
    expect(snapshot.hints.some((h) => h.code === 'LOW_CACHE_HIT_RATE')).toBe(true);

    // Window override test
    const overridden = await analyzeConversation({
      appDataDir,
      configDir,
      workspacePath: workspaceDir,
      conversationId: convId,
      windowOverride: 500_000,
    });
    expect(overridden.contextLimit).toBe(500_000);
    expect(overridden.categories.reduce((acc, c) => acc + c.tokens, 0)).toBe(
      overridden.totalUsedTokens
    );
  });

  it('handles empty conversations without NaNs', async () => {
    const root = makeTempDir('agy-no-turns-');
    const appDataDir = path.join(root, 'antigravity');
    const configDir = path.join(root, 'config');
    fs.mkdirSync(path.join(appDataDir, 'brain'), { recursive: true });
    fs.mkdirSync(configDir, { recursive: true });

    const snapshot = await analyzeConversation({
      appDataDir,
      configDir,
      conversationId: 'missing-id',
    });

    expect(snapshot.totalUsedTokens).toBe(0);
    expect(snapshot.usedPercent).toBe(0);
    expect(Number.isNaN(snapshot.freeSpacePercent)).toBe(false);
    expect(snapshot.categories.reduce((a, c) => a + c.tokens, 0)).toBe(0);
    expect(snapshot.meta.source).toBe('empty');
  });

  it('rejects regex-like workspace hints and localizes TOP_STATIC_CONSUMER hints', async () => {
    const root = makeTempDir('agy-hints-');
    const appDataDir = path.join(root, 'antigravity');
    const configDir = path.join(root, 'config');
    const convId = 'conv-hints';
    const logsDir = path.join(appDataDir, 'brain', convId, '.system_generated', 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    fs.mkdirSync(configDir, { recursive: true });

    // Create a large MCP instructions file (> 5,000 tokens) to trigger TOP_STATIC_CONSUMER
    fs.writeFileSync(
      path.join(configDir, 'mcp_config.json'),
      JSON.stringify({ mcpServers: { heavy: { command: 'node' } } })
    );
    const mcpHeavyDir = path.join(appDataDir, 'mcp', 'heavy');
    fs.mkdirSync(mcpHeavyDir, { recursive: true });
    fs.writeFileSync(
      path.join(mcpHeavyDir, 'instructions.md'),
      'Detailed MCP instruction block for testing localization. '.repeat(450)
    );

    fs.writeFileSync(
      path.join(logsDir, 'transcript.jsonl'),
      [
        JSON.stringify({
          step_index: 0,
          type: 'USER_INPUT',
          created_at: '2026-11-26T02:00:00Z',
          content: 'Check regex Command Working Directory:\\s*([^\\n\\r") in source code',
        }),
        JSON.stringify({
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          created_at: '2026-11-26T02:00:05Z',
          model: 'gemini-4-neon-high',
          input_tokens: 45_000,
          cache_read_tokens: 0,
          output_tokens: 200,
          content: 'Command Working Directory:\\s*([^\\n\\r")',
        }),
      ].join('\n')
    );

    const snapshot = await analyzeConversation({
      appDataDir,
      configDir,
      conversationId: convId,
    });

    expect(snapshot.meta.workspacePath).toBeUndefined();

    const staticHint = snapshot.hints.find((h) => h.code === 'TOP_STATIC_CONSUMER');
    expect(staticHint).toBeDefined();
    expect(staticHint!.titleVi).toContain('Hướng dẫn máy chủ MCP');
    expect(staticHint!.titleVi).not.toContain('mcp_instructions');
    expect(staticHint!.titleEn).toContain('MCP server instructions');
    expect(staticHint!.titleEn).not.toContain('mcp_instructions');
    // VI uses dot thousands separator, EN uses comma thousands separator
    expect(staticHint!.detailVi).toMatch(/\d+\.\d{3} token/);
    expect(staticHint!.detailEn).toMatch(/\d+,\d{3} tokens/);
  });

  it('does not double-count loaded SKILL.md into Turn 1 static skills, parses multiline YAML, preserves core system tokens on overflow, and sorts categories desc', async () => {
    const root = makeTempDir('agy-loaded-skill-');
    const appDataDir = path.join(root, 'antigravity');
    const configDir = path.join(root, 'config');
    const convId = 'conv-loaded';
    const logsDir = path.join(appDataDir, 'brain', convId, '.system_generated', 'logs');
    fs.mkdirSync(logsDir, { recursive: true });

    const heavySkillDir = path.join(configDir, 'skills', 'heavy-skill');
    fs.mkdirSync(heavySkillDir, { recursive: true });
    const heavySkillPath = path.join(heavySkillDir, 'SKILL.md');
    fs.writeFileSync(
      heavySkillPath,
      [
        '---',
        'name: heavy-skill',
        'description: >-',
        '  Multiline YAML description that summarizes',
        '  what this skill does cleanly.',
        '---',
        '',
        'Full body section '.repeat(1200),
      ].join('\n')
    );

    const scan = scanWorkspaceContext({ appDataDir, configDir });
    const scannedHeavy = scan.skills.find((s) => s.name === 'heavy-skill');
    expect(scannedHeavy).toBeDefined();
    expect(scannedHeavy!.description).toBe(
      'Multiline YAML description that summarizes what this skill does cleanly.'
    );
    expect(scannedHeavy!.indexTokens).toBeLessThan(80);

    fs.writeFileSync(
      path.join(logsDir, 'transcript_full.jsonl'),
      [
        JSON.stringify({
          step_index: 0,
          type: 'USER_INPUT',
          created_at: '2026-11-26T02:00:00Z',
          content: 'Load heavy-skill and run task',
          media: [{ path: '/tmp/a.png' }],
        }),
        JSON.stringify({
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          created_at: '2026-11-26T02:00:05Z',
          model: 'gemini-4-hydrogen-high',
          input_tokens: 33_340,
          cache_read_tokens: 0,
          output_tokens: 400,
          tool_calls: [{ name: 'read_file', args: { Path: heavySkillPath } }],
        }),
        JSON.stringify({
          step_index: 2,
          type: 'PLANNER_RESPONSE',
          created_at: '2026-11-26T02:00:15Z',
          model: 'gemini-4-hydrogen-high',
          input_tokens: 45_000,
          cache_read_tokens: 33_000,
          output_tokens: 500,
        }),
      ].join('\n')
    );

    const snapshot = await analyzeConversation({
      appDataDir,
      configDir,
      conversationId: convId,
    });

    const skillsCat = snapshot.categories.find((c) => c.id === 'skills')!;
    const sysPromptCat = snapshot.categories.find((c) => c.id === 'system_prompt')!;
    const sysToolsCat = snapshot.categories.find((c) => c.id === 'system_tools')!;
    const msgsCat = snapshot.categories.find((c) => c.id === 'messages')!;

    expect(skillsCat.tokens).toBe(scannedHeavy!.indexTokens);
    expect(sysPromptCat.tokens).toBeGreaterThan(10_000);
    expect(sysToolsCat.tokens).toBeGreaterThan(5_000);
    expect(msgsCat.tokens).toBeGreaterThan(40_000);
    expect(snapshot.categories[0].id).toBe('messages');
    for (let i = 1; i < snapshot.categories.length; i++) {
      expect(snapshot.categories[i - 1].tokens).toBeGreaterThanOrEqual(
        snapshot.categories[i].tokens
      );
    }
    expect(snapshot.categories.reduce((acc, c) => acc + c.tokens, 0)).toBe(
      snapshot.totalUsedTokens
    );

    // Overflow scenario: many skills exceeding Turn 1 ceiling still preserve calibrated system_prompt & system_tools
    for (let i = 0; i < 120; i++) {
      const dir = path.join(configDir, 'skills', `extra-${i}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'SKILL.md'),
        `---\nname: extra-${i}\ndescription: ${'Skill description padding '.repeat(35)}\n---\nBody`
      );
    }
    const overflowSnap = await analyzeConversation({
      appDataDir,
      configDir,
      conversationId: convId,
    });
    expect(
      overflowSnap.categories.find((c) => c.id === 'system_prompt')!.tokens
    ).toBeGreaterThan(0);
    expect(
      overflowSnap.categories.find((c) => c.id === 'system_tools')!.tokens
    ).toBeGreaterThan(0);
    expect(overflowSnap.categories.reduce((acc, c) => acc + c.tokens, 0)).toBe(
      overflowSnap.totalUsedTokens
    );
  });
});

describe('real local brain integration (if present)', () => {
  const realAppDataDir = path.join(os.homedir(), '.gemini', 'antigravity');
  const realBrainDir = path.join(realAppDataDir, 'brain');
  const hasRealBrain = fs.existsSync(realBrainDir);

  it.skipIf(!hasRealBrain)(
    'lists 30 conversations quickly and analyzes the latest real conversation cleanly',
    async () => {
      const t0 = performance.now();
      const list = await listConversationsSummary({
        appDataDir: realAppDataDir,
        limit: 30,
      });
      const elapsedMs = performance.now() - t0;

      expect(list.length).toBeGreaterThan(0);
      expect(elapsedMs).toBeLessThan(200);

      // Direct cold 30-folder readConversationQuickStats benchmark (<50ms)
      clearTranscriptCache();
      const brainDir = path.join(realAppDataDir, 'brain');
      const ids = list.slice(0, 30).map((c) => c.id);
      const t1 = performance.now();
      for (const id of ids) {
        readConversationQuickStats(brainDir, id);
      }
      const quickElapsedMs = performance.now() - t1;
      expect(quickElapsedMs).toBeLessThan(50);

      const snapshot = await analyzeConversation({
        appDataDir: realAppDataDir,
        conversationId: list[0].id,
      });

      expect(snapshot.conversation.id).toBe(list[0].id);
      expect(
        snapshot.categories.reduce((acc, c) => acc + c.tokens, 0)
      ).toBe(snapshot.totalUsedTokens);
      expect(snapshot.freeSpaceTokens).toBeGreaterThanOrEqual(0);
    }
  );
});
