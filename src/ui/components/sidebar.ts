import type { ConversationSummary, Locale } from '../../shared/types.js';
import { formatHeadlinePercent, type Translations } from '../i18n.js';
import { escapeHtml } from '../utils/dom.js';

export interface SidebarProps {
  conversations: ConversationSummary[];
  activeId: string;
  searchQuery: string;
  locale: Locale;
  t: Translations;
}

export function renderConversationSidebar(props: SidebarProps): string {
  const { conversations, activeId, searchQuery, locale, t } = props;
  if (conversations.length === 0) return '';

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
    <aside class="cm-sidebar" aria-label="${escapeHtml(t.conversationsTitle)}">
      <div class="cm-sidebar-header">
        <span>${escapeHtml(t.conversationsTitle)}</span>
        <span class="tabular-nums">${conversations.length}</span>
      </div>
      <input
        type="search"
        class="cm-sidebar-search"
        data-sidebar-search
        value="${escapeHtml(searchQuery)}"
        placeholder="${escapeHtml(t.conversationsSearchPlaceholder)}"
        aria-label="${escapeHtml(t.conversationsSearchPlaceholder)}"
      />
      <div class="cm-sidebar-list">${listHtml}</div>
    </aside>
  `;
}

export function renderNarrowConversationSelect(
  conversations: ConversationSummary[],
  activeId: string,
): string {
  if (conversations.length <= 1) return '';

  const options = conversations
    .map((conv) => {
      const selected = conv.id === activeId ? 'selected' : '';
      const label = conv.title || conv.id;
      return `<option value="${escapeHtml(conv.id)}" ${selected}>${escapeHtml(label)}</option>`;
    })
    .join('');

  return `<select class="cm-narrow-switcher" data-narrow-conversation aria-label="Conversation">${options}</select>`;
}
