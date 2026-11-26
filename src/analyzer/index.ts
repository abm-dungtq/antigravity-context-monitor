import fs from 'node:fs';
import path from 'node:path';
import type {
  CategoryId,
  ContextCategory,
  ContextSnapshot,
  ConversationSummary,
  DeferredCategory,
  DetailItem,
  OptimizationHint,
} from '../shared/types.js';
import { getModelContextConfig } from './models.js';
import { scanWorkspaceContext } from './scanner.js';
import {
  getDefaultAppDataDir,
  parseTranscript,
  readConversationQuickStats,
  type ParsedTranscript,
} from './transcript.js';

export interface LsConversationInput {
  id: string;
  title?: string;
  summary?: string;
  runState?: string;
  updateTime?: string;
  projectId?: string;
}

export interface LsPluginInput {
  name: string;
  dir: string;
  disabled: boolean;
  skills?: Array<{ name: string }>;
  agents?: Array<{ name: string }>;
  rules?: Array<{ absolutePath: string }>;
  mcpServers?: Array<{ name: string }>;
}

export interface AnalyzerOptions {
  appDataDir?: string;
  configDir?: string;
  workspacePath?: string;
  conversationId?: string;
  windowOverride?: number;
  lsConversations?: LsConversationInput[];
  lsPlugins?: LsPluginInput[];
}

const CATEGORY_COLORS: Record<CategoryId, string> = {
  messages: '#2563EB',
  memory_files: '#EA580C',
  system_prompt: '#059669',
  skills: '#EAB308',
  system_tools: '#71717A',
  custom_agents: '#8B8B94',
  mcp_instructions: '#A1A1AA',
};

function toPercent(tokens: number, contextLimit: number): number {
  if (contextLimit <= 0 || tokens <= 0) return 0;
  return Number(((tokens / contextLimit) * 100).toFixed(1));
}

function sumTokens(items: DetailItem[]): number {
  let total = 0;
  for (const item of items) {
    total += item.tokens;
  }
  return total;
}

function sortByTokensDesc(items: DetailItem[]): DetailItem[] {
  return [...items].sort((a, b) => b.tokens - a.tokens);
}

/**
 * Lists recent conversations from `<appDataDir>/brain/*` merged with optional
 * Language Server conversation metadata.
 */
export async function listConversationsSummary(opts?: {
  appDataDir?: string;
  limit?: number;
  lsConversations?: LsConversationInput[];
}): Promise<ConversationSummary[]> {
  const appDataDir = opts?.appDataDir || getDefaultAppDataDir();
  const brainDir = path.join(appDataDir, 'brain');

  const lsById = new Map<string, LsConversationInput>();
  if (Array.isArray(opts?.lsConversations)) {
    for (const c of opts.lsConversations) {
      if (c?.id) lsById.set(c.id, c);
    }
  }

  const summaries: ConversationSummary[] = [];
  const seenIds = new Set<string>();

  if (fs.existsSync(brainDir)) {
    const entries = fs.readdirSync(brainDir, { withFileTypes: true });
    const candidates: Array<{ id: string; mtimeMs: number }> = [];

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const id = entry.name;
      const logsDir = path.join(brainDir, id, '.system_generated', 'logs');
      const compactPath = path.join(logsDir, 'transcript.jsonl');
      const fullPath = path.join(logsDir, 'transcript_full.jsonl');

      const ls = lsById.get(id);
      const lsMs = ls?.updateTime ? Date.parse(ls.updateTime) || 0 : 0;

      let mtimeMs = -1;
      try {
        mtimeMs = Math.max(fs.statSync(compactPath).mtimeMs, lsMs);
      } catch {
        try {
          mtimeMs = Math.max(fs.statSync(fullPath).mtimeMs, lsMs);
        } catch {
          if (ls) {
            mtimeMs = lsMs;
          }
        }
      }

      if (mtimeMs >= 0) {
        candidates.push({ id, mtimeMs });
      }
    }

    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

    const maxToRead =
      typeof opts?.limit === 'number' && opts.limit > 0
        ? Math.min(candidates.length, opts.limit)
        : candidates.length;

    for (let i = 0; i < maxToRead; i++) {
      const id = candidates[i].id;
      const quick = readConversationQuickStats(brainDir, id);
      const ls = lsById.get(id);

      if (!quick && !ls) continue;

      seenIds.add(id);
      const model = quick?.model || 'unknown';
      const { contextLimit } = getModelContextConfig(model);
      const totalTokens = quick?.totalTokens ?? 0;
      const title =
        ls?.title?.trim() ||
        quick?.firstUserContent?.slice(0, 72) ||
        `Conversation ${id.slice(0, 8)}`;

      summaries.push({
        id,
        title,
        summary: ls?.summary,
        model,
        runState: ls?.runState || 'RUN_STATE_IDLE',
        totalTokens,
        contextLimit,
        usedPercent: toPercent(totalTokens, contextLimit),
        turns: quick?.turns ?? 0,
        updatedAt: ls?.updateTime || quick?.updatedAt || new Date(0).toISOString(),
        workspacePath: quick?.workspacePath,
      });
    }
  }

  // Include any LS conversations not yet materialized in brainDir
  for (const [id, ls] of lsById.entries()) {
    if (seenIds.has(id)) continue;
    const { contextLimit } = getModelContextConfig('unknown');
    summaries.push({
      id,
      title: ls.title?.trim() || `Conversation ${id.slice(0, 8)}`,
      summary: ls.summary,
      model: 'unknown',
      runState: ls.runState || 'RUN_STATE_IDLE',
      totalTokens: 0,
      contextLimit,
      usedPercent: 0,
      turns: 0,
      updatedAt: ls.updateTime || new Date(0).toISOString(),
    });
  }

  summaries.sort((a, b) => {
    const ta = Date.parse(a.updatedAt) || 0;
    const tb = Date.parse(b.updatedAt) || 0;
    return tb - ta;
  });

  if (typeof opts?.limit === 'number' && opts.limit > 0) {
    return summaries.slice(0, opts.limit);
  }
  return summaries;
}

const CATEGORY_LABELS: Record<CategoryId, { vi: string; en: string }> = {
  messages: { vi: 'Tin nhắn', en: 'Messages' },
  memory_files: { vi: 'Tệp bộ nhớ', en: 'Memory files' },
  system_prompt: { vi: 'Lời nhắc hệ thống', en: 'System prompt' },
  skills: { vi: 'Skills', en: 'Skills' },
  system_tools: { vi: 'Công cụ hệ thống', en: 'System tools' },
  custom_agents: { vi: 'Tác nhân tùy chỉnh', en: 'Custom agents' },
  mcp_instructions: { vi: 'Hướng dẫn máy chủ MCP', en: 'MCP server instructions' },
};

function buildHints(params: {
  usedPercent: number;
  totalUsedTokens: number;
  contextLimit: number;
  cacheHitRate: number;
  turnsCount: number;
  compactionCount: number;
  categories: ContextCategory[];
  memoryFiles: DetailItem[];
}): OptimizationHint[] {
  const hints: OptimizationHint[] = [];
  const {
    usedPercent,
    totalUsedTokens,
    cacheHitRate,
    turnsCount,
    compactionCount,
    categories,
    memoryFiles,
  } = params;

  const usedPctVi = String(usedPercent).replace('.', ',');
  if (usedPercent >= 65) {
    hints.push({
      severity: 'high',
      code: 'HIGH_CONTEXT_USAGE',
      titleVi: 'Ngữ cảnh đã dùng cao (>= 65%)',
      titleEn: 'High context usage (>= 65%)',
      detailVi: `Đã dùng ${usedPctVi}% cửa sổ ngữ cảnh. Nên chạy /compact hoặc mở cuộc trò chuyện mới để tránh suy giảm chất lượng.`,
      detailEn: `${usedPercent}% of the context window is used. Run /compact or start a new conversation to avoid quality degradation.`,
      actionType: 'copy_compact',
    });
  } else if (usedPercent >= 40) {
    hints.push({
      severity: 'warn',
      code: 'MODERATE_CONTEXT_USAGE',
      titleVi: 'Ngữ cảnh đang tăng (>= 40%)',
      titleEn: 'Context usage is growing (>= 40%)',
      detailVi: `Đang sử dụng ${usedPctVi}% cửa sổ ngữ cảnh. Có thể dùng /compact sau khi xong tác vụ hiện tại.`,
      detailEn: `${usedPercent}% of the context window is in use. Consider running /compact after finishing the current task.`,
      actionType: 'copy_compact',
    });
  }

  if (compactionCount > 0) {
    hints.push({
      severity: 'info',
      code: 'COMPACTION_OCCURRED',
      titleVi: `Đã nén ngữ cảnh ${compactionCount} lần`,
      titleEn: `Context compacted ${compactionCount} time(s)`,
      detailVi:
        'Lịch sử hội thoại cũ đã được tóm tắt qua checkpoint. Một số chi tiết đầu phiên có thể không còn nguyên văn.',
      detailEn:
        'Earlier conversation history was summarized via checkpoint. Some early details may no longer be verbatim.',
    });
  }

  if (turnsCount >= 2 && cacheHitRate < 0.4) {
    const pct = Math.round(cacheHitRate * 100);
    hints.push({
      severity: 'warn',
      code: 'LOW_CACHE_HIT_RATE',
      titleVi: `Tỷ lệ Cache Hit thấp (${pct}%)`,
      titleEn: `Low cache hit rate (${pct}%)`,
      detailVi:
        'Tỷ lệ dùng lại prompt cache dưới 40%. Tránh thay đổi tệp bộ nhớ hoặc danh sách công cụ giữa phiên để giảm chi phí & độ trễ.',
      detailEn:
        'Prompt cache reuse is below 40%. Avoid mutating memory files or tool definitions mid-session to reduce cost and latency.',
    });
  }

  if (totalUsedTokens > 0) {
    const staticCats = categories.filter(
      (c) =>
        c.id === 'memory_files' ||
        c.id === 'skills' ||
        c.id === 'custom_agents' ||
        c.id === 'mcp_instructions'
    );
    staticCats.sort((a, b) => b.tokens - a.tokens);
    const topStatic = staticCats[0];

    if (topStatic && (topStatic.tokens >= 5_000 || topStatic.percent >= 5)) {
      const topMemFile = memoryFiles[0];
      const tokensVi = topStatic.tokens.toLocaleString('vi-VN');
      const tokensEn = topStatic.tokens.toLocaleString('en-US');
      const pctVi = String(topStatic.percent).replace('.', ',');
      const labels = CATEGORY_LABELS[topStatic.id];

      if (topStatic.id === 'memory_files' && topMemFile?.path) {
        hints.push({
          severity: topStatic.percent >= 10 ? 'warn' : 'info',
          code: 'TOP_STATIC_CONSUMER',
          titleVi: `Tệp bộ nhớ chiếm ${tokensVi} token`,
          titleEn: `Memory files use ${tokensEn} tokens`,
          detailVi: `Lớn nhất là ${topMemFile.name} (${topMemFile.tokens.toLocaleString('vi-VN')} token). Cân nhắc tinh gọn quy tắc ít dùng.`,
          detailEn: `Largest is ${topMemFile.name} (${topMemFile.tokens.toLocaleString('en-US')} tokens). Consider trimming unused rules.`,
          actionType: 'open_file',
          targetPath: topMemFile.path,
          targetAccordion: 'memoryFiles',
        });
      } else {
        const accordionMap: Record<string, string> = {
          memory_files: 'memoryFiles',
          skills: 'skills',
          custom_agents: 'customAgents',
          mcp_instructions: 'mcpTools',
        };
        hints.push({
          severity: topStatic.percent >= 10 ? 'warn' : 'info',
          code: 'TOP_STATIC_CONSUMER',
          titleVi: `Thành phần tĩnh lớn nhất: ${labels.vi} (${pctVi}%)`,
          titleEn: `Largest static consumer: ${labels.en} (${topStatic.percent}%)`,
          detailVi: `Đang chiếm ${tokensVi} token ở mỗi lượt gọi. Mở danh sách chi tiết để rà soát.`,
          detailEn: `Consuming ${tokensEn} tokens per turn. Open the breakdown accordion to inspect.`,
          actionType: 'open_accordion',
          targetAccordion: accordionMap[topStatic.id] || 'skills',
        });
      }
    }
  }

  return hints;
}

const CATEGORY_ORDER_TIEBREAKER: Record<CategoryId, number> = {
  messages: 0,
  memory_files: 1,
  system_prompt: 2,
  skills: 3,
  system_tools: 4,
  custom_agents: 5,
  mcp_instructions: 6,
};

function reconcileCategories(params: {
  totalUsedTokens: number;
  contextLimit: number;
  parsed: ParsedTranscript;
  measuredMemory: number;
  measuredSkills: number;
  measuredAgents: number;
  measuredMcpInst: number;
  memoryCount: number;
  skillsCount: number;
  agentsCount: number;
  mcpInstCount: number;
}): ContextCategory[] {
  const {
    totalUsedTokens,
    contextLimit,
    parsed,
    measuredMemory,
    measuredSkills,
    measuredAgents,
    measuredMcpInst,
    memoryCount,
    skillsCount,
    agentsCount,
    mcpInstCount,
  } = params;

  const hasTurns = parsed.turns.length > 0 && totalUsedTokens > 0;

  if (!hasTurns) {
    const emptyOrder: CategoryId[] = [
      'messages',
      'memory_files',
      'system_prompt',
      'skills',
      'system_tools',
      'custom_agents',
      'mcp_instructions',
    ];
    const counts: Partial<Record<CategoryId, number>> = {
      custom_agents: agentsCount,
      memory_files: memoryCount,
      skills: skillsCount,
      mcp_instructions: mcpInstCount,
      messages: 0,
    };
    return emptyOrder.map((id) => ({
      id,
      color: CATEGORY_COLORS[id],
      tokens: 0,
      percent: 0,
      exact: false,
      calibrated: false,
      count: counts[id],
    }));
  }

  const measuredStaticSum =
    measuredMemory + measuredSkills + measuredAgents + measuredMcpInst;
  const turn1Ceiling = Math.max(
    0,
    (parsed.turn1BaselineTokens || parsed.latestBaselineTokens) - parsed.turn1UserTokens
  );
  const baselineOverhead = Math.min(totalUsedTokens, turn1Ceiling);
  const minCoreSystem =
    baselineOverhead >= 6_000
      ? Math.round(baselineOverhead * 0.35)
      : Math.round(baselineOverhead * 0.45);

  let memoryTokens = measuredMemory;
  let skillsTokens = measuredSkills;
  let agentsTokens = measuredAgents;
  let mcpInstTokens = measuredMcpInst;
  let systemPromptTokens = 0;
  let systemToolsTokens = 0;

  if (baselineOverhead - measuredStaticSum >= minCoreSystem) {
    const residual = baselineOverhead - measuredStaticSum;
    systemPromptTokens = Math.round(residual * 0.68);
    systemToolsTokens = residual - systemPromptTokens;
  } else {
    const coreSystem = minCoreSystem;
    systemPromptTokens = Math.round(coreSystem * 0.68);
    systemToolsTokens = coreSystem - systemPromptTokens;

    const targetMeasured = Math.max(0, baselineOverhead - coreSystem);
    if (measuredStaticSum > 0 && targetMeasured > 0) {
      const scale = targetMeasured / measuredStaticSum;
      memoryTokens = Math.round(measuredMemory * scale);
      skillsTokens = Math.round(measuredSkills * scale);
      agentsTokens = Math.round(measuredAgents * scale);
      mcpInstTokens = Math.round(measuredMcpInst * scale);

      const scaledSum =
        memoryTokens + skillsTokens + agentsTokens + mcpInstTokens;
      if (scaledSum !== targetMeasured) {
        let diff = scaledSum - targetMeasured;
        const arr = [
          { key: 'mem', val: memoryTokens },
          { key: 'sk', val: skillsTokens },
          { key: 'ag', val: agentsTokens },
          { key: 'mcp', val: mcpInstTokens },
        ].sort((a, b) => b.val - a.val);
        if (diff > 0) {
          for (const item of arr) {
            if (diff <= 0) break;
            const take = Math.min(item.val, diff);
            item.val -= take;
            diff -= take;
          }
        } else if (diff < 0 && arr[0]) {
          arr[0].val += -diff;
        }
        memoryTokens = arr.find((x) => x.key === 'mem')!.val;
        skillsTokens = arr.find((x) => x.key === 'sk')!.val;
        agentsTokens = arr.find((x) => x.key === 'ag')!.val;
        mcpInstTokens = arr.find((x) => x.key === 'mcp')!.val;
      }
    } else {
      memoryTokens = 0;
      skillsTokens = 0;
      agentsTokens = 0;
      mcpInstTokens = 0;
    }
  }

  const activeStaticSum =
    memoryTokens +
    systemPromptTokens +
    skillsTokens +
    systemToolsTokens +
    agentsTokens +
    mcpInstTokens;

  let messagesTokens = Math.max(0, totalUsedTokens - activeStaticSum);

  // Enforce exact sum invariant: sum(categories) === totalUsedTokens
  const currentSum = activeStaticSum + messagesTokens;
  const diff = totalUsedTokens - currentSum;
  if (diff !== 0) {
    messagesTokens = Math.max(0, messagesTokens + diff);
  }

  const rawCategories: ContextCategory[] = [
    {
      id: 'messages',
      color: CATEGORY_COLORS.messages,
      tokens: messagesTokens,
      percent: toPercent(messagesTokens, contextLimit),
      exact: false,
      calibrated: true,
      count: parsed.turns.length,
    },
    {
      id: 'memory_files',
      color: CATEGORY_COLORS.memory_files,
      tokens: memoryTokens,
      percent: toPercent(memoryTokens, contextLimit),
      exact: false,
      calibrated: false,
      count: memoryCount,
    },
    {
      id: 'system_prompt',
      color: CATEGORY_COLORS.system_prompt,
      tokens: systemPromptTokens,
      percent: toPercent(systemPromptTokens, contextLimit),
      exact: false,
      calibrated: true,
    },
    {
      id: 'skills',
      color: CATEGORY_COLORS.skills,
      tokens: skillsTokens,
      percent: toPercent(skillsTokens, contextLimit),
      exact: false,
      calibrated: false,
      count: skillsCount,
    },
    {
      id: 'system_tools',
      color: CATEGORY_COLORS.system_tools,
      tokens: systemToolsTokens,
      percent: toPercent(systemToolsTokens, contextLimit),
      exact: false,
      calibrated: true,
    },
    {
      id: 'custom_agents',
      color: CATEGORY_COLORS.custom_agents,
      tokens: agentsTokens,
      percent: toPercent(agentsTokens, contextLimit),
      exact: false,
      calibrated: false,
      count: agentsCount,
    },
    {
      id: 'mcp_instructions',
      color: CATEGORY_COLORS.mcp_instructions,
      tokens: mcpInstTokens,
      percent: toPercent(mcpInstTokens, contextLimit),
      exact: false,
      calibrated: false,
      count: mcpInstCount,
    },
  ];

  // Final safety check on sum invariant
  const finalSum = rawCategories.reduce((acc, c) => acc + c.tokens, 0);
  if (finalSum !== totalUsedTokens) {
    const residualDiff = totalUsedTokens - finalSum;
    const largest = [...rawCategories].sort((a, b) => b.tokens - a.tokens)[0];
    if (largest && largest.tokens + residualDiff >= 0) {
      largest.tokens += residualDiff;
      largest.percent = toPercent(largest.tokens, contextLimit);
    }
  }

  rawCategories.sort((a, b) => {
    if (b.tokens !== a.tokens) return b.tokens - a.tokens;
    return CATEGORY_ORDER_TIEBREAKER[a.id] - CATEGORY_ORDER_TIEBREAKER[b.id];
  });

  return rawCategories;
}

/**
 * Analyzes a conversation's transcript and static workspace/config overhead,
 * producing a complete, sum-consistent `ContextSnapshot`.
 */
export async function analyzeConversation(
  opts?: AnalyzerOptions
): Promise<ContextSnapshot> {
  const appDataDir = opts?.appDataDir || getDefaultAppDataDir();
  const lsConnected =
    Array.isArray(opts?.lsConversations) || Array.isArray(opts?.lsPlugins);

  const lsConvsById = new Map<string, LsConversationInput>();
  if (Array.isArray(opts?.lsConversations)) {
    for (const c of opts.lsConversations) {
      if (c?.id) lsConvsById.set(c.id, c);
    }
  }

  let targetId = opts?.conversationId;
  if (!targetId) {
    const recent = await listConversationsSummary({
      appDataDir,
      limit: 1,
      lsConversations: opts?.lsConversations,
    });
    targetId = recent[0]?.id;
  }

  const parsed: ParsedTranscript = targetId
    ? await parseTranscript(appDataDir, targetId)
    : await parseTranscript(appDataDir, '__nonexistent__');

  const resolvedWorkspacePath = opts?.workspacePath || parsed.workspacePath;

  const rawScan = scanWorkspaceContext({
    appDataDir,
    configDir: opts?.configDir,
    workspacePath: resolvedWorkspacePath,
    lsPlugins: opts?.lsPlugins,
  });

  // Resolve loaded vs indexed skills based on transcript tool calls / references
  const skillItems: DetailItem[] = [];
  let activeSkillsTokens = 0;
  let deferredSkillsBodyTokens = 0;
  let deferredSkillsCount = 0;

  for (const sk of rawScan.skills) {
    const isLoaded =
      parsed.loadedSkillPaths.has(sk.path) ||
      parsed.loadedSkillPaths.has(sk.realPath) ||
      parsed.loadedSkillNames.has(sk.name) ||
      parsed.loadedSkillNames.has(path.basename(path.dirname(sk.path)));

    // Static <skills> index stays constant across turns; full SKILL.md reads belong in Messages.
    activeSkillsTokens += sk.indexTokens;

    if (!isLoaded) {
      deferredSkillsBodyTokens += sk.bodyTokens;
      deferredSkillsCount++;
    }

    skillItems.push({
      name: sk.name,
      sublabel: isLoaded ? `${sk.group} · full ~${sk.fullTokens} tok in msgs` : sk.group,
      path: sk.path,
      tokens: sk.indexTokens,
      chars: sk.chars,
      status: isLoaded ? 'loaded' : 'indexed',
      group: sk.group,
    });
  }

  const measuredMemory = sumTokens(rawScan.memoryFiles);
  const measuredAgents = sumTokens(rawScan.customAgents);
  const measuredMcpInst = sumTokens(rawScan.mcpInstructions);
  const mcpDeferredTokens = sumTokens(rawScan.mcpTools);

  const lsMeta = targetId ? lsConvsById.get(targetId) : undefined;
  const modelId = parsed.model !== 'unknown' ? parsed.model : 'unknown';
  const { contextLimit, bufferRatio } = getModelContextConfig(
    modelId,
    opts?.windowOverride
  );

  const totalUsedTokens = parsed.totalUsedTokens;
  const usedPercent = toPercent(totalUsedTokens, contextLimit);
  const autocompactBufferTokens = Math.round(contextLimit * bufferRatio);
  const autocompactBufferPercent = toPercent(autocompactBufferTokens, contextLimit);
  const freeSpaceTokens = Math.max(
    0,
    contextLimit - totalUsedTokens - autocompactBufferTokens
  );
  const freeSpacePercent = toPercent(freeSpaceTokens, contextLimit);

  const categories = reconcileCategories({
    totalUsedTokens,
    contextLimit,
    parsed,
    measuredMemory,
    measuredSkills: activeSkillsTokens,
    measuredAgents,
    measuredMcpInst,
    memoryCount: rawScan.memoryFiles.length,
    skillsCount: skillItems.length,
    agentsCount: rawScan.customAgents.length,
    mcpInstCount: rawScan.mcpInstructions.length,
  });

  const deferred: DeferredCategory[] = [
    {
      id: 'mcp_deferred_tools',
      tokens: mcpDeferredTokens,
      count: rawScan.mcpTools.length,
    },
    {
      id: 'skills_deferred_body',
      tokens: deferredSkillsBodyTokens,
      count: deferredSkillsCount,
    },
  ];

  const sortedMemory = sortByTokensDesc(rawScan.memoryFiles);
  const sortedSkills = sortByTokensDesc(skillItems);
  const sortedAgents = sortByTokensDesc(rawScan.customAgents);
  const sortedMcpTools = sortByTokensDesc([
    ...rawScan.mcpInstructions,
    ...rawScan.mcpTools,
  ]);

  const hints = buildHints({
    usedPercent,
    totalUsedTokens,
    contextLimit,
    cacheHitRate: parsed.cacheHitRate,
    turnsCount: parsed.turns.length,
    compactionCount: parsed.compactionCount,
    categories,
    memoryFiles: sortedMemory,
  });

  const convId = targetId || 'empty';
  const conversation: ConversationSummary = {
    id: convId,
    title:
      lsMeta?.title?.trim() ||
      parsed.firstUserContent?.slice(0, 72) ||
      (targetId ? `Conversation ${targetId.slice(0, 8)}` : 'No active conversation'),
    summary: lsMeta?.summary,
    model: modelId,
    runState: lsMeta?.runState || 'RUN_STATE_IDLE',
    totalTokens: totalUsedTokens,
    contextLimit,
    usedPercent,
    turns: parsed.turns.length,
    updatedAt: lsMeta?.updateTime || parsed.updatedAt,
    workspacePath: resolvedWorkspacePath,
  };

  return {
    generatedAt: new Date().toISOString(),
    conversation,
    totalUsedTokens,
    contextLimit,
    usedPercent,
    autocompactBufferTokens,
    autocompactBufferPercent,
    freeSpaceTokens,
    freeSpacePercent,
    cacheHitRate: parsed.cacheHitRate,
    latestCacheReadTokens: parsed.latestCacheReadTokens,
    latestInputTokens: parsed.latestInputTokens,
    latestOutputTokens: parsed.latestOutputTokens,
    compactionCount: parsed.compactionCount,
    turn1BaselineTokens: parsed.turn1BaselineTokens,
    categories,
    deferred,
    turns: parsed.turns,
    hints,
    accordions: {
      mcpTools: sortedMcpTools,
      memoryFiles: sortedMemory,
      skills: sortedSkills,
      customAgents: sortedAgents,
      turnMessages: parsed.turnMessages,
    },
    meta: {
      source: parsed.source,
      lsConnected,
      workspacePath: resolvedWorkspacePath,
    },
  };
}
