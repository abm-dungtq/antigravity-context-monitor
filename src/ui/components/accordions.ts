import type { ContextSnapshot, DetailItem, Locale } from '../../shared/types.js';
import { formatTokens, type Translations } from '../i18n.js';
import { escapeHtml, renderChevronSvg } from '../utils/dom.js';

export type AccordionKey = keyof ContextSnapshot['accordions'];

export interface AccordionsProps {
  accordions: ContextSnapshot['accordions'];
  openAccordions: Set<AccordionKey>;
  searchQueries: Record<AccordionKey, string>;
  locale: Locale;
  t: Translations;
  extraBottomHtml?: string;
}

const ACCORDION_ORDER: AccordionKey[] = [
  'mcpTools',
  'memoryFiles',
  'skills',
  'customAgents',
  'turnMessages',
];

function filterAndSortItems(
  items: DetailItem[],
  query: string,
): DetailItem[] {
  const normalized = query.trim().toLowerCase();
  const filtered = normalized
    ? items.filter(
        (item) =>
          item.name.toLowerCase().includes(normalized) ||
          (item.sublabel?.toLowerCase().includes(normalized) ?? false) ||
          (item.group?.toLowerCase().includes(normalized) ?? false) ||
          (item.path?.toLowerCase().includes(normalized) ?? false),
      )
    : items;

  return [...filtered].sort((a, b) => b.tokens - a.tokens);
}

export function renderAccordions(props: AccordionsProps): string {
  const { accordions, openAccordions, searchQueries, locale, t, extraBottomHtml } = props;

  const blocks = ACCORDION_ORDER.map((key) => {
    const rawItems = accordions[key] ?? [];
    const isOpen = openAccordions.has(key);
    const title = t.accordions[key];
    const query = searchQueries[key] ?? '';

    const triggerHtml = `
      <button
        type="button"
        class="cm-acc-trigger"
        data-accordion-toggle="${key}"
        aria-expanded="${isOpen}"
      >
        <span class="cm-acc-left">
          ${renderChevronSvg(isOpen)}
          <span class="cm-acc-title">${escapeHtml(title)}</span>
        </span>
        <span class="cm-acc-count tabular-nums">${rawItems.length}</span>
      </button>
    `;

    if (!isOpen) {
      return `<div class="cm-acc-item" data-accordion-section="${key}">${triggerHtml}</div>`;
    }

    const items = filterAndSortItems(rawItems, query);
    const showSearch = rawItems.length > 8;

    const searchHtml = showSearch
      ? `<input
          type="search"
          class="cm-acc-search"
          data-accordion-search="${key}"
          value="${escapeHtml(query)}"
          placeholder="${escapeHtml(t.searchPlaceholder)}"
          aria-label="${escapeHtml(title)}"
        />`
      : '';

    const rowsHtml =
      items.length === 0
        ? `<div class="cm-empty-msg">${escapeHtml(t.noItems)}</div>`
        : items
            .map((item) => {
              const sub = item.sublabel || item.group || '';
              const statusLabel = item.status ? t.statusLabels[item.status] ?? item.status : '';
              const statusClass = item.status === 'loaded' || item.status === 'active' ? 'is-loaded' : '';
              const hasPath = Boolean(item.path);
              const tag = hasPath ? 'button' : 'div';
              const attrs = hasPath
                ? `type="button" data-open-path="${escapeHtml(item.path!)}" title="${escapeHtml(item.path!)}"`
                : item.path
                  ? `title="${escapeHtml(item.path)}"`
                  : '';
              return `
                <${tag} class="cm-acc-row ${hasPath ? 'is-link' : ''}" ${attrs}>
                  <span class="cm-acc-row-main">
                    <span class="cm-acc-row-name-line">
                      <span class="cm-acc-row-name">${escapeHtml(item.name)}</span>
                      ${statusLabel ? `<span class="cm-status-pill ${statusClass}">${escapeHtml(statusLabel)}</span>` : ''}
                    </span>
                    ${sub ? `<span class="cm-acc-row-sub">${escapeHtml(sub)}</span>` : ''}
                  </span>
                  <span class="cm-acc-row-tokens tabular-nums">${escapeHtml(formatTokens(item.tokens, locale))}</span>
                </${tag}>
              `;
            })
            .join('');

    return `
      <div class="cm-acc-item" data-accordion-section="${key}">
        ${triggerHtml}
        <div class="cm-acc-body">
          ${searchHtml}
          <div class="cm-acc-list">${rowsHtml}</div>
        </div>
      </div>
    `;
  }).join('');

  return `<section class="cm-accordions">${blocks}${extraBottomHtml ?? ''}</section>`;
}
