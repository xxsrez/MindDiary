import type {
  ExactRevisionIndexDocument,
  ExactRevisionIndexEntry,
  ReadExactRevisionIndexResult,
  ReplaceExactRevisionIndexRequest,
  SearchIndex,
} from "@mind-diary/application-ports";

export const SEARCH_ADAPTER = "memory-exact-revision" as const;
export type SearchAdapterContract = SearchIndex;

function key(spaceId: string, revisionId: string): string {
  return `${spaceId}\u0000${revisionId}`;
}

function cloneDocuments(
  documents: readonly Readonly<ExactRevisionIndexDocument>[],
): readonly Readonly<ExactRevisionIndexDocument>[] {
  return Object.freeze(
    documents.map((document) =>
      Object.freeze({
        path: document.path,
        text: document.text,
        ...(document.sha256 === undefined ? {} : { sha256: document.sha256 }),
        ...(document.fields === undefined ? {} : { fields: document.fields }),
      }),
    ),
  );
}

async function digestText(
  text: string,
): Promise<ExactRevisionIndexEntry["sha256"]> {
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
  return `sha256:${[...digest]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}` as ExactRevisionIndexEntry["sha256"];
}

/** Durable-process fixture whose only lookup key is Space + exact revision. */
export class InMemoryExactRevisionSearchIndex implements SearchIndex {
  readonly kind = "search-index" as const;
  readonly #revisions = new Map<
    string,
    {
      readonly spaceId: ReplaceExactRevisionIndexRequest["spaceId"];
      readonly revisionId: ReplaceExactRevisionIndexRequest["revisionId"];
      readonly documents: readonly Readonly<ExactRevisionIndexDocument>[];
    }
  >();
  readonly #documents = new Map<string, Readonly<ExactRevisionIndexDocument>>();
  #nextFailure: Error | null = null;

  async findMissingDigests(
    spaceId: ReplaceExactRevisionIndexRequest["spaceId"],
    digests: readonly ExactRevisionIndexEntry["sha256"][],
  ) {
    return Object.freeze([...new Set(digests)].filter(
      (digest) => !this.#documents.has(`${spaceId}\u0000${digest}`),
    ));
  }

  async replaceExactRevision(request: ReplaceExactRevisionIndexRequest): Promise<void> {
    if (
      typeof request.spaceId !== "string" ||
      request.spaceId.length === 0 ||
      typeof request.revisionId !== "string" ||
      request.revisionId.length === 0 ||
      !Array.isArray(request.documents)
    ) {
      throw new TypeError("exact revision index request is invalid");
    }
    if (this.#nextFailure) {
      const failure = this.#nextFailure;
      this.#nextFailure = null;
      throw failure;
    }
    const paths = new Set<string>();
    for (const document of request.documents) {
      if (
        typeof document.path !== "string" ||
        document.path.length === 0 ||
        typeof document.text !== "string" ||
        paths.has(document.path)
      ) {
        throw new TypeError("exact revision index documents are invalid");
      }
      paths.add(document.path);
      const digest = await digestText(document.text);
      if (document.sha256 !== undefined && document.sha256 !== digest) {
        throw new TypeError("exact revision index document digest is invalid");
      }
      this.#documents.set(
        `${request.spaceId}\u0000${digest}`,
        Object.freeze({ path: document.path, text: document.text, sha256: digest }),
      );
    }
    const revisionDocuments = request.entries === undefined
      ? cloneDocuments(request.documents)
      : Object.freeze(request.entries.map((entry) => {
          const document = this.#documents.get(`${request.spaceId}\u0000${entry.sha256}`);
          if (document === undefined) {
            throw new TypeError("exact revision index document body is unavailable");
          }
          return Object.freeze({
            path: entry.path,
            text: document.text,
            sha256: entry.sha256,
          });
        }));
    this.#revisions.set(
      key(request.spaceId, request.revisionId),
      Object.freeze({
        spaceId: request.spaceId,
        revisionId: request.revisionId,
        documents: revisionDocuments,
      }),
    );
  }

  async readExactRevision(
    spaceId: ReplaceExactRevisionIndexRequest["spaceId"],
    revisionId: ReplaceExactRevisionIndexRequest["revisionId"],
  ): Promise<ReadExactRevisionIndexResult> {
    const record = this.#revisions.get(key(spaceId, revisionId));
    if (!record) return Object.freeze({ kind: "unavailable" });
    return Object.freeze({
      kind: "ready",
      spaceId: record.spaceId,
      revisionId: record.revisionId,
      documents: cloneDocuments(record.documents),
    });
  }

  async inspectExactRevision(
    spaceId: ReplaceExactRevisionIndexRequest["spaceId"],
    revisionId: ReplaceExactRevisionIndexRequest["revisionId"],
  ) {
    return this.#revisions.has(key(spaceId, revisionId))
      ? Object.freeze({ kind: "ready" as const, spaceId, revisionId })
      : Object.freeze({ kind: "unavailable" as const });
  }

  /** Structural alias for application readers that require an exact ready snapshot. */
  async read(
    spaceId: ReplaceExactRevisionIndexRequest["spaceId"],
    revisionId: ReplaceExactRevisionIndexRequest["revisionId"],
  ): Promise<ReadExactRevisionIndexResult> {
    return this.readExactRevision(spaceId, revisionId);
  }

  async purgeSpace(spaceId: ReplaceExactRevisionIndexRequest["spaceId"]): Promise<number> {
    const keys = [...this.#revisions]
      .filter(([, record]) => record.spaceId === spaceId)
      .map(([recordKey]) => recordKey);
    keys.forEach((recordKey) => this.#revisions.delete(recordKey));
    for (const documentKey of [...this.#documents.keys()]) {
      if (documentKey.startsWith(`${spaceId}\u0000`)) this.#documents.delete(documentKey);
    }
    return keys.length;
  }

  failNextReplaceForTest(error: Error = new Error("injected index failure")): void {
    this.#nextFailure = error;
  }
}
