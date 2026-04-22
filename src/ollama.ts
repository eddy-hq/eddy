import { config } from './config';
import { logger } from './logger';
import { GuardError } from './errors';

interface OllamaOptions {
  temperature?: number;
  num_predict?: number;
}

interface OllamaGenerateRequest {
  model: string;
  prompt: string;
  stream: boolean;
  images?: string[];
  options?: OllamaOptions;
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
  model = config.OLLAMA_GUARD_MODEL,
  images?: string[],
  options?: OllamaOptions,
): Promise<string> {
  let response: Response;
  try {
    const body: OllamaGenerateRequest = { model, prompt, stream: false };
    if (images?.length) body.images = images;
    if (options) body.options = options;
    response = await fetch(`${config.OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
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
