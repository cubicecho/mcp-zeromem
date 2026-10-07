import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { z } from 'zod';

/**
 * The one request the curator agent makes of a model: an OpenAI-compatible
 * `chat/completions` call with tools. Lemonade, llama.cpp, Ollama and vLLM all
 * serve it, which is the point: the curator is whatever model the operator
 * already runs. The answer eval makes the same request of the model under test.
 */

export interface LlmConfig {
  /** Base URL up to and including the version, e.g. `http://framework.lan:13305/api/v1`. */
  url: string;
  model: string;
  apiKey: string | null;
  /** A local model reads a long playbook slowly; this is per request, not per run. */
  timeoutMs: number;
  /** Cap on one reply, reasoning included. Unset leaves it to the server. */
  maxTokens?: number;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: unknown };
}

export interface Completion {
  /** The assistant turn, ready to append to the conversation. */
  message: Extract<ChatMessage, { role: 'assistant' }>;
  promptTokens: number;
  completionTokens: number;
  /** The reply stopped at the token cap, not because the model was done. */
  truncated: boolean;
}

const responseSchema = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullish(),
        message: z.object({
          content: z.string().nullish(),
          tool_calls: z
            .array(
              z.object({
                id: z.string().nullish(),
                function: z.object({
                  name: z.string(),
                  // Some servers hand the arguments back already parsed.
                  arguments: z.union([z.string(), z.record(z.unknown())]).nullish(),
                }),
              }),
            )
            .nullish(),
        }),
      }),
    )
    .min(1),
  usage: z.object({ prompt_tokens: z.number().nullish(), completion_tokens: z.number().nullish() }).nullish(),
});

/** A reasoning model's scratch work, when the server leaves it in the content. */
const THINKING = /<think>[\s\S]*?<\/think>/g;

export async function complete(
  llm: LlmConfig,
  messages: readonly ChatMessage[],
  tools: readonly ToolSpec[],
): Promise<Completion> {
  const endpoint = `${llm.url.replace(/\/+$/, '')}/chat/completions`;
  let status: number;
  let body: string;
  try {
    ({ status, body } = await post(
      endpoint,
      llm.apiKey,
      JSON.stringify({
        model: llm.model,
        messages,
        ...(tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
        // Curation is judgement against written rules, not invention.
        temperature: 0,
        stream: false,
        ...(llm.maxTokens === undefined ? {} : { max_tokens: llm.maxTokens }),
      }),
      llm.timeoutMs,
    ));
  } catch (err) {
    throw new Error(`model at ${endpoint} did not answer`, { cause: err });
  }
  if (status < 200 || status >= 300) {
    throw new Error(`model at ${endpoint} answered ${status}: ${body.slice(0, 500)}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch (err) {
    throw new Error(`model at ${endpoint} did not answer in JSON: ${body.slice(0, 200)}`, { cause: err });
  }
  const parsed = responseSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`model at ${endpoint} answered in an unexpected shape: ${parsed.error.message}`);
  }
  const [choice] = parsed.data.choices;
  const raw = choice?.message;
  const toolCalls: ToolCall[] = (raw?.tool_calls ?? []).map((call, index) => ({
    id: call.id ?? `call_${index}`,
    type: 'function',
    function: {
      name: call.function.name,
      arguments:
        typeof call.function.arguments === 'string'
          ? call.function.arguments
          : JSON.stringify(call.function.arguments ?? {}),
    },
  }));
  const content = raw?.content?.replace(THINKING, '').trim() ?? '';
  return {
    message: {
      role: 'assistant',
      content: content === '' && toolCalls.length > 0 ? null : content,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    },
    promptTokens: parsed.data.usage?.prompt_tokens ?? 0,
    completionTokens: parsed.data.usage?.completion_tokens ?? 0,
    truncated: choice?.finish_reason === 'length',
  };
}

/**
 * One POST with one deadline. Not `fetch`: Node's gives up after five minutes
 * without response headers whatever signal it is handed, and a local model
 * answering without streaming sends its headers only when it has finished.
 */
function post(
  endpoint: string,
  apiKey: string | null,
  payload: string,
  timeoutMs: number,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint);
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        signal: AbortSignal.timeout(timeoutMs),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}
