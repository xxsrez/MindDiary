import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "../..");

async function readRepositoryFile(relativePath) {
  return readFile(resolve(repositoryRoot, relativePath), "utf8");
}

test("MD-303 fixes the format-neutral v4 manifest and legacy read boundary", async () => {
  const [spec, adr, storage, traceability] = await Promise.all([
    readRepositoryFile("docs/specs/bundle-files.md"),
    readRepositoryFile("docs/decisions/0021-format-neutral-bundle-files.md"),
    readRepositoryFile("docs/specs/sites-storage-capacity-import.md"),
    readRepositoryFile("docs/specs/traceability.md"),
  ]);

  for (const text of [spec, adr, storage]) {
    assert.match(text, /mind-diary-revision-manifest-v4/);
    assert.match(text, /application\/octet-stream/);
  }
  assert.match(spec, /`kind` is exactly `markdown \| opaque`/);
  assert.match(spec, /\| v1 \| Markdown-only;/i);
  assert.match(spec, /\| v2 \| Inline mixed manifest with closed raster\/PDF\/ZIP/i);
  assert.match(spec, /\| v3 \| Separately digested R2 manifest with v2 entry semantics/i);
  assert.match(spec, /first ordinary change from v1\/v2\/v3[\s\S]*creates a new v4 child/i);
  assert.match(spec, /Unknown manifest format fails closed/i);
  assert.match(adr, /заменяет closed MIME admission[\s\S]*64 MiB limit/i);
  assert.match(adr, /repository runtime.*legacy bounded baseline/is);
  assert.match(traceability, /BF7-Contract-v4.*`MD-303`/s);
  assert.match(traceability, /BF8-Streaming-state.*`MD-304`/s);
});

test("MD-303 keeps media advisory, bounded and independent from serving", async () => {
  const [spec, api] = await Promise.all([
    readRepositoryFile("docs/specs/bundle-files.md"),
    readRepositoryFile("docs/specs/api.md"),
  ]);

  for (const text of [spec, api]) {
    assert.match(text, /lowercase[\s\S]{0,20}MIME essence/);
    assert.match(text, /exactly one slash|ровно один `\/`/i);
    assert.match(text, /`tchar`/);
    assert.match(text, /Missing,[\s\S]{0,40}(?:invalid|unknown)[\s\S]{0,30}conflicting evidence/i);
    assert.match(text, /application\/octet-stream/);
    assert.match(text, /nosniff/);
    assert.match(text, /download-only/);
  }
  assert.match(spec, /127 ASCII bytes/);
  assert.match(api, /at most 127\s+bytes/);
  for (const mediaType of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
    assert.ok(spec.includes(`\`${mediaType}\``), `missing safe raster media: ${mediaType}`);
  }
  assert.match(spec, /Eligibility is a derived serving decision, not\s+manifest identity/);
  assert.match(spec, /SVG, HTML, JavaScript, executables, archives, Office,[\s\S]*download-only/);
});

test("MD-303 defines the exact 256 MiB bounded-streaming invariant", async () => {
  const [spec, adr, ingress] = await Promise.all([
    readRepositoryFile("docs/specs/bundle-files.md"),
    readRepositoryFile("docs/decisions/0021-format-neutral-bundle-files.md"),
    readRepositoryFile("docs/specs/file-ingress.md"),
  ]);

  for (const text of [spec, adr, ingress]) {
    assert.match(text, /268,435,456 bytes \(256 MiB\)/);
    assert.match(text, /268,435,457/);
  }
  assert.match(spec, /Content-Length.*rejected before body read/is);
  assert.match(spec, /counting stream/);
  assert.match(spec, /must not call a full-file `arrayBuffer`/);
  assert.match(spec, /resident memory proportional to file size/);
  assert.match(adr, /Staged bytes referenced by one changeset are raised from[\s\S]*128 MiB to 256 MiB/);
  assert.match(spec, /synthetic file larger[\s\S]*146,215,108 bytes/);
});

test("MD-303 covers arbitrary formats without expanding the MD-306 boundary", async () => {
  const [spec, domain, traceability] = await Promise.all([
    readRepositoryFile("docs/specs/bundle-files.md"),
    readRepositoryFile("docs/specs/domain-model.md"),
    readRepositoryFile("docs/specs/traceability.md"),
  ]);

  for (const example of ["DOCX", "HEIC", "EPUB", "OPUS", "HTML", "Jupyter notebook", "ZIP", "Unknown `.bin`"]) {
    assert.ok(spec.includes(example), `missing arbitrary-format example: ${example}`);
  }
  for (const token of ["recorded_by", "applies_to", "sources"]) {
    assert.ok(spec.includes(`\`${token}\``), `missing preserved producer field: ${token}`);
  }
  assert.match(spec, /MD-306 may preserve one typed OKF Markdown entry/);
  assert.match(spec, /ordinary revision using existing Markdown[\s\S]*`staged_file_ref`/);
  assert.match(spec, /does not add an OKF `Asset`/);
  assert.match(domain, /MD-306 may add one typed OKF Markdown entry/);
  assert.match(traceability, /BF9-Incremental-OKF.*`MD-306`/s);
});
