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
  let finished = false;
  try {
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
        if (payload === '[DONE]') {
          // Drain to EOF so the body completes and the connection can be
          // reused; returning mid-body leaves a dangling stream that can
          // crash Node on exit (Windows libuv assertion).
          while (!(await reader.read()).done) { /* discard */ }
          finished = true;
          return;
        }
        yield payload;
      }
    }
    finished = true;
    // remainder without trailing newline
    if (buffer.startsWith('data:')) {
      const payload = buffer.slice(5).trim();
      if (payload && payload !== '[DONE]') yield payload;
    }
  } finally {
    // consumer stopped early (abort, error, break): release the socket
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
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
