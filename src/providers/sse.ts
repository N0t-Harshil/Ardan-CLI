// Streaming SSE helper shared by all provider adapters.

export interface SseLine {
  data: string;
}

/** Reads an HTTP body as Server-Sent-Events data payloads. */
export async function* streamSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineAt: number;
    while ((newlineAt = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineAt).replace(/\r$/, '');
      buffer = buffer.slice(newlineAt + 1);
      if (!line) continue;
      if (line.startsWith(':')) continue; // comment / keep-alive
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      yield payload;
    }
  }
  // remainder without trailing newline
  if (buffer.startsWith('data:')) {
    const payload = buffer.slice(5).trim();
    if (payload && payload !== '[DONE]') yield payload;
  }
}

/** Reads an HTTP error body as readable text (clipped). */
export async function readErrorBody(
  response: Response,
  limit = 400,
): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, limit);
  } catch {
    return `<status ${response.status}>`;
  }
}

export function jsonAppend(
  target: string | undefined,
  delta: string,
): string {
  return (target || '') + delta;
}
