import type { Locale, TurnPoint } from '../../shared/types.js';
import { formatPercent, formatTokenDelta, formatTokens, type Translations } from '../i18n.js';
import { escapeHtml, renderChevronSvg } from '../utils/dom.js';

export interface TurnChartProps {
  turns: TurnPoint[];
  contextLimit: number;
  cacheHitRate: number;
  compactionCount: number;
  isOpen: boolean;
  hoveredTurn: number | null;
  locale: Locale;
  t: Translations;
}

export function renderTurnChartSection(props: TurnChartProps): string {
  const { turns, cacheHitRate, compactionCount, isOpen, hoveredTurn, locale, t } = props;
  if (turns.length === 0) return '';

  const cachePct = Math.round(Math.max(0, Math.min(1, cacheHitRate)) * 100);
  const badgeClass = cachePct >= 70 ? 'is-good' : cachePct >= 40 ? 'is-warn' : 'is-neutral';

  const headerHtml = `
    <button
      type="button"
      class="cm-section-head"
      data-action="toggle-chart"
      aria-expanded="${isOpen}"
    >
      <span class="cm-section-title-wrap">
        ${renderChevronSvg(isOpen)}
        <span class="cm-section-title">${escapeHtml(t.turnGrowthTitle)}</span>
      </span>
      <span class="cm-badge ${badgeClass} tabular-nums">
        ${escapeHtml(t.cacheHitLabel)}: ${cachePct}%
      </span>
    </button>
  `;

  if (!isOpen) {
    return `<section class="cm-section">${headerHtml}</section>`;
  }

  const width = 320;
  const height = 56;
  const padX = 6;
  const padY = 7;
  const plotW = width - padX * 2;
  const plotH = height - padY * 2;

  const maxTokens = Math.max(
    1,
    ...turns.map((pt) => pt.totalTokens),
  );

  const coords = turns.map((pt, idx) => {
    const x =
      turns.length === 1
        ? padX + plotW / 2
        : padX + (idx / (turns.length - 1)) * plotW;
    const ratio = Math.max(0, Math.min(1, pt.totalTokens / maxTokens));
    const y = padY + plotH - ratio * plotH;
    return { x, y, pt };
  });

  const linePoints = coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');
  const areaPoints =
    coords.length > 1
      ? `${coords[0].x.toFixed(1)},${height - padY} ${linePoints} ${coords[coords.length - 1].x.toFixed(1)},${height - padY}`
      : '';

  const compactionMarkers = coords
    .filter((c) => c.pt.isCompaction)
    .map(
      (c) =>
        `<line x1="${c.x.toFixed(1)}" y1="2" x2="${c.x.toFixed(1)}" y2="${height - 2}" stroke="#EA580C" stroke-width="1.2" stroke-dasharray="2.5 2" opacity="0.85" />`,
    )
    .join('');

  const activePoint =
    hoveredTurn !== null
      ? coords.find((c) => c.pt.turn === hoveredTurn) ?? coords[coords.length - 1]
      : coords[coords.length - 1];

  const dotsHtml = coords
    .map(({ x, y, pt }) => {
      const isSelected = activePoint?.pt.turn === pt.turn;
      const fill = pt.isCompaction ? '#EA580C' : '#2563EB';
      const r = isSelected ? 3.8 : pt.isCompaction ? 3.2 : 2.2;
      const titleText = `${t.turnLabel(pt.turn)} · ${formatTokens(pt.totalTokens, locale)} · ${t.cacheHitLabel} ${Math.round(pt.cacheHitRate * 100)}%`;
      return `
        <g data-turn-point="${pt.turn}" style="cursor:pointer">
          <title>${escapeHtml(titleText)}</title>
          <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="8" fill="transparent" />
          <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}" fill="${fill}" stroke="var(--cm-bg-secondary, #f8fafc)" stroke-width="1.2" />
        </g>
      `;
    })
    .join('');

  const infoPt = activePoint.pt;
  const infoLine = `${t.turnLabel(infoPt.turn)} · ${formatTokens(infoPt.totalTokens, locale)} · ${t.cacheHitLabel} ${formatPercent(infoPt.cacheHitRate * 100, locale)} (${formatTokenDelta(infoPt.deltaTokens, locale)})`;

  return `
    <section class="cm-section">
      ${headerHtml}
      <div class="cm-chart-body">
        <svg class="cm-chart-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(t.turnGrowthTitle)}">
          <defs>
            <linearGradient id="cm-turn-area" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#2563EB" stop-opacity="0.22" />
              <stop offset="100%" stop-color="#2563EB" stop-opacity="0.01" />
            </linearGradient>
          </defs>
          <line x1="${padX}" y1="${height - padY}" x2="${width - padX}" y2="${height - padY}" stroke="var(--cm-border-primary, #e2e8f0)" stroke-width="1" />
          ${areaPoints ? `<polygon points="${areaPoints}" fill="url(#cm-turn-area)" />` : ''}
          ${coords.length > 1 ? `<polyline points="${linePoints}" fill="none" stroke="#2563EB" stroke-width="1.75" stroke-linejoin="round" stroke-linecap="round" />` : ''}
          ${compactionMarkers}
          ${dotsHtml}
        </svg>
        <div class="cm-chart-meta tabular-nums">
          <span class="cm-chart-tooltip-text" data-chart-readout>${escapeHtml(infoLine)}</span>
          ${
            infoPt.isCompaction
              ? `<span class="cm-compaction-tag">${escapeHtml(t.compactionBadge)}</span>`
              : compactionCount > 0
                ? `<span class="cm-compaction-tag">${escapeHtml(t.compactionsCount(compactionCount))}</span>`
                : ''
          }
        </div>
      </div>
    </section>
  `;
}
