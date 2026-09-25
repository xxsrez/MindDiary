const encoder = new TextEncoder();

async function digest(value) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Read-only, controller-scoped projection for reconciling acceptance cleanup. */
export async function canonicalGateProbe(environment) {
  const gates = await environment.DB.prepare(
    "SELECT key_digest, operation_id, acquired_at FROM md_canonical_key_gates LIMIT 2",
  ).all();
  if (gates.results.length !== 1) return { gate_count: gates.results.length, probe_complete: false };
  const gate = gates.results[0];
  const page = await environment.MIND_DIARY_BUCKET.list({ limit: 1000, include: ["customMetadata"] });
  if (page.truncated) return { gate_count: 1, probe_complete: false };
  let canonical = null;
  let sidecar = null;
  for (const item of page.objects) {
    if (await digest(item.key) === gate.key_digest) {
      canonical = {
        state: item.customMetadata?.state ?? null,
        delete_boundary: item.customMetadata?.deleteBoundary ?? null,
        protected_at: item.customMetadata?.protectedAt ?? null,
        size: item.size,
      };
    }
    const objectKey = item.customMetadata?.objectKey;
    if (typeof objectKey === "string" && await digest(objectKey) === gate.key_digest) {
      sidecar = { size: item.size, schema: item.customMetadata?.schema ?? null };
    }
  }
  return {
    gate_count: 1,
    operation_id: gate.operation_id,
    acquired_at: gate.acquired_at,
    probe_complete: true,
    object_count: page.objects.length,
    canonical,
    sidecar,
  };
}
