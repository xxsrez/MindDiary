// Test-only D1-shaped adapter backed by SQLite, not an HTTP/UI automation tool.
import { DatabaseSync } from "node:sqlite";

export class SqliteD1 {
  constructor() { this.sqlite = new DatabaseSync(":memory:"); }
  prepare(sql) {
    // node:sqlite treats ?1 as named; D1 bind() uses positional numbered slots.
    // Preserve quoted literals/comments and duplicate numbered references.
    const order = []; let slots = 0;
    const normalized = sql.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|--[^\n]*|\/\*[\s\S]*?\*\/|\?(\d*)/g, (match, index) => {
      if (!match.startsWith("?")) return match;
      const slot = index ? Number(index) - 1 : slots;
      slots = Math.max(slots, slot + 1); order.push(slot); return "?";
    });
    // D1 prepares on the server when the batch executes, after preceding DDL.
    const statement = () => this.sqlite.prepare(normalized);
    let values = [];
    const parameters = () => {
      if (values.length !== slots) throw new Error("D1 parameter count mismatch");
      return order.map((index) => values[index]);
    };
    const run = () => {
      if (/^\s*(SELECT|WITH|PRAGMA)\b/i.test(sql) || /\bRETURNING\b/i.test(sql)) {
        return { success: true, results: statement().all(...parameters()), meta: { changes: 0 } };
      }
      const result = statement().run(...parameters());
      return { success: true, results: [], meta: { changes: Number(result.changes) } };
    };
    return {
      bind(...input) { values = input; return this; },
      async run() { return run(); },
      async all() { return { success: true, results: statement().all(...parameters()), meta: { changes: 0 } }; },
      async first() { return statement().get(...parameters()) ?? null; },
      execute: run,
    };
  }
  async batch(statements) {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => statement.execute());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) { this.sqlite.exec("ROLLBACK"); throw error; }
  }
  close() { this.sqlite.close(); }
}
