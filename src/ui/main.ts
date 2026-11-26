import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiHostCapabilities,
  type McpUiHostContext,
} from '@modelcontextprotocol/ext-apps';
import { z } from 'zod';
import type {
  CategoryId,
  ContextCategory,
  ContextSnapshot,
  ConversationSummary,
  Locale,
  OptimizationHint,
} from '../shared/types.js';
import {
  renderAccordions,
  type AccordionKey,
} from './components/accordions.js';
import { renderTurnChartSection } from './components/chart.js';
import { renderConversationsAccordionItem } from './components/sidebar.js';
import {
  formatHeadlinePercent,
  formatPercent,
  formatTokenDelta,
  formatTokens,
  getTranslations,
  type Translations,
} from './i18n.js';
import { SAMPLE_CONVERSATIONS, SAMPLE_SNAPSHOT } from './mock-data.js';
import './styles.css';
import {
  copyTextWithFallback,
  escapeHtml,
  renderRefreshSvg,
  toEncodedFileUri,
} from './utils/dom.js';

const ToggleAuxPaneResultSchema = z
  .object({
    isError: z.boolean().optional(),
  })
  .passthrough();

interface MockPayload {
  snapshot?: ContextSnapshot;
  conversations?: ConversationSummary[];
  locale?: Locale;
  hostCapabilities?: McpUiHostCapabilities;
  theme?: 'light' | 'dark';
}

declare global {
  interface Window {
    __CONTEXT_MONITOR_MOCK__?: MockPayload;
  }
}

interface UiState {
  locale: Locale;
  snapshot: ContextSnapshot | null;
  conversations: ConversationSummary[];
  selectedConversationId: string | null;
  loading: boolean;
  isRefreshing: boolean;
  cancelled: boolean;
  errorMessage: string | null;
  autoRefresh: boolean;
  chartOpen: boolean;
  conversationsOpen: boolean;
  hoveredTurn: number | null;
  openAccordions: Set<AccordionKey>;
  accordionSearches: Record<AccordionKey, string>;
  sidebarSearch: string;
  copiedCompact: boolean;
  attachedContext: boolean;
  toastMessage: string | null;
  hostCapabilities: McpUiHostCapabilities | undefined;
}

const CATEGORY_TO_ACCORDION: Partial<Record<CategoryId, AccordionKey>> = {
  messages: 'turnMessages',
  memory_files: 'memoryFiles',
  skills: 'skills',
  custom_agents: 'customAgents',
  mcp_instructions: 'mcpTools',
};

const isStandalone = typeof window !== 'undefined' && window.parent === window;

const state: UiState = {
  locale: 'vi',
  snapshot: null,
  conversations: [],
  selectedConversationId: null,
  loading: true,
  isRefreshing: false,
  cancelled: false,
  errorMessage: null,
  autoRefresh: true,
  chartOpen: true,
  conversationsOpen: false,
  hoveredTurn: null,
  openAccordions: new Set<AccordionKey>(),
  accordionSearches: {
    mcpTools: '',
    memoryFiles: '',
    skills: '',
    customAgents: '',
    turnMessages: '',
  },
  sidebarSearch: '',
  copiedCompact: false,
  attachedContext: false,
  toastMessage: null,
  hostCapabilities: undefined,
};

const rootEl = document.getElementById('app')!;
let app: App | null = null;
let isConnected = false;
let toastTimer: number | null = null;
let badgeTimer: number | null = null;
let lastRefreshAt = 0;
let activeRequestSeq = 0;
let inFlightCount = 0;

function showToast(message: string): void {
  state.toastMessage = message;
  render();
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    state.toastMessage = null;
    render();
  }, 2600);
}

function applyHostContext(ctx: McpUiHostContext | undefined): void {
  if (!ctx) return;
  if (ctx.theme === 'dark' || ctx.theme === 'light') {
    applyDocumentTheme(ctx.theme);
  }
  if (ctx.styles?.variables) {
    applyHostStyleVariables(ctx.styles.variables);
  }
  if (ctx.styles?.css?.fonts) {
    applyHostFonts(ctx.styles.css.fonts);
  }
}

function applyPayload(data: unknown, explicitTargetId?: string): void {
  if (!data || typeof data !== 'object') return;
  const record = data as Record<string, unknown>;
  const snap = (record.snapshot as ContextSnapshot | undefined) ?? undefined;
  const convs = Array.isArray(record.conversations)
    ? (record.conversations as ConversationSummary[])
    : undefined;

  if (snap) {
    state.snapshot = snap;
    if (explicitTargetId) {
      state.selectedConversationId = explicitTargetId;
    } else if (!state.selectedConversationId && snap.conversation?.id) {
      state.selectedConversationId = snap.conversation.id;
    }
    state.loading = false;
    state.cancelled = false;
    state.errorMessage = null;
  }

  if (convs) {
    state.conversations = convs;
    if (!state.selectedConversationId && convs.length > 0) {
      state.selectedConversationId = convs[0].id;
    }
  }
}

function extractTextFromContent(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const texts = content
    .filter(
      (b): b is { type: string; text: string } =>
        Boolean(b && typeof b === 'object' && (b as { type?: string }).type === 'text' && typeof (b as { text?: string }).text === 'string'),
    )
    .map((b) => b.text);
  return texts.length > 0 ? texts.join('\n') : null;
}

function handleToolResult(
  params: {
    structuredContent?: unknown;
    content?: unknown;
    isError?: boolean;
  },
  explicitTargetId?: string,
): void {
  if (params.isError) {
    state.loading = false;
    state.isRefreshing = inFlightCount > 0;
    state.errorMessage = extractTextFromContent(params.content) ?? 'Error loading context';
    render();
    return;
  }
  if (params.structuredContent) {
    applyPayload(params.structuredContent, explicitTargetId);
  }
  state.loading = false;
  state.isRefreshing = inFlightCount > 0;
  render();
}

async function refreshContext(
  targetId?: string,
  opts?: { userInitiated?: boolean; forceRefresh?: boolean },
): Promise<void> {
  if (!opts?.userInitiated && state.isRefreshing) return;

  if (isStandalone) {
    if (targetId && state.conversations.length > 0) {
      const found = state.conversations.find((c) => c.id === targetId);
      if (found && state.snapshot) {
        state.selectedConversationId = found.id;
        state.snapshot = {
          ...state.snapshot,
          conversation: found,
          totalUsedTokens: found.totalTokens,
          contextLimit: found.contextLimit,
          usedPercent: found.usedPercent,
        };
      }
    }
    render();
    return;
  }

  if (!app || !isConnected) return;

  const seq = ++activeRequestSeq;
  inFlightCount++;
  state.isRefreshing = true;
  render();

  try {
    const convId = targetId ?? state.selectedConversationId ?? undefined;
    const args: Record<string, unknown> = {};
    if (convId) args.conversationId = convId;
    if (state.snapshot?.meta.workspacePath) {
      args.workspacePath = state.snapshot.meta.workspacePath;
    }
    if (opts?.forceRefresh) {
      args.forceRefresh = true;
    }

    const result = await app.callServerTool({
      name: 'refresh_context',
      arguments: args,
    });
    inFlightCount = Math.max(0, inFlightCount - 1);
    if (seq !== activeRequestSeq) {
      state.isRefreshing = inFlightCount > 0;
      render();
      return;
    }
    lastRefreshAt = Date.now();
    handleToolResult(result, targetId);
  } catch (err) {
    inFlightCount = Math.max(0, inFlightCount - 1);
    state.isRefreshing = inFlightCount > 0;
    if (seq === activeRequestSeq && state.loading) {
      state.loading = false;
      state.errorMessage = err instanceof Error ? err.message : String(err);
    }
    render();
  }
}

function buildContextSummaryMarkdown(snap: ContextSnapshot, locale: Locale): string {
  const t = getTranslations(locale);
  const lines = [
    `## ${t.title}: ${snap.conversation.title || snap.conversation.id}`,
    `- Model: ${snap.conversation.model}`,
    `- ${t.usedLabel}: ${formatHeadlinePercent(snap.usedPercent, locale)} (${formatTokens(snap.totalUsedTokens, locale)} / ${formatTokens(snap.contextLimit, locale)})`,
    `- ${t.cacheHitLabel}: ${Math.round(snap.cacheHitRate * 100)}%`,
    '',
    ...snap.categories.map(
      (cat) =>
        `- ${t.categories[cat.id]}: ${formatTokens(cat.tokens, locale)} (${formatPercent(cat.percent, locale)})`,
    ),
  ];
  return lines.join('\n');
}

function getCategoryTooltip(cat: ContextCategory, t: Translations): string {
  const accuracy = cat.exact ? t.exactTooltip : t.calibratedTooltip;
  const hasAccordion = Boolean(CATEGORY_TO_ACCORDION[cat.id]);
  return hasAccordion ? `${accuracy} · ${t.inspectHintTooltip}` : accuracy;
}

function renderSegmentedBar(snap: ContextSnapshot, t: Translations): string {
  const limit = Math.max(1, snap.contextLimit);
  const segs: string[] = [];

  for (const cat of snap.categories) {
    if (cat.tokens <= 0) continue;
    const pct = Math.max(0.4, (cat.tokens / limit) * 100);
    const label = `${t.categories[cat.id]}: ${formatTokens(cat.tokens, state.locale)} (${formatPercent(cat.percent, state.locale)})`;
    segs.push(
      `<div class="cm-bar-seg" style="width:${pct.toFixed(2)}%;background:${escapeHtml(cat.color)}" title="${escapeHtml(label)}"></div>`,
    );
  }

  if (snap.autocompactBufferTokens > 0) {
    const bufPct = Math.max(0.4, (snap.autocompactBufferTokens / limit) * 100);
    const label = `${t.autocompactBuffer}: ${formatTokens(snap.autocompactBufferTokens, state.locale)} (${formatPercent(snap.autocompactBufferPercent, state.locale)})`;
    segs.push(
      `<div class="cm-bar-seg is-buffer" style="width:${bufPct.toFixed(2)}%" title="${escapeHtml(label)}"></div>`,
    );
  }

  return `<div class="cm-bar-track" role="img" aria-label="${escapeHtml(t.title)}">${segs.join('')}</div>`;
}

function renderBreakdown(snap: ContextSnapshot, t: Translations): string {
  const { locale } = state;

  const activeRows = snap.categories
    .map((cat) => {
      const accordionKey = CATEGORY_TO_ACCORDION[cat.id];
      const tooltip = getCategoryTooltip(cat, t);
      const hasUnderline = Boolean(accordionKey) || cat.calibrated || cat.exact;
      const labelHtml = accordionKey
        ? `<button type="button" class="cm-row-label has-underline" data-jump-accordion="${accordionKey}" title="${escapeHtml(tooltip)}">${escapeHtml(t.categories[cat.id])}</button>`
        : `<span class="cm-row-label ${hasUnderline ? 'has-underline' : ''}" title="${escapeHtml(tooltip)}">${escapeHtml(t.categories[cat.id])}</span>`;

      return `
        <div class="cm-row ${accordionKey ? 'is-clickable' : ''}">
          <span class="cm-swatch" style="background:${escapeHtml(cat.color)}"></span>
          ${labelHtml}
          <span class="cm-row-tokens tabular-nums">${escapeHtml(formatTokens(cat.tokens, locale))}</span>
          <span class="cm-row-pct tabular-nums">${escapeHtml(formatPercent(cat.percent, locale))}</span>
        </div>
      `;
    })
    .join('');

  const bufferRow = `
    <div class="cm-row">
      <span class="cm-swatch is-buffer"></span>
      <span class="cm-row-label is-muted">${escapeHtml(t.autocompactBuffer)}</span>
      <span class="cm-row-tokens tabular-nums">${escapeHtml(formatTokens(snap.autocompactBufferTokens, locale))}</span>
      <span class="cm-row-pct tabular-nums">${escapeHtml(formatPercent(snap.autocompactBufferPercent, locale))}</span>
    </div>
  `;

  const freeRow = `
    <div class="cm-row">
      <span class="cm-swatch is-free"></span>
      <span class="cm-row-label is-muted">${escapeHtml(t.freeSpace)}</span>
      <span class="cm-row-tokens tabular-nums">${escapeHtml(formatTokens(snap.freeSpaceTokens, locale))}</span>
      <span class="cm-row-pct tabular-nums">${escapeHtml(formatPercent(snap.freeSpacePercent, locale))}</span>
    </div>
  `;

  const deferredRows = snap.deferred
    .map(
      (def) => `
      <div class="cm-row">
        <span class="cm-swatch" style="background:transparent"></span>
        <span class="cm-row-label is-muted">${escapeHtml(t.deferred[def.id])}</span>
        <span class="cm-row-tokens tabular-nums">${escapeHtml(formatTokens(def.tokens, locale))}</span>
        <span class="cm-row-pct tabular-nums">—</span>
      </div>
    `,
    )
    .join('');

  return `
    <div class="cm-breakdown">
      ${activeRows}
      <div class="cm-divider"></div>
      ${bufferRow}
      ${freeRow}
      ${deferredRows ? `<div class="cm-divider"></div>${deferredRows}` : ''}
    </div>
  `;
}

function renderHintButtons(hint: OptimizationHint | undefined, t: Translations): string {
  const canUpdateContext = Boolean(state.hostCapabilities?.updateModelContext);
  const canSendMessage = Boolean(state.hostCapabilities?.message);

  const extraButtons: string[] = [];

  if (hint?.actionType === 'open_accordion' && hint.targetAccordion) {
    extraButtons.push(
      `<button type="button" class="cm-action-btn" data-jump-accordion="${escapeHtml(hint.targetAccordion)}">${escapeHtml(t.accordions[hint.targetAccordion as AccordionKey] ?? hint.targetAccordion)}</button>`,
    );
  }
  if (hint?.actionType === 'open_file' && hint.targetPath) {
    extraButtons.push(
      `<button type="button" class="cm-action-btn" data-open-path="${escapeHtml(hint.targetPath)}">${escapeHtml(t.openFile)}</button>`,
    );
  }
  if (canUpdateContext) {
    extraButtons.push(
      `<button type="button" class="cm-action-btn" data-action="attach-context">${escapeHtml(state.attachedContext ? t.attachedBadge : t.attachContext)}</button>`,
    );
  }
  if (canSendMessage) {
    extraButtons.push(
      `<button type="button" class="cm-action-btn is-primary" data-action="ask-agent">${escapeHtml(t.askAgent)}</button>`,
    );
  }

  return `
    <div class="cm-hint-actions">
      <button type="button" class="cm-action-btn" data-action="copy-compact">
        ${escapeHtml(state.copiedCompact ? t.copiedBadge : t.copyCompact)}
      </button>
      ${extraButtons.join('')}
    </div>
  `;
}

function renderHintsSection(snap: ContextSnapshot, t: Translations): string {
  const topHints = snap.hints.slice(0, 2);
  if (topHints.length === 0 && snap.totalUsedTokens === 0) return '';

  if (topHints.length === 0) {
    return `
      <section class="cm-hints">
        <div class="cm-hint-card">
          ${renderHintButtons(undefined, t)}
        </div>
      </section>
    `;
  }

  const cards = topHints
    .map((hint, idx) => {
      const title = state.locale === 'vi' ? hint.titleVi : hint.titleEn;
      const detail = state.locale === 'vi' ? hint.detailVi : hint.detailEn;
      const sevClass = hint.severity === 'high' ? 'is-high' : hint.severity === 'warn' ? 'is-warn' : '';
      return `
        <div class="cm-hint-card ${sevClass}">
          <div class="cm-hint-top">
            <span class="cm-hint-title">${escapeHtml(title)}</span>
          </div>
          <div class="cm-hint-detail">${escapeHtml(detail)}</div>
          ${idx === 0 ? renderHintButtons(hint, t) : ''}
        </div>
      `;
    })
    .join('');

  return `<section class="cm-hints" aria-label="${escapeHtml(t.hintsTitle)}">${cards}</section>`;
}

function renderSkeleton(t: Translations): string {
  return `
    <div class="cm-main">
      <div class="cm-header">
        <div class="cm-title-group">
          <h1 class="cm-title">${escapeHtml(t.title)}</h1>
        </div>
      </div>
      <div class="cm-skeleton-block" style="height:18px;width:55%;margin-bottom:10px"></div>
      <div class="cm-skeleton-block" style="height:6px;width:100%;margin-bottom:16px"></div>
      <div class="cm-skeleton-block" style="height:16px;width:100%;margin-bottom:8px"></div>
      <div class="cm-skeleton-block" style="height:16px;width:92%;margin-bottom:8px"></div>
      <div class="cm-skeleton-block" style="height:16px;width:86%;margin-bottom:8px"></div>
      <div class="cm-skeleton-block" style="height:16px;width:78%;margin-bottom:14px"></div>
      <div class="cm-notice">${escapeHtml(t.loadingTitle)} · ${escapeHtml(t.loadingSubtitle)}</div>
    </div>
  `;
}

function renderHeader(t: Translations): string {
  return `
    <header class="cm-header">
      <div class="cm-title-group">
        <h1 class="cm-title">${escapeHtml(t.title)}</h1>
      </div>
      <div class="cm-controls">
        <button
          type="button"
          class="cm-pill-btn ${state.autoRefresh ? 'is-on' : ''}"
          data-action="toggle-auto-refresh"
          title="${escapeHtml(state.autoRefresh ? t.autoRefreshOn : t.autoRefreshOff)}"
          aria-pressed="${state.autoRefresh}"
        >
          <span class="cm-live-dot" aria-hidden="true"></span>
          <span>3s</span>
        </button>
        <button
          type="button"
          class="cm-icon-btn ${state.isRefreshing ? 'is-spinning' : ''}"
          data-action="manual-refresh"
          title="${escapeHtml(t.refreshNow)}"
          aria-label="${escapeHtml(t.refreshNow)}"
        >
          ${renderRefreshSvg()}
        </button>
        <div class="cm-lang-toggle" role="group" aria-label="Language">
          <button
            type="button"
            class="cm-lang-btn ${state.locale === 'vi' ? 'is-active' : ''}"
            data-set-locale="vi"
          >VI</button>
          <button
            type="button"
            class="cm-lang-btn ${state.locale === 'en' ? 'is-active' : ''}"
            data-set-locale="en"
          >EN</button>
        </div>
      </div>
    </header>
  `;
}

function render(): void {
  const t = getTranslations(state.locale);

  // Preserve active search input focus/selection across full re-renders
  const activeEl = document.activeElement as HTMLInputElement | null;
  const activeAccSearch = activeEl?.dataset?.accordionSearch;
  const activeSidebarSearch = activeEl?.hasAttribute('data-sidebar-search') ?? false;
  const selStart = activeEl?.selectionStart ?? null;
  const selEnd = activeEl?.selectionEnd ?? null;

  if (state.loading && !state.snapshot) {
    rootEl.innerHTML = `<div class="cm-shell">${renderSkeleton(t)}</div>`;
    return;
  }

  const snap = state.snapshot;
  const activeConvId = state.selectedConversationId ?? snap?.conversation.id ?? '';
  const conversationsAccordionHtml =
    state.conversations.length > 0
      ? renderConversationsAccordionItem({
          conversations: state.conversations,
          activeId: activeConvId,
          isOpen: state.conversationsOpen,
          searchQuery: state.sidebarSearch,
          locale: state.locale,
          t,
        })
      : '';

  let bodyHtml = '';
  if (state.cancelled && !snap) {
    bodyHtml = `<div class="cm-notice">${escapeHtml(t.cancelledNotice)}</div>`;
  } else if (state.errorMessage && !snap) {
    bodyHtml = `<div class="cm-notice">${escapeHtml(state.errorMessage)}</div>`;
  } else if (snap) {
    const usedPctStr = formatHeadlinePercent(snap.usedPercent, state.locale);
    const usedRatioStr = `${formatTokens(snap.totalUsedTokens, state.locale)} / ${formatTokens(snap.contextLimit, state.locale)}`;
    const convTitle = snap.conversation.title || snap.conversation.id;
    const isEmpty = snap.meta.source === 'empty' || (snap.totalUsedTokens === 0 && snap.turns.length === 0);

    bodyHtml = `
      <div class="cm-submeta">
        <span class="cm-submeta-title" title="${escapeHtml(convTitle)}">${escapeHtml(convTitle)}</span>
        <span class="cm-model-chip">${escapeHtml(snap.conversation.model)}</span>
      </div>
      <div class="cm-headline">
        <span class="cm-used-pct tabular-nums">${escapeHtml(t.usedLabel)} ${escapeHtml(usedPctStr)}</span>
        <span class="cm-used-ratio tabular-nums">${escapeHtml(usedRatioStr)}</span>
      </div>
      ${renderSegmentedBar(snap, t)}
      ${renderBreakdown(snap, t)}
      ${isEmpty ? `<div class="cm-notice">${escapeHtml(t.emptyTranscript)}</div>` : ''}
      ${renderTurnChartSection({
        turns: snap.turns,
        contextLimit: snap.contextLimit,
        cacheHitRate: snap.cacheHitRate,
        compactionCount: snap.compactionCount,
        isOpen: state.chartOpen,
        hoveredTurn: state.hoveredTurn,
        locale: state.locale,
        t,
      })}
      ${renderHintsSection(snap, t)}
      ${renderAccordions({
        accordions: snap.accordions,
        openAccordions: state.openAccordions,
        searchQueries: state.accordionSearches,
        locale: state.locale,
        t,
        extraBottomHtml: conversationsAccordionHtml,
      })}
    `;
  }

  const toastHtml = state.toastMessage
    ? `<div class="cm-toast" role="status" aria-live="polite">${escapeHtml(state.toastMessage)}</div>`
    : '';

  rootEl.innerHTML = `
    <div class="cm-shell">
      <main class="cm-main">
        ${renderHeader(t)}
        ${bodyHtml}
      </main>
    </div>
    ${toastHtml}
  `;

  if (activeAccSearch) {
    const nextInput = rootEl.querySelector<HTMLInputElement>(
      `[data-accordion-search="${CSS.escape(activeAccSearch)}"]`,
    );
    if (nextInput) {
      nextInput.focus();
      if (selStart !== null && selEnd !== null) {
        nextInput.setSelectionRange(selStart, selEnd);
      }
    }
  } else if (activeSidebarSearch) {
    const nextInput = rootEl.querySelector<HTMLInputElement>('[data-sidebar-search]');
    if (nextInput) {
      nextInput.focus();
      if (selStart !== null && selEnd !== null) {
        nextInput.setSelectionRange(selStart, selEnd);
      }
    }
  }
}

async function openFileInAuxPane(filePath: string): Promise<void> {
  const t = getTranslations(state.locale);
  if (isStandalone || !app || !isConnected) {
    showToast(`${t.previewUnavailable}: ${filePath}`);
    return;
  }

  try {
    const uri = toEncodedFileUri(filePath);
    const res = await app.request(
      {
        method: 'com.google.antigravity/toggle-aux-pane',
        params: { tabType: 'fileView', uri },
      },
      ToggleAuxPaneResultSchema,
    );
    if (res?.isError) {
      showToast(t.previewUnavailable);
    }
  } catch {
    showToast(t.previewUnavailable);
  }
}

function attachDomEvents(): void {
  rootEl.addEventListener('click', async (event) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;

    const localeBtn = target.closest<HTMLElement>('[data-set-locale]');
    if (localeBtn) {
      const next = localeBtn.dataset.setLocale as Locale;
      if (next === 'vi' || next === 'en') {
        state.locale = next;
        document.documentElement.lang = next;
        render();
      }
      return;
    }

    const actionEl = target.closest<HTMLElement>('[data-action]');
    if (actionEl) {
      const action = actionEl.dataset.action;
      const t = getTranslations(state.locale);

      if (action === 'toggle-auto-refresh') {
        state.autoRefresh = !state.autoRefresh;
        render();
        return;
      }

      if (action === 'manual-refresh') {
        void refreshContext(undefined, { userInitiated: true, forceRefresh: true });
        return;
      }

      if (action === 'toggle-chart') {
        state.chartOpen = !state.chartOpen;
        render();
        return;
      }

      if (action === 'toggle-conversations') {
        state.conversationsOpen = !state.conversationsOpen;
        render();
        return;
      }

      if (action === 'copy-compact') {
        const ok = await copyTextWithFallback('/compact');
        if (ok) {
          state.copiedCompact = true;
          render();
          if (badgeTimer !== null) window.clearTimeout(badgeTimer);
          badgeTimer = window.setTimeout(() => {
            state.copiedCompact = false;
            render();
          }, 2000);
        }
        return;
      }

      if (action === 'attach-context' && state.snapshot && app && isConnected) {
        try {
          await app.updateModelContext({
            content: [
              {
                type: 'text',
                text: buildContextSummaryMarkdown(state.snapshot, state.locale),
              },
            ],
          });
          state.attachedContext = true;
          render();
          window.setTimeout(() => {
            state.attachedContext = false;
            render();
          }, 2000);
        } catch {
          showToast(t.modelContextUnavailable);
        }
        return;
      }

      if (action === 'ask-agent' && state.snapshot && app && isConnected) {
        const promptText =
          state.locale === 'vi'
            ? `Hãy phân tích tình trạng ngữ cảnh hiện tại (${formatHeadlinePercent(state.snapshot.usedPercent, 'vi')} đã dùng, cache hit ${Math.round(state.snapshot.cacheHitRate * 100)}%) và đề xuất cách tối ưu gọn nhất.`
            : `Analyze my current context usage (${formatHeadlinePercent(state.snapshot.usedPercent, 'en')} used, ${Math.round(state.snapshot.cacheHitRate * 100)}% cache hit) and suggest the highest-impact optimizations.`;
        try {
          const res = await app.sendMessage({
            role: 'user',
            content: [{ type: 'text', text: promptText }],
          });
          if (!res?.isError) {
            showToast(t.messageSentNotice);
          }
        } catch {
          showToast(t.modelContextUnavailable);
        }
        return;
      }
    }

    const jumpAcc = target.closest<HTMLElement>('[data-jump-accordion]');
    if (jumpAcc) {
      const key = jumpAcc.dataset.jumpAccordion as AccordionKey;
      state.openAccordions.add(key);
      render();
      const el = rootEl.querySelector(`[data-accordion-section="${CSS.escape(key)}"]`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return;
    }

    const accToggle = target.closest<HTMLElement>('[data-accordion-toggle]');
    if (accToggle) {
      const key = accToggle.dataset.accordionToggle as AccordionKey;
      if (state.openAccordions.has(key)) {
        state.openAccordions.delete(key);
      } else {
        state.openAccordions.add(key);
      }
      render();
      return;
    }

    const openPathEl = target.closest<HTMLElement>('[data-open-path]');
    if (openPathEl?.dataset.openPath) {
      void openFileInAuxPane(openPathEl.dataset.openPath);
      return;
    }

    const convEl = target.closest<HTMLElement>('[data-select-conversation]');
    if (convEl?.dataset.selectConversation) {
      const id = convEl.dataset.selectConversation;
      if (id !== state.selectedConversationId) {
        state.selectedConversationId = id;
        void refreshContext(id, { userInitiated: true });
      }
      return;
    }

    const turnPoint = target.closest<HTMLElement>('[data-turn-point]');
    if (turnPoint?.dataset.turnPoint) {
      const turnNum = Number(turnPoint.dataset.turnPoint);
      if (Number.isFinite(turnNum)) {
        state.hoveredTurn = turnNum;
        render();
      }
    }
  });

  rootEl.addEventListener('input', (event) => {
    const target = event.target as HTMLInputElement | null;
    if (!target) return;

    if (target.dataset.accordionSearch) {
      const key = target.dataset.accordionSearch as AccordionKey;
      state.accordionSearches[key] = target.value;
      render();
      return;
    }

    if (target.hasAttribute('data-sidebar-search')) {
      state.sidebarSearch = target.value;
      render();
    }
  });

  rootEl.addEventListener('mouseover', (event) => {
    const target = event.target as HTMLElement | null;
    const turnPoint = target?.closest<HTMLElement>('[data-turn-point]');
    if (!turnPoint?.dataset.turnPoint || !state.snapshot) return;

    const turnNum = Number(turnPoint.dataset.turnPoint);
    if (!Number.isFinite(turnNum) || state.hoveredTurn === turnNum) return;

    const pt = state.snapshot.turns.find((item) => item.turn === turnNum);
    if (!pt) return;

    state.hoveredTurn = turnNum;
    const readout = rootEl.querySelector<HTMLElement>('[data-chart-readout]');
    if (readout) {
      const t = getTranslations(state.locale);
      const delta = formatTokenDelta(pt.deltaTokens, state.locale);
      readout.textContent = `${t.turnLabel(pt.turn)} · ${formatTokens(pt.totalTokens, state.locale)} · ${t.cacheHitLabel} ${formatPercent(pt.cacheHitRate * 100, state.locale)} (${delta})`;
    }
  });
}

function applyMockPayload(mock: MockPayload | undefined): void {
  if (!mock) return;
  if (mock.theme) applyDocumentTheme(mock.theme);
  if (mock.locale === 'vi' || mock.locale === 'en') {
    state.locale = mock.locale;
    document.documentElement.lang = mock.locale;
  }
  if (mock.hostCapabilities !== undefined) {
    state.hostCapabilities = mock.hostCapabilities;
  }
  if (mock.conversations) {
    state.conversations = mock.conversations;
  }
  if (mock.snapshot) {
    state.snapshot = mock.snapshot;
    state.selectedConversationId = mock.snapshot.conversation.id;
    state.loading = false;
  }
  render();
}

function setupStandalonePreview(): void {
  let currentMock = window.__CONTEXT_MONITOR_MOCK__;
  if (currentMock) {
    applyMockPayload(currentMock);
  } else {
    state.snapshot = SAMPLE_SNAPSHOT;
    state.conversations = SAMPLE_CONVERSATIONS;
    state.selectedConversationId = SAMPLE_SNAPSHOT.conversation.id;
    state.loading = false;
    render();
  }

  try {
    Object.defineProperty(window, '__CONTEXT_MONITOR_MOCK__', {
      configurable: true,
      get: () => currentMock,
      set: (value: MockPayload | undefined) => {
        currentMock = value;
        applyMockPayload(value);
      },
    });
  } catch {
    // Ignore if property is non-configurable in test environment.
  }
}

async function init(): Promise<void> {
  attachDomEvents();
  render();

  if (isStandalone) {
    setupStandalonePreview();
    return;
  }

  app = new App(
    { name: 'Context Monitor', version: '1.0.0' },
    {},
    { autoResize: true },
  );

  // Register ALL handlers BEFORE app.connect()
  app.ontoolinput = (params) => {
    const argId = params.arguments?.conversationId;
    if (typeof argId === 'string' && argId.length > 0) {
      state.selectedConversationId = argId;
    }
    state.cancelled = false;
    if (!state.snapshot) {
      state.loading = true;
      render();
    }
  };

  app.ontoolresult = (params) => {
    lastRefreshAt = Date.now();
    handleToolResult(params as {
      structuredContent?: Record<string, unknown>;
      content?: unknown;
      isError?: boolean;
    });
  };

  app.ontoolcancelled = () => {
    state.loading = false;
    state.isRefreshing = false;
    state.cancelled = true;
    render();
  };

  app.onhostcontextchanged = (ctx) => {
    applyHostContext(ctx);
  };

  try {
    await app.connect();
    isConnected = true;
    applyHostContext(app.getHostContext());
    state.hostCapabilities = app.getHostCapabilities();
    render();

    window.setInterval(() => {
      if (!state.autoRefresh || document.hidden || state.isRefreshing || !isConnected) {
        return;
      }
      void refreshContext();
    }, 3000);

    document.addEventListener('visibilitychange', () => {
      if (
        !document.hidden &&
        state.autoRefresh &&
        isConnected &&
        !state.isRefreshing &&
        Date.now() - lastRefreshAt >= 3000
      ) {
        void refreshContext();
      }
    });
  } catch (err) {
    state.loading = false;
    state.errorMessage = err instanceof Error ? err.message : String(err);
    render();
  }
}

void init();
