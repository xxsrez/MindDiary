interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

interface D1Result<Row = Record<string, unknown>> {
  readonly results?: readonly Row[];
  readonly meta?: { readonly changes?: number };
}

interface D1PreparedStatement {
  bind(...values: readonly unknown[]): D1PreparedStatement;
  run<Row = Record<string, unknown>>(): Promise<D1Result<Row>>;
  all<Row = Record<string, unknown>>(): Promise<D1Result<Row>>;
  first?<Row = Record<string, unknown>>(): Promise<Row | null>;
}

interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch(statements: readonly D1PreparedStatement[]): Promise<readonly D1Result[]>;
}

interface R2ObjectBody {
  readonly key: string;
  readonly size: number;
  readonly etag: string;
  readonly customMetadata?: Readonly<Record<string, string>>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>;
  put(key: string, value: ArrayBuffer | Uint8Array, options?: Readonly<Record<string, unknown>>): Promise<R2ObjectBody | null>;
  delete(key: string | readonly string[]): Promise<void>;
  list(options?: Readonly<Record<string, unknown>>): Promise<{
    readonly objects: readonly R2ObjectBody[];
    readonly truncated: boolean;
    readonly cursor?: string;
  }>;
}

declare module "vinext/server/app-router-entry" {
  const handler: {
    fetch(request: Request, environment: unknown, context: unknown): Promise<Response>;
  };
  export default handler;
}
