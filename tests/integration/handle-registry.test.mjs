import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryHandleRegistry } from "@mind-diary/adapter-metadata-memory";
import { opaqueId, verifiedSpaceHost } from "@mind-diary/domain";

const HOST_A = verifiedSpaceHost("alpha.example");
const HOST_B = verifiedSpaceHost("beta.example");

function space(value) {
  return opaqueId(value);
}

function reservation(host, handle, spaceId) {
  return { host, handle, spaceId };
}

test("reservation is host-scoped, exact retry is idempotent and handle identity is immutable", async () => {
  const registry = new InMemoryHandleRegistry();
  const firstSpace = space("space_first");
  const secondSpace = space("space_second");

  const first = await registry.reserveHandle(reservation(HOST_A, "shared-notes", firstSpace));
  assert.equal(first.kind, "reserved");
  assert.equal(first.replayed, false);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.reservation));

  const replay = await registry.reserveHandle(reservation(HOST_A, "shared-notes", firstSpace));
  assert.equal(replay.kind, "reserved");
  assert.equal(replay.replayed, true);
  assert.equal(replay.reservation.spaceId, firstSpace);

  assert.deepEqual(
    await registry.reserveHandle(reservation(HOST_A, "other-notes", firstSpace)),
    { kind: "immutable_handle" },
  );
  assert.deepEqual(
    await registry.reserveHandle(reservation(HOST_A, "shared-notes", secondSpace)),
    { kind: "handle_unavailable" },
  );
  assert.equal(
    (await registry.resolveHandle({ host: HOST_A, handle: "shared-notes" })).spaceId,
    firstSpace,
  );

  const crossHost = await registry.reserveHandle(
    reservation(HOST_B, "shared-notes", secondSpace),
  );
  assert.equal(crossHost.kind, "reserved");
  assert.equal(
    (await registry.resolveHandle({ host: HOST_B, handle: "shared-notes" })).spaceId,
    secondSpace,
  );
  assert.equal(registry.snapshot().reservations.length, 2);
});

test("reserved, occupied and retired handles share one availability failure", async () => {
  const registry = new InMemoryHandleRegistry();
  const owner = space("space_owner");
  const candidate = space("space_candidate");
  const generic = { kind: "handle_unavailable" };

  for (const reserved of ["me", "admin"]) {
    assert.deepEqual(
      await registry.reserveHandle(reservation(HOST_A, reserved, owner)),
      generic,
    );
  }
  assert.equal(registry.snapshot().reservations.length, 0);

  assert.equal(
    (await registry.reserveHandle(reservation(HOST_A, "occupied", owner))).kind,
    "reserved",
  );
  assert.deepEqual(
    await registry.reserveHandle(reservation(HOST_A, "occupied", candidate)),
    generic,
  );
  assert.equal(registry.snapshot().reservations.length, 1);

  assert.equal(
    (await registry.retireHandle({ host: HOST_A, handle: "occupied", spaceId: owner })).kind,
    "retired",
  );
  assert.deepEqual(
    await registry.reserveHandle(reservation(HOST_A, "occupied", candidate)),
    generic,
  );
  assert.deepEqual(
    await registry.resolveHandle({ host: HOST_A, handle: "occupied" }),
    { kind: "not_found" },
  );
});

test("non-canonical equivalents cannot create aliases and failures preserve final state", async () => {
  const registry = new InMemoryHandleRegistry();
  const owner = space("space_canonical");
  assert.equal(
    (await registry.reserveHandle(reservation(HOST_A, "abc", owner))).kind,
    "reserved",
  );

  for (const equivalent of ["ａｂｃ", "%61bc"]) {
    assert.deepEqual(
      await registry.reserveHandle(reservation(HOST_A, equivalent, space("space_alias"))),
      { kind: "invalid_handle", reason: "non_canonical" },
    );
    assert.deepEqual(
      await registry.resolveHandle({ host: HOST_A, handle: equivalent }),
      { kind: "not_found" },
    );
  }
  const snapshot = registry.snapshot();
  assert.equal(snapshot.reservations.length, 1);
  assert.equal(snapshot.reservations[0].canonicalHandle, "abc");
  assert.equal(snapshot.retiredMarkers.length, 0);
});

test("concurrent conflicting reservations have exactly one winner", async () => {
  const registry = new InMemoryHandleRegistry();
  const candidates = Array.from({ length: 24 }, (_, index) =>
    space(`space_racer_${String(index)}`),
  );
  const results = await Promise.all(
    candidates.map((spaceId) =>
      registry.reserveHandle(reservation(HOST_A, "race-handle", spaceId)),
    ),
  );
  const winners = results
    .map((result, index) => ({ result, spaceId: candidates[index] }))
    .filter(({ result }) => result.kind === "reserved");
  assert.equal(winners.length, 1);
  assert.equal(results.filter((result) => result.kind === "handle_unavailable").length, 23);
  assert.deepEqual(await registry.resolveHandle({ host: HOST_A, handle: "race-handle" }), {
    kind: "resolved",
    spaceId: winners[0].spaceId,
  });
  assert.equal(registry.snapshot().reservations.length, 1);
});

test("retirement is permanent and retains no Space, owner or content link", async () => {
  const registry = new InMemoryHandleRegistry();
  const owner = space("space_to_delete");
  const stranger = space("space_stranger");
  await registry.reserveHandle(reservation(HOST_A, "retired-mind", owner));

  assert.deepEqual(
    await registry.retireHandle({
      host: HOST_A,
      handle: "retired-mind",
      spaceId: stranger,
    }),
    { kind: "not_found" },
  );
  assert.equal(registry.snapshot().reservations.length, 1);

  const retired = await registry.retireHandle({
    host: HOST_A,
    handle: "retired-mind",
    spaceId: owner,
  });
  assert.equal(retired.kind, "retired");
  assert.deepEqual(Object.keys(retired.marker).sort(), ["canonicalHandle", "host"]);
  assert.equal(JSON.stringify(retired.marker).includes("space_to_delete"), false);

  const snapshot = registry.snapshot();
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.reservations));
  assert.ok(Object.isFrozen(snapshot.retiredMarkers));
  assert.equal(snapshot.reservations.length, 0);
  assert.deepEqual(snapshot.retiredMarkers, [{
    host: HOST_A,
    canonicalHandle: "retired-mind",
  }]);
  assert.deepEqual(
    await registry.reserveHandle(reservation(HOST_A, "retired-mind", stranger)),
    { kind: "handle_unavailable" },
  );
});
