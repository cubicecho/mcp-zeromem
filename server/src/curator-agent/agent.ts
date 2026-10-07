import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { errorChainMessage } from '../errors.ts';
import { type ChatMessage, complete, type LlmConfig, type ToolCall, type ToolSpec } from './llm.ts';

/**
 * A curation run driven by a local model.
 *
 * The server runs no agent and still does not: this is an MCP client like any
 * other curator. It fetches one of the curator prompts, hands it to an
 * OpenAI-compatible model as its task, and relays the model's tool calls to the
 * `zeromem_curate_*` tools until the model stops calling them. Every rule the
 * model follows is in the prompt the server serves; nothing here knows what a
 * duplicate is.
 */

export interface AgentOptions {
  /** A connected client whose listing includes the curator tools. */
  client: Client;
  llm: LlmConfig;
  prompt: { name: string; args?: Record<string, string> };
  /** Model requests at most; a run that needs more is reported as unfinished. */
  maxSteps?: number;
  /** Longest tool result handed to the model, in characters, before it is cut and marked. */
  maxToolChars?: number;
  /** Size of the conversation, in characters, past which the oldest tool results are dropped. */
  maxContextChars?: number;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface AgentReport {
  /** The model's closing reply. */
  summary: string;
  /** The model stopped calling tools on its own, inside `maxSteps`. */
  finished: boolean;
  /** A `run_end` was applied, so the next run starts where this one ended. */
  closed: boolean;
  steps: number;
  tool_calls: Record<string, number>;
  tool_errors: number;
  prompt_tokens: number;
  completion_tokens: number;
}

const DEFAULTS = { maxSteps: 40, maxToolChars: 12_000, maxContextChars: 120_000 };

/** What a curator may call: its own tools, plus the two reads the playbook sends it to. */
const ALSO_SERVED = new Set(['zeromem_read_session', 'zeromem_recall']);
const APPLY = 'zeromem_curate_apply';

const DROPPED = '[dropped to keep the conversation inside the context window; call the tool again if you need it]';

const NOT_CLOSED = [
  'The run is not closed. Call zeromem_curate_apply with the same run_id and',
  'actions: [{"op": "run_end", "summary": "..."}], then reply with the summary.',
].join(' ');

export async function runCurator(options: AgentOptions): Promise<AgentReport> {
  const { client, llm, prompt } = options;
  const maxSteps = options.maxSteps ?? DEFAULTS.maxSteps;
  const maxToolChars = options.maxToolChars ?? DEFAULTS.maxToolChars;
  const maxContextChars = options.maxContextChars ?? DEFAULTS.maxContextChars;
  const log = options.log ?? (() => {});
  const now = (options.now ?? (() => new Date()))();

  const listing = await client.listTools();
  const tools: ToolSpec[] = listing.tools
    .filter((tool) => tool.name.startsWith('zeromem_curate_') || ALSO_SERVED.has(tool.name))
    .map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description ?? '', parameters: tool.inputSchema },
    }));
  if (!tools.some((tool) => tool.function.name.startsWith('zeromem_curate_'))) {
    throw new Error(
      'the server did not list the curator tools: connect with the curator token, or turn on "expose to every client"',
    );
  }
  const canApply = tools.some((tool) => tool.function.name === APPLY);

  const served = await client.getPrompt({ name: prompt.name, arguments: prompt.args ?? {} });
  const task = served.messages.map((m) => (m.content.type === 'text' ? m.content.text : '')).join('\n\n');

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: [
        'You are the curator of a zeromem memory store. The user message is your procedure: follow it with the tools.',
        `The time is ${now.toISOString()} (UTC).`,
        'Act by calling tools, not by describing calls. Turn ids are numbers taken from tool results; never invent one.',
        'When the procedure is complete, stop calling tools and reply with your summary.',
      ].join(' '),
    },
    { role: 'user', content: task },
  ];

  const report: AgentReport = {
    summary: '',
    finished: false,
    closed: false,
    steps: 0,
    tool_calls: {},
    tool_errors: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
  };
  let nudged = false;

  while (report.steps < maxSteps) {
    trim(messages, maxContextChars);
    const completion = await complete(llm, messages, tools);
    report.steps += 1;
    report.prompt_tokens += completion.promptTokens;
    report.completion_tokens += completion.completionTokens;
    messages.push(completion.message);

    const calls = completion.message.tool_calls ?? [];
    if (calls.length === 0) {
      report.summary = completion.message.content ?? '';
      // A run left open makes the next one start from the same cursor; ask once.
      if (canApply && !report.closed && !nudged) {
        nudged = true;
        log('model stopped without closing the run; asking it to');
        messages.push({ role: 'user', content: NOT_CLOSED });
        continue;
      }
      report.finished = true;
      break;
    }

    for (const call of calls) {
      const name = call.function.name;
      report.tool_calls[name] = (report.tool_calls[name] ?? 0) + 1;
      const outcome = await relay(client, call, tools);
      if (outcome.isError) {
        report.tool_errors += 1;
      } else if (name === APPLY && closesRun(outcome.args)) {
        report.closed = true;
      }
      log(`${name} ${summarise(outcome.args)}${outcome.isError ? ` → error: ${outcome.text.slice(0, 200)}` : ''}`);
      messages.push({ role: 'tool', tool_call_id: call.id, content: clip(outcome.text, maxToolChars) });
    }
  }

  if (!report.finished) {
    log(`stopped after ${report.steps} model requests without a closing reply`);
  }
  return report;
}

export interface Outcome {
  args: Record<string, unknown>;
  text: string;
  isError: boolean;
}

/** Run one tool call. Whatever goes wrong is an answer the model can read and correct. */
export async function relay(client: Client, call: ToolCall, tools: readonly ToolSpec[]): Promise<Outcome> {
  const name = call.function.name;
  if (!tools.some((tool) => tool.function.name === name)) {
    return { args: {}, text: `There is no tool named ${name}.`, isError: true };
  }
  let args: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(call.function.arguments || '{}');
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('expected a JSON object');
    }
    args = parsed as Record<string, unknown>;
  } catch (err) {
    return { args: {}, text: `The arguments were not a JSON object: ${errorChainMessage(err)}`, isError: true };
  }
  try {
    const result = await client.callTool({ name, arguments: args });
    const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
    const text = content.map((part) => (part.type === 'text' ? (part.text ?? '') : '')).join('\n');
    return { args, text, isError: result.isError === true };
  } catch (err) {
    // The SDK throws on arguments the tool's schema rejects.
    return { args, text: errorChainMessage(err), isError: true };
  }
}

function closesRun(args: Record<string, unknown>): boolean {
  if (args.dry_run === true || !Array.isArray(args.actions)) {
    return false;
  }
  return args.actions.some((action) => (action as { op?: unknown } | null)?.op === 'run_end');
}

/** The call in one log line: which ops for an apply, the arguments otherwise. */
function summarise(args: Record<string, unknown>): string {
  if (Array.isArray(args.actions)) {
    const ops = args.actions.map((action) => String((action as { op?: unknown } | null)?.op ?? '?'));
    return `${args.dry_run === true ? 'dry run ' : ''}[${ops.join(', ')}]`;
  }
  const text = JSON.stringify(args);
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

/**
 * Cut a long result and say so, with what to do about it: an unmarked cut reads
 * as "that is everything", and the model curates half a page as if it were whole.
 */
export function clip(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}\n… [clipped: ${limit} of ${text.length} characters — ask for less at a time: a smaller limit, fewer turn_ids]`;
}

/** Drop the oldest tool results until the conversation fits; the calls that produced them stay. */
function trim(messages: ChatMessage[], maxChars: number): void {
  let total = messages.reduce((sum, m) => sum + size(m), 0);
  for (const message of messages) {
    if (total <= maxChars) {
      return;
    }
    if (message.role === 'tool' && message.content !== DROPPED) {
      total -= message.content.length - DROPPED.length;
      message.content = DROPPED;
    }
  }
}

function size(message: ChatMessage): number {
  const calls = message.role === 'assistant' ? (message.tool_calls ?? []) : [];
  return (message.content?.length ?? 0) + calls.reduce((sum, call) => sum + call.function.arguments.length, 0);
}
