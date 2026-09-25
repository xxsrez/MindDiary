import assert from "node:assert/strict";
import test from "node:test";

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
        }] },
        { method: "createExportJob", args: [{ jobId, spaceId }] },
      ],
    }),
  };
}

test("UAT191 capacity summary never exposes another owner's identifiers", async () => {
  const snapshot = JSON.stringify({
    v: 1, metadata: {
      memberships: encodedMap([["membership-own", {
        principalId: "principal_owner", spaceId: OWN, state: "active", role: "owner",
      }]]),
      capacityReservations: encodedMap([
        [ownId, { reservationId: ownId, spaceId: OWN, heavy: true,
          createdAt: "2026-09-21T10:00:01.000Z", state: "released", updatedAt: "2026-09-21T12:00:00.000Z" }],
        [foreignId, { reservationId: foreignId, spaceId: FOREIGN, heavy: true,
          createdAt: "2026-09-21T10:00:02.000Z", state: "active", updatedAt: "2026-09-21T10:00:02.000Z" }],
      ]),
    }, tokens: {},
  });
  const database = {
    prepare(sql) {
      return {
        bind() { return this; },
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
            success: true, results: [{ sequence: 1268, payload_json: snapshot,
              updated_at: "2026-08-23T02:11:42.275Z" }],
          };
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
  const handler = createUat191CapacityHistory({ database,
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
  assert.equal(JSON.stringify(body).includes(foreignId), false);
  assert.equal(JSON.stringify(body).includes(FOREIGN), false);
  assert.equal(JSON.stringify(body).includes("job-foreign"), false);
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
