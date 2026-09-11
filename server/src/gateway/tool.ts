import type { ZodRawShape } from 'zod';

/**
 * One MCP tool: its schema, its handler, and the annotations clients use to
 * decide what may run without asking.
 *
 * `kind` is the write gate. Read tools are always listed; write tools are
 * dropped from the listing entirely under `ZEROMEM_READ_ONLY` — an agent should
 * never see a tool it cannot call. `destructive` marks the one that deletes.
 */
export interface ToolDefinition<Args extends ZodRawShape = ZodRawShape> {
  name: string;
  title: string;
  description: string;
  /** Zod raw shape; the SDK converts it to JSON Schema and validates calls against it. */
  inputSchema: Args;
  kind: 'read' | 'write';
  /** True for a write that cannot be undone (forgetting a session). */
  destructive?: boolean;
  /**
   * Returns the value to serialize as the tool result; a string is sent as-is.
   * Throwing yields a tool error, not a transport error.
   */
  run: (args: Record<string, unknown>) => Promise<unknown>;
}

/** Build a tool definition, preserving the literal type of its input schema. */
export function defineTool<Args extends ZodRawShape>(definition: ToolDefinition<Args>): ToolDefinition<Args> {
  return definition;
}
