import { describe, expect, it } from 'vitest';
import type { ContextSnapshot, ConversationSummary, TurnPoint } from '../../shared/types.js';
import { renderAccordions } from '../components/accordions.js';
import { renderTurnChartSection } from '../components/chart.js';
import { renderConversationsAccordionItem } from '../components/sidebar.js';
import {
  formatHeadlinePercent,
  formatPercent,
  formatTokenDelta,
  formatTokens,
  getTranslations,
} from '../i18n.js';
import { escapeHtml, toEncodedFileUri } from '../utils/dom.js';

describe('UI formatters & i18n', () => {
  it('formats token counts, deltas, and percentages in VI and EN', () => {
    expect(formatTokens(0, 'vi')).toBe('0');
    expect(formatTokens(999, 'vi')).toBe('999');
    expect(formatTokens(123_600, 'vi')).toBe('123,6 N');
    expect(formatTokens(123_600, 'en')).toBe('123.6K');
    expect(formatTokens(33_000, 'vi')).toBe('33 N');
    expect(formatTokens(33_000, 'en')).toBe('33K');
    expect(formatTokens(999_999, 'vi')).toBe('1 Tr');
    expect(formatTokens(999_999, 'en')).toBe('1M');
    expect(formatTokens(Number.NaN, 'vi')).toBe('0');
    expect(formatTokens(-50, 'en')).toBe('0');

    expect(formatTokenDelta(0, 'vi')).toBe('0');
    expect(formatTokenDelta(18_200, 'vi')).toBe('+18,2 N');
    expect(formatTokenDelta(-45_100, 'en')).toBe('-45.1K');

    expect(formatPercent(8.2, 'vi')).toBe('8,2%');
    expect(formatPercent(12.0, 'en')).toBe('12%');
    expect(formatHeadlinePercent(0.4, 'vi')).toBe('0,4%');
    expect(formatHeadlinePercent(12.4, 'vi')).toBe('12%');
  });

  it('keeps Vietnamese category labels aligned with reference terminology', () => {
    const vi = getTranslations('vi');
    expect(vi.title).toBe('Ngữ cảnh');
    expect(vi.categories.system_prompt).toBe('Câu lệnh hệ thống');
    expect(vi.categories.memory_files).toBe('Tệp bộ nhớ');
    expect(vi.autocompactBuffer).toBe('Vùng đệm tự động thu gọn');
  });
});

describe('UI escaping & file URI encoding', () => {
  it('escapes HTML special characters against XSS', () => {
    expect(escapeHtml(`<script>"alert('x')" &</script>`)).toBe(
      '&lt;script&gt;&quot;alert(&#39;x&#39;)&quot; &amp;&lt;/script&gt;',
    );
  });

  it('encodes spaces, #, %, and Vietnamese diacritics into valid file:// URIs', () => {
    expect(toEncodedFileUri('file:///already/encoded%20path')).toBe(
      'file:///already/encoded%20path',
    );
    expect(toEncodedFileUri('/Users/demo/My Docs/file #1 (100%).md')).toBe(
      'file:///Users/demo/My%20Docs/file%20%231%20(100%25).md',
    );
    expect(toEncodedFileUri('/tmp/Tài liệu/AGENTS.md')).toBe(
      'file:///tmp/T%C3%A0i%20li%E1%BB%87u/AGENTS.md',
    );
    expect(toEncodedFileUri('C:\\Users\\My Name\\file.md')).toBe(
      'file:///C:/Users/My%20Name/file.md',
    );
  });
});

describe('UI component renderers', () => {
  it('renders conversations accordion collapsed by default and filters safely when open', () => {
    const t = getTranslations('vi');
    const conversations: ConversationSummary[] = [
      {
        id: 'conv-1',
        title: 'Antigravity <script>alert(1)</script>',
        model: 'gemini-4-neon-high',
        runState: 'RUN_STATE_RUNNING',
        totalTokens: 120_000,
        contextLimit: 1_000_000,
        usedPercent: 12,
        turns: 4,
        updatedAt: '2026-11-26T07:00:00Z',
      },
      {
        id: 'conv-2',
        title: 'Video Production',
        model: 'claude-sonnet-4',
        runState: 'RUN_STATE_IDLE',
        totalTokens: 50_000,
        contextLimit: 200_000,
        usedPercent: 25,
        turns: 2,
        updatedAt: '2026-11-26T06:00:00Z',
      },
    ];

    const collapsedHtml = renderConversationsAccordionItem({
      conversations,
      activeId: 'conv-1',
      isOpen: false,
      searchQuery: '',
      locale: 'vi',
      t,
    });
    expect(collapsedHtml).toContain('aria-expanded="false"');
    expect(collapsedHtml).not.toContain('cm-conv-list');

    const openHtml = renderConversationsAccordionItem({
      conversations,
      activeId: 'conv-1',
      isOpen: true,
      searchQuery: 'video',
      locale: 'vi',
      t,
    });
    expect(openHtml).toContain('aria-expanded="true"');
    expect(openHtml).toContain('Video Production');
    expect(openHtml).not.toContain('Antigravity');

    const xssHtml = renderConversationsAccordionItem({
      conversations,
      activeId: 'conv-1',
      isOpen: true,
      searchQuery: '',
      locale: 'vi',
      t,
    });
    expect(xssHtml).not.toContain('<script>');
    expect(xssHtml).toContain('&lt;script&gt;');
  });

  it('renders accordions sorted by tokens descending, search threshold >8, and extraBottomHtml', () => {
    const t = getTranslations('vi');
    const skills = Array.from({ length: 10 }, (_, i) => ({
      name: i === 0 ? 'low-skill' : `skill-${i}`,
      path: `/tmp/skill-${i}/SKILL.md`,
      tokens: i === 0 ? 10 : 100 + i * 20,
      status: 'indexed' as const,
    }));

    const accordions: ContextSnapshot['accordions'] = {
      mcpTools: [{ name: '<b>xss</b>', tokens: 500, status: 'lazy' }],
      memoryFiles: [],
      skills,
      customAgents: [],
      turnMessages: [],
    };

    const html = renderAccordions({
      accordions,
      openAccordions: new Set(['skills', 'mcpTools']),
      searchQueries: {
        mcpTools: '',
        memoryFiles: '',
        skills: '',
        customAgents: '',
        turnMessages: '',
      },
      locale: 'vi',
      t,
      extraBottomHtml: '<div data-test="bottom-slot">BOTTOM</div>',
    });

    expect(html).toContain('data-accordion-search="skills"');
    expect(html).not.toContain('data-accordion-search="mcpTools"');
    expect(html).toContain('&lt;b&gt;xss&lt;/b&gt;');
    expect(html).not.toContain('<b>xss</b>');
    expect(html.indexOf('skill-9')).toBeLessThan(html.indexOf('low-skill'));
    expect(html).toContain('data-test="bottom-slot"');
  });

  it('renders turn growth chart with compaction markers and cache hit badges', () => {
    const t = getTranslations('vi');
    expect(
      renderTurnChartSection({
        turns: [],
        contextLimit: 1_000_000,
        cacheHitRate: 0,
        compactionCount: 0,
        isOpen: true,
        hoveredTurn: null,
        locale: 'vi',
        t,
      }),
    ).toBe('');

    const turns: TurnPoint[] = [
      {
        turn: 1,
        stepIndex: 1,
        timestamp: '2026-11-26T01:00:00Z',
        totalTokens: 30_000,
        inputTokens: 30_000,
        cacheReadTokens: 0,
        outputTokens: 300,
        cacheHitRate: 0,
        isCompaction: false,
        deltaTokens: 30_000,
      },
      {
        turn: 2,
        stepIndex: 3,
        timestamp: '2026-11-26T01:05:00Z',
        totalTokens: 18_000,
        inputTokens: 4_000,
        cacheReadTokens: 14_000,
        outputTokens: 200,
        cacheHitRate: 0.78,
        isCompaction: true,
        deltaTokens: -12_000,
      },
    ];

    const chartHtml = renderTurnChartSection({
      turns,
      contextLimit: 1_000_000,
      cacheHitRate: 0.78,
      compactionCount: 1,
      isOpen: true,
      hoveredTurn: null,
      locale: 'vi',
      t,
    });

    expect(chartHtml).toContain('cm-badge is-good');
    expect(chartHtml).toContain('Cache hit: 78%');
    expect(chartHtml).toContain('Thu gọn ngữ cảnh');
    expect(chartHtml).toContain('stroke-dasharray="2.5 2"');
  });
});
