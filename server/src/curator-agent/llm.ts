import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type OpenAI from 'openai';

/**
 * The model the curator and the answer eval talk to: any OpenAI-compatible
 * `chat/completions` endpoint with tools. Lemonade, llama.cpp, Ollama and vLLM
 * all serve it, which is the point: the curator is whatever model the operator
 * already runs. The request, the stream and the tool loop are agent-core's;
 * what is here is how this repo's environment names one.
 */

export interface LlmConfig {
  /** Base URL up to and including the version, e.g. `http://framework.lan:13305/api/v1`. */
  url: string;
  model: string;
  apiKey: string | null;
  /**
   * How long the endpoint may go quiet: before the first token, between two
   * tokens, and for the whole of a reply that is not streamed. A local model
   * reads a long playbook slowly, so it is generous.
   */
  timeoutMs: number;
  /** Cap on one reply, reasoning included. Unset leaves it to the server. */
  maxTokens?: number;
}

export type ToolSpec = OpenAI.ChatCompletionFunctionTool;

/** The endpoint half of agent-core's config, as both the loop and a side task read it. */
export function endpointOf(llm: LlmConfig) {
  const seconds = llm.timeoutMs / 1000;
  return {
    baseUrl: llm.url,
    // Empty is agent-core's "no key": no Authorization header, and no reaching for $OPENAI_API_KEY.
    apiKey: llm.apiKey ?? '',
    requestTimeoutSeconds: seconds,
    // The first wait is prefill, and the one this used to be the whole request's deadline for;
    // agent-core would otherwise allow it five times the silence.
    firstTokenSeconds: seconds,
  };
}

/** What `runAgentLoop` takes as its config: the endpoint, the model, and the step budget. */
export function loopConfig(llm: LlmConfig, maxSteps: number) {
  return {
    ...endpointOf(llm),
    model: llm.model,
    maxTokens: llm.maxTokens ?? 0,
    // Curation and answering from memory are judgement against what is written, not invention.
    temperature: 0,
    maxToolIterations: maxSteps,
  };
}

/** The server's tools whose names pass `keep`, as function tools for the model. */
export async function toolSpecs(client: Client, keep: (name: string) => boolean): Promise<ToolSpec[]> {
  const listing = await client.listTools();
  return listing.tools
    .filter((tool) => keep(tool.name))
    .map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description ?? '',
        parameters: tool.inputSchema as Record<string, unknown>,
      },
    }));
}
