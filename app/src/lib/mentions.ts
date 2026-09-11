import type { Mention } from '@mcp-zeromem/shared';

export interface TextSpan {
  text: string;
  mention: Mention | null;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Cut a turn's text into plain and mentioned spans. Mention offsets are
 * UTF-8 byte offsets from the engine, so the split happens on the encoded
 * bytes and each piece is decoded back. Overlapping mentions are resolved
 * first-wins, in start order.
 */
export function splitMentions(text: string, mentions: Mention[]): TextSpan[] {
  if (mentions.length === 0) {
    return [{ text, mention: null }];
  }
  const bytes = encoder.encode(text);
  const spans: TextSpan[] = [];
  let cursor = 0;
  const ordered = [...mentions].sort((a, b) => a.start - b.start || b.end - a.end);
  for (const mention of ordered) {
    const start = Math.min(bytes.length, mention.start);
    const end = Math.min(bytes.length, mention.end);
    if (start < cursor || end <= start) {
      continue;
    }
    if (start > cursor) {
      spans.push({ text: decoder.decode(bytes.subarray(cursor, start)), mention: null });
    }
    spans.push({ text: decoder.decode(bytes.subarray(start, end)), mention });
    cursor = end;
  }
  if (cursor < bytes.length) {
    spans.push({ text: decoder.decode(bytes.subarray(cursor)), mention: null });
  }
  return spans;
}
