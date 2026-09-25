import assert from "node:assert/strict";
import test from "node:test";
import {
  createUat191IncidentDiagnostic,
  projectUat191Event,
  UAT191_INCIDENT_DIAGNOSTIC_PATH,
} from "../../packages/composition-root/dist/uat191-incident-diagnostic.js";

const ORIGIN = "https://mind-diary.example.test";
const MIND_ID = "space_target";

function row(sequence, spaceId = MIND_ID) {
  return {
    sequence,
    target: "metadata",
    operation: "runCapacityReservationTransaction",
    committed_at: "2026-09-21T15:40:00.000Z",
    payload_json: JSON.stringify({
      v: 1,
      kind: "transaction",
      target: "metadata",
      method: "runCapacityReservationTransaction",
      calls: [{
        method: "reserveCapacity",
        args: [{
          spaceId,
          reservationId: `capacity:export:${spaceId}:operation_${sequence}`,
          operation: "export",
          heavy: true,
          expiresAt: "2026-09-22T15:40:00.000Z",
          requested: { temporaryBytes: 66182 },
          email: "private@example.test",
          content: "private Markdown",
          path: "wiki/private.md",
          token: "secret-token",
        }],
      }],
    }),
  };
}

test("UAT191 projection keeps target accounting and excludes unrelated/private event data", () => {
  const projected = projectUat191Event(row(7), MIND_ID);
  assert.equal(projected.sequence, 7);
  assert.deepEqual(projected.calls[0].details, {
    reservationId: "capacity:export:space_target:operation_7",
    expiresAt: "2026-09-22T15:40:00.000Z",
    operation: "export",
    heavy: true,
    requested: { temporaryBytes: 66182 },
  });
  assert.equal(projectUat191Event(row(8, "space_other"), MIND_ID), null);
  const unrelated = row(8, "space_other");
  const unrelatedPayload = JSON.parse(unrelated.payload_json);
  unrelatedPayload.calls[0].args[0].content = "capacity:export:space_target:operation_7";
  assert.equal(projectUat191Event({ ...unrelated, payload_json: JSON.stringify(unrelatedPayload) }, MIND_ID), null);
  const text = JSON.stringify(projected);
  for (const secret of ["private@example.test", "private Markdown", "wiki/private.md", "secret-token"]) {
    assert.equal(text.includes(secret), false, secret);
  }
});

test("UAT191 links consume and cancel calls by the exact target reservation ID", () => {
  for (const method of ["consumeCapacityReservation", "cancelCapacityReservation"]) {
    const event = row(9);
    const payload = JSON.parse(event.payload_json);
    payload.calls = [{ method, args: [{
      reservationId: "capacity:export:space_target:operation_7",
      consumedAt: "2026-09-21T15:39:00.000Z",
      actual: { temporaryBytes: 4096 },
    }] }];
    const linked = projectUat191Event({ ...event, payload_json: JSON.stringify(payload) }, MIND_ID);
    assert.equal(linked.calls[0].method, method);
    assert.equal(linked.calls[0].details.reservationId, "capacity:export:space_target:operation_7");
    assert.equal(projectUat191Event({
      ...event,
      payload_json: JSON.stringify({ ...payload, calls: [{ method, args: [{
        reservationId: "capacity:export:space_other:space_target",
      }] }] }),
    }, MIND_ID), null);
  }
});

test("temporary diagnostic requires authorization and rejects unbounded query", async () => {
  let databaseCalls = 0;
  const database = { prepare() { databaseCalls++; throw new Error("must not query"); } };
  const denied = createUat191IncidentDiagnostic({ database, authorizedMindId: async () => null });
  assert.equal((await denied(new Request(ORIGIN + UAT191_INCIDENT_DIAGNOSTIC_PATH))).status, 404);
  const allowed = createUat191IncidentDiagnostic({ database, authorizedMindId: async () => MIND_ID });
  assert.equal((await allowed(new Request(ORIGIN + UAT191_INCIDENT_DIAGNOSTIC_PATH + "?start=2020"))).status, 400);
  assert.equal((await allowed(new Request(ORIGIN + UAT191_INCIDENT_DIAGNOSTIC_PATH + "?before=0"))).status, 400);
  assert.equal((await allowed(new Request(ORIGIN + UAT191_INCIDENT_DIAGNOSTIC_PATH, { method: "POST" }))).status, 404);
  assert.equal(databaseCalls, 0);
});

test("temporary diagnostic pages fixed-window D1 events without returning raw payload", async () => {
  const queries = [];
  const rows = Array.from({ length: 41 }, (_, index) => row(50 - index));
  const database = {
    prepare(sql) {
      queries.push(sql);
      return {
        bind(...values) {
          queries.push(values);
          return { async all() { return { success: true, results: rows }; } };
        },
      };
    },
  };
  const handler = createUat191IncidentDiagnostic({ database, authorizedMindId: async () => MIND_ID });
  const result = await handler(new Request(ORIGIN + UAT191_INCIDENT_DIAGNOSTIC_PATH));
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("cache-control"), "no-store");
  const payload = await result.json();
  assert.equal(payload.data.events.length, 40);
  assert.equal(payload.data.next_before, 11);
  assert.deepEqual(queries[1], ["2026-09-20T15:30:00.000Z", "2026-09-21T16:00:00.000Z", Number.MAX_SAFE_INTEGER, MIND_ID, 41]);
  assert.match(queries[0], /instr\(payload_json, \?4\) > 0/u);
  assert.equal(JSON.stringify(payload).includes("private@example.test"), false);
});
