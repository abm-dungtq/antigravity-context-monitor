export const DEFAULT_CONTEXT_LIMIT = 1_000_000;
export const DEFAULT_AUTOCOMPACT_BUFFER_RATIO = 0.033;

export interface ModelContextConfig {
  model: string;
  contextLimit: number;
  bufferRatio: number;
}

/**
 * Resolves the context window limit for a given model identifier, honoring
 * an optional explicit positive window override.
 */
export function getModelContextLimit(
  modelId?: string,
  windowOverride?: number
): number {
  if (
    typeof windowOverride === 'number' &&
    Number.isFinite(windowOverride) &&
    windowOverride > 0
  ) {
    return Math.round(windowOverride);
  }

  const id = (modelId ?? '').trim().toLowerCase();
  if (!id) {
    return DEFAULT_CONTEXT_LIMIT;
  }

  if (
    id.startsWith('gemini-4-') ||
    id.startsWith('gemini-3-') ||
    id.startsWith('gemini-2.5-')
  ) {
    return 1_000_000;
  }

  if (id.startsWith('claude-')) {
    return id.includes('1m') ? 1_000_000 : 200_000;
  }

  if (id.startsWith('gpt-4.1')) {
    return 1_000_000;
  }

  if (
    id.startsWith('gpt-4') ||
    id.startsWith('gpt-5') ||
    id.startsWith('o1') ||
    id.startsWith('o3') ||
    id.startsWith('o4')
  ) {
    return 200_000;
  }

  return DEFAULT_CONTEXT_LIMIT;
}

/**
 * Returns the full context limit and autocompact buffer configuration for a model.
 */
export function getModelContextConfig(
  modelId?: string,
  windowOverride?: number
): ModelContextConfig {
  return {
    model: (modelId ?? '').trim() || 'unknown',
    contextLimit: getModelContextLimit(modelId, windowOverride),
    bufferRatio: DEFAULT_AUTOCOMPACT_BUFFER_RATIO,
  };
}
