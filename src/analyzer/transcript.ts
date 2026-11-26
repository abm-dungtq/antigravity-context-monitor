import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DetailItem, TurnPoint } from '../shared/types.js';
import { estimateTokens } from './tokenizer.js';

export interface QuickConversationStats {
  id: string;
  model: string;
  totalTokens: number;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  turns: number;
  updatedAt: string;
  firstUserContent?: string;
  workspacePath?: string;
}

export interface ParsedTranscript {
  source: 'transcript_full' | 'transcript' | 'empty';
  model: string;
  updatedAt: string;
  firstUserContent?: string;
  workspacePath?: string;
  turns: TurnPoint[];
  compactionCount: number;
  turn1BaselineTokens: number;
  latestBaselineTokens: number;
  turn1UserTokens: number;
  latestBaselineUserTokens: number;
  latestInputTokens: number;
  latestCacheReadTokens: number;
  latestOutputTokens: number;
  totalUsedTokens: number;
  cacheHitRate: number;
  loadedSkillPaths: Set<string>;
  loadedSkillNames: Set<string>;
  turnMessages: DetailItem[];
}

interface CacheEntry<T> {
  filePath: string;
  mtimeMs: number;
  size: number;
  value: T;
}

const fullTranscriptCache = new Map<string, CacheEntry<ParsedTranscript>>();
const quickStatsCache = new Map<string, CacheEntry<QuickConversationStats>>();

export function clearTranscriptCache(): void {
  fullTranscriptCache.clear();
  quickStatsCache.clear();
}

const QUICK_HEAD_BYTES = 8 * 1024;
const QUICK_TAIL_BYTES = 64 * 1024;
const SKILL_PATH_RE = /[/\\]skills[/\\]([^/\\"\s]+)[/\\]SKILL\.md/gi;

export function getDefaultAppDataDir(): string {
  return (
    process.env.ANTIGRAVITY_APP_DATA_DIR ||
    path.join(os.homedir(), '.gemini', 'antigravity')
  );
}

function cleanUserContent(raw: string): string {
  const reqMatch = raw.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i);
  const extracted = reqMatch ? reqMatch[1] : raw;
  return extracted.replace(/\s+/g, ' ').trim();
}

function isValidWorkspaceCandidate(raw: string): string | undefined {
  const trimmed = raw.trim().replace(/^['"]|['"]$/g, '').replace(/\\n.*$/, '').trim();
  if (!trimmed || trimmed.length > 512) return undefined;
  if (!/^(\/|~\/|[A-Za-z]:[/\\])/.test(trimmed)) return undefined;
  // Reject regex literals, brackets, or escaped whitespace sequences
  if (/[()[\]*?{}|^$`]/.test(trimmed)) return undefined;
  if (/\\[snrtdwSNRT]/.test(trimmed)) return undefined;
  if (trimmed.startsWith('~/')) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return trimmed;
}

function extractWorkspaceHint(text: string): string | undefined {
  const candidates: string[] = [];
  const cwdMatch = text.match(/Command Working Directory:\s*([^\n\r"]+)/);
  if (cwdMatch?.[1]) {
    const valid = isValidWorkspaceCandidate(cwdMatch[1]);
    if (valid) candidates.push(valid);
  }
  const activeMatch = text.match(/Active Workspaces:\s*(?:\r?\n|\\n)-\s*([^\n\r"]+)/);
  if (activeMatch?.[1]) {
    const valid = isValidWorkspaceCandidate(activeMatch[1]);
    if (valid) candidates.push(valid);
  }
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      // Ignore stat error
    }
  }
  return candidates[0];
}

function resolveTranscriptPath(
  logsDir: string,
  preferFull: boolean
): { filePath: string; source: 'transcript_full' | 'transcript' } | null {
  const fullPath = path.join(logsDir, 'transcript_full.jsonl');
  const compactPath = path.join(logsDir, 'transcript.jsonl');

  if (preferFull) {
    if (fs.existsSync(fullPath)) {
      return { filePath: fullPath, source: 'transcript_full' };
    }
    if (fs.existsSync(compactPath)) {
      return { filePath: compactPath, source: 'transcript' };
    }
  } else {
    if (fs.existsSync(compactPath)) {
      return { filePath: compactPath, source: 'transcript' };
    }
    if (fs.existsSync(fullPath)) {
      return { filePath: fullPath, source: 'transcript_full' };
    }
  }
  return null;
}

function readSliceSync(fd: number, offset: number, length: number): string {
  const buf = Buffer.allocUnsafe(length);
  const bytesRead = fs.readSync(fd, buf, 0, length, offset);
  return buf.subarray(0, bytesRead).toString('utf8');
}

function parseJsonLines(raw: string, skipPartialFirstLine: boolean): Record<string, unknown>[] {
  const lines = raw.split('\n');
  const start = skipPartialFirstLine ? 1 : 0;
  const parsed: Record<string, unknown>[] = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line) as unknown;
      if (obj && typeof obj === 'object') {
        parsed.push(obj as Record<string, unknown>);
      }
    } catch {
      // Ignore partial or malformed lines (e.g. truncated tail/head or active write)
    }
  }
  return parsed;
}

function recordSkillPathsFromString(
  text: string,
  loadedSkillPaths: Set<string>,
  loadedSkillNames: Set<string>
): void {
  SKILL_PATH_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SKILL_PATH_RE.exec(text)) !== null) {
    const skillName = match[1];
    if (skillName) {
      loadedSkillNames.add(skillName);
    }
    const startIdx = Math.max(0, text.lastIndexOf('"', match.index) + 1);
    const endQuote = text.indexOf('SKILL.md', match.index);
    if (endQuote !== -1) {
      const candidate = text.slice(startIdx, endQuote + 'SKILL.md'.length).trim();
      if (candidate.startsWith('/') || /^[A-Za-z]:[/\\]/.test(candidate)) {
        loadedSkillPaths.add(candidate);
        try {
          loadedSkillPaths.add(fs.realpathSync(candidate));
        } catch {
          // Path may not exist on disk anymore
        }
      }
    }
  }
}

function detectLoadedSkillsInEntry(
  entry: Record<string, unknown>,
  loadedSkillPaths: Set<string>,
  loadedSkillNames: Set<string>
): void {
  const toolCalls = entry.tool_calls;
  if (Array.isArray(toolCalls)) {
    for (const tc of toolCalls) {
      if (!tc || typeof tc !== 'object') continue;
      const call = tc as Record<string, unknown>;
      const name = typeof call.name === 'string' ? call.name : '';
      const args = call.args as Record<string, unknown> | undefined;
      if (args && typeof args === 'object') {
        const rawPath =
          args.Path ?? args.AbsolutePath ?? args.path ?? args.TargetFile;
        if (typeof rawPath === 'string') {
          const cleaned = rawPath.replace(/^"|"$/g, '');
          if (cleaned.endsWith('SKILL.md') || name === 'read_file' || name === 'view_file') {
            recordSkillPathsFromString(cleaned, loadedSkillPaths, loadedSkillNames);
          }
        }
      }
    }
  }

  if (typeof entry.content === 'string' && entry.content.includes('SKILL.md')) {
    recordSkillPathsFromString(entry.content, loadedSkillPaths, loadedSkillNames);
  }
}

/**
 * Fast quick-stats reader for conversation listing. Reads at most ~8KB head + ~64KB tail
 * of `transcript.jsonl` (falling back to `transcript_full.jsonl`) so 30 brain folders
 * scan in <50ms.
 */
export function readConversationQuickStats(
  brainDir: string,
  id: string
): QuickConversationStats | null {
  const logsDir = path.join(brainDir, id, '.system_generated', 'logs');
  const resolved = resolveTranscriptPath(logsDir, false);
  if (!resolved) {
    return null;
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved.filePath);
  } catch {
    return null;
  }

  const cached = quickStatsCache.get(id);
  if (
    cached &&
    cached.filePath === resolved.filePath &&
    cached.mtimeMs === stat.mtimeMs &&
    cached.size === stat.size
  ) {
    return cached.value;
  }

  let fd: number | null = null;
  try {
    fd = fs.openSync(resolved.filePath, 'r');
    const fileSize = stat.size;
    let headEntries: Record<string, unknown>[] = [];
    let tailEntries: Record<string, unknown>[] = [];
    let tailBytesRead = fileSize;

    if (fileSize <= QUICK_TAIL_BYTES) {
      const fullText = readSliceSync(fd, 0, fileSize);
      tailEntries = parseJsonLines(fullText, false);
      headEntries = tailEntries;
    } else {
      const headText = readSliceSync(fd, 0, Math.min(QUICK_HEAD_BYTES, fileSize));
      headEntries = parseJsonLines(headText, false);

      const tailOffset = Math.max(0, fileSize - QUICK_TAIL_BYTES);
      tailBytesRead = fileSize - tailOffset;
      const tailText = readSliceSync(fd, tailOffset, tailBytesRead);
      tailEntries = parseJsonLines(tailText, tailOffset > 0);
    }

    let firstUserContent: string | undefined;
    let workspacePath: string | undefined;
    for (const entry of headEntries) {
      if (
        !firstUserContent &&
        entry.type === 'USER_INPUT' &&
        typeof entry.content === 'string'
      ) {
        const cleaned = cleanUserContent(entry.content);
        if (cleaned) {
          firstUserContent = cleaned.slice(0, 160);
        }
      }
      if (
        !workspacePath &&
        (entry.type === 'USER_INPUT' || entry.type === 'SYSTEM_MESSAGE') &&
        typeof entry.content === 'string'
      ) {
        workspacePath = extractWorkspaceHint(entry.content);
      }
      if (firstUserContent && workspacePath) break;
    }

    let model = 'unknown';
    let inputTokens = 0;
    let cacheReadTokens = 0;
    let outputTokens = 0;
    let updatedAt = stat.mtime.toISOString();
    let tailPlannerTurns = 0;

    for (const entry of tailEntries) {
      if (typeof entry.created_at === 'string') {
        updatedAt = entry.created_at;
      }
      if (typeof entry.model === 'string' && entry.model.trim()) {
        model = entry.model.trim();
      }
      if (
        entry.type === 'PLANNER_RESPONSE' &&
        (entry.input_tokens != null || entry.cache_read_tokens != null)
      ) {
        tailPlannerTurns++;
        inputTokens = Number(entry.input_tokens ?? 0);
        cacheReadTokens = Number(entry.cache_read_tokens ?? 0);
        outputTokens = Number(entry.output_tokens ?? 0);
      }
    }

    const totalTokens = inputTokens + cacheReadTokens;
    const turns =
      fileSize <= QUICK_TAIL_BYTES
        ? tailPlannerTurns
        : Math.max(
            tailPlannerTurns,
            Math.round(tailPlannerTurns * (fileSize / Math.max(1, tailBytesRead)))
          );

    const stats: QuickConversationStats = {
      id,
      model,
      totalTokens,
      inputTokens,
      cacheReadTokens,
      outputTokens,
      turns,
      updatedAt,
      firstUserContent,
      workspacePath,
    };

    quickStatsCache.set(id, {
      filePath: resolved.filePath,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      value: stats,
    });

    return stats;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close failure
      }
    }
  }
}

/**
 * Parses a full conversation transcript (`transcript_full.jsonl` preferred, fallback
 * `transcript.jsonl`), caching by `(filePath, mtimeMs, size)`.
 */
export async function parseTranscript(
  appDataDir: string,
  conversationId: string
): Promise<ParsedTranscript> {
  const logsDir = path.join(
    appDataDir,
    'brain',
    conversationId,
    '.system_generated',
    'logs'
  );
  const resolved = resolveTranscriptPath(logsDir, true);

  if (!resolved) {
    return emptyTranscript();
  }

  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(resolved.filePath);
  } catch {
    return emptyTranscript();
  }

  const cacheKey = `${conversationId}:${resolved.filePath}`;
  const cached = fullTranscriptCache.get(cacheKey);
  if (
    cached &&
    cached.filePath === resolved.filePath &&
    cached.mtimeMs === stat.mtimeMs &&
    cached.size === stat.size
  ) {
    return cached.value;
  }

  let raw = '';
  try {
    raw = await fs.promises.readFile(resolved.filePath, 'utf8');
  } catch {
    return emptyTranscript();
  }

  const entries = parseJsonLines(raw, false);
  const turns: TurnPoint[] = [];
  const turnMessages: DetailItem[] = [];
  const loadedSkillPaths = new Set<string>();
  const loadedSkillNames = new Set<string>();

  let model = 'unknown';
  let updatedAt = stat.mtime.toISOString();
  let firstUserContent: string | undefined;
  let workspacePath: string | undefined;
  let sawCheckpointSincePrev = false;
  let compactionCount = 0;
  let pendingUserTokens = 0;
  let turn1UserTokens = 0;
  let latestBaselineUserTokens = 0;
  let turn1BaselineTokens = 0;
  let latestBaselineTokens = 0;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const entryType =
      typeof entry.type === 'string'
        ? entry.type
        : typeof entry.stepType === 'string'
          ? entry.stepType
          : '';

    if (typeof entry.created_at === 'string' && entry.created_at) {
      updatedAt = entry.created_at;
    }

    if (typeof entry.model === 'string' && entry.model.trim()) {
      model = entry.model.trim();
    }

    detectLoadedSkillsInEntry(entry, loadedSkillPaths, loadedSkillNames);

    if (
      !workspacePath &&
      (entryType === 'USER_INPUT' || entryType === 'SYSTEM_MESSAGE') &&
      typeof entry.content === 'string'
    ) {
      workspacePath = extractWorkspaceHint(entry.content);
    }

    if (entryType === 'CHECKPOINT') {
      sawCheckpointSincePrev = true;
      continue;
    }

    if (entryType === 'USER_INPUT' && typeof entry.content === 'string') {
      const cleaned = cleanUserContent(entry.content);
      if (!firstUserContent && cleaned) {
        firstUserContent = cleaned.slice(0, 160);
      }
      const mediaCount = Array.isArray(entry.media) ? entry.media.length : 0;
      pendingUserTokens += estimateTokens(entry.content, 'prose') + mediaCount * 300;
      continue;
    }

    if (
      entryType === 'PLANNER_RESPONSE' &&
      (entry.input_tokens != null || entry.cache_read_tokens != null)
    ) {
      const inputTokens = Number(entry.input_tokens ?? 0);
      const cacheReadTokens = Number(entry.cache_read_tokens ?? 0);
      const outputTokens = Number(entry.output_tokens ?? 0);
      const totalTokens = inputTokens + cacheReadTokens;
      const cacheHitRate = totalTokens > 0 ? cacheReadTokens / totalTokens : 0;

      const prevTotal = turns.length > 0 ? turns[turns.length - 1].totalTokens : 0;
      const isCompaction =
        turns.length > 0 &&
        (sawCheckpointSincePrev ||
          (prevTotal > 20_000 && totalTokens < prevTotal * 0.7));
      const deltaTokens = turns.length === 0 ? totalTokens : totalTokens - prevTotal;

      if (isCompaction) {
        compactionCount++;
        latestBaselineTokens = totalTokens;
        latestBaselineUserTokens = pendingUserTokens;
      }

      if (turns.length === 0) {
        turn1BaselineTokens = totalTokens;
        latestBaselineTokens = totalTokens;
        turn1UserTokens = pendingUserTokens;
        latestBaselineUserTokens = pendingUserTokens;
      }

      const turnNumber = turns.length + 1;
      const stepIndex =
        typeof entry.step_index === 'number' ? entry.step_index : i;
      const timestamp =
        typeof entry.created_at === 'string' ? entry.created_at : updatedAt;
      const turnModel =
        typeof entry.model === 'string' && entry.model.trim()
          ? entry.model.trim()
          : model !== 'unknown'
            ? model
            : undefined;

      const point: TurnPoint = {
        turn: turnNumber,
        stepIndex,
        timestamp,
        model: turnModel,
        totalTokens,
        inputTokens,
        cacheReadTokens,
        outputTokens,
        cacheHitRate,
        isCompaction,
        deltaTokens,
      };
      turns.push(point);

      const thinkingChars =
        typeof entry.thinking === 'string' ? entry.thinking.length : 0;
      const thinkingTokens =
        typeof entry.thinking === 'string' && thinkingChars > 0
          ? estimateTokens(entry.thinking, 'prose')
          : 0;
      const deltaStr =
        deltaTokens >= 0 ? `+${deltaTokens}` : `${deltaTokens}`;

      turnMessages.push({
        name: `Turn ${turnNumber}${isCompaction ? ' (compact)' : ''}`,
        sublabel: `in ${inputTokens} · cache ${cacheReadTokens} · out ${outputTokens} · think ${thinkingTokens} · Δ ${deltaStr}`,
        tokens: totalTokens,
        status: isCompaction ? 'active' : 'loaded',
        group: turnModel,
      });

      sawCheckpointSincePrev = false;
      pendingUserTokens = 0;
    }
  }

  const latestTurn = turns.length > 0 ? turns[turns.length - 1] : null;

  const result: ParsedTranscript = {
    source: resolved.source,
    model,
    updatedAt,
    firstUserContent,
    workspacePath,
    turns,
    compactionCount,
    turn1BaselineTokens,
    latestBaselineTokens,
    turn1UserTokens,
    latestBaselineUserTokens,
    latestInputTokens: latestTurn?.inputTokens ?? 0,
    latestCacheReadTokens: latestTurn?.cacheReadTokens ?? 0,
    latestOutputTokens: latestTurn?.outputTokens ?? 0,
    totalUsedTokens: latestTurn?.totalTokens ?? 0,
    cacheHitRate: latestTurn?.cacheHitRate ?? 0,
    loadedSkillPaths,
    loadedSkillNames,
    turnMessages,
  };

  fullTranscriptCache.set(cacheKey, {
    filePath: resolved.filePath,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    value: result,
  });

  return result;
}

function emptyTranscript(): ParsedTranscript {
  return {
    source: 'empty',
    model: 'unknown',
    updatedAt: new Date().toISOString(),
    turns: [],
    compactionCount: 0,
    turn1BaselineTokens: 0,
    latestBaselineTokens: 0,
    turn1UserTokens: 0,
    latestBaselineUserTokens: 0,
    latestInputTokens: 0,
    latestCacheReadTokens: 0,
    latestOutputTokens: 0,
    totalUsedTokens: 0,
    cacheHitRate: 0,
    loadedSkillPaths: new Set<string>(),
    loadedSkillNames: new Set<string>(),
    turnMessages: [],
  };
}
