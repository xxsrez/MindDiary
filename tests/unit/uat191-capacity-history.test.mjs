import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryRevisionMetadataStore } from "../../packages/adapter-metadata-memory/dist/index.js";
import { DEFAULT_CAPACITY_LIMITS } from "../../packages/application-content/dist/capacity.js";

import {
  authorizedUat191CapacityActor,
  createUat191CapacityHistory,
} from "../../packages/composition-root/dist/uat191-capacity-history.js";

const OWN = "space_owned";
const FOREIGN = "space_foreign";
const ownId = `capacity:export:${OWN}:job-own`;
const foreignId = `capacity:export:${FOREIGN}:job-foreign`;

function encodedMap(entries) {
  return { __md_sites_type: "map", entries };
}

function encodeDurable(value) {
  return JSON.stringify(value, (_key, item) => {
    if (item === undefined) return { __md_sites_type: "undefined" };
    if (item instanceof Uint8Array) return { __md_sites_type: "uint8array", bytes: [...item] };
    if (item instanceof Map) return encodedMap([...item.entries()]);
    if (item instanceof Set) return { __md_sites_type: "set", values: [...item.values()] };
    return item;
  });
}

function event(sequence, reservationId, spaceId, jobId) {
  return {
    sequence,
    committed_at: `2026-09-21T10:00:0${sequence}.000Z`,
    payload_json: JSON.stringify({
      v: 1, kind: "transaction", target: "metadata", method: "runExportStartTransaction",
      calls: [
        { method: "admitCapacityReservation", args: [{
          reservationId, spaceId, operation: "export", operationRef: jobId,
          heavy: true, createdAt: `2026-09-21T10:00:0${sequence}.000Z`,
          expiresAt: `2026-09-22T10:00:0${sequence}.000Z`,
          requested: { physicalCanonicalBytes: 0, temporaryBytes: 4096,
            d1MetadataBytes: 1280 },
        }] },
        { method: "createExportJob", args: [{ jobId, spaceId }] },
      ],
    }),
  };
}

test("UAT191 capacity summary never exposes another owner's identifiers", async () => {
  let incidentOperation = "runExportStartTransaction";
  const legacySnapshot = encodeDurable({ v: 1,
    metadata: new InMemoryRevisionMetadataStore().exportDurableSnapshot(), tokens: {} });
  const snapshot = JSON.stringify({
    v: 1, metadata: {
      memberships: encodedMap([["membership-own", {
        principalId: "principal_owner", spaceId: OWN, state: "active", role: "owner",
      }]]),
      exportJobs: encodedMap([["job-own", { jobId: "job-own", spaceId: OWN,
        state: "completed", updatedAt: "2026-09-25T12:00:00.000Z" }]]),
      capacityReservations: encodedMap([
        [ownId, { reservationId: ownId, spaceId: OWN, heavy: true,
          operation: "export", operationRef: "job-own",
          createdAt: "2026-09-21T10:00:01.000Z", expiresAt: "2026-09-22T10:00:01.000Z",
          requested: { physicalCanonicalBytes: 0, temporaryBytes: 4096,
            d1MetadataBytes: 1280 }, actual: null,
          state: "released", updatedAt: "2026-09-25T12:00:00.000Z" }],
        [foreignId, { reservationId: foreignId, spaceId: FOREIGN, heavy: true,
          createdAt: "2026-09-21T10:00:02.000Z", state: "active", updatedAt: "2026-09-21T10:00:02.000Z" }],
      ]),
    }, tokens: {},
  });
  const database = {
    prepare(sql) {
      return {
        bind(...args) { this.args = args; return this; },
        async all() {
          if (sql.includes("/*md485-capacity-head*/")) return { success: true, results: [{
            sequence: 13040, chunk_count: 1, payload_chars: snapshot.length,
            updated_at: "2026-09-25T00:00:00.000Z",
          }] };
          if (sql.includes("/*md485-capacity-chunks*/")) return { success: true,
            results: [{ chunk_index: 0, payload_json: snapshot }] };
          if (sql.includes("/*md485-capacity-historical-stats*/")) return {
            success: true, results: [{ event_count: 11756, payload_chars: 100000,
              first_sequence: 1269, last_sequence: 13024 }],
          };
          if (sql.includes("/*md485-capacity-legacy-snapshot*/")) return {
            success: true, results: [{ sequence: 1268, payload_json: legacySnapshot,
              updated_at: "2026-08-23T02:11:42.275Z" }],
          };
          if (sql.includes("/*md485-capacity-replay*/")) {
            const [first, last] = this.args;
            return { success: true, results: Array.from(
              { length: Math.min(512, last - first + 1) }, (_, index) => {
                const sequence = first + index;
                if (sequence === 13025) return {
                  sequence, target: "metadata", operation: incidentOperation,
                  committed_at: "2026-09-21T15:40:15.540Z",
                  payload_json: encodeDurable({ v: 1, kind: "transaction", target: "metadata",
                    method: incidentOperation, calls: [{
                      method: "admitCapacityReservation", args: [{
                        reservationId: ownId, requestedByPrincipalId: "principal_owner",
                        spaceId: OWN, operation: "export", operationRef: "job-own",
                        baseRevisionId: null, idempotencyKey: "test-export-key",
                        requested: { physicalCanonicalBytes: 0, temporaryBytes: 1024,
                          d1MetadataBytes: 1280 }, bulk: true,
                        heavy: true, createdAt: "2026-09-21T15:40:15.540Z",
                        expiresAt: "2026-09-22T15:40:15.540Z",
                      }, DEFAULT_CAPACITY_LIMITS],
                    }] }),
                };
                return { sequence, target: "tokens", operation: "noop",
                  committed_at: "2026-09-21T10:00:00.000Z",
                  payload_json: '{"v":1,"kind":"direct","target":"tokens","method":"noop","args":[]}' };
              }) };
          }
          if (sql.includes("/*md485-target-collectors*/")) {
            assert.match(sql, /sequence BETWEEN \?1 AND \?2/u);
            assert.match(sql, /operation = 'collectExpiredCapacityReservations'/u);
            assert.deepEqual(this.args.slice(0, 4), [1269, 13027,
              "2026-09-21T15:40:15.540Z", "2026-09-21T15:41:52.951Z"]);
            return { success: true, results: [{ before_export: 2,
              export_to_import: 1, since_expiry_0: 1 }] };
          }
          if (sql.includes("/*md485-target-incident*/")) {
            assert.match(sql, /sequence = 13025/u);
            return { success: true, results: [{ sequence: 13025,
              committed_at: "2026-09-21T15:40:15.540Z",
              payload_json: JSON.stringify({ v: 1, kind: "transaction", target: "metadata",
                method: "runExportStartTransaction", calls: [{
                  method: "admitCapacityReservation", args: [{
                    reservationId: `capacity:export:${OWN}:job-incident`,
                    spaceId: OWN, operation: "export", heavy: true,
                    createdAt: "2026-09-21T15:40:15.540Z",
                    requested: { physicalCanonicalBytes: 0,
                      temporaryBytes: 8192, d1MetadataBytes: 2048 },
                  }],
                }] }),
            }] };
          }
          if (sql.includes("/*md485-incident-prior*/")) {
            assert.match(sql, /sequence BETWEEN 1269 AND 13024/u);
            assert.deepEqual(this.args, [`capacity:export:${OWN}:job-incident`]);
            return { success: true, results: [] };
          }
          if (sql.includes("/*md485-target-related*/")) {
            assert.match(sql, /sequence BETWEEN \?1 AND \?2/u);
            assert.deepEqual(this.args, [1269, 13040, ownId]);
            return { success: true, results: [event(1, ownId, OWN, "job-own"),
              event(2, foreignId, FOREIGN, "job-own"),
              { sequence: 3, committed_at: "2026-09-21T10:00:03.000Z",
                payload_json: JSON.stringify({ v: 1, kind: "direct", target: "metadata",
                  method: "updateUnrelatedEntry", args: [{ spaceId: FOREIGN,
                    body: `contains ${ownId} but is unrelated` }] }) }],
            };
          }
          if (sql.includes("/*md485-capacity-events*/")) {
            assert.match(sql, /completeExpiredExportCleanup/u);
            return { success: true,
            results: [event(1, ownId, OWN, "job-own"),
              event(2, foreignId, FOREIGN, "job-foreign"),
              { sequence: 3, committed_at: "2026-09-21T10:00:03.000Z",
                payload_json: JSON.stringify({ v: 1, kind: "direct", target: "metadata",
                  method: "completeExpiredExportCleanup",
                  args: ["job-own", 2, "2026-09-21T10:00:03.000Z"],
                }) },
              { sequence: 4, committed_at: "2026-09-21T10:00:04.000Z",
                payload_json: JSON.stringify({ v: 1, kind: "transaction", target: "metadata",
                  method: "runExportStartTransaction", calls: [{ method: "admitCapacityReservation",
                    args: [{ reservationId: foreignId, spaceId: FOREIGN, operation: "export",
                      operationRef: "job-foreign", heavy: true,
                      createdAt: "2026-09-21T10:00:04.000Z",
                      expiresAt: "2026-09-22T10:00:04.000Z" }] }],
                }) }] };
          }
          throw new Error("unexpected query");
        },
      };
    },
  };
  const handler = createUat191CapacityHistory({ database, replay: true,
    authorizedActor: async () => ({ principalId: "principal_owner", mindId: OWN }) });
  const result = await handler(new Request(
    "https://mind-diary.example.invalid/api/v1/internal/operators/diagnostics/md485-uat191-capacity",
  ));
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.deepEqual(body.data.distinct_heavy_admission_ids_seen,
    { target: 1, owned_other: 0, site_other: 1 });
  assert.deepEqual(body.data.creation_confirmed_by_followup,
    { target: 1, owned_other: 0, site_other: 1 });
  assert.deepEqual(body.data.confirmed_with_terminal_call_before_cutoff,
    { target: 1, owned_other: 0, site_other: 0 });
  assert.deepEqual(body.data.confirmed_without_terminal_call_unexpired_at_cutoff,
    { target: 0, owned_other: 0, site_other: 1 });
  assert.equal(body.data.target_reservations[0].reservation_id, ownId);
  assert.equal(body.data.historical_replay_feasibility.contiguous_by_count, true);
  assert.equal(body.data.historical_replay.status, "replayed_under_current_semantics",
    JSON.stringify(body.data.historical_replay));
  assert.equal(body.data.historical_replay.before_export.active_heavy_site, 0);
  assert.equal(JSON.stringify(body).includes(foreignId), false);
  assert.equal(JSON.stringify(body).includes(FOREIGN), false);
  assert.equal(JSON.stringify(body).includes("job-foreign"), false);
  incidentOperation = "runCapacityTransaction";
  const mismatched = await handler(new Request(
    "https://mind-diary.example.invalid/api/v1/internal/operators/diagnostics/md485-uat191-capacity",
  ));
  assert.equal((await mismatched.json()).data.historical_replay.status,
    "incompatible_or_unavailable");
  const boundedHandler = createUat191CapacityHistory({ database,
    authorizedActor: async () => ({ principalId: "principal_owner", mindId: OWN }) });
  const bounded = await boundedHandler(new Request(
    "https://mind-diary.example.invalid/api/v1/internal/operators/diagnostics/md485-uat191-capacity",
  ));
  const boundedBody = await bounded.json();
  assert.equal(boundedBody.data.historical_replay.status, "skipped_after_hosted_timeout");
  assert.deepEqual(boundedBody.data.snapshot_rows_created_before_cutoff_possible_active,
    { target: 1, owned_other: 0, site_other: 1 });
  assert.equal(boundedBody.data.target_candidate_traces[0].reservation_id, ownId);
  assert.equal(boundedBody.data.target_candidate_traces[0].related_calls.length, 1);
  assert.deepEqual(boundedBody.data.target_candidate_traces[0].requested_at_snapshot,
    { physicalCanonicalBytes: 0, temporaryBytes: 4096, d1MetadataBytes: 1280 });
  assert.equal(boundedBody.data.target_candidate_traces[0].admission_matches_snapshot,
    true);
  assert.equal(boundedBody.data.incident_export_request.prior_admission_calls_with_same_id, 0);
  assert.deepEqual(boundedBody.data.incident_export_request.requested,
    { physicalCanonicalBytes: 0, temporaryBytes: 8192, d1MetadataBytes: 2048 });
  assert.deepEqual(boundedBody.data.target_candidate_traces[0].related_calls[0].methods,
    ["admitCapacityReservation", "createExportJob"]);
  assert.equal(boundedBody.data.collector_counts.before_export, 2);
  assert.equal(boundedBody.data.collector_counts.export_to_import, 1);
  assert.equal(boundedBody.data.collector_counts
    .since_target_expiry_before_export[0].count, 1);
  assert.equal(JSON.stringify(boundedBody).includes(foreignId), false);
});

test("UAT191 capacity summary fails closed for an unauthorized caller", async () => {
  const handler = createUat191CapacityHistory({ database: { prepare() {
    throw new Error("database must not be read");
  } }, authorizedActor: async () => null });
  const result = await handler(new Request(
    "https://mind-diary.example.invalid/api/v1/internal/operators/diagnostics/md485-uat191-capacity",
  ));
  assert.equal(result.status, 404);
});

test("UAT191 capacity actor requires Sites identity, operator allowlist, and current ownership", async () => {
  let identity = { kind: "authenticated", actor: {
    principalId: "principal_owner", authentication: { kind: "sites_identity" },
  } };
  let role = "owner";
  const authorize = authorizedUat191CapacityActor({
    resolveIdentity: async () => identity,
    operatorPrincipalIds: new Set(["principal_owner"]),
    resolveTargetMind: async () => ({ mindId: OWN, isPersonal: false,
      access: { kind: "membership", role } }),
  });
  const request = new Request("https://mind-diary.example.invalid/");
  assert.deepEqual(await authorize(request),
    { principalId: "principal_owner", mindId: OWN });
  role = "reader";
  assert.equal(await authorize(request), null);
  role = "owner";
  identity = { kind: "authenticated", actor: {
    principalId: "principal_owner", authentication: { kind: "bearer_token" },
  } };
  assert.equal(await authorize(request), null);
});
