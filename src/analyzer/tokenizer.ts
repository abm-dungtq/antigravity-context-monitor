export type TextKind = 'prose' | 'code' | 'json';

const SAMPLE_LIMIT = 4096;

function isVietnameseDiacritic(code: number): boolean {
  // Latin Extended Additional (Vietnamese stacked diacritics) and đ/Đ, ă/Ă, ơ/Ơ, ư/Ư
  if (code >= 0x1e00 && code <= 0x1eff) return true;
  if (code === 0x0110 || code === 0x0111) return true; // Đ, đ
  if (code === 0x0102 || code === 0x0103) return true; // Ă, ă
  if (code === 0x01a0 || code === 0x01a1) return true; // Ơ, ơ
  if (code === 0x01af || code === 0x01b0) return true; // Ư, ư
  return false;
}

function isExtendedLatin(code: number): boolean {
  return code >= 0x00c0 && code <= 0x024f;
}

function isCjkOrSymbol(code: number): boolean {
  return code >= 0x2e80;
}

/**
 * Fast, dependency-free token estimator calibrated for Vietnamese diacritics,
 * English prose, JSON schemas, and source code.
 */
export function estimateTokens(text: string, kind?: TextKind): number {
  if (!text || text.length === 0) {
    return 0;
  }

  const len = text.length;
  const sampleLen = Math.min(len, SAMPLE_LIMIT);

  let nonAsciiLatin = 0;
  let vietnameseSpecific = 0;
  let cjkCount = 0;
  let codePunct = 0;

  for (let i = 0; i < sampleLen; i++) {
    const code = text.charCodeAt(i);
    if (isVietnameseDiacritic(code)) {
      vietnameseSpecific++;
      nonAsciiLatin++;
    } else if (isExtendedLatin(code)) {
      nonAsciiLatin++;
    } else if (isCjkOrSymbol(code)) {
      cjkCount++;
    } else if (
      code === 0x7b || // {
      code === 0x7d || // }
      code === 0x5b || // [
      code === 0x5d || // ]
      code === 0x3a || // :
      code === 0x3b || // ;
      code === 0x3d || // =
      code === 0x3c || // <
      code === 0x3e || // >
      code === 0x22 // "
    ) {
      codePunct++;
    }
  }

  const cjkRatio = cjkCount / sampleLen;
  const viRatio = nonAsciiLatin / sampleLen;
  const punctRatio = codePunct / sampleLen;

  let resolvedKind = kind;
  if (!resolvedKind) {
    const trimmed = text.slice(0, 64).trimStart();
    if (
      (trimmed.startsWith('{') || trimmed.startsWith('[')) &&
      punctRatio >= 0.06
    ) {
      resolvedKind = 'json';
    } else if (punctRatio >= 0.08) {
      resolvedKind = 'code';
    } else {
      resolvedKind = 'prose';
    }
  }

  let charsPerToken: number;

  if (resolvedKind === 'json') {
    // JSON schemas/objects average ~3.2-3.4 chars/token; slightly denser with Vietnamese strings
    charsPerToken = vietnameseSpecific > 0 ? 3.1 : 3.3;
  } else if (resolvedKind === 'code') {
    charsPerToken = vietnameseSpecific > 0 ? 3.2 : 3.4;
  } else {
    // Prose: Vietnamese averages ~2.6-3.2 chars/token; English averages ~3.8-4.0 chars/token
    if (vietnameseSpecific > 0 || viRatio >= 0.03) {
      const viWeight = Math.min(1, viRatio / 0.12 + (vietnameseSpecific > 0 ? 0.35 : 0));
      charsPerToken = 3.9 - viWeight * 1.05; // blends smoothly from 3.9 down to ~2.85
      charsPerToken = Math.max(2.7, Math.min(3.15, charsPerToken));
    } else {
      charsPerToken = 3.9;
    }
  }

  if (cjkRatio > 0.15) {
    charsPerToken = Math.max(1.5, charsPerToken * (1 - cjkRatio * 0.55));
  }

  return Math.max(1, Math.round(len / charsPerToken));
}
