import {
  createSitesAuditSink,
  createSitesPrivacySafeObservabilitySink,
  type D1DatabaseLike as AuditD1DatabaseLike,
  type SitesObservabilityWriter,
} from "@mind-diary/adapter-audit-sites";
import {
  createBackgroundServiceActor,
  createProductBackgroundDispatcher,
} from "@mind-diary/adapter-background";
import { SitesMindLocatorCodec } from "@mind-diary/adapter-locator-sites";
import {
  MCP_APPS_ENDPOINT,
  MCP_ENDPOINT,
  FILE_UPLOAD_INTENT_ROUTE_PREFIX,
  MCP_LEGACY_CODEX_ENDPOINT,
  MCP_RETIRED_SITES_ENDPOINT,
  ProductMcpContentApplication,
  createFileUploadIntentHttpHandler,
  createLegacyCodexMcpHttpHandler,
  createMcpHttpHandler,
  createMcpHttpHandlerAtEndpoint,
  type McpRequestIdGenerator,
} from "@mind-diary/adapter-mcp";
import {
  OAUTH_ACCESS_RECORD_PREFIX,
  OAUTH_ACCESS_TOKEN_PREFIX,
  createSitesOAuthConnector,
  type D1DatabaseLike as OAuthD1DatabaseLike,
} from "@mind-diary/adapter-oauth-sites";
import {
  createSitesLocalFileUploadIntentStore,
  createSitesMetadataStore,
  type D1DatabaseLike as MetadataD1DatabaseLike,
} from "@mind-diary/adapter-metadata-sites";
import {
  createSitesObjectStore,
  type R2BucketLike,
} from "@mind-diary/adapter-object-sites";
import {
  createSitesSearchIndex,
  type D1DatabaseLike as SearchD1DatabaseLike,
} from "@mind-diary/adapter-search-sites";
import {
  createWebCryptoExportDownloadSecretCrypto,
  createWebCryptoTokenHasher,
} from "@mind-diary/adapter-security-webcrypto";
import {
  createProductWebHttpHandler,
  createProductExportDownloadHttpHandler,
  createProductBundleFileDownloadHttpHandler,
  resolveProductSitesIdentity,
  SITES_IDENTITY_PROVIDER,
  type ProductSitesIdentityResolution,
  type ProductSitesSessionSnapshot,
  type ProductWebActor,
  type ProductWebControlApplication,
  type TrustedSitesIdentitySnapshot,
} from "@mind-diary/adapter-web";
import {
  AuditOutboxDeliveryHandler,
  BackgroundPrivacySafeObservability,
  BoundedObjectCleanupHandler,
  ExportJobExpiryHandler,
  ExportJobHandler,
  InvitationExpiryJobHandler,
  ReadyExactRevisionIndexService,
  RevisionIndexJobHandler,
  RevisionIndexStatusService,
} from "@mind-diary/application-background";
import {
  BUNDLE_FILE_LIMITS,
  BundleFileStagingService,
  BundleFileDownloadService,
  CapacityAdmissionService,
  DEFAULT_CAPACITY_LIMITS,
  CanonicalRevisionCoordinator,
  ChangesetCommitService,
  ContentPrivacySafeObservability,
  DeterministicOkfExportService,
  ExportJobApplicationService,
  FileIngressCoordinator,
  GeneratedArtifactIngressService,
  LocalFileUploadIntentCleanupService,
  LocalFileUploadIntentService,
  MCP_CONTENT_DEPLOYMENT_CAPABILITIES,
  McpBearerAuthenticationService,
  createLocalFileUploadIntentSecretCodec,
  MarkdownImportService,
  MindBrowseService,
  MindBindingContentAuthorizer,
  MindDiscoveryService,
  MindHistoryService,
  MindSearchService,
  MindValidationService,
  TrustedServerGeneratedIngressService,
  type McpBearerAuthenticator,
} from "@mind-diary/application-content";
import {
  AccountBootstrapService,
  AccountDeletionService,
  CredentialWriteTargetApplicationService,
  ControlReadService,
  ControlPrivacySafeObservability,
  InvitationControlService,
  MembershipControlService,
  MindRouteService,
  OrdinaryMindControlService,
  OrdinaryMindDeletionService,
  OwnershipTransferService,
  PersonalMindControlService,
  PrincipalMindUsageApplicationService,
  PublicMindCatalogService,
  PrincipalActivityService,
  ServiceOperatorDirectoryService,
  TokenLifecycleService,
  VisibilityControlService,
} from "@mind-diary/application-control";
import {
  CapabilityAuthorizer,
  CurrentAccessBackgroundAuthorizer,
  type PrivacySafeObservabilityEvent,
  type PrivacySafeObservabilitySink,
} from "@mind-diary/application-ports";
import {
  isRevisionIndexTerminalFailureCode,
  type Capability,
  type EffectiveTokenScopes,
  type MindBindingOwnerId,
  type PrincipalId,
  type UtcInstant,
  version,
  verifiedSpaceHost,
} from "@mind-diary/domain";
import {
  createBoundedInMemoryIngressAdapter,
  type BoundedInMemoryIngressPort,
} from "./bounded-in-memory-ingress.js";
import {
  createOpenAiMcpAppsNativeFileParameterComposition,
  createVerifiedNativeFileParameterComposition,
  type ProductSiteVerifiedNativeFileParameterRouteOptions,
} from "./native-file-route.js";
import {
  assertRestrictedUatGeneratedSourceTestConfig,
  createRestrictedUatGeneratedSourceHandler,
  type RestrictedUatGeneratedSourceTestConfig,
} from "./restricted-uat-generated-sources.js";

export {
  RESTRICTED_UAT_GENERATED_SOURCE_TEST_ROUTE,
  RESTRICTED_UAT_GENERATED_SOURCE_TOKEN_NAME,
} from "./restricted-uat-generated-sources.js";

const PRODUCT_SITES_DEPLOYMENT_CAPABILITIES = Object.freeze([
  "content:browse",
  "content:search",
  "content:fetch",
  "content:history",
  "content:validate",
  "content:export",
  "content:write",
  "members:manage-basic",
  "settings:configure",
  "members:manage-admin",
  "visibility:change",
  "ownership:transfer",
  "space:delete",
] satisfies readonly Capability[]);

export interface ProductSiteTrustedIdentityReader {
  readVerifiedIdentity(request: Request):
    | TrustedSitesIdentitySnapshot
    | Promise<TrustedSitesIdentitySnapshot>;
}

/**
 * Full recovery is operator/background work. The request pulse is deliberately
 * limited to bounded index reconciliation and due invitation expiry, so it
 * cannot run cleanup or export scans on the foreground metadata queue.
 */
export type ProductSiteRecoveryMode = "full" | "request";

export interface ProductSiteRuntimeOptions {
  readonly database: MetadataD1DatabaseLike & SearchD1DatabaseLike & AuditD1DatabaseLike & OAuthD1DatabaseLike;
  readonly bucket: R2BucketLike;
  readonly publicOrigin: string;
  readonly identity: ProductSiteTrustedIdentityReader;
  /** Constructor-only trusted binding namespace; product composition defaults to OpenAI Sites. */
  readonly identityBindingProvider?: string;
  readonly tokenVerifierKey: Uint8Array;
  readonly locatorKey: Uint8Array;
  readonly exportDownloadVerifierKey: Uint8Array;
  readonly csrfKey: Uint8Array;
  /** Optional 256-bit gate-only key authenticating bounded benchmark correlation. */
  readonly performanceCorrelationKey?: Uint8Array;
  /** Optional UAT safeguard: skip best-effort Web activity writes on navigation. */
  readonly webActivityEnabled?: boolean;
  /** Constructor-only service authority. Missing/empty configuration fails closed. */
  readonly serviceOperatorPrincipalIds?: readonly string[];
  /**
   * Constructor-only test seam. The deployed Worker supplies it only for the
   * exact restricted-UAT posture; ordinary product compositions omit it.
   */
  readonly restrictedUatGeneratedSourceTest?: Readonly<
    RestrictedUatGeneratedSourceTestConfig
  >;
  /** Constructor-only clock dependency; Product Worker uses the system clock. */
  readonly now?: () => Date;
  /** Exact route/profile evidence; absent keeps native file staging unavailable. */
  readonly verifiedNativeFileParameterRoute?: ProductSiteVerifiedNativeFileParameterRouteOptions;
  readonly observabilityWriter?: SitesObservabilityWriter;
  readonly schedule: (work: Readonly<{ readonly kind: string; readonly id: string }>) => void | Promise<void>;
}

export interface ProductSiteRuntime {
  /** Trusted in-process producer route; deliberately absent from HTTP/MCP discovery. */
  readonly serverGeneratedIngress: Readonly<
    Pick<TrustedServerGeneratedIngressService, "stage">
  >;
  readonly fetch: (
    request: Request,
    deferActivity?: (promise: Promise<unknown>) => void,
  ) => Promise<Response | null>;
  /** Trusted constructor-owned bytes ingress; never an HTTP or MCP route. */
  readonly boundedInMemoryIngress: BoundedInMemoryIngressPort;
  /** Bounded recovery; request mode handles index work and due invitation expiry. */
  readonly recoverBackground: (
    limit?: number,
    mode?: ProductSiteRecoveryMode,
  ) => Promise<Readonly<{
    backfilled: number;
    repaired: number;
    dispatched: number;
    failed: number;
    cleanupDeleted: number;
    cleanupReclaimedBytes: number;
  }>>;
  readonly dispatchBackground: (work: Readonly<
    | { readonly kind: "revision_index"; readonly jobId: string }
    | { readonly kind: "export"; readonly jobId: string }
    | { readonly kind: "audit_outbox"; readonly messageId: string }
    | { readonly kind: "invitation_expiry"; readonly jobId: string }
    | { readonly kind: "export_expiry"; readonly jobId: string }
  >) => Promise<unknown>;
}

function nextOpaque(prefix: string): never {
  return `${prefix}_${crypto.randomUUID()}` as never;
}

function nextPresentationRef(prefix: "ptok_v1_" | "conn_v1_"): never {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const encoded = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${prefix}${encoded}` as never;
}

function benchmarkCorrelationId(request: Request): string | null {
  const value = request.headers.get("x-mind-diary-performance-correlation-id");
  return value !== null && /^benchmark_[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u.test(value)
    ? value
    : null;
}

function performanceCorrelationSignature(request: Request): Uint8Array | null {
  const value = request.headers.get("x-mind-diary-performance-correlation-signature");
  const match = /^hmac-sha256:([0-9a-f]{64})$/u.exec(value ?? "");
  if (match === null) return null;
  return Uint8Array.from(match[1]!.match(/.{2}/gu)!, (byte) => Number.parseInt(byte, 16));
}

function performanceCorrelationMessage(id: string): Uint8Array {
  return new TextEncoder().encode(`mind-diary/performance-correlation/v1\0${id}`);
}

function canonicalHost(origin: string) {
  const url = new URL(origin);
  const loopbackHttp = url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  if (
    (url.protocol !== "https:" && !loopbackHttp) ||
    url.origin !== origin ||
    url.username !== "" ||
    url.password !== "" ||
    (url.protocol === "https:" && url.port !== "") ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError("publicOrigin must be a canonical HTTPS or loopback HTTP origin");
  }
  return verifiedSpaceHost(url.hostname === "[::1]" ? "localhost" : url.hostname);
}

function ids(capture?: {
  readonly indexJob?: (id: string) => void;
  readonly auditOutbox?: (id: string) => void;
  readonly invitationExpiry?: (id: string) => void;
}) {
  return Object.freeze({
    nextPrincipalId: () => nextOpaque("principal"),
    nextExternalBindingId: () => nextOpaque("binding"),
    nextSpaceId: () => nextOpaque("space"),
    nextMembershipId: () => nextOpaque("membership"),
    nextRevisionId: () => nextOpaque("revision"),
    nextReadMindBindingId: () => nextOpaque("read-binding"),
    nextWriteMindBindingId: () => nextOpaque("write-binding"),
    nextMindBindingAuditEventId: () => nextOpaque("audit-binding"),
    nextMindBindingOutboxMessageId: () => {
      const id = nextOpaque("outbox-binding");
      capture?.auditOutbox?.(id);
      return id;
    },
    nextCredentialWriteTargetGenerationId: () => nextOpaque("write-target-generation"),
    nextCredentialWriteTargetAuditEventId: () => nextOpaque("audit-write-target"),
    nextCredentialWriteTargetOutboxMessageId: () => {
      const id = nextOpaque("outbox-write-target");
      capture?.auditOutbox?.(id);
      return id;
    },
    nextPrincipalMindUsageGenerationId: () =>
      nextOpaque("mind-usage-generation"),
    nextPrincipalMindUsageAuditEventId: () =>
      nextOpaque("audit-mind-usage"),
    nextPrincipalMindUsageOutboxMessageId: () => {
      const id = nextOpaque("outbox-mind-usage");
      capture?.auditOutbox?.(id);
      return id;
    },
    nextPersonalSpaceHandle: () => `personal-${crypto.randomUUID()}`,
    nextAuditEventId: () => nextOpaque("audit"),
    nextOutboxMessageId: () => {
      const id = nextOpaque("outbox");
      capture?.auditOutbox?.(id);
      return id;
    },
    nextIndexJobId: () => {
      const id = nextOpaque("job-index");
      capture?.indexJob?.(id);
      return id;
    },
    nextExportJobId: () => nextOpaque("job-export"),
    nextInvitationId: () => nextOpaque("invitation"),
    nextInvitationExpiryJobId: () => {
      const id = nextOpaque("job-invitation");
      capture?.invitationExpiry?.(id);
      return id;
    },
    nextImpactId: () => nextOpaque("impact"),
    nextDeletedPrincipalId: () => nextOpaque("deleted-principal"),
    nextTokenId: () => nextOpaque("token"),
    nextPersonalTokenRef: () => nextPresentationRef("ptok_v1_"),
  });
}

function requestIds(): McpRequestIdGenerator {
  return { nextRequestId: () => nextOpaque("request") };
}

function recordRuntimeMetric(
  sink: PrivacySafeObservabilitySink,
  event: Readonly<PrivacySafeObservabilityEvent>,
): void {
  try {
    const pending = sink.record(Object.freeze(event));
    if (
      typeof pending === "object" &&
      pending !== null &&
      "catch" in pending &&
      typeof pending.catch === "function"
    ) {
      void pending.catch(() => undefined);
    }
  } catch {
    // Operational telemetry is best-effort and cannot change product behavior.
  }
}

function actorCsrfIdentity(actor: ProductWebActor): string {
  return actor.kind === "registered_principal"
    ? `principal:${actor.principalId}`
    : `binding:${actor.provider}:${actor.normalizedBinding}`;
}

async function createCsrf(keyBytes: Uint8Array) {
  if (!(keyBytes instanceof Uint8Array) || keyBytes.byteLength < 32) {
    throw new TypeError("csrfKey must contain at least 256 bits");
  }
  const keyCopy = new Uint8Array(keyBytes);
  const key = await crypto.subtle.importKey(
    "raw",
    keyCopy,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  keyCopy.fill(0);
  const issue = async (actor: ProductWebActor): Promise<string> => {
    const message = new TextEncoder().encode(`mind-diary-csrf-v1\0${actorCsrfIdentity(actor)}`);
    try {
      const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
      return btoa(String.fromCharCode(...signature))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/u, "");
    } finally {
      message.fill(0);
    }
  };
  return Object.freeze({
    issue,
    async verify(actor: ProductWebActor, candidate: string): Promise<boolean> {
      const expected = await issue(actor);
      if (candidate.length !== expected.length) return false;
      let difference = 0;
      for (let index = 0; index < expected.length; index += 1) {
        difference |= expected.charCodeAt(index) ^ candidate.charCodeAt(index);
      }
      return difference === 0;
    },
  });
}

function asRecord(input: Readonly<Record<string, unknown>>, additions: Record<string, unknown> = {}) {
  const { mind_ref: _mindRef, member_id: _memberId, invitation_id: _invitationId, token_id: _tokenId, ...rest } = input;
  return Object.freeze({ ...rest, ...additions });
}

function safePersonalTokenDescriptor(token: Readonly<{
  readonly personalTokenRef: unknown;
  readonly name: string;
  readonly displayPrefix: string;
  readonly scopes: readonly string[];
  readonly state: string;
  readonly version: number;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
}>) {
  if (
    typeof token.personalTokenRef !== "string" ||
    !/^ptok_v1_[0-9a-f]{32}$/u.test(token.personalTokenRef)
  ) throw new Error("Personal token presentation metadata is unavailable");
  return Object.freeze({
    personalTokenRef: token.personalTokenRef,
    name: token.name,
    displayPrefix: token.displayPrefix,
    scopes: token.scopes,
    state: token.state,
    version: token.version,
    createdAt: token.createdAt,
    expiresAt: token.expiresAt,
    lastUsedAt: token.lastUsedAt,
    revokedAt: token.revokedAt,
  });
}

class ProductControlApplication {
  constructor(
    readonly services: {
      readonly bootstrap: AccountBootstrapService;
      readonly personal: PersonalMindControlService;
      readonly ordinary: OrdinaryMindControlService;
      readonly ordinaryDeletion: OrdinaryMindDeletionService;
      readonly accountDeletion: AccountDeletionService;
      readonly visibility: VisibilityControlService;
      readonly ownership: OwnershipTransferService;
      readonly membership: MembershipControlService;
      readonly reads: ControlReadService;
      readonly invitation: InvitationControlService;
      readonly routes: MindRouteService;
      readonly catalog: PublicMindCatalogService;
      readonly tokens: TokenLifecycleService;
      readonly capacity: CapacityAdmissionService;
      readonly markdownImports: MarkdownImportService;
      readonly exports: Pick<ExportJobApplicationService, "start" | "getStatus">;
      readonly scheduleExport: (jobId: string) => void | Promise<void>;
      readonly operatorDirectory: ServiceOperatorDirectoryService;
      /** Optional read-session bridge used by server-rendered detail pages. */
      readonly consistentRead?: <Result>(
        operation: (control: ProductWebControlApplication) => Promise<Result>,
      ) => Promise<Result>;
    },
  ) {}

  withConsistentRead<Result>(
    operation: (control: ProductWebControlApplication) => Promise<Result>,
  ): Promise<Result> {
    if (typeof operation !== "function") {
      throw new TypeError("consistent read callback is required");
    }
    return this.services.consistentRead === undefined
      ? operation(this)
      : this.services.consistentRead(operation);
  }

  async #mind(actor: ProductWebActor, input: Readonly<Record<string, unknown>>) {
    const ref = input.mind_ref;
    return this.services.routes.resolveRoute(actor as never, ref === "me" ? "/me" : `/${String(ref)}`);
  }

  async execute(request: {
    readonly operation: string;
    readonly actor: ProductWebActor;
    readonly input: Readonly<Record<string, unknown>>;
  }): Promise<unknown> {
    const { actor, input } = request;
    switch (request.operation) {
      case "get_session":
        return this.services.personal.resolveMyMind(actor as never);
      case "bootstrap_account":
        return this.services.bootstrap.bootstrapAccount(actor as never, asRecord(input) as never);
      case "rename_account":
        return this.services.personal.renameAccount(actor as never, asRecord(input) as never);
      case "get_account_deletion_impact":
        return this.services.accountDeletion.getAccountDeletionImpact(actor as never);
      case "delete_account":
        return this.services.accountDeletion.deleteAccount(actor as never, asRecord(input) as never);
      case "list_minds":
        return this.services.routes.listMinds(actor as never);
      case "create_space_with_owner":
        return this.services.ordinary.createSpaceWithOwner(actor as never, asRecord(input) as never);
      case "get_mind_info":
        return this.#mind(actor, input);
      case "get_capacity_usage": {
        const mind = await this.#mind(actor, input);
        return this.services.capacity.readMindUsage({
          actor: actor as never,
          spaceId: mind.mindId,
        });
      }
      case "plan_markdown_import": {
        const mind = await this.#mind(actor, input);
        return this.services.markdownImports.plan({
          actor: actor as never,
          spaceId: mind.mindId,
          expectedRevisionId: input.expectedRevisionId as never,
          idempotencyKey: input.idempotencyKey,
          files: input.files,
        });
      }
      case "start_markdown_import": {
        const mind = await this.#mind(actor, input);
        return this.services.markdownImports.start({
          actor: actor as never,
          spaceId: mind.mindId,
          planId: input.planId,
          idempotencyKey: input.idempotencyKey,
        });
      }
      case "start_export": {
        const allowedKeys = new Set([
          "mind_ref",
          "revisionSelector",
          "profile",
          "idempotencyKey",
        ]);
        if (
          Object.keys(input).some((key) => !allowedKeys.has(key)) ||
          typeof input.idempotencyKey !== "string" ||
          input.idempotencyKey.length === 0
        ) {
          throw Object.assign(new Error("Invalid export start request."), {
            code: "invalid_request",
          });
        }
        const mind = await this.#mind(actor, input);
        const result = await this.services.exports.start({
          actor: actor as never,
          spaceId: mind.mindId,
          revisionSelector: input.revisionSelector,
          profile: input.profile,
          idempotencyKey: input.idempotencyKey,
        });
        if (result.kind !== "started") {
          const code = result.kind === "denied"
            ? result.decision.code
            : result.kind === "invalid"
              ? result.code
              : result.kind;
          throw Object.assign(new Error("Export was not started."), { code });
        }
        await this.services.scheduleExport(String(result.job.jobId));
        return Object.freeze({
          job: Object.freeze({
            jobId: result.job.jobId,
            status: result.job.status,
            revisionId: result.job.revisionId,
            createdAt: result.job.createdAt,
          }),
          replayed: result.replayed,
        });
      }
      case "get_markdown_import":
        return this.services.markdownImports.status(
          actor as never,
          String(input.import_id ?? ""),
        );
      case "stage_markdown_import_batch":
        return this.services.markdownImports.stageBatch({
          actor: actor as never,
          importId: String(input.import_id ?? ""),
          checkpoint: input.checkpoint,
          expectedVersion: input.expectedVersion,
          files: input.files,
        });
      case "validate_markdown_import":
        return this.services.markdownImports.validate({
          actor: actor as never,
          importId: String(input.import_id ?? ""),
          expectedVersion: input.expectedVersion,
        });
      case "commit_markdown_import":
        return this.services.markdownImports.commit({
          actor: actor as never,
          importId: String(input.import_id ?? ""),
          expectedVersion: input.expectedVersion,
          summary: input.summary,
        });
      case "cancel_markdown_import":
        return this.services.markdownImports.cancel(
          actor as never,
          String(input.import_id ?? ""),
          input.expectedVersion,
        );
      case "get_export_status": {
        if (
          Object.keys(input).some((key) => key !== "job_id") ||
          typeof input.job_id !== "string" ||
          input.job_id.length === 0 ||
          input.job_id.length > 512 ||
          /[\u0000-\u001f\u007f]/u.test(input.job_id)
        ) {
          throw Object.assign(new Error("Invalid export job locator."), {
            code: "invalid_request",
          });
        }
        const result = await this.services.exports.getStatus({
          actor: actor as never,
          jobId: input.job_id as never,
        });
        if (result.kind !== "found") {
          throw Object.assign(new Error("Export job was not found."), {
            code: "export_job_not_found",
          });
        }
        const { archive, ...job } = result.job;
        return Object.freeze({
          job: Object.freeze({
            ...job,
            ...(archive === null ? {} : archive),
            ...(result.download === null
              ? {}
              : {
                  downloadUrl: result.download.url,
                  downloadExpiresAt: result.download.expiresAt,
                }),
          }),
        });
      }
      case "rename_space": {
        const mind = await this.#mind(actor, input);
        return this.services.ordinary.renameSpace(actor as never, asRecord(input, { mindId: mind.mindId }) as never);
      }
      case "get_mind_deletion_impact": {
        const mind = await this.#mind(actor, input);
        return this.services.ordinaryDeletion.getDeletionImpact(actor as never, { handle: mind.route.slice(1) });
      }
      case "delete_space": {
        const mind = await this.#mind(actor, input);
        return this.services.ordinaryDeletion.deleteSpace(actor as never, asRecord(input, { handle: mind.route.slice(1) }) as never);
      }
      case "list_public_minds":
        return this.services.catalog.listPublicMinds(actor as never, asRecord(input));
      case "change_visibility": {
        const mind = await this.#mind(actor, input);
        return this.services.visibility.changeVisibility(actor as never, asRecord(input, { mindId: mind.mindId }) as never);
      }
      case "change_membership_role":
      case "revoke_membership":
      case "leave_space": {
        const mind = await this.#mind(actor, input);
        const command = asRecord(input, { mindId: mind.mindId, memberId: input.member_id });
        if (request.operation === "change_membership_role") return this.services.membership.changeMembershipRole(actor as never, command as never);
        if (request.operation === "revoke_membership") return this.services.membership.revokeMembership(actor as never, command as never);
        return this.services.membership.leaveSpace(actor as never, command as never);
      }
      case "transfer_ownership": {
        const mind = await this.#mind(actor, input);
        return this.services.ownership.transferOwnership(actor as never, asRecord(input, { mindId: mind.mindId }) as never);
      }
      case "create_invitation": {
        const mind = await this.#mind(actor, input);
        return this.services.invitation.createInvitation(actor as never, asRecord(input, { mindId: mind.mindId }) as never);
      }
      case "accept_invitation":
      case "reject_invitation":
      case "reissue_invitation":
      case "cancel_invitation": {
        const command = asRecord(input, { invitationId: input.invitation_id });
        if (request.operation === "accept_invitation") return this.services.invitation.acceptInvitation(actor as never, command as never);
        if (request.operation === "reject_invitation") return this.services.invitation.rejectInvitation(actor as never, command as never);
        if (request.operation === "reissue_invitation") return this.services.invitation.reissueInvitation(actor as never, command as never);
        return this.services.invitation.cancelInvitation(actor as never, command as never);
      }
      case "list_mcp_tokens":
        return (await this.services.tokens.listMcpTokens(actor as never)).filter(
          (token) => !String(token.tokenId).startsWith(OAUTH_ACCESS_RECORD_PREFIX),
        );
      case "list_personal_token_page":
        return this.services.tokens.listPersonalTokenPage(actor as never, asRecord(input) as never);
      case "read_personal_token":
        return this.services.tokens.readPersonalToken(
          actor as never,
          input.personal_token_ref as never,
        );
      case "issue_mcp_token": {
        const result = await this.services.tokens.issueMcpToken(actor as never, asRecord(input) as never);
        return Object.freeze({
          "token": safePersonalTokenDescriptor(result.token),
          secret: result.secret.consumeSecret(),
        });
      }
      case "revoke_mcp_token":
        return this.services.tokens.revokeMcpToken(actor as never, input.token_id as never);
      case "revoke_personal_token": {
        const result = await this.services.tokens.revokePersonalToken(
          actor as never,
          input.personal_token_ref as never,
        );
        return Object.freeze({
          token: result.token,
          replayed: result.replayed,
        });
      }
      case "list_members":
      {
        const mind = await this.#mind(actor, input);
        return this.services.reads.listMembers(actor as never, mind.mindId);
      }
      case "list_invitations":
        return this.services.reads.listInvitations(actor as never);
      case "reconcile_invitation_expiries":
        return this.services.reads.reconcileInvitationExpiries(actor as never);
      case "list_service_operator_principals":
        return this.services.operatorDirectory.list(actor as never, input);
      default:
        throw Object.assign(new Error("Unknown control operation."), { code: "not_found" });
    }
  }
}

/** Creates the durable Sites-only product runtime. This function performs no deployment. */
export async function createProductSiteRuntime(
  options: ProductSiteRuntimeOptions,
): Promise<Readonly<ProductSiteRuntime>> {
  const nativeFileComposition = createVerifiedNativeFileParameterComposition(
    options.verifiedNativeFileParameterRoute,
  );
  const nativeFileRoute = nativeFileComposition.route;
  const mcpAppsNativeFileComposition =
    createOpenAiMcpAppsNativeFileParameterComposition();
  const host = canonicalHost(options.publicOrigin);
  const identityBindingProvider = options.identityBindingProvider ?? SITES_IDENTITY_PROVIDER;
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(identityBindingProvider)) {
    throw new TypeError("identityBindingProvider must be a bounded provider name");
  }
  const restrictedUatGeneratedSourceTest =
    options.restrictedUatGeneratedSourceTest;
  assertRestrictedUatGeneratedSourceTestConfig(restrictedUatGeneratedSourceTest);
  const now = options.now ?? (() => new Date());
  const clock = Object.freeze({ now: () => now().toISOString() as never });
  if (
    options.performanceCorrelationKey !== undefined &&
    options.performanceCorrelationKey.byteLength !== 32
  ) throw new TypeError("performanceCorrelationKey must contain exactly 32 bytes");
  let performanceCorrelationCryptoKey: CryptoKey | null = null;
  if (options.performanceCorrelationKey !== undefined) {
    const keyMaterial = Uint8Array.from(options.performanceCorrelationKey);
    try {
      performanceCorrelationCryptoKey = await crypto.subtle.importKey(
        "raw",
        keyMaterial.buffer,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"],
      );
    } finally {
      keyMaterial.fill(0);
    }
  }
  const trustedIdentitySourceRequests = new WeakMap<Request, Request>();
  const trustedPerformanceRequest = async (request: Request): Promise<Request> => {
    if (
      request.headers.get("x-mind-diary-performance-correlation-id") === null &&
      request.headers.get("x-mind-diary-performance-correlation-signature") === null
    ) return request;
    const correlationId = benchmarkCorrelationId(request);
    const signature = performanceCorrelationSignature(request);
    const headers = new Headers(request.headers);
    headers.delete("x-mind-diary-performance-correlation-signature");
    let verified = false;
    if (
      correlationId !== null && signature !== null &&
      performanceCorrelationCryptoKey !== null
    ) {
      try {
        const signatureBytes = Uint8Array.from(signature);
        const messageBytes = Uint8Array.from(performanceCorrelationMessage(correlationId));
        verified = await crypto.subtle.verify(
          "HMAC",
          performanceCorrelationCryptoKey,
          signatureBytes.buffer,
          messageBytes.buffer,
        );
      } catch {
        verified = false;
      }
    }
    if (!verified) headers.delete("x-mind-diary-performance-correlation-id");
    const sanitized = new Request(request, { headers });
    trustedIdentitySourceRequests.set(sanitized, request);
    return sanitized;
  };
  const pendingIndexJobs: string[] = [];
  const pendingAuditOutbox: string[] = [];
  const pendingInvitationExpiry: string[] = [];
  let capturedWorkTail: Promise<void> = Promise.resolve();
  const generated = ids({
    indexJob: (id) => pendingIndexJobs.push(id),
    auditOutbox: (id) => pendingAuditOutbox.push(id),
    invitationExpiry: (id) => pendingInvitationExpiry.push(id),
  });
  const scheduleCapturedWork = async () => {
    const work = [
      ...pendingIndexJobs.splice(0).map((id) => ({ kind: "revision_index", id } as const)),
      ...pendingAuditOutbox.splice(0).map((id) => ({ kind: "audit_outbox", id } as const)),
      ...pendingInvitationExpiry.splice(0).map((id) => ({ kind: "invitation_expiry", id } as const)),
    ];
    try {
      await Promise.all(work.map(async (item) => options.schedule(item)));
    } catch (error) {
      for (const item of work) {
        if (item.kind === "revision_index") pendingIndexJobs.push(item.id);
        if (item.kind === "audit_outbox") pendingAuditOutbox.push(item.id);
        if (item.kind === "invitation_expiry") pendingInvitationExpiry.push(item.id);
      }
      throw error;
    }
  };
  const discardCapturedWork = () => {
    pendingIndexJobs.splice(0);
    pendingAuditOutbox.splice(0);
    pendingInvitationExpiry.splice(0);
  };
  const runWithCapturedWork = async <Result>(
    operation: () => Promise<Result>,
    shouldSchedule: (result: Result) => boolean = () => true,
  ): Promise<Result> => {
    const previous = capturedWorkTail;
    let release!: () => void;
    capturedWorkTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    let operationStarted = false;
    let operationCompleted = false;
    try {
      if (
        pendingIndexJobs.length > 0 ||
        pendingAuditOutbox.length > 0 ||
        pendingInvitationExpiry.length > 0
      ) {
        await scheduleCapturedWork();
      }
      operationStarted = true;
      const result = await operation();
      operationCompleted = true;
      if (shouldSchedule(result)) await scheduleCapturedWork();
      else discardCapturedWork();
      return result;
    } catch (error) {
      if (operationStarted && !operationCompleted) discardCapturedWork();
      throw error;
    } finally {
      release();
    }
  };
  // D1-backed adapters now probe their existing schema lazily; only a genuinely
  // missing or outdated table runs the idempotent migration batch. This keeps
  // cold isolates from competing on schema-changing DDL before serving a page.
  const [objects, tokenHasher, downloadCrypto, csrf] = await Promise.all([
    createSitesObjectStore(options.bucket),
    createWebCryptoTokenHasher({ verifierKey: options.tokenVerifierKey }),
    createWebCryptoExportDownloadSecretCrypto({ verifierKey: options.exportDownloadVerifierKey }),
    createCsrf(options.csrfKey),
  ]);
  const metadata = await createSitesMetadataStore(options.database);
  const index = await createSitesSearchIndex(options.database);
  const audit = await createSitesAuditSink(options.database);
  const uploadIntentMetadata = await createSitesLocalFileUploadIntentStore(options.database);
  // Presentation refs are only needed by the user-facing token management
  // page. Keep the legacy repair off the shared cold navigation path; a
  // single-flight retry still preserves the migration invariant when that
  // page is first opened.
  let personalTokenPresentationRefsReady: Promise<void> | null = null;
  const ensurePersonalTokenPresentationRefs = async (): Promise<void> => {
    if (personalTokenPresentationRefsReady === null) {
      personalTokenPresentationRefsReady = (async () => {
        const missing = await metadata.listMcpTokensMissingPresentationRefs();
        if (missing.length === 0) return;
        await metadata.assignPersonalTokenRefs(missing.map((tokenId) =>
          Object.freeze({
            tokenId,
            personalTokenRef: generated.nextPersonalTokenRef(),
          })
        ));
        if ((await metadata.listMcpTokensMissingPresentationRefs()).length > 0) {
          throw new Error("Personal token presentation-ref migration did not converge");
        }
      })().catch((error) => {
        personalTokenPresentationRefsReady = null;
        throw error;
      });
    }
    await personalTokenPresentationRefsReady;
  };
  const benchmarkCorrelations = new Map<string, string>();
  const telemetry = createSitesPrivacySafeObservabilitySink(options.observabilityWriter, {
    benchmarkCorrelationId: (requestId) => requestId === null
      ? null
      : benchmarkCorrelations.get(requestId) ?? null,
  });
  const controlObservability = new ControlPrivacySafeObservability({
    sink: telemetry,
    clock,
    cohort: "close_circle",
  });
  const contentObservability = new ContentPrivacySafeObservability({
    sink: telemetry,
    cohort: "close_circle",
  });
  const backgroundObservability = new BackgroundPrivacySafeObservability({
    sink: telemetry,
    cohort: "close_circle",
  });
  const authorizer = new CapabilityAuthorizer(metadata);
  const configuredOperatorPrincipalIds = new Set<PrincipalId>();
  for (const principalId of options.serviceOperatorPrincipalIds ?? []) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(principalId)) {
      throw new TypeError("serviceOperatorPrincipalIds must contain bounded opaque IDs");
    }
    configuredOperatorPrincipalIds.add(principalId as PrincipalId);
  }
  const activity = new PrincipalActivityService(metadata);
  const mindUsage = new PrincipalMindUsageApplicationService({
    usage: metadata,
    ids: generated,
    digest: objects,
  });
  const backgroundAuthorizer = new CurrentAccessBackgroundAuthorizer(metadata);
  const revisions = new CanonicalRevisionCoordinator({ objects, revisions: metadata });
  const indexStatus = new RevisionIndexStatusService(metadata);
  const locators = new SitesMindLocatorCodec({
    database: options.database,
    secret: options.locatorKey,
    now,
  });

  const credentialWriteTargets = new CredentialWriteTargetApplicationService({
    targets: metadata,
    ids: generated,
    digest: objects,
  });
  const contentAuthorizer = new MindBindingContentAuthorizer({
    delegate: authorizer,
    bindings: metadata,
    readAuthority: "current_acl",
    consistentRead: (operation) =>
      metadata.withConsistentRead((store) =>
        operation({
          bindings: store,
          delegate: new CapabilityAuthorizer(store),
        })),
  });
  const discovery = new MindDiscoveryService({
    store: metadata,
    host,
    indexStatus,
    indexStatusForStore: (store) => new RevisionIndexStatusService(store),
    credentialAccess: contentAuthorizer,
  });
  const bundleFileStaging = new BundleFileStagingService({
    authorizer: contentAuthorizer,
    metadata,
    objects,
    clock,
  });
  const boundedInMemoryIngress = createBoundedInMemoryIngressAdapter({
    application: new GeneratedArtifactIngressService({
      staging: bundleFileStaging,
    }),
  });
  const uploadIntentSecrets = await createLocalFileUploadIntentSecretCodec(
    options.tokenVerifierKey,
  );
  const uploadIntents = new LocalFileUploadIntentService({
    authorizer: contentAuthorizer,
    bindings: metadata,
    intents: uploadIntentMetadata,
    staging: {
      stageStream: (request) => bundleFileStaging.stageStream(request),
      readStagedBundleFile: (stagedFileId) =>
        metadata.readStagedBundleFile(stagedFileId),
    },
    digest: objects,
    clock,
    secrets: uploadIntentSecrets,
    deploymentCapabilities: MCP_CONTENT_DEPLOYMENT_CAPABILITIES,
    issuerActorAllowed: (actor) =>
      String(actor.authentication.tokenId).startsWith(
        OAUTH_ACCESS_RECORD_PREFIX,
      ) &&
      String(actor.authentication.bindingOwnerId).startsWith(
        "md_oauth_grant_",
      ),
  });
  const uploadIntentCleanup = new LocalFileUploadIntentCleanupService({
    intents: uploadIntentMetadata,
    clock,
  });
  const contentReadServices = (store: typeof metadata) => {
    const scopedAuthorizer = new MindBindingContentAuthorizer({
      delegate: new CapabilityAuthorizer(store),
      bindings: store,
      readAuthority: "current_acl",
    });
    return Object.freeze({
      browse: new MindBrowseService({
        store,
        objects,
        host,
        locators,
        authorizer: scopedAuthorizer,
        credentialAccess: scopedAuthorizer,
      }),
      search: new MindSearchService({
        store,
        index: new ReadyExactRevisionIndexService({ work: store, index }),
        host,
        locators,
        authorizer: scopedAuthorizer,
        credentialAccess: scopedAuthorizer,
      }),
      history: new MindHistoryService({
        store,
        host,
        authorizer: scopedAuthorizer,
        credentialAccess: scopedAuthorizer,
      }),
    });
  };
  // One current D1 snapshot/tail is the authority for one closed content-read
  // request. All binding, ACL, revision and final-stamp checks still run, but
  // they compare the same immutable read-session instead of paying for several
  // identical cross-region refreshes inside a single MCP call.
  const browse = Object.freeze({
    browseEntries: (...args: Parameters<MindBrowseService["browseEntries"]>) =>
      metadata.withConsistentRead((store) =>
        contentReadServices(store).browse.browseEntries(...args)),
    listBundleFiles: (...args: Parameters<MindBrowseService["listBundleFiles"]>) =>
      metadata.withConsistentRead((store) =>
        contentReadServices(store).browse.listBundleFiles(...args)),
    fetch: (...args: Parameters<MindBrowseService["fetch"]>) =>
      metadata.withConsistentRead((store) =>
        contentReadServices(store).browse.fetch(...args)),
    readResource: (...args: Parameters<MindBrowseService["readResource"]>) =>
      metadata.withConsistentRead((store) =>
        contentReadServices(store).browse.readResource(...args)),
  });
  const search = Object.freeze({
    searchEntries: (...args: Parameters<MindSearchService["searchEntries"]>) =>
      metadata.withConsistentRead((store) =>
        contentReadServices(store).search.searchEntries(...args)),
  });
  const principalsWithObservedUsefulSearch = new Set<string>();
  const observedSearch = {
    async searchEntries(
      actor: Parameters<MindSearchService["searchEntries"]>[0],
      query: Parameters<MindSearchService["searchEntries"]>[1],
    ) {
      const result = await search.searchEntries(actor, query);
      if (
        actor.kind === "registered_principal" &&
        result.results.length > 0 &&
        !principalsWithObservedUsefulSearch.has(actor.principalId)
      ) {
        principalsWithObservedUsefulSearch.add(actor.principalId);
        try {
          const account = await metadata.readAccount(actor.principalId);
          const startedAt = Date.parse(account?.principal.createdAt ?? "");
          const completedAt = Date.parse(actor.occurredAtUtc);
          const durationMs = completedAt - startedAt;
          if (
            account === null ||
            !Number.isSafeInteger(durationMs) ||
            durationMs < 0
          ) {
            principalsWithObservedUsefulSearch.delete(actor.principalId);
          } else {
            contentObservability.recordPilot({
              actor,
              metric: "time_to_first_useful_search_ms",
              operation: "search",
              outcome: "resolved",
              value: durationMs,
            });
          }
        } catch {
          principalsWithObservedUsefulSearch.delete(actor.principalId);
        }
      }
      return result;
    },
  };
  const history = Object.freeze({
    listRevisions: (...args: Parameters<MindHistoryService["listRevisions"]>) =>
      metadata.withConsistentRead((store) =>
        contentReadServices(store).history.listRevisions(...args)),
    getRevision: (...args: Parameters<MindHistoryService["getRevision"]>) =>
      metadata.withConsistentRead((store) =>
        contentReadServices(store).history.getRevision(...args)),
  });
  const validation = new MindValidationService({
    store: metadata,
    objects,
    host,
    authorizer: contentAuthorizer,
    credentialAccess: contentAuthorizer,
  });
  const commits = new ChangesetCommitService({
    authorizer: contentAuthorizer,
    metadata,
    revisions,
    objects,
    clock,
    revisionIds: generated,
    effectIds: generated,
  });
  const fileIngress = new FileIngressCoordinator({
    capabilityStatus: Object.freeze({
      session_attachment: "available_hosted",
      local_path: "available_hosted",
      "workspace/generated_artifact": "available_hosted",
    }),
    staging: bundleFileStaging,
    commits,
  });
  const serverGeneratedIngressService = new TrustedServerGeneratedIngressService({
    ingress: new GeneratedArtifactIngressService({ staging: bundleFileStaging }),
    reconciliation: bundleFileStaging,
    targets: metadata,
  });
  const restrictedUatTimeoutIngressService =
    restrictedUatGeneratedSourceTest === undefined
      ? null
      : new TrustedServerGeneratedIngressService({
          ingress: new GeneratedArtifactIngressService({ staging: bundleFileStaging }),
          reconciliation: bundleFileStaging,
          targets: metadata,
          producerLeaseMilliseconds: 25,
        });
  const serverGeneratedIngress = Object.freeze({
    stage: serverGeneratedIngressService.stage.bind(serverGeneratedIngressService),
  });
  const markdownImports = new MarkdownImportService({
    authorizer,
    metadata,
    objects,
    revisions,
    clock,
    revisionIds: generated,
    effectIds: generated,
  });
  const exports = new ExportJobApplicationService({
    authorizer,
    backgroundAuthorizer,
    metadata,
    digest: objects,
    archives: objects,
    clock,
    jobIds: generated,
    downloadSecretCrypto: downloadCrypto,
    downloadUrlBase: `${options.publicOrigin}/api/v1/exports`,
  });
  const bundleFileDownloads = new BundleFileDownloadService({
    store: metadata,
    objects,
    authorizer: contentAuthorizer,
    credentialAccess: contentAuthorizer,
    host,
    clock,
    secrets: downloadCrypto,
    downloadUrlBase: `${options.publicOrigin}/api/bundle-download`,
  });
  const mcpApplicationDependencies = {
    discovery,
    browse,
    search: observedSearch,
    history,
    validation,
    staging: bundleFileStaging,
    uploadIntents,
    uploadIntentUrl: (capability) =>
      new URL(
        `${FILE_UPLOAD_INTENT_ROUTE_PREFIX}${encodeURIComponent(capability)}`,
        options.publicOrigin,
      ).href,
    ingress: fileIngress,
    bundleFileDownloads,
    commits: {
      commit: async (request) => {
        const result = await runWithCapturedWork(
          () => commits.commit(request),
          (result) => result.kind === "committed",
        );
        if (result.kind === "revision_conflict") {
          contentObservability.recordCasConflict(request.actor);
        }
        return result;
      },
    },
  } satisfies ConstructorParameters<typeof ProductMcpContentApplication>[0];
  const directMcpApplication = new ProductMcpContentApplication(
    mcpApplicationDependencies,
  );
  const nativeMcpApplication = nativeFileRoute === undefined
    ? null
    : new ProductMcpContentApplication({
        ...mcpApplicationDependencies,
        nativeFileRoute,
      });
  const mcpAppsMcpApplication = new ProductMcpContentApplication({
    ...mcpApplicationDependencies,
    nativeFileRoute: mcpAppsNativeFileComposition.route,
  });
  const resolveIdentity = async (
    request: Request,
  ): Promise<ProductSitesIdentityResolution> => {
    const context = Object.freeze({
      requestId: nextOpaque("request"),
      occurredAtUtc: clock.now(),
      deploymentCapabilities: PRODUCT_SITES_DEPLOYMENT_CAPABILITIES,
    });
    let session: Readonly<ProductSitesSessionSnapshot> | undefined;
    const resolution = await resolveProductSitesIdentity({
      snapshot: await options.identity.readVerifiedIdentity(
        trustedIdentitySourceRequests.get(request) ?? request,
      ),
      bindingProvider: identityBindingProvider,
      bindings: {
        async readActiveBinding(lookup) {
          const account = await metadata.readAccountByExternalBinding(lookup as never);
          if (account !== null) {
            session = Object.freeze({
              principal: Object.freeze({
                displayName: account.principal.displayName,
                profileVersion: account.principal.profileVersion,
              }),
              personalMind: Object.freeze({
                name: account.personalMind.space.name,
                headRevisionId: account.personalMind.space.headRevisionId,
              }),
            });
          }
          return account === null
            ? Object.freeze({ kind: "unbound" as const })
            : Object.freeze({
                kind: "bound" as const,
                provider: lookup.provider,
                normalizedBinding: lookup.normalizedBinding,
                principalId: account.principal.principalId,
              });
        },
      },
      context,
    });
    return resolution.kind === "authenticated" && session !== undefined
      ? Object.freeze({ ...resolution, session })
      : resolution;
  };
  const oauth = await createSitesOAuthConnector({
    database: options.database,
    publicOrigin: options.publicOrigin,
    verifierKey: options.tokenVerifierKey,
    authorizationTokens: metadata,
    async registerWriteTargetOwner(input) {
      const result = await metadata.runCredentialWriteTargetTransaction(
        (transaction) => transaction.registerCredentialWriteTargetOwner({
          bindingOwnerId: input.bindingOwnerId as MindBindingOwnerId,
          principalId: input.principalId as PrincipalId,
          credentialKind: "oauth_grant",
          occurredAt: input.occurredAt as UtcInstant,
        }),
      );
      // A legacy owner stays pending until the separate explicit upgrade.
      if (result.kind !== "registered" && result.kind !== "owner_conflict") {
        throw new Error("OAuth write-target profile initialization failed.");
      }
      const actor = Object.freeze({
        kind: "registered_principal" as const,
        principalId: input.principalId as PrincipalId,
        authentication: Object.freeze({ kind: "sites_identity" as const }),
        deploymentCapabilities: PRODUCT_SITES_DEPLOYMENT_CAPABILITIES,
        requestId: nextOpaque("request-oauth-write-target-upgrade"),
        occurredAtUtc: input.occurredAt as UtcInstant,
      });
      const current = await credentialWriteTargets.read({
        actor,
        bindingOwnerId: input.bindingOwnerId as MindBindingOwnerId,
        credentialScopes: Object.freeze([...input.credentialScopes]) as EffectiveTokenScopes,
      });
      if (current?.kind === "pending_upgrade") {
        const upgraded = await credentialWriteTargets.mutate({
          actor,
          bindingOwnerId: input.bindingOwnerId as MindBindingOwnerId,
          credentialScopes: Object.freeze([...input.credentialScopes]) as EffectiveTokenScopes,
          operation: "upgrade_legacy",
          credentialKind: "oauth_grant",
          idempotencyKey: `oauth-target-upgrade:${input.bindingOwnerId}`,
        });
        if (upgraded.kind !== "applied") {
          throw new Error("OAuth write-target profile upgrade failed.");
        }
      }
    },
    async revokeWriteTargetOwner(input) {
      const result = await metadata.revokeCredentialWriteTargetOwner({
        bindingOwnerId: input.bindingOwnerId as MindBindingOwnerId,
        principalId: input.principalId as PrincipalId,
        requestId: nextOpaque("request-oauth-write-target-revoke"),
        auditEventId: generated.nextCredentialWriteTargetAuditEventId(),
        auditOutboxMessageId: generated.nextCredentialWriteTargetOutboxMessageId(),
        occurredAt: input.occurredAt as UtcInstant,
      });
      if (result.kind !== "revoked" && result.kind !== "not_found") {
        throw new Error("OAuth write-target owner revocation failed.");
      }
    },
    now,
    async resolveIdentity(request) {
      const identity = await resolveIdentity(request);
      return identity.kind === "authenticated"
        ? Object.freeze({
            kind: "authenticated" as const,
            principalId: String(identity.actor.principalId),
          })
        : Object.freeze({ kind: identity.kind });
    },
  });
  const personalTokenAuthenticator = new McpBearerAuthenticationService({
    clock,
    tokenHasher,
    tokens: metadata,
  });
  const authenticator: McpBearerAuthenticator = Object.freeze({
    authenticate(
      candidate: unknown,
      requestId: Parameters<McpBearerAuthenticator["authenticate"]>[1],
    ) {
      return typeof candidate === "string" && candidate.startsWith(OAUTH_ACCESS_TOKEN_PREFIX)
        ? oauth.authenticator.authenticate(candidate, requestId)
        : personalTokenAuthenticator.authenticate(candidate, requestId);
    },
  });
  const mcpDependencies = {
    authenticator,
    allowedOrigin: options.publicOrigin,
    oauth: Object.freeze({
      protectedResourceMetadataUrl: oauth.protectedResourceMetadataUrl,
    }),
  };
  const handleMcp = async (
    request: Request,
    profile: "modern" | "compatibility" | "apps",
    deferActivity?: (promise: Promise<unknown>) => void,
  ): Promise<Response> => {
    const mcpApplication = profile === "apps"
      ? mcpAppsMcpApplication
      : nativeMcpApplication !== null &&
          nativeFileComposition.mcpProfiles.includes(profile)
        ? nativeMcpApplication
        : directMcpApplication;
    const startedAt = performance.now();
    const requestId = requestIds().nextRequestId();
    const performanceCorrelationId = benchmarkCorrelationId(request);
    if (performanceCorrelationId !== null) {
      benchmarkCorrelations.set(requestId, performanceCorrelationId);
    }
    const performanceProfile = profile === "modern" || profile === "apps"
      ? "mcp_modern" as const
      : "mcp_compatibility" as const;
    const timedAuthenticator: McpBearerAuthenticator = Object.freeze({
      async authenticate(
        candidate: Parameters<McpBearerAuthenticator["authenticate"]>[0],
        currentRequestId: Parameters<McpBearerAuthenticator["authenticate"]>[1],
      ) {
        const stageStartedAt = performance.now();
        let stageOutcome: "success" | "failure" = "failure";
        try {
          const result = await authenticator.authenticate(candidate, currentRequestId);
          stageOutcome = result.kind === "authenticated" ? "success" : "failure";
          return result;
        } finally {
          contentObservability.recordMcpPerformance({
            requestId: currentRequestId,
            occurredAtUtc: clock.now(),
            durationMs: Math.max(0, performance.now() - stageStartedAt),
            profile: performanceProfile,
            stage: "stage_authentication",
            tool: null,
            outcome: stageOutcome,
          });
        }
      },
    });
    const mcpWriteActivityTools = new Set([
      "commit_changeset",
      "capture_knowledge",
      "create_file_upload_intent",
      "stage_bundle_file",
      "set_read_mind_binding",
      "set_write_mind_binding",
    ]);
    const recordMcpActivity = (
      actor: Parameters<PrincipalActivityService["recordSuccessful"]>[0],
      kind: Parameters<PrincipalActivityService["recordSuccessful"]>[2],
    ): Promise<void> | undefined => {
      const pending = activity.recordSuccessful(actor, "mcp", kind);
      if (deferActivity === undefined) return pending;
      try {
        deferActivity(pending);
      } catch {
        // Activity remains best-effort even if a host defer hook is unavailable.
      }
      return undefined;
    };
    const timedContent = new Proxy(mcpApplication, {
      get(target, property, receiver) {
        if (property === "listTools") {
          return async (contentRequest: Parameters<ProductMcpContentApplication["listTools"]>[0]) => {
            const result = await target.listTools(contentRequest);
            await recordMcpActivity(contentRequest.actor, "discovery");
            return result;
          };
        }
        if (property === "listRootResources") {
          return async (contentRequest: Parameters<ProductMcpContentApplication["listRootResources"]>[0]) => {
            const result = await target.listRootResources(contentRequest);
            await recordMcpActivity(contentRequest.actor, "discovery");
            return result;
          };
        }
        if (property === "readResource") {
          return async (contentRequest: Parameters<ProductMcpContentApplication["readResource"]>[0]) => {
            const result = await target.readResource(contentRequest);
            await recordMcpActivity(contentRequest.actor, "content_read");
            return result;
          };
        }
        if (property === "executeAuthorizedToolCall") {
          return async (toolRequest: Parameters<ProductMcpContentApplication["executeAuthorizedToolCall"]>[0]) => {
            const stageStartedAt = performance.now();
            let stageOutcome: "success" | "failure" = "failure";
            try {
              const result = await target.executeAuthorizedToolCall(toolRequest);
              stageOutcome = "success";
              const toolResult = typeof result === "object" && result !== null
                ? result as { readonly isError?: unknown }
                : null;
              if (toolResult?.isError !== true) {
                await recordMcpActivity(
                  toolRequest.actor,
                  mcpWriteActivityTools.has(toolRequest.name)
                    ? "content_write"
                    : "content_read",
                );
              }
              return result;
            } finally {
              contentObservability.recordMcpPerformance({
                requestId: toolRequest.actor.requestId,
                occurredAtUtc: clock.now(),
                durationMs: Math.max(0, performance.now() - stageStartedAt),
                profile: performanceProfile,
                stage: "stage_application",
                tool: toolRequest.name,
                outcome: stageOutcome,
              });
            }
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const dependencies = {
      ...mcpDependencies,
      authenticator: timedAuthenticator,
      content: timedContent,
      requestIds: { nextRequestId: () => requestId },
      logger: {
        record(event: {
          readonly requestId: typeof requestId;
          readonly status: number;
          readonly outcome:
            | "authenticated"
            | "authentication_failed"
            | "authentication_unavailable"
            | "protocol_error"
            | "tool_denied"
            | "tool_completed"
            | "internal_error";
        }): void {
          contentObservability.recordMcpRequest({
            requestId: event.requestId,
            occurredAtUtc: clock.now(),
            durationMs: Math.max(0, performance.now() - startedAt),
            status: event.status,
            outcome: event.outcome,
            profile: performanceProfile,
          });
        },
      },
    };
    let response: Response;
    try {
      response = await (profile === "compatibility"
        ? createLegacyCodexMcpHttpHandler(dependencies)(request)
        : profile === "apps"
          ? createMcpHttpHandlerAtEndpoint(dependencies, MCP_APPS_ENDPOINT)(request)
          : createMcpHttpHandler(dependencies)(request));
    } finally {
      benchmarkCorrelations.delete(requestId);
    }
    const headers = new Headers(response.headers);
    headers.set("x-mind-diary-request-id", requestId);
    if (performanceCorrelationId !== null) {
      headers.set("x-mind-diary-performance-correlation-id", performanceCorrelationId);
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };

  const commonAuditIds = generated;
  const controlServices = {
    bootstrap: new AccountBootstrapService({ accounts: metadata, objects, ids: generated, logger: controlObservability }),
    personal: new PersonalMindControlService({ personalMinds: metadata, digest: objects, logger: controlObservability }),
    ordinary: new OrdinaryMindControlService({ ordinaryMinds: metadata, objects, ids: generated, host, logger: controlObservability }),
    ordinaryDeletion: new OrdinaryMindDeletionService({ ordinaryMinds: metadata, objects, index, audit, exportArchives: objects, ids: generated, clock, host, logger: controlObservability }),
    accountDeletion: new AccountDeletionService({ accounts: metadata, tokens: metadata, objects, index, audit, exportArchives: objects, ids: generated, clock, host, logger: controlObservability }),
    visibility: new VisibilityControlService({ ordinaryMinds: metadata, objects, auditIds: commonAuditIds, logger: controlObservability }),
    ownership: new OwnershipTransferService({ ordinaryMinds: metadata, objects, auditIds: commonAuditIds, capacityLimits: DEFAULT_CAPACITY_LIMITS, logger: controlObservability }),
    membership: new MembershipControlService({ memberships: metadata, digest: objects, auditIds: commonAuditIds, logger: controlObservability }),
    reads: new ControlReadService(metadata, metadata),
    invitation: new InvitationControlService({
      invitations: metadata,
      objects,
      ids: generated,
      identityProvider: identityBindingProvider,
      logger: controlObservability,
    }),
    routes: new MindRouteService({ routes: metadata, host, logger: controlObservability }),
    catalog: new PublicMindCatalogService({ catalog: metadata, host, logger: controlObservability }),
    tokens: new TokenLifecycleService({
      clock,
      tokenHasher,
      tokenIds: generated,
      personalTokenRefs: generated,
      tokens: metadata,
      writeTargets: metadata,
      writeTargetIds: generated,
      logger: controlObservability,
    }),
    capacity: new CapacityAdmissionService({
      metadata,
      authorizer,
      clock,
    }),
    markdownImports,
    exports,
    scheduleExport: async (jobId: string) => options.schedule({ kind: "export", id: jobId }),
    operatorDirectory: new ServiceOperatorDirectoryService({
      store: metadata,
      tokens: metadata,
      operatorPrincipalIds: configuredOperatorPrincipalIds,
      ids: generated,
    }),
  };
  const consistentRead = async <Result>(
    operation: (control: ProductWebControlApplication) => Promise<Result>,
  ): Promise<Result> => metadata.withConsistentRead(async (readStore) => {
    // The detail page performs several independent reads. Rebind only the
    // read services to this one refreshed snapshot; mutation services remain
    // on the live store and are never exposed through this callback.
    const readControl = new ProductControlApplication({
      ...controlServices,
      reads: new ControlReadService(readStore),
      routes: new MindRouteService({ routes: readStore, host, logger: controlObservability }),
      capacity: new CapacityAdmissionService({
        metadata: readStore,
        authorizer: new CapabilityAuthorizer(readStore),
        clock,
      }),
    });
    return operation(readControl);
  });
  const control = new ProductControlApplication({
    ...controlServices,
    consistentRead,
  });

  const restrictedUatGeneratedSourceHandler =
    restrictedUatGeneratedSourceTest === undefined
      ? async (_request: Request): Promise<Response | null> => null
      : createRestrictedUatGeneratedSourceHandler({
          config: restrictedUatGeneratedSourceTest,
          publicOrigin: options.publicOrigin,
          resolveIdentity,
          verifyCsrf: (actor, token) => csrf.verify(actor, token),
          metadata,
          objects,
          boundedInMemoryIngress,
          serverGeneratedIngress: serverGeneratedIngressService,
          timeoutIngress: restrictedUatTimeoutIngressService!,
          commit: (request) =>
            runWithCapturedWork(
              () => commits.commit(request),
              (result) => result.kind === "committed" && !result.replayed,
            ),
          clockNow: () => clock.now(),
          nextRequestId: () => nextOpaque("uat-generated-source-request"),
        });

  const web = createProductWebHttpHandler({
    applicationOrigin: options.publicOrigin,
    csrf,
    mindUsage,
    performance: {
      record(event) {
        if (event.benchmarkCorrelationId !== null) {
          benchmarkCorrelations.set(event.requestId, event.benchmarkCorrelationId);
        }
        try {
          recordRuntimeMetric(telemetry, {
            kind: "operational",
            metric: "request_latency_ms",
            surface: "control",
            operation: event.operation,
            outcome: event.outcome,
            unit: "milliseconds",
            value: event.durationMs,
            occurredAtUtc: clock.now(),
            requestId: event.requestId as never,
            jobId: null,
            cohort: null,
          });
        } finally {
          benchmarkCorrelations.delete(event.requestId);
        }
      },
    },
    control: {
      async execute(request) {
        const result = await runWithCapturedWork(() =>
          request.operation === "get_invitations_overview"
            ? (async () => {
                await controlServices.reads.reconcileInvitationExpiries(
                  request.actor as never,
                );
                return metadata.withConsistentRead((store) =>
                  new ControlReadService(store).listInvitations(
                    request.actor as never,
                  ),
                );
              })()
            : control.execute(request));
        if (
          request.operation === "delete_account" &&
          request.actor.kind === "registered_principal"
        ) {
          try {
            await oauth.revokePrincipalConnections(String(request.actor.principalId));
          } catch {
            // The authoritative account cascade already revoked mirrored MCP
            // authorization records; normalized OAuth cleanup is best effort.
          }
        }
        return result;
      },
      withConsistentRead<Result>(
        operation: (readControl: ProductWebControlApplication) => Promise<Result>,
      ): Promise<Result> {
        return control.withConsistentRead(operation);
      },
    },
    resolveIdentity,
    oauthConnections: {
      listPage(principalId, query) {
        return oauth.listConnectionPage(principalId, query);
      },
      read(principalId, connectionRef) {
        return oauth.readConnection(principalId, connectionRef);
      },
      revoke(principalId, connectionRef) {
        return oauth.revokeConnection(principalId, connectionRef);
      },
    },
    personalTokens: {
      async listPage(actor, query) {
        await ensurePersonalTokenPresentationRefs();
        const page = await control.services.tokens.listPersonalTokenPage(actor as never, query);
        const items = await Promise.all(page.items.map(async (item) => {
          const metadataToken = await metadata.readMcpTokenMetadataByPresentationRef(
            actor.principalId,
            item.personalTokenRef,
          );
          if (metadataToken === null) {
            throw new Error("Personal token binding owner is unavailable");
          }
          return Object.freeze({
            ...item,
            bindingOwnerId: String(metadataToken.tokenId),
          });
        }));
        return Object.freeze({ items: Object.freeze(items), nextCursor: page.nextCursor });
      },
      async read(actor, personalTokenRef) {
        try {
          await ensurePersonalTokenPresentationRefs();
          const [item, metadataToken] = await Promise.all([
            control.services.tokens.readPersonalToken(actor as never, personalTokenRef as never),
            metadata.readMcpTokenMetadataByPresentationRef(
              actor.principalId,
              personalTokenRef as never,
            ),
          ]);
          return metadataToken === null
            ? null
            : Object.freeze({ ...item, bindingOwnerId: String(metadataToken.tokenId) });
        } catch (error) {
          if (
            typeof error === "object" && error !== null && "code" in error &&
            (error.code === "token_not_found" || error.code === "invalid_token_id")
          ) return null;
          throw error;
        }
      },
    },
    ...(options.webActivityEnabled === false ? {} : { activity }),
  });
  const exportDownload = createProductExportDownloadHttpHandler({
    async download(secret) {
      const actor = createBackgroundServiceActor({
        serviceId: "mind-diary-export-download",
        requestId: nextOpaque("download-request"),
        occurredAtUtc: clock.now(),
        deploymentCapabilities: Object.freeze(["content:export"]),
      });
      return exports.download({ actor, secret });
    },
  });
  const bundleFileDownload = createProductBundleFileDownloadHttpHandler({
    async download(secret) {
      const actor = createBackgroundServiceActor({
        serviceId: "mind-diary-bundle-file-download",
        requestId: nextOpaque("bundle-download-request"),
        occurredAtUtc: clock.now(),
        deploymentCapabilities: Object.freeze(["content:fetch"]),
      });
      return bundleFileDownloads.download(actor, secret);
    },
  });
  const fileUploadIntent = createFileUploadIntentHttpHandler({
    application: uploadIntents,
    publicOrigin: options.publicOrigin,
    nextRequestId: () => nextOpaque("file-upload-request"),
  });

  const indexJobs = new RevisionIndexJobHandler({ work: metadata, revisions, index, clock });
  const exportJobs = new ExportJobHandler({
    jobs: metadata,
    backgroundAuthorizer,
    builder: new DeterministicOkfExportService({ materializer: revisions, digest: objects }),
    archives: objects,
    clock,
  });
  const auditJobs = new AuditOutboxDeliveryHandler({ work: metadata, audit, clock });
  const invitationJobs = new InvitationExpiryJobHandler({
    jobs: metadata,
    clock,
    observability: backgroundObservability,
  });
  const exportExpiry = new ExportJobExpiryHandler({ jobs: metadata, archives: objects, clock });
  const objectCleanup = new BoundedObjectCleanupHandler({
    objects,
    checkpoints: metadata,
    reachability: metadata,
    staging: metadata,
    exports: metadata,
    clock,
    observability: backgroundObservability,
  });
  const dispatchBackground = createProductBackgroundDispatcher({
    serviceId: "mind-diary-sites-background",
    now: clock.now,
    requestId: () => nextOpaque("background-request"),
    handlers: {
      revisionIndex: async (actor, jobId) => {
        const startedAt = Date.now();
        try {
          const result = await indexJobs.handle({ actor, jobId: jobId as never });
          backgroundObservability.recordJob({
            actor,
            jobId: jobId as never,
            occurredAtUtc: clock.now(),
            job: "revision_index",
            outcome: result.kind === "completed" || result.kind === "already_completed"
              ? "success"
              : result.kind === "failed"
                ? isRevisionIndexTerminalFailureCode(result.failureCode)
                  ? "unresolved"
                  : "failure"
                : result.kind === "not_available"
                  ? "unavailable"
                  : "retry",
            lagMs: Math.max(0, Date.now() - startedAt),
          });
          return result;
        } catch (error) {
          backgroundObservability.recordJob({
            actor,
            jobId: jobId as never,
            occurredAtUtc: clock.now(),
            job: "revision_index",
            outcome: "failure",
            lagMs: Math.max(0, Date.now() - startedAt),
          });
          throw error;
        }
      },
      export: async (actor, jobId) => {
        const startedAt = Date.now();
        const exportActor = Object.freeze({
          ...actor,
          deploymentCapabilities: Object.freeze(["content:export"] as never),
        });
        try {
          const result = await exportJobs.handle({ actor: exportActor, jobId: jobId as never });
          const succeeded = result.kind === "completed" || result.kind === "already_completed";
          backgroundObservability.recordJob({
            actor,
            jobId: jobId as never,
            occurredAtUtc: clock.now(),
            job: "export",
            outcome: succeeded
              ? "success"
              : result.kind === "failed"
                ? "failure"
                : result.kind === "not_available"
                  ? "unavailable"
                  : "retry",
            lagMs: Math.max(0, Date.now() - startedAt),
          });
          if (succeeded) {
            backgroundObservability.recordExportUsage({
              actor,
              jobId: jobId as never,
              occurredAtUtc: clock.now(),
              count: 1,
            });
          }
          return result;
        } catch (error) {
          backgroundObservability.recordJob({
            actor,
            jobId: jobId as never,
            occurredAtUtc: clock.now(),
            job: "export",
            outcome: "failure",
            lagMs: Math.max(0, Date.now() - startedAt),
          });
          throw error;
        }
      },
      auditOutbox: (actor, messageId) => auditJobs.handle({ actor, outboxMessageId: messageId as never }),
      invitationExpiry: (actor, jobId) => invitationJobs.handle({ actor, jobId: jobId as never }),
      exportExpiry: (actor, jobId) => exportExpiry.handle({ actor, jobId: jobId as never }),
    },
  });

  const recoverBackground = async (
    requestedLimit = 16,
    mode: ProductSiteRecoveryMode = "full",
  ) => {
    if (mode !== "full" && mode !== "request") {
      throw new TypeError("unknown product recovery mode");
    }
    const requestTick = mode === "request";
    const limit = Number.isSafeInteger(requestedLimit)
      ? Math.max(1, Math.min(64, requestedLimit))
      : 16;
    const nowUtc = clock.now();
    const recoveryActor = createBackgroundServiceActor({
      serviceId: "mind-diary-sites-recovery",
      requestId: nextOpaque("background-request"),
      occurredAtUtc: nowUtc,
      deploymentCapabilities: Object.freeze([]),
    });
    const totalStartedAt = Date.now();
    const stage = async <Result>(
      operation:
        | "recovery_index_gaps"
        | "recovery_index_dispatch"
        | "recovery_invitation_expiry_dispatch"
        | "recovery_export_dispatch"
        | "recovery_staging_cleanup"
        | "recovery_import_cleanup"
        | "recovery_object_cleanup",
      run: () => Promise<Result>,
    ): Promise<Result> => {
      const startedAt = Date.now();
      try {
        const result = await run();
        backgroundObservability.recordRecoveryStage({
          actor: recoveryActor,
          occurredAtUtc: clock.now(),
          stage: operation,
          outcome: "success",
          durationMs: Date.now() - startedAt,
        });
        return result;
      } catch (error) {
        backgroundObservability.recordRecoveryStage({
          actor: recoveryActor,
          occurredAtUtc: clock.now(),
          stage: operation,
          outcome: "failure",
          durationMs: Date.now() - startedAt,
        });
        throw error;
      }
    };
    try {
      const reconciliation = await stage("recovery_index_gaps", async () => {
        const candidates = await metadata.listActiveRevisionIndexRecoveryCandidates(limit);
        let backfilled = 0;
        let repaired = 0;
        for (const candidate of candidates) {
          if (candidate.reason === "verify_ready_projection") {
            const projected = index.inspectExactRevision === undefined
              ? await index.readExactRevision(candidate.spaceId, candidate.revisionId)
              : await index.inspectExactRevision(candidate.spaceId, candidate.revisionId);
            if (projected.kind === "ready" &&
                projected.spaceId === candidate.spaceId &&
                projected.revisionId === candidate.revisionId) {
              continue;
            }
          }
          const jobId = nextOpaque("job-index-recovery");
          const job = Object.freeze({
              jobId,
              target: Object.freeze({
                kind: "revision_index" as const,
                spaceId: candidate.spaceId,
                revisionId: candidate.revisionId,
              }),
              state: "queued" as const,
              version: version(1),
              attempts: 0,
              availableAt: nowUtc,
              claimExpiresAt: null,
              createdAt: nowUtc,
              updatedAt: nowUtc,
            });
          const state = Object.freeze({
              spaceId: candidate.spaceId,
              revisionId: candidate.revisionId,
              status: "queued" as const,
              attempts: 0,
              queuedAt: nowUtc,
              updatedAt: nowUtc,
              readyAt: null,
              lastFailureCode: null,
            });
          const ensured = candidate.reason === "metadata_missing"
            ? await metadata.ensureRevisionIndexQueued(job, state)
            : candidate.reason === "metadata_inconsistent"
              ? await metadata.repairRevisionIndexQueued(
                  job,
                  state,
                  Object.freeze({ kind: "metadata_inconsistent" as const }),
                )
              : await metadata.repairRevisionIndexQueued(
                  job,
                  state,
                  Object.freeze({
                    kind: "physical_index_missing" as const,
                    expectedReadyJobId: candidate.observedJobId,
                    expectedReadyJobVersion: candidate.observedJobVersion,
                  }),
                );
          if (ensured.kind !== "queued") continue;
          if (candidate.reason === "metadata_missing") backfilled += 1;
          else repaired += 1;
        }
        return Object.freeze({ backfilled, repaired });
      });
      const results = await stage("recovery_index_dispatch", async () => {
        const due = await metadata.listRecoverableIndexJobs(clock.now(), limit);
        const settled: PromiseSettledResult<unknown>[] = [];
        for (const job of due) {
          try {
            settled.push({
              status: "fulfilled",
              value: await dispatchBackground({ kind: "revision_index", jobId: job.jobId }),
            });
          } catch (reason) {
            settled.push({ status: "rejected", reason });
          }
        }
        return settled;
      });
      const invitationResults = await stage(
        "recovery_invitation_expiry_dispatch",
        async () => {
          const due = await metadata.listRecoverableInvitationExpiryJobs(
            clock.now(),
            limit,
          );
          const settled: PromiseSettledResult<unknown>[] = [];
          for (const job of due) {
            backgroundObservability.recordInvitationExpiry({
              actor: recoveryActor,
              jobId: job.jobId,
              occurredAtUtc: nowUtc,
              outcome: "due",
              lagMs: Math.max(0, Date.parse(nowUtc) - Date.parse(job.availableAt)),
            });
            try {
              settled.push({
                status: "fulfilled",
                value: await dispatchBackground({
                  kind: "invitation_expiry",
                  jobId: job.jobId,
                }),
              });
            } catch (reason) {
              settled.push({ status: "rejected", reason });
            }
          }
          return settled;
        },
      );
      const exportResults = requestTick
        ? []
        : await stage("recovery_export_dispatch", async () => {
            const due = await metadata.listRecoverableExportJobs(clock.now(), limit);
            const settled: PromiseSettledResult<unknown>[] = [];
            for (const job of due) {
              try {
                settled.push({
                  status: "fulfilled",
                  value: await dispatchBackground({ kind: "export", jobId: job.jobId }),
                });
              } catch (reason) {
                settled.push({ status: "rejected", reason });
              }
            }
            return settled;
          });
      let cleanupDeleted = 0;
      let cleanupReclaimedBytes = 0;
      let cleanupFailures = 0;
      if (!requestTick) {
        try {
          const staged = await stage(
            "recovery_staging_cleanup",
            () => bundleFileStaging.collectExpired(),
          );
          cleanupDeleted += staged.deleted;
          cleanupReclaimedBytes += staged.bytes;
          const expiredIntents = await stage(
            "recovery_staging_cleanup",
            () => uploadIntentCleanup.run(),
          );
          cleanupDeleted += expiredIntents.deleted;
          const imported = await stage(
            "recovery_import_cleanup",
            () => markdownImports.collectExpired({
              maxSessions: Math.min(16, limit),
              maxFiles: limit,
            }),
          );
          cleanupDeleted += imported.deleted;
          cleanupReclaimedBytes += imported.reclaimedBytes;
          const cleaned = await stage(
            "recovery_object_cleanup",
            () => objectCleanup.handle({
              actor: recoveryActor,
              createdBefore: new Date(
                Date.parse(nowUtc) - BUNDLE_FILE_LIMITS.gcSafetyMilliseconds,
              ).toISOString(),
              maxObjects: limit,
              maxBytes: BUNDLE_FILE_LIMITS.gcMaxBytes,
              maxDurationMs: 5_000,
            }),
          );
          cleanupDeleted += cleaned.deleted;
          cleanupReclaimedBytes += cleaned.reclaimedBytes;
        } catch {
          cleanupFailures = 1;
        }
      }
      const result = Object.freeze({
        backfilled: reconciliation.backfilled,
        repaired: reconciliation.repaired,
        dispatched:
          results.length + invitationResults.length + exportResults.length,
        failed:
          results.filter((entry) =>
            entry.status === "rejected" ||
            (typeof entry.value === "object" && entry.value !== null &&
              "kind" in entry.value && entry.value.kind === "failed")
          ).length +
          invitationResults.filter((entry) =>
            entry.status === "rejected" ||
            (typeof entry.value === "object" && entry.value !== null &&
              "kind" in entry.value && entry.value.kind === "failed")
          ).length +
          exportResults.filter((entry) =>
            entry.status === "rejected" ||
            (typeof entry.value === "object" && entry.value !== null &&
              "kind" in entry.value && entry.value.kind === "failed")
          ).length +
          cleanupFailures,
        cleanupDeleted,
        cleanupReclaimedBytes,
      });
      backgroundObservability.recordRecoveryStage({
        actor: recoveryActor,
        occurredAtUtc: clock.now(),
        stage: "recovery_total",
        outcome: result.failed === 0 ? "success" : "failure",
        durationMs: Date.now() - totalStartedAt,
      });
      return result;
    } catch (error) {
      backgroundObservability.recordRecoveryStage({
        actor: recoveryActor,
        occurredAtUtc: clock.now(),
        stage: "recovery_total",
        outcome: "failure",
        durationMs: Date.now() - totalStartedAt,
      });
      throw error;
    }
  };

  return Object.freeze({
    boundedInMemoryIngress,
    serverGeneratedIngress,
    dispatchBackground,
    recoverBackground,
    async fetch(
      request: Request,
      deferActivity?: (promise: Promise<unknown>) => void,
    ): Promise<Response | null> {
      request = await trustedPerformanceRequest(request);
      const path = new URL(request.url).pathname;
      const oauthResponse = await oauth.fetch(request);
      if (oauthResponse !== null) return oauthResponse;
      if (path === MCP_ENDPOINT) return handleMcp(request, "modern", deferActivity);
      if (path === MCP_APPS_ENDPOINT) return handleMcp(request, "apps", deferActivity);
      if (path === MCP_LEGACY_CODEX_ENDPOINT) {
        return handleMcp(request, "compatibility", deferActivity);
      }
      if (path === MCP_RETIRED_SITES_ENDPOINT) {
        return new Response(
          JSON.stringify({
            type: "about:blank",
            title: "Not Found",
            status: 404,
            code: "route_not_found",
          }),
          {
            status: 404,
            headers: {
              "cache-control": "no-store",
              "content-type": "application/problem+json; charset=utf-8",
            },
          },
        );
      }
      const startedAt = Date.now();
      const exportRequest = path.startsWith("/api/v1/exports/");
      const bundleFileRequest = path.startsWith("/api/bundle-download/");
      const fileUploadRequest = path.startsWith(
        FILE_UPLOAD_INTENT_ROUTE_PREFIX,
      );
      try {
        const response =
          (await restrictedUatGeneratedSourceHandler(request)) ??
          (await exportDownload(request)) ??
          (await bundleFileDownload(request)) ??
          (await fileUploadIntent(request)) ??
          await web(request, deferActivity);
        if (response !== null) {
          const surface =
            exportRequest || bundleFileRequest || fileUploadRequest
              ? "content" as const
              : "control" as const;
          const operation = exportRequest
            ? "export" as const
            : bundleFileRequest
              ? "get_bundle_file_download" as const
              : fileUploadRequest
                ? request.method === "PUT"
                  ? "stage_bundle_file" as const
                  : "reconcile_file_stage" as const
                : "request" as const;
          recordRuntimeMetric(telemetry, {
            kind: "operational",
            metric: "request_latency_ms",
            surface,
            operation,
            outcome: response.status >= 400 ? "failure" : "success",
            unit: "milliseconds",
            value: Math.max(0, Date.now() - startedAt),
            occurredAtUtc: clock.now(),
            requestId: null,
            jobId: null,
            cohort: null,
          });
          if (response.status === 401) {
            recordRuntimeMetric(telemetry, {
              kind: "operational",
              metric: "authentication_outcome",
              surface,
              operation: "authentication",
              outcome: "denied",
              unit: "count",
              value: 1,
              occurredAtUtc: clock.now(),
              requestId: null,
              jobId: null,
              cohort: null,
            });
          }
          if (response.status >= 500) {
            recordRuntimeMetric(telemetry, {
              kind: "operational",
              metric: "request_error",
              surface,
              operation: response.status === 503 ? "storage" : operation,
              outcome: response.status === 503 ? "unavailable" : "failure",
              unit: "count",
              value: 1,
              occurredAtUtc: clock.now(),
              requestId: null,
              jobId: null,
              cohort: null,
            });
          }
        }
        return response;
      } catch (error) {
        recordRuntimeMetric(telemetry, {
          kind: "operational",
          metric: "request_error",
          surface:
            exportRequest || bundleFileRequest || fileUploadRequest
              ? "content"
              : "control",
          operation: "storage",
          outcome: "unavailable",
          unit: "count",
          value: 1,
          occurredAtUtc: clock.now(),
          requestId: null,
          jobId: null,
          cohort: null,
        });
        throw error;
      }
    },
  });
}
