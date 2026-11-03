/** Bound the JSON-RPC envelope before parsing, independently of transport headers. */
export const MCP_MAX_JSON_BODY_BYTES = 32 * 1024 * 1024;

export class McpBodyTooLarge extends Error {}

export async function readMcpJsonBody(request: Request): Promise<unknown> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MCP_MAX_JSON_BODY_BYTES) {
    void request.body?.cancel().catch(() => undefined);
    throw new McpBodyTooLarge();
  }
  const reader = request.body?.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  if (reader !== undefined) {
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > MCP_MAX_JSON_BODY_BYTES) {
          void reader.cancel().catch(() => undefined);
          throw new McpBodyTooLarge();
        }
        text += decoder.decode(part.value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      reader.releaseLock();
    }
  }
  return JSON.parse(text) as unknown;
}
