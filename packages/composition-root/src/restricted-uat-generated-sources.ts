import { createSitesMetadataStore } from "@mind-diary/adapter-metadata-sites";
import { createSitesObjectStore } from "@mind-diary/adapter-object-sites";
import type { ProductSitesIdentityResolution } from "@mind-diary/adapter-web";
import {
  ChangesetCommitService,
  MCP_CONTENT_DEPLOYMENT_CAPABILITIES,
  SERVER_GENERATED_INGRESS_LIMITS,
  TrustedServerGeneratedIngressService,
} from "@mind-diary/application-content";
import type {
  MindBindingOwnerId,
  UtcInstant,
  WriteMindBindingId,
} from "@mind-diary/domain";
import type { BoundedInMemoryIngressPort } from "./bounded-in-memory-ingress.js";

export const RESTRICTED_UAT_GENERATED_SOURCE_TEST_ROUTE =
  "/api/internal/uat/generated-sources";

export const RESTRICTED_UAT_GENERATED_SOURCE_TOKEN_NAME =
  "UAT Generated Sources";

export interface RestrictedUatGeneratedSourceTestConfig {
  readonly deploymentClass: "uat";
  readonly deploymentPosture: "restricted-uat";
  readonly candidateSha: string;
}

type MetadataStore = Awaited<ReturnType<typeof createSitesMetadataStore>>;
type ObjectStore = Awaited<ReturnType<typeof createSitesObjectStore>>;
type AuthenticatedIdentity = Extract<
  ProductSitesIdentityResolution,
  Readonly<{ readonly kind: "authenticated" }>
>;
type ServerGeneratedActor = Parameters<
  TrustedServerGeneratedIngressService["stage"]
>[0]["actor"];
type CommitRequest = Parameters<ChangesetCommitService["commit"]>[0];
type CommitResult = Awaited<ReturnType<ChangesetCommitService["commit"]>>;

const RESTRICTED_UAT_GENERATED_SOURCE_CAPABILITIES = Object.freeze([
  Object.freeze({
    source_kind: "bounded_in_memory" as const,
    test_composition_status: "available" as const,
    test_transport: "constructor_owned_bytes" as const,
    max_bytes: 4_194_304,
  }),
  Object.freeze({
    source_kind: "server_generated" as const,
    test_composition_status: "available" as const,
    test_transport: "constructor_owned_stream" as const,
    max_bytes: SERVER_GENERATED_INGRESS_LIMITS.maxBytes,
  }),
]);

const RESTRICTED_UAT_GENERATED_SOURCE_SCHEMA =
  "mind-diary/restricted-uat-generated-source-test/v1";
const RESTRICTED_UAT_GENERATED_RUN_ID =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{7,63}$/u;
const RESTRICTED_UAT_PERSONAL_TOKEN_REF = /^ptok_v1_[0-9a-f]{32}$/u;
const UAT_BOUNDED_PNG_PREFIX = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const UAT_SERVER_GENERATED_PDF = new TextEncoder().encode(
  "%PDF-1.7\n% Mind Diary restricted UAT synthetic fixture\n",
);

function restrictedUatGeneratedPng(): Uint8Array {
  const bytes = new Uint8Array(4_194_304);
  bytes.set(UAT_BOUNDED_PNG_PREFIX);
  bytes.set(
    new TextEncoder().encode("Mind Diary restricted UAT synthetic fixture"),
    64,
  );
  return bytes;
}

function problem(status: number, code: string, message: string): Response {
  return Response.json(
    Object.freeze({
      ok: false,
      error: Object.freeze({ code, message, retryable: status >= 500 }),
    }),
    {
      status,
      headers: {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    },
  );
}

function success(data: unknown): Response {
  return Response.json(
    Object.freeze({ ok: true, data }),
    {
      headers: {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    },
  );
}

export function assertRestrictedUatGeneratedSourceTestConfig(
  config: RestrictedUatGeneratedSourceTestConfig | undefined,
): void {
  if (
    config !== undefined &&
    (
      config.deploymentClass !== "uat" ||
      config.deploymentPosture !== "restricted-uat" ||
      !/^[0-9a-f]{40}$/u.test(config.candidateSha)
    )
  ) {
    throw new TypeError(
      "restrictedUatGeneratedSourceTest requires exact restricted-UAT lineage",
    );
  }
}

export function createRestrictedUatGeneratedSourceHandler(dependencies: Readonly<{
  readonly config: RestrictedUatGeneratedSourceTestConfig;
  readonly publicOrigin: string;
  readonly resolveIdentity: (
    request: Request,
  ) => Promise<ProductSitesIdentityResolution>;
  readonly verifyCsrf: (
    actor: AuthenticatedIdentity["actor"],
    token: string,
  ) => Promise<boolean>;
  readonly metadata: MetadataStore;
  readonly objects: ObjectStore;
  readonly boundedInMemoryIngress: BoundedInMemoryIngressPort;
  readonly serverGeneratedIngress: TrustedServerGeneratedIngressService;
  readonly timeoutIngress: TrustedServerGeneratedIngressService;
  readonly commit: (request: CommitRequest) => Promise<CommitResult>;
  readonly clockNow: () => UtcInstant;
  readonly nextRequestId: () => ServerGeneratedActor["requestId"];
}>): (request: Request) => Promise<Response | null> {
  const capabilityProjection = Object.freeze({
    schema: RESTRICTED_UAT_GENERATED_SOURCE_SCHEMA,
    candidate_sha: dependencies.config.candidateSha,
    capability_rows: RESTRICTED_UAT_GENERATED_SOURCE_CAPABILITIES,
  });

  return async (request: Request): Promise<Response | null> => {
    if (
      new URL(request.url).pathname !==
        RESTRICTED_UAT_GENERATED_SOURCE_TEST_ROUTE
    ) return null;

    if (request.method !== "GET" && request.method !== "POST") {
      return problem(
        405,
        "method_not_allowed",
        "This restricted UAT test command does not support that method.",
      );
    }

    const identity = await dependencies.resolveIdentity(request);
    if (identity.kind !== "authenticated") {
      return problem(
        401,
        "authentication_required",
        "A registered restricted UAT principal is required.",
      );
    }
    if (request.method === "GET") return success(capabilityProjection);

    if (
      request.headers.get("origin") !== dependencies.publicOrigin ||
      !await dependencies.verifyCsrf(
        identity.actor,
        request.headers.get("x-csrf-token") ?? "",
      )
    ) {
      return problem(
        403,
        "csrf_verification_failed",
        "The restricted UAT test command was not accepted.",
      );
    }
    if (
      request.headers.get("content-type")?.split(";", 1)[0]?.trim()
        .toLowerCase() !== "application/json"
    ) {
      return problem(
        415,
        "unsupported_media_type",
        "The restricted UAT test command requires JSON.",
      );
    }

    let input: unknown;
    try {
      input = await request.json();
    } catch {
      return problem(400, "invalid_request", "The restricted UAT test command is invalid.");
    }
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return problem(400, "invalid_request", "The restricted UAT test command is invalid.");
    }
    const command = input as Readonly<Record<string, unknown>>;
    if (
      Object.keys(command).some((key) =>
        !["action", "personal_token_ref", "run_id"].includes(key)
      ) ||
      command.action !== "run_matrix" ||
      typeof command.personal_token_ref !== "string" ||
      !RESTRICTED_UAT_PERSONAL_TOKEN_REF.test(command.personal_token_ref) ||
      typeof command.run_id !== "string" ||
      !RESTRICTED_UAT_GENERATED_RUN_ID.test(command.run_id)
    ) {
      return problem(
        400,
        "invalid_request",
        "Only the fixed generated-source UAT matrix can be requested.",
      );
    }

    const principalId = identity.actor.principalId;
    const metadataToken = await dependencies.metadata
      .readMcpTokenMetadataByPresentationRef(
        principalId,
        command.personal_token_ref as never,
      );
    const nowMilliseconds = Date.parse(dependencies.clockNow());
    const tokenCreatedMilliseconds = Date.parse(metadataToken?.createdAt ?? "");
    const tokenExpiresMilliseconds = Date.parse(metadataToken?.expiresAt ?? "");
    if (
      metadataToken === null ||
      metadataToken.name !== RESTRICTED_UAT_GENERATED_SOURCE_TOKEN_NAME ||
      metadataToken.state !== "active" ||
      !(metadataToken.scopes as readonly string[]).includes("content:write") ||
      !Number.isFinite(nowMilliseconds) ||
      !Number.isFinite(tokenCreatedMilliseconds) ||
      !Number.isFinite(tokenExpiresMilliseconds) ||
      tokenExpiresMilliseconds <= nowMilliseconds ||
      tokenExpiresMilliseconds - tokenCreatedMilliseconds >
        8 * 24 * 60 * 60 * 1_000
    ) {
      return problem(
        409,
        "dedicated_write_credential_required",
        "A current short-lived dedicated generated-source credential is required.",
      );
    }

    const bindingOwnerId = metadataToken.tokenId as unknown as MindBindingOwnerId;
    const target = await dependencies.metadata.readCredentialWriteTarget(
      bindingOwnerId,
      principalId,
    );
    const generation = target?.kind === "current"
      ? target.state.activeGeneration
      : null;
    if (
      target?.kind !== "current" ||
      target.state.lifecycleState !== "active" ||
      target.state.bindingOwnerId !== bindingOwnerId ||
      target.state.principalId !== principalId ||
      generation === null ||
      generation.bindingOwnerId !== bindingOwnerId
    ) {
      return problem(
        409,
        "writable_target_required",
        "The dedicated credential must have one current writable target.",
      );
    }

    const [mind, targetClassification, members, initialHead] = await Promise.all([
      dependencies.metadata.readResolvedSpace(generation.spaceId),
      dependencies.metadata.classifyPersonalMindTarget({
        principalId,
        spaceId: generation.spaceId,
      }),
      dependencies.metadata.listControlMembers(generation.spaceId),
      dependencies.metadata.readHead(generation.spaceId),
    ]);
    const initialRevision = initialHead === null
      ? null
      : await dependencies.metadata.readRevision(generation.spaceId, initialHead);
    if (
      mind === null ||
      targetClassification.kind !== "ordinary" ||
      mind.space.state !== "active" ||
      mind.space.visibility !== "private" ||
      initialHead === null ||
      initialRevision === null ||
      initialRevision.revision.revisionNumber !== 1 ||
      members.length !== 1 ||
      members[0]?.principalId !== principalId ||
      members[0]?.role !== "owner" ||
      members[0]?.state !== "active"
    ) {
      return problem(
        409,
        "run_owned_private_mind_required",
        "The writable target must be one fresh private run-owned ordinary Mind.",
      );
    }

    const actor: ServerGeneratedActor = Object.freeze({
      kind: "registered_principal" as const,
      principalId,
      authentication: Object.freeze({
        kind: "mcp_token" as const,
        tokenId: metadataToken.tokenId,
        bindingOwnerId,
        effectiveScopes: metadataToken.scopes,
      }),
      deploymentCapabilities: MCP_CONTENT_DEPLOYMENT_CAPABILITIES,
      requestId: dependencies.nextRequestId(),
      occurredAtUtc: dependencies.clockNow(),
    });
    const idempotencyPrefix =
      `uat-generated:${dependencies.config.candidateSha.slice(0, 12)}:${command.run_id}`;
    const assertions: Array<Readonly<{
      readonly id: string;
      readonly status: "passed";
    }>> = [];
    const expect = (id: string, condition: boolean): void => {
      if (!condition) {
        throw Object.assign(
          new Error("Restricted UAT generated-source assertion failed"),
          { code: "uat_generated_source_assertion_failed", assertionId: id },
        );
      }
      assertions.push(Object.freeze({ id, status: "passed" }));
    };

    try {
      const boundedBytes = restrictedUatGeneratedPng();
      const boundedSha256 = await dependencies.objects.calculateSha256(boundedBytes);
      const serverBytes = Uint8Array.from(UAT_SERVER_GENERATED_PDF);
      const serverSha256 = await dependencies.objects.calculateSha256(serverBytes);
      const common = Object.freeze({ actor, spaceId: generation.spaceId });
      const writeBindingId = generation.generationId as unknown as WriteMindBindingId;
      const boundedCommon = Object.freeze({
        ...common,
        writeBindingId,
        displayFilename: "uat-generated-bounded.png",
        claimedMediaType: "image/png",
      });
      const serverCommon = Object.freeze({
        ...common,
        displayFilename: "uat-server-generated.pdf",
        expectedMediaType: "application/pdf",
        expectedSize: serverBytes.byteLength,
        expectedSha256: serverSha256,
      });

      const oversized = await dependencies.boundedInMemoryIngress.stage({
        ...boundedCommon,
        idempotencyKey: `${idempotencyPrefix}:bounded-plus-one` as never,
        bytes: new Uint8Array(4_194_305),
      });
      expect(
        "bounded-plus-one-rejected",
        oversized.kind === "invalid" &&
          oversized.code === "generated_artifact_size_limit_exceeded",
      );
      const boundedDigestMismatch = await dependencies.boundedInMemoryIngress.stage({
        ...boundedCommon,
        idempotencyKey: `${idempotencyPrefix}:bounded-digest-mismatch` as never,
        expectedSize: boundedBytes.byteLength,
        expectedSha256: `sha256:${"0".repeat(64)}` as never,
        bytes: boundedBytes,
      });
      expect(
        "bounded-digest-mismatch-rejected",
        boundedDigestMismatch.kind === "invalid" &&
          boundedDigestMismatch.code === "expected_sha256_mismatch",
      );
      const boundedStaleTarget = await dependencies.boundedInMemoryIngress.stage({
        ...boundedCommon,
        writeBindingId: "uat_stale_target_generation" as never,
        idempotencyKey: `${idempotencyPrefix}:bounded-stale-target` as never,
        bytes: UAT_BOUNDED_PNG_PREFIX,
      });
      expect("bounded-stale-target-rejected", boundedStaleTarget.kind === "denied");

      const boundedStageRequest = Object.freeze({
        ...boundedCommon,
        idempotencyKey: `${idempotencyPrefix}:bounded` as never,
        expectedSize: boundedBytes.byteLength,
        expectedSha256: boundedSha256,
        bytes: boundedBytes,
      });
      const bounded = await dependencies.boundedInMemoryIngress.stage(boundedStageRequest);
      const boundedReplay = await dependencies.boundedInMemoryIngress.stage(
        boundedStageRequest,
      );
      expect(
        "bounded-exact-4mib-staged",
        bounded.kind === "staged" &&
          bounded.record.size === 4_194_304 &&
          bounded.record.sha256 === boundedSha256,
      );
      expect(
        "bounded-stage-reconciled-without-duplicate",
        bounded.kind === "staged" &&
          boundedReplay.kind === "staged" &&
          boundedReplay.replayed &&
          boundedReplay.record.stagedFileId === bounded.record.stagedFileId,
      );

      const serverTargetMismatch = await dependencies.serverGeneratedIngress.stage({
        ...serverCommon,
        spaceId: "space_uat_non_target" as never,
        idempotencyKey: `${idempotencyPrefix}:server-stale-target`,
        producer: () => (async function* () { yield serverBytes; })(),
      });
      expect(
        "server-stale-target-rejected-before-producer",
        serverTargetMismatch.kind === "invalid" &&
          serverTargetMismatch.code === "writable_target_mismatch",
      );
      const serverOverflow = await dependencies.serverGeneratedIngress.stage({
        ...serverCommon,
        idempotencyKey: `${idempotencyPrefix}:server-overflow`,
        expectedSize: SERVER_GENERATED_INGRESS_LIMITS.maxBytes + 1,
        expectedSha256: `sha256:${"0".repeat(64)}`,
        producer: () => (async function* () { yield serverBytes; })(),
      });
      expect("server-overflow-rejected", serverOverflow.kind === "invalid");

      const cancellation = new AbortController();
      const serverCancelled = await dependencies.serverGeneratedIngress.stage({
        ...serverCommon,
        idempotencyKey: `${idempotencyPrefix}:server-cancel`,
        signal: cancellation.signal,
        producer: () => ({
          [Symbol.asyncIterator]() {
            let step = 0;
            return {
              async next(): Promise<IteratorResult<Uint8Array>> {
                step += 1;
                if (step === 1) {
                  return { done: false, value: serverBytes.subarray(0, 8) };
                }
                cancellation.abort();
                return await new Promise<IteratorResult<Uint8Array>>(() => undefined);
              },
              async return() {
                return { done: true, value: undefined };
              },
            };
          },
        }),
      });
      expect(
        "server-cancellation-rejected-without-publication",
        serverCancelled.kind === "invalid" &&
          serverCancelled.code === "generated_artifact_cancelled",
      );
      const serverProducerError = await dependencies.serverGeneratedIngress.stage({
        ...serverCommon,
        idempotencyKey: `${idempotencyPrefix}:server-producer-error`,
        producer: () => (async function* () {
          yield serverBytes.subarray(0, 8);
          throw new Error("private synthetic producer failure");
        })(),
      });
      expect(
        "server-producer-error-rejected-without-publication",
        serverProducerError.kind === "invalid" &&
          serverProducerError.code === "generated_artifact_streaming_unavailable",
      );
      const serverTimeout = await dependencies.timeoutIngress.stage({
        ...serverCommon,
        idempotencyKey: `${idempotencyPrefix}:server-timeout`,
        producer: () => new Promise(() => undefined),
      });
      expect(
        "server-timeout-rejected-without-publication",
        serverTimeout.kind === "invalid" &&
          serverTimeout.code === "generated_artifact_streaming_unavailable",
      );

      let representativeProducerInvocations = 0;
      const serverStageRequest = Object.freeze({
        ...serverCommon,
        idempotencyKey: `${idempotencyPrefix}:server`,
        producer: () => {
          representativeProducerInvocations += 1;
          return (async function* () {
            yield serverBytes.subarray(0, 11);
            yield serverBytes.subarray(11);
          })();
        },
      });
      const server = await dependencies.serverGeneratedIngress.stage(serverStageRequest);
      const serverReplay = await dependencies.serverGeneratedIngress.stage(
        serverStageRequest,
      );
      expect(
        "server-representative-stream-staged",
        server.kind === "staged" &&
          server.record.size === serverBytes.byteLength &&
          server.record.sha256 === serverSha256,
      );
      expect(
        "server-stage-reconciled-without-producer-retry",
        server.kind === "staged" &&
          serverReplay.kind === "staged" &&
          serverReplay.replayed &&
          serverReplay.record.stagedFileId === server.record.stagedFileId &&
          representativeProducerInvocations === 1,
      );

      expect(
        "staging-does-not-move-head",
        await dependencies.metadata.readHead(generation.spaceId) === initialHead,
      );
      if (bounded.kind !== "staged" || server.kind !== "staged") {
        throw Object.assign(new Error("Generated sources were not staged"), {
          code: "uat_generated_source_assertion_failed",
          assertionId: "positive-stage-result",
        });
      }

      const commitRequest = Object.freeze({
        actor,
        spaceId: generation.spaceId,
        writeBindingId: generation.generationId,
        expectedRevisionId: initialHead,
        idempotencyKey: `${idempotencyPrefix}:commit`,
        summary: "Publish restricted UAT deterministic generated-source fixtures",
        operations: Object.freeze([
          Object.freeze({
            type: "create_bundle_file" as const,
            path: "assets/uat-generated-bounded.png",
            staged_file_id: bounded.record.stagedFileId,
          }),
          Object.freeze({
            type: "create_bundle_file" as const,
            path: "assets/uat-server-generated.pdf",
            staged_file_id: server.record.stagedFileId,
          }),
        ]),
      });
      const committed = await dependencies.commit(commitRequest);
      const commitReplay = await dependencies.commit(commitRequest);
      expect(
        "one-explicit-atomic-commit",
        committed.kind === "committed" &&
          !committed.replayed &&
          commitReplay.kind === "committed" &&
          commitReplay.replayed &&
          commitReplay.envelope.revision.revisionId ===
            committed.envelope.revision.revisionId,
      );
      if (committed.kind !== "committed") {
        throw Object.assign(new Error("Generated-source commit failed"), {
          code: "uat_generated_source_assertion_failed",
          assertionId: "one-explicit-atomic-commit",
        });
      }
      expect(
        "head-moves-only-to-committed-revision",
        await dependencies.metadata.readHead(generation.spaceId) ===
          committed.envelope.revision.revisionId,
      );

      return success(Object.freeze({
        ...capabilityProjection,
        status: "passed",
        assertions: Object.freeze(assertions),
        staged: Object.freeze({
          bounded_in_memory: Object.freeze({
            size: bounded.record.size,
            sha256: bounded.record.sha256,
          }),
          server_generated: Object.freeze({
            size: server.record.size,
            sha256: server.record.sha256,
          }),
        }),
        commit: Object.freeze({
          one_revision: true,
          replayed: commitReplay.kind === "committed" && commitReplay.replayed,
        }),
      }));
    } catch (error) {
      const assertionId = typeof error === "object" && error !== null &&
          "assertionId" in error && typeof error.assertionId === "string"
        ? error.assertionId
        : null;
      return Response.json(
        Object.freeze({
          ok: false,
          error: Object.freeze({
            code: "uat_generated_source_assertion_failed",
            message: "The restricted UAT generated-source matrix failed closed.",
            retryable: false,
            assertion_id: assertionId,
          }),
        }),
        {
          status: 409,
          headers: {
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          },
        },
      );
    }
  };
}
