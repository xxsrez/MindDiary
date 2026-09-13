import assert from "node:assert/strict";
import test from "node:test";
import {
  SYSTEM_BACKUP_D1_SCHEMA,
  assertSystemBackupD1Schema,
} from "../../packages/composition-root/dist/system-backup-schema.js";
import { ACCEPTANCE_BACKUP_EXTRA_D1_SCHEMA } from "../../apps/mind-diary-acceptance/backup-test-profile.mjs";

const rows = (schema) => Object.entries(schema).flatMap(([table_name, columns]) =>
  columns.split(" ").map((column_name) => ({ table_name, column_name })));

test("acceptance backup checks its transient D1 columns without relaxing Product", () => {
  const product = rows(SYSTEM_BACKUP_D1_SCHEMA);
  const acceptance = [...product, ...rows(ACCEPTANCE_BACKUP_EXTRA_D1_SCHEMA)];
  assert.doesNotThrow(() => assertSystemBackupD1Schema(product));
  assert.throws(() => assertSystemBackupD1Schema(acceptance), /schema mismatch/u);
  assert.doesNotThrow(() => assertSystemBackupD1Schema(
    acceptance, ACCEPTANCE_BACKUP_EXTRA_D1_SCHEMA));
  assert.throws(() => assertSystemBackupD1Schema(
    [...acceptance, { table_name: "md_acceptance_runs", column_name: "unclassified" }],
    ACCEPTANCE_BACKUP_EXTRA_D1_SCHEMA), /unknown or missing column/u);
  assert.throws(() => assertSystemBackupD1Schema(
    [...acceptance, { table_name: "md_unknown", column_name: "content" }],
    ACCEPTANCE_BACKUP_EXTRA_D1_SCHEMA), /schema mismatch/u);
});
