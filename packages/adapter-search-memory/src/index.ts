import type {
  ExactRevisionIndexDocument,
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
  return Object.freeze(documents.map((document) => Object.freeze({ ...document })));
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
  #nextFailure: Error | null = null;

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
    }
    this.#revisions.set(
      key(request.spaceId, request.revisionId),
      Object.freeze({
        spaceId: request.spaceId,
        revisionId: request.revisionId,
        documents: cloneDocuments(request.documents),
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

  async purgeSpace(spaceId: ReplaceExactRevisionIndexRequest["spaceId"]): Promise<number> {
    const keys = [...this.#revisions]
      .filter(([, record]) => record.spaceId === spaceId)
      .map(([recordKey]) => recordKey);
    keys.forEach((recordKey) => this.#revisions.delete(recordKey));
    return keys.length;
  }

  failNextReplaceForTest(error: Error = new Error("injected index failure")): void {
    this.#nextFailure = error;
  }
}
