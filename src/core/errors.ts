/** OpenAI-compatible error body (ADR-0003). */
export interface OpenAiErrorBody {
  error: { message: string; type: string; code: string | null };
}

export function openAiError(message: string, type: string, code: string | null): OpenAiErrorBody {
  return { error: { message, type, code } };
}
