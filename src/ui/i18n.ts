import type { CategoryId, DeferredCategory, Locale } from '../shared/types.js';

export interface Translations {
  title: string;
  usedLabel: string;
  autocompactBuffer: string;
  freeSpace: string;
  categories: Record<CategoryId, string>;
  deferred: Record<DeferredCategory['id'], string>;
  accordions: {
    mcpTools: string;
    memoryFiles: string;
    skills: string;
    customAgents: string;
    turnMessages: string;
  };
  exactTooltip: string;
  calibratedTooltip: string;
  inspectHintTooltip: string;
  autoRefreshOn: string;
  autoRefreshOff: string;
  refreshNow: string;
  turnGrowthTitle: string;
  cacheHitLabel: string;
  compactionBadge: string;
  compactionsCount: (count: number) => string;
  turnLabel: (turn: number) => string;
  deltaLabel: string;
  hintsTitle: string;
  copyCompact: string;
  copiedBadge: string;
  attachContext: string;
  attachedBadge: string;
  askAgent: string;
  openFile: string;
  searchPlaceholder: string;
  conversationsTitle: string;
  conversationsSearchPlaceholder: string;
  noConversations: string;
  noItems: string;
  loadingTitle: string;
  loadingSubtitle: string;
  cancelledNotice: string;
  emptyTranscript: string;
  previewUnavailable: string;
  modelContextUnavailable: string;
  messageSentNotice: string;
  turnsUnit: string;
  tokensUnit: string;
  statusLabels: Record<string, string>;
}

const VI_TEXTS: Translations = {
  title: 'Ngữ cảnh',
  usedLabel: 'Đã dùng',
  autocompactBuffer: 'Vùng đệm tự động thu gọn',
  freeSpace: 'Dung lượng còn trống',
  categories: {
    messages: 'Tin nhắn',
    memory_files: 'Tệp bộ nhớ',
    system_prompt: 'Câu lệnh hệ thống',
    skills: 'Skills',
    system_tools: 'Công cụ hệ thống',
    custom_agents: 'Tác nhân tùy chỉnh',
    mcp_instructions: 'Hướng dẫn máy chủ MCP',
  },
  deferred: {
    mcp_deferred_tools: 'Công cụ MCP (tải khi cần)',
    skills_deferred_body: 'Kỹ năng chưa mở (nội dung đầy đủ)',
  },
  accordions: {
    mcpTools: 'Công cụ MCP',
    memoryFiles: 'Tệp bộ nhớ',
    skills: 'Skills',
    customAgents: 'Tác nhân tùy chỉnh',
    turnMessages: 'Tin nhắn theo lượt',
  },
  exactTooltip: 'Đo thật từ transcript',
  calibratedTooltip: 'Ước lượng hiệu chuẩn từ lượt 1',
  inspectHintTooltip: 'Nhấn để mở danh sách chi tiết',
  autoRefreshOn: 'Tự làm mới mỗi 3 giây (đang bật)',
  autoRefreshOff: 'Tự làm mới mỗi 3 giây (đang tắt)',
  refreshNow: 'Làm mới ngay',
  turnGrowthTitle: 'Tăng trưởng theo lượt & Cache',
  cacheHitLabel: 'Cache hit',
  compactionBadge: 'Thu gọn ngữ cảnh',
  compactionsCount: (count: number) => `${count} lần thu gọn`,
  turnLabel: (turn: number) => `Lượt ${turn}`,
  deltaLabel: 'Tăng thêm',
  hintsTitle: 'Gợi ý tối ưu',
  copyCompact: 'Sao chép /compact',
  copiedBadge: 'Đã chép!',
  attachContext: 'Gắn vào chat',
  attachedBadge: 'Đã gắn!',
  askAgent: 'Hỏi Agent',
  openFile: 'Mở tệp',
  searchPlaceholder: 'Lọc theo tên hoặc đường dẫn…',
  conversationsTitle: 'Cuộc trò chuyện',
  conversationsSearchPlaceholder: 'Tìm cuộc trò chuyện…',
  noConversations: 'Chưa có cuộc trò chuyện nào',
  noItems: 'Không có mục phù hợp',
  loadingTitle: 'Đang đọc dữ liệu ngữ cảnh…',
  loadingSubtitle: 'Đang kết nối phiên Antigravity hiện tại',
  cancelledNotice: 'Yêu cầu đọc ngữ cảnh đã bị hủy.',
  emptyTranscript: 'Cuộc trò chuyện chưa có lượt nào được ghi nhận.',
  previewUnavailable: 'Không thể mở khung xem tệp ở chế độ này',
  modelContextUnavailable: 'Host không hỗ trợ gắn ngữ cảnh trực tiếp',
  messageSentNotice: 'Đã gửi gợi ý tới khung chat',
  turnsUnit: 'lượt',
  tokensUnit: 'token',
  statusLabels: {
    loaded: 'đã nạp',
    indexed: 'chỉ mục',
    eager: 'nạp sẵn',
    lazy: 'tải khi cần',
    active: 'đang bật',
  },
};

const EN_TEXTS: Translations = {
  title: 'Context',
  usedLabel: 'Used',
  autocompactBuffer: 'Autocompact buffer',
  freeSpace: 'Free space',
  categories: {
    messages: 'Messages',
    memory_files: 'Memory files',
    system_prompt: 'System prompt',
    skills: 'Skills',
    system_tools: 'System tools',
    custom_agents: 'Custom agents',
    mcp_instructions: 'MCP instructions',
  },
  deferred: {
    mcp_deferred_tools: 'MCP tools (deferred)',
    skills_deferred_body: 'Skills (deferred body)',
  },
  accordions: {
    mcpTools: 'MCP tools',
    memoryFiles: 'Memory files',
    skills: 'Skills',
    customAgents: 'Custom agents',
    turnMessages: 'Messages by turn',
  },
  exactTooltip: 'Measured directly from transcript',
  calibratedTooltip: 'Calibrated estimate from Turn 1 baseline',
  inspectHintTooltip: 'Click to inspect breakdown list',
  autoRefreshOn: 'Auto-refresh every 3s (on)',
  autoRefreshOff: 'Auto-refresh every 3s (off)',
  refreshNow: 'Refresh now',
  turnGrowthTitle: 'Turn Growth & Cache Hit',
  cacheHitLabel: 'Cache hit',
  compactionBadge: 'Compaction',
  compactionsCount: (count: number) => `${count} compaction${count === 1 ? '' : 's'}`,
  turnLabel: (turn: number) => `Turn ${turn}`,
  deltaLabel: 'Delta',
  hintsTitle: 'Optimization Hints',
  copyCompact: 'Copy /compact',
  copiedBadge: 'Copied!',
  attachContext: 'Attach to chat',
  attachedBadge: 'Attached!',
  askAgent: 'Ask Agent',
  openFile: 'Open file',
  searchPlaceholder: 'Filter by name or path…',
  conversationsTitle: 'Conversations',
  conversationsSearchPlaceholder: 'Search conversations…',
  noConversations: 'No conversations found',
  noItems: 'No matching items',
  loadingTitle: 'Reading context telemetry…',
  loadingSubtitle: 'Connecting to current Antigravity session',
  cancelledNotice: 'Context inspection was cancelled.',
  emptyTranscript: 'No turns recorded in this conversation yet.',
  previewUnavailable: 'File preview pane is unavailable in this view',
  modelContextUnavailable: 'Host does not support attaching model context',
  messageSentNotice: 'Sent prompt to chat',
  turnsUnit: 'turns',
  tokensUnit: 'tokens',
  statusLabels: {
    loaded: 'loaded',
    indexed: 'indexed',
    eager: 'eager',
    lazy: 'deferred',
    active: 'active',
  },
};

export function getTranslations(locale: Locale): Translations {
  return locale === 'vi' ? VI_TEXTS : EN_TEXTS;
}

function stripTrailingZero(value: string): string {
  return value.endsWith('.0') ? value.slice(0, -2) : value;
}

/**
 * Format token counts compactly for VI ('123,6 N', '1 Tr', '33 N') and EN ('123.6K', '1M', '33K').
 */
export function formatTokens(tokens: number, locale: Locale): string {
  const safe = Number.isFinite(tokens) ? Math.max(0, Math.round(tokens)) : 0;
  if (safe < 1_000) {
    return String(safe);
  }

  if (safe < 1_000_000) {
    const kVal = safe / 1_000;
    const roundedK = Number(kVal.toFixed(1));
    if (roundedK >= 1_000) {
      return locale === 'vi' ? '1 Tr' : '1M';
    }
    const raw = stripTrailingZero(roundedK.toFixed(1));
    if (locale === 'vi') {
      return `${raw.replace('.', ',')} N`;
    }
    return `${raw}K`;
  }

  const mVal = safe / 1_000_000;
  const raw = stripTrailingZero(mVal.toFixed(1));
  if (locale === 'vi') {
    return `${raw.replace('.', ',')} Tr`;
  }
  return `${raw}M`;
}

/**
 * Format signed token delta (e.g. '+18,2 N' / '-45,1 N').
 */
export function formatTokenDelta(delta: number, locale: Locale): string {
  if (!Number.isFinite(delta) || delta === 0) return '0';
  const sign = delta > 0 ? '+' : '-';
  return `${sign}${formatTokens(Math.abs(delta), locale)}`;
}

/**
 * Format percentage cleanly ('8,2%' / '12%' in VI, '8.2%' / '12%' in EN).
 */
export function formatPercent(percent: number, locale: Locale): string {
  const safe = Number.isFinite(percent) ? Math.max(0, percent) : 0;
  const raw = stripTrailingZero(safe.toFixed(1));
  const localized = locale === 'vi' ? raw.replace('.', ',') : raw;
  return `${localized}%`;
}

/**
 * Format headline integer-first percent ('12%', or '0,4%' if between 0 and 1).
 */
export function formatHeadlinePercent(percent: number, locale: Locale): string {
  const safe = Number.isFinite(percent) ? Math.max(0, percent) : 0;
  if (safe > 0 && safe < 1) {
    return formatPercent(safe, locale);
  }
  return `${Math.round(safe)}%`;
}
