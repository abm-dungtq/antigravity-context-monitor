export type Locale = 'vi' | 'en';

export type CategoryId =
  | 'messages'
  | 'memory_files'
  | 'system_prompt'
  | 'skills'
  | 'system_tools'
  | 'custom_agents'
  | 'mcp_instructions';

export interface ContextCategory {
  id: CategoryId;
  color: string;
  tokens: number;
  percent: number;
  exact: boolean;
  calibrated: boolean;
  count?: number;
  noteKey?: string;
}

export interface DeferredCategory {
  id: 'mcp_deferred_tools' | 'skills_deferred_body';
  tokens: number;
  count: number;
}

export interface DetailItem {
  name: string;
  sublabel?: string;
  path?: string;
  tokens: number;
  chars?: number;
  status?: 'loaded' | 'indexed' | 'eager' | 'lazy' | 'active';
  group?: string;
}

export interface TurnPoint {
  turn: number;
  stepIndex: number;
  timestamp: string;
  model?: string;
  totalTokens: number;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  cacheHitRate: number;
  isCompaction: boolean;
  deltaTokens: number;
  label?: string;
}

export interface OptimizationHint {
  severity: 'info' | 'warn' | 'high';
  code: string;
  titleVi: string;
  titleEn: string;
  detailVi: string;
  detailEn: string;
  actionType?: 'copy_compact' | 'open_file' | 'open_accordion';
  targetPath?: string;
  targetAccordion?: string;
}

export interface ConversationSummary {
  id: string;
  title: string;
  summary?: string;
  model: string;
  runState: string;
  totalTokens: number;
  contextLimit: number;
  usedPercent: number;
  turns: number;
  updatedAt: string;
  workspacePath?: string;
}

export interface ContextSnapshot {
  generatedAt: string;
  conversation: ConversationSummary;
  totalUsedTokens: number;
  contextLimit: number;
  usedPercent: number;
  autocompactBufferTokens: number;
  autocompactBufferPercent: number;
  freeSpaceTokens: number;
  freeSpacePercent: number;
  cacheHitRate: number;
  latestCacheReadTokens: number;
  latestInputTokens: number;
  latestOutputTokens: number;
  compactionCount: number;
  turn1BaselineTokens: number;
  categories: ContextCategory[];
  deferred: DeferredCategory[];
  turns: TurnPoint[];
  hints: OptimizationHint[];
  accordions: {
    mcpTools: DetailItem[];
    memoryFiles: DetailItem[];
    skills: DetailItem[];
    customAgents: DetailItem[];
    turnMessages: DetailItem[];
  };
  meta: {
    source: 'transcript_full' | 'transcript' | 'empty';
    lsConnected: boolean;
    workspacePath?: string;
  };
}
