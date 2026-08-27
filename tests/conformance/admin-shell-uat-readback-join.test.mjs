import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  ADMIN_SHELL_UAT_JOURNEYS,
  createStructuralJoin,
  parseCli,
  validateStructuralJoin,
} from "../../scripts/join-admin-shell-uat-readback.mjs";
import { ProbeFailure } from "../../scripts/lib/multi-principal-probe-core.mjs";

const expected = Object.freeze({
  candidateSha: "a".repeat(40),
  sourceTreeSha: "b".repeat(40),
  siteProjectId: "appgprj_fixture123",
});
const archiveBytes = Buffer.from("exact packaged Sites archive fixture", "utf8");
const serverBundleBytes = Buffer.from("export default { fetch() {} };", "utf8");
const cssBytes = Buffer.from("body { color: CanvasText; }\n", "utf8");
const clientBytes = Buffer.from("document.documentElement.dataset.ready = 'true';\n", "utf8");
const root = resolve(import.meta.dirname, "../..");

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function journeys() {
  return ADMIN_SHELL_UAT_JOURNEYS.map((journey) => ({
    id: journey.id,
    status: "passed",
    route: journey.route,
    viewport: { ...journey.viewport },
    current_items: [...journey.currentItems],
    checks: [...journey.checks],
    metrics: {
      document_overflow_px: 0,
      body_overflow_px: 0,
      minimum_hit_target_px: 44,
      h1_count: 1,
      page_header_bottom_px: 240,
      first_key_content_top_px: 300,
    },
  }));
}

function providerReadback() {
  return {
    schema: "mind-diary/admin-shell-sites-provider-readback/v1",
    generator: "codex-sites-connector-readback/v1",
    observed_at_utc: "2026-08-27T22:31:00.000Z",
    site: {
      id: expected.siteProjectId,
      status: "active",
      current_live_url: "https://mind-diary.example.invalid",
      updated_at: "2026-08-27T22:29:00.000Z",
    },
    saved_version: {
      id: "appgver_fixture123",
      project_id: expected.siteProjectId,
      version_number: 347,
      source: { commit_sha: expected.candidateSha },
      archive_storage: {
        archive_format: "tar.gz",
        content_hash: sha256(archiveBytes),
        size_bytes: archiveBytes.byteLength,
      },
    },
    version: {
      id: "appgver_fixture123",
      project_id: expected.siteProjectId,
      version_number: 347,
      source: { commit_sha: expected.candidateSha },
      archive_storage: {
        archive_format: "tar.gz",
        content_hash: sha256(archiveBytes),
        size_bytes: archiveBytes.byteLength,
      },
    },
    deployment_start: {
      id: "appgdep_fixture123",
      project_id: expected.siteProjectId,
      version_id: "appgver_fixture123",
      status: "publishing",
      type: "publish",
      url: null,
      updated_at: "2026-08-27T22:29:30.000Z",
    },
    deployment: {
      id: "appgdep_fixture123",
      project_id: expected.siteProjectId,
      version_id: "appgver_fixture123",
      status: "succeeded",
      type: "publish",
      url: "https://mind-diary.example.invalid",
      updated_at: "2026-08-27T22:30:00.000Z",
    },
  };
}

function browserReadback() {
  return {
    schema: "mind-diary/admin-shell-in-app-browser-readback/v1",
    generator: "codex-in-app-browser-same-origin-readback/v1",
    browser_surface: "codex-in-app-browser",
    live_url: "https://mind-diary.example.invalid",
    observed_at_utc: "2026-08-27T22:32:00.000Z",
    assets: [
      {
        path: "/ui/mind-diary-shell.css",
        response_url: "https://mind-diary.example.invalid/ui/mind-diary-shell.css",
        status: 200,
        content_type: "text/css; charset=utf-8",
        body_base64: cssBytes.toString("base64"),
        body_sha256: sha256(cssBytes),
      },
      {
        path: "/ui/mind-diary-shell-client.js",
        response_url: "https://mind-diary.example.invalid/ui/mind-diary-shell-client.js",
        status: 200,
        content_type: "text/javascript; charset=utf-8",
        body_base64: clientBytes.toString("base64"),
        body_sha256: sha256(clientBytes),
      },
    ],
    journeys: journeys(),
  };
}

function inputs(overrides = {}) {
  const provider = overrides.providerReadback ?? providerReadback();
  const browser = overrides.browserReadback ?? browserReadback();
  return {
    providerReadback: provider,
    browserReadback: browser,
    providerReadbackBytes: Buffer.from(JSON.stringify(provider), "utf8"),
    browserReadbackBytes: Buffer.from(JSON.stringify(browser), "utf8"),
    archiveBytes: overrides.archiveBytes ?? archiveBytes,
    serverBundleBytes,
    candidateAssets: {
      "/ui/mind-diary-shell.css": cssBytes,
      "/ui/mind-diary-shell-client.js": clientBytes,
    },
  };
}

test("admin shell structural join CLI accepts only exact provider, browser and archive inputs", () => {
  assert.deepEqual(parseCli([
    "--provider-readback", "/tmp/provider.json",
    "--browser-readback", "/tmp/browser.json",
    "--artifact-archive", "/tmp/site.tar.gz",
    "--candidate-sha", expected.candidateSha,
    "--join-out", "/tmp/join.json",
  ]), {
    provider_readback: "/tmp/provider.json",
    browser_readback: "/tmp/browser.json",
    artifact_archive: "/tmp/site.tar.gz",
    candidate_sha: expected.candidateSha,
    join_out: "/tmp/join.json",
  });
  assert.throws(
    () => parseCli(["--receipt", "/tmp/self-asserted.json", "--approve", "true"]),
    (error) => error instanceof ProbeFailure && error.code === "unsupported_cli_argument",
  );
});

test("local join binds bytes but remains explicitly nonterminal and non-hosted", () => {
  const input = inputs();
  const join = createStructuralJoin(input, expected);
  assert.equal(join.schema, "mind-diary/admin-shell-uat-readback-join/v1");
  assert.equal(join.status, "structurally_verified_readback");
  assert.equal(join.hosted_evidence, false);
  assert.equal(join.acceptance, "nonterminal");
  assert.equal(join.provenance, "unverified-local-files");
  assert.equal(join.byte_bindings.artifact_archive_sha256, sha256(archiveBytes));
  assert.equal(join.byte_bindings.server_bundle_sha256, sha256(serverBundleBytes));
  assert.equal(join.byte_bindings.shell_css_sha256, sha256(cssBytes));
  assert.equal(join.byte_bindings.shell_client_sha256, sha256(clientBytes));
  assert.equal(JSON.stringify(join).includes("body_base64"), false);
  assert.notEqual(join.status, "passed");
});

test("fake hashes, live bytes and opaque IDs cannot replace bound inputs", () => {
  const fakeArchiveHash = providerReadback();
  fakeArchiveHash.version.archive_storage.content_hash = `sha256:${"f".repeat(64)}`;
  assert.throws(
    () => createStructuralJoin(inputs({ providerReadback: fakeArchiveHash }), expected),
    (error) => error instanceof ProbeFailure && error.code === "uat_archive_digest_mismatch",
  );

  const fakeLiveHash = browserReadback();
  fakeLiveHash.assets[0].body_sha256 = `sha256:${"e".repeat(64)}`;
  assert.throws(
    () => createStructuralJoin(inputs({ browserReadback: fakeLiveHash }), expected),
    (error) => error instanceof ProbeFailure &&
      error.code === "live_asset_supplied_digest_mismatch",
  );

  const fakeProviderId = providerReadback();
  fakeProviderId.deployment.id = "appgdep_fabricated";
  assert.throws(
    () => createStructuralJoin(inputs({ providerReadback: fakeProviderId }), expected),
    (error) => error instanceof ProbeFailure &&
      error.code === "provider_readback_lineage_mismatch",
  );

  const input = inputs();
  const join = structuredClone(createStructuralJoin(input, expected));
  join.claimed_lineage.deployment_id = "appgdep_fabricated";
  assert.throws(
    () => validateStructuralJoin(join, {
      ...expected,
      provider: {
        site_project_id: input.providerReadback.site.id,
        site_version_id: input.providerReadback.version.id,
        deployment_id: input.providerReadback.deployment.id,
        version_number: input.providerReadback.version.version_number,
        artifact_archive_sha256: sha256(archiveBytes),
      },
      browser: {
        assets: {
          "/ui/mind-diary-shell.css": sha256(cssBytes),
          "/ui/mind-diary-shell-client.js": sha256(clientBytes),
        },
        journeys: journeys(),
      },
      serverBundleSha256: sha256(serverBundleBytes),
      input,
    }),
    (error) => error instanceof ProbeFailure && error.code === "uat_evidence_binding_mismatch",
  );
});

test("reviewer reproduction: local lookalike inputs never produce hosted PASS", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mind-diary-md347-lookalike-"));
  try {
    const stage = join(directory, "stage");
    const archive = join(directory, "fake-site.tar.gz");
    const providerPath = join(directory, "provider.json");
    const browserPath = join(directory, "browser.json");
    const joinPath = join(directory, "join.json");
    await mkdir(join(stage, "dist/server"), { recursive: true });
    await writeFile(join(stage, "dist/server/index.js"), "fake local server bundle\n", "utf8");
    execFileSync("tar", ["-C", stage, "-czf", archive, "dist"]);
    const candidate = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    const hosting = JSON.parse(await readFile(
      join(root, "apps/mind-diary-site/.openai/hosting.json"),
      "utf8",
    ));
    const packed = await readFile(archive);
    const provider = providerReadback();
    provider.site.id = hosting.project_id;
    provider.saved_version.project_id = hosting.project_id;
    provider.version.project_id = hosting.project_id;
    provider.deployment_start.project_id = hosting.project_id;
    provider.deployment.project_id = hosting.project_id;
    provider.saved_version.source.commit_sha = candidate;
    provider.version.source.commit_sha = candidate;
    for (const storage of [
      provider.saved_version.archive_storage,
      provider.version.archive_storage,
    ]) {
      storage.content_hash = sha256(packed);
      storage.size_bytes = packed.byteLength;
    }
    const css = execFileSync("git", ["show", `${candidate}:packages/adapter-web/src/ui-shell.css`], {
      cwd: root,
    });
    const shellInteractions = execFileSync(
      "git",
      ["show", `${candidate}:packages/adapter-web/assets/shell-interactions.js`],
      { cwd: root },
    );
    const productClient = execFileSync(
      "git",
      ["show", `${candidate}:packages/adapter-web/assets/product-ui-client.js`],
      { cwd: root },
    );
    const browser = browserReadback();
    for (const [asset, bytes] of [
      [browser.assets[0], css],
      [browser.assets[1], Buffer.concat([
        shellInteractions,
        Buffer.from("\n"),
        productClient,
      ])],
    ]) {
      asset.body_base64 = bytes.toString("base64");
      asset.body_sha256 = sha256(bytes);
    }
    await writeFile(providerPath, JSON.stringify(provider), "utf8");
    await writeFile(browserPath, JSON.stringify(browser), "utf8");
    const executed = spawnSync(process.execPath, [
      join(root, "scripts/join-admin-shell-uat-readback.mjs"),
      "--provider-readback", providerPath,
      "--browser-readback", browserPath,
      "--artifact-archive", archive,
      "--candidate-sha", candidate,
      "--join-out", joinPath,
    ], { cwd: root, encoding: "utf8" });
    assert.equal(executed.status, 0, executed.stderr);
    const output = JSON.parse(executed.stdout.trim());
    const localJoin = JSON.parse(await readFile(joinPath, "utf8"));
    for (const value of [output, localJoin]) {
      assert.equal(value.status, "structurally_verified_readback");
      assert.equal(value.hosted_evidence, false);
      assert.equal(value.acceptance, "nonterminal");
      assert.notEqual(value.status, "passed");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
