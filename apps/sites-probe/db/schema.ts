import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const probeCounter = sqliteTable("probe_counter", {
  id: integer("id").primaryKey(),
  counter: integer("counter").notNull(),
});

export const probeOperations = sqliteTable("probe_operations", {
  operationId: text("operation_id").primaryKey(),
  expectedCounter: integer("expected_counter").notNull(),
  resultCounter: integer("result_counter").notNull(),
  objectKey: text("object_key").notNull(),
});
