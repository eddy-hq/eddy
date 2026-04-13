import { config } from './config';
import { logger } from './logger';
import { GuardError } from './errors';

interface OllamaGenerateRequest {
  model: string;
  prompt: string;
  stream: boolean;
}

interface OllamaGenerateResponse {
  response: string;
  done: boolean;
}

interface OllamaTagsResponse {
  models: Array<{ name: string }>;
}

export async function ollamaGenerate(
  prompt: string,
  model = config.OLLAMA_GUARD_MODEL
): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`${config.OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, stream: false } satisfies OllamaGenerateRequest),
    });
  } catch (err) {
    throw new GuardError(`Ollama unreachable: ${String(err)}`);
  }

  if (!response.ok) {
    throw new GuardError(`Ollama returned ${response.status}: ${await response.text()}`);
  }

  const data = (await response.json()) as OllamaGenerateResponse;
  return data.response;
}

export async function ollamaHealthCheck(): Promise<{ ok: boolean; models: string[] }> {
  try {
    const response = await fetch(`${config.OLLAMA_URL}/api/tags`);
    if (!response.ok) return { ok: false, models: [] };
    const data = (await response.json()) as OllamaTagsResponse;
    const models = data.models.map((m) => m.name);
    const guardModelPresent = models.some((m) => m.startsWith(config.OLLAMA_GUARD_MODEL));
    if (!guardModelPresent) {
      logger.warn({ model: config.OLLAMA_GUARD_MODEL }, 'Guard model not found in Ollama');
    }
    return { ok: true, models };
  } catch {
    return { ok: false, models: [] };
  }
}
