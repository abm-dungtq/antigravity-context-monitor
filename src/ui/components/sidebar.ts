import type { ConversationSummary, Locale } from '../../shared/types.js';
import { formatHeadlinePercent, type Translations } from '../i18n.js';
import { escapeHtml, renderChevronSvg } from '../utils/dom.js';

export interface ConversationsAccordionProps {
  conversations: ConversationSummary[];
  activeId: string;
  isOpen: boolean;
  searchQuery: string;
  locale: Locale;
  t: Translations;
}

export function renderConversationsAccordionItem(
  props: ConversationsAccordionProps,
): string {
  const { conversations, activeId, isOpen, searchQuery, locale, t } = props;
  if (conversations.length === 0) return '';

  const triggerHtml = `
    <button
      type="button"
      class="cm-acc-trigger"
      data-action="toggle-conversations"
      aria-expanded="${isOpen}"
    >
      <span class="cm-acc-left">
        ${renderChevronSvg(isOpen)}
        <span class="cm-acc-title">${escapeHtml(t.conversationsTitle)}</span>
      </span>
      <span class="cm-acc-count tabular-nums">${conversations.length}</span>
    </button>
  `;

  if (!isOpen) {
    return `<div class="cm-acc-item" data-accordion-section="conversations">${triggerHtml}</div>`;
  }

  const q = searchQuery.trim().toLowerCase();
  const filtered = q
    ? conversations.filter(
        (c) =>
          c.title.toLowerCase().includes(q) ||
          c.model.toLowerCase().includes(q) ||
          (c.summary?.toLowerCase().includes(q) ?? false),
      )
    : conversations;

  const listHtml =
    filtered.length === 0
      ? `<div class="cm-empty-msg">${escapeHtml(t.noConversations)}</div>`
      : filtered
          .map((conv) => {
            const isActive = conv.id === activeId;
            const isRunning = conv.runState === 'RUN_STATE_RUNNING';
            const pct = Math.max(0, Math.min(100, conv.usedPercent));
            return `
              <button
                type="button"
                class="cm-conv-item ${isActive ? 'is-active' : ''}"
                data-select-conversation="${escapeHtml(conv.id)}"
              >
                <span class="cm-conv-top">
                  <span class="cm-run-dot ${isRunning ? 'is-running' : ''}" aria-hidden="true"></span>
                  <span class="cm-conv-title">${escapeHtml(conv.title || conv.id)}</span>
                </span>
                <span class="cm-conv-meta">
                  <span class="cm-conv-model">${escapeHtml(conv.model)}</span>
                  <span class="tabular-nums">${escapeHtml(formatHeadlinePercent(pct, locale))}</span>
                </span>
                <span class="cm-conv-minibar" aria-hidden="true">
                  <span class="cm-conv-minibar-fill" style="width:${pct.toFixed(1)}%"></span>
                </span>
              </button>
            `;
          })
          .join('');

  return `
    <div class="cm-acc-item" data-accordion-section="conversations">
      ${triggerHtml}
      <div class="cm-acc-body">
        <input
          type="search"
          class="cm-acc-search"
          data-sidebar-search
          value="${escapeHtml(searchQuery)}"
          placeholder="${escapeHtml(t.conversationsSearchPlaceholder)}"
          aria-label="${escapeHtml(t.conversationsSearchPlaceholder)}"
        />
        <div class="cm-conv-list">${listHtml}</div>
      </div>
    </div>
  `;
}
