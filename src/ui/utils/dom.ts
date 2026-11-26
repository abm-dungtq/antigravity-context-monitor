export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Safely encodes a local filesystem path as a `file://` URI, escaping spaces,
 * `#`, `%`, and non-ASCII characters while preserving path separators and Windows drive letters.
 */
export function toEncodedFileUri(filePath: string): string {
  if (filePath.startsWith('file://')) return filePath;
  const normalized = filePath.replaceAll('\\', '/');
  const encodedSegments = normalized.split('/').map((seg, idx) => {
    if (idx === 0 && /^[A-Za-z]:$/.test(seg)) return seg;
    return encodeURIComponent(seg);
  });
  const joined = encodedSegments.join('/');
  return joined.startsWith('/') ? `file://${joined}` : `file:///${joined}`;
}

export async function copyTextWithFallback(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Clipboard API can be blocked in sandboxed iframes; fall back to execCommand.
    }
  }

  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    textarea.style.pointerEvents = 'none';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

export function renderChevronSvg(isOpen: boolean): string {
  return `<svg class="cm-chevron ${isOpen ? 'is-open' : ''}" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M6 3.5L10.5 8L6 12.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

export function renderRefreshSvg(): string {
  return `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M13.5 8a5.5 5.5 0 1 1-1.35-3.61M13.5 2.5v2.75h-2.75" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}
