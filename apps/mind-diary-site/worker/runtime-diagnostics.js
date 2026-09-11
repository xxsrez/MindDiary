import { AsyncLocalStorage } from "node:async_hooks";

const STAGES = new Set(["request", "operation", "queue", "d1", "recovery"]);
const OPERATIONS = new Set(["web", "mcp", "maintenance", "metadata", "read", "mutation", "transaction", "read_session", "bounded", "append", "readback", "request"]);
const PHASES = new Set(["start", "end", "failed", "timeout", "canceled", "suppressed"]);
const TIMEOUTS = new Set(["metadata_queue_timeout", "metadata_d1_timeout", "request_timeout", "recovery_deadline_exceeded"]);
const opaque = (value) => typeof value === "string" && /^[0-9a-f-]{36}$/u.test(value) ? value : null;

export class RuntimeDiagnostics {
  #context = new AsyncLocalStorage();
  #write;
  #writing = false;

  constructor({ write = (line) => console.log(line) } = {}) { this.#write = write; }

  #emit(context, stage, operation, phase, elapsed = 0) {
    if (!context || this.#writing) return;
    const root = context.root;
    if (root.count >= 96) {
      if (root.suppressed) return;
      root.suppressed = true;
      phase = "suppressed";
    }
    root.count += 1;
    const line = JSON.stringify({
      event: "mind-diary.wait-trace", schema: 1,
      trace_id: root.id, span_id: context.span, parent_span_id: context.parent,
      runtime_generation: opaque(context.generation ?? root.generation),
      blocked_by_trace_id: opaque(context.blockedBy?.traceId),
      blocked_by_span_id: opaque(context.blockedBy?.spanId),
      stage: STAGES.has(stage) ? stage : "operation",
      operation: OPERATIONS.has(operation) ? operation : "metadata",
      phase: PHASES.has(phase) ? phase : "failed",
      elapsed_ms: Number.isFinite(elapsed) ? Math.min(86_400_000, Math.max(0, Math.round(elapsed))) : 0,
      late: root.closed,
    });
    this.#writing = true;
    try { this.#write(line); } catch { /* Diagnostics cannot change product outcomes. */ }
    finally { this.#writing = false; }
  }

  runRequest(request, work) {
    const path = new URL(request.url).pathname;
    const operation = path === "/api/v1/internal/operators/recovery" ? "maintenance"
      : path.startsWith("/api/mcp") ? "mcp" : "web";
    const root = { id: crypto.randomUUID(), count: 0, suppressed: false, closed: false, generation: null };
    return this.#context.run({ root, span: null, parent: null }, async () => {
      try {
        const result = await this.observe("request", operation, work);
        if (result instanceof Response) {
          try { result.headers.set("x-mind-diary-wait-trace-id", root.id); } catch { /* Immutable responses remain unchanged. */ }
        }
        return result;
      }
      finally { root.closed = true; }
    });
  }

  bindRuntime(generation) {
    const context = this.#context.getStore();
    if (context) context.root.generation = generation;
  }

  expire(code) {
    this.#expire(this.#context.getStore(), code);
  }

  expirationHandler() {
    const context = this.#context.getStore();
    return (code) => this.#expire(context, code);
  }

  #expire(context, code) {
    this.#emit(context, "request", "request", code === "request_canceled" ? "canceled" : "timeout");
    if (context) context.root.closed = true;
  }

  forRuntime(generation) {
    return {
      observe: (stage, operation, work, blockedBy) => this.observe(stage, operation, work, generation, blockedBy),
      current: () => {
        const context = this.#context.getStore();
        return context?.span ? { traceId: context.root.id, spanId: context.span } : undefined;
      },
    };
  }

  async observe(stage, operation, work, generation, blockedBy) {
    const parent = this.#context.getStore();
    if (!parent) return work();
    const context = { ...parent, span: crypto.randomUUID(), parent: parent.span, blockedBy,
      ...(generation === undefined ? {} : { generation }) };
    const started = performance.now();
    this.#emit(context, stage, operation, "start");
    return this.#context.run(context, async () => {
      try {
        const value = await work();
        this.#emit(context, stage, operation, "end", performance.now() - started);
        return value;
      } catch (error) {
        this.#emit(context, stage, operation, TIMEOUTS.has(error?.code) ? "timeout" : "failed", performance.now() - started);
        throw error;
      }
    });
  }
}
