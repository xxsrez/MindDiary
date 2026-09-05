import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../../packages/adapter-web/assets/product-ui-client.js", import.meta.url), "utf8");
for (const closeOrder of ["synchronous", "queued"]) {
  test(`token dialog close wipes the secret and refreshes once with ${closeOrder} close event`, () => {
    const handlers = {};
    let reloads = 0;
    const secret = { textContent: "synthetic-one-time-secret" };
    const dialog = { close() { if (closeOrder === "synchronous") handlers.close(); }, addEventListener(name, callback) { handlers[name] = callback; } };
    const button = { addEventListener(_name, callback) { handlers.button = callback; } };
    const context = vm.createContext({
      document: {
        addEventListener() {},
        querySelector(selector) { return selector === "[data-secret-dialog]" ? dialog : selector === "[data-secret-value]" ? secret : null; },
        querySelectorAll(selector) { return selector === "[data-close-secret]" ? [button] : []; },
      },
      location: { reload() { reloads++; } },
    });
    vm.runInContext(source, context);
    vm.runInContext('refreshAfterSecret = true; revealed = "synthetic-one-time-secret";', context);
    handlers.button();
    assert.doesNotMatch(secret.textContent, /synthetic-one-time-secret/);
    if (closeOrder === "queued") handlers.close();
    assert.equal(reloads, 1);
    assert.equal(vm.runInContext("revealed", context), "");
  });
}
