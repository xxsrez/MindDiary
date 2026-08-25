import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  PRODUCT_COLLABORATION_CLIENT_JAVASCRIPT,
  PRODUCT_CONNECTIONS_CLIENT_JAVASCRIPT,
  PRODUCT_MARKDOWN_IMPORT_CLIENT_JAVASCRIPT,
  PRODUCT_ORDINARY_MINDS_CLIENT_JAVASCRIPT,
  PRODUCT_SHELL_INTERACTIONS_JAVASCRIPT,
  PRODUCT_UI_CLIENT_JAVASCRIPT,
  PRODUCT_UI_SHELL_CSS,
  PRODUCT_UI_TOKENS_CSS,
  PRODUCT_VISIBILITY_CATALOG_CLIENT_JAVASCRIPT,
} from "../../packages/adapter-web/dist/product-ui-assets.js";

const root = new URL("../../", import.meta.url);
const expected = new Map([
  [PRODUCT_UI_TOKENS_CSS, "docs/assets/brand/mind-diary-tokens.css"],
  [PRODUCT_UI_SHELL_CSS, "packages/adapter-web/src/ui-shell.css"],
  [PRODUCT_SHELL_INTERACTIONS_JAVASCRIPT, "packages/adapter-web/assets/shell-interactions.js"],
  [PRODUCT_UI_CLIENT_JAVASCRIPT, "packages/adapter-web/assets/product-ui-client.js"],
  [PRODUCT_ORDINARY_MINDS_CLIENT_JAVASCRIPT, "packages/adapter-web/assets/ordinary-minds-client.js"],
  [PRODUCT_MARKDOWN_IMPORT_CLIENT_JAVASCRIPT, "packages/adapter-web/assets/markdown-import-client.js"],
  [PRODUCT_COLLABORATION_CLIENT_JAVASCRIPT, "packages/adapter-web/assets/collaboration-client.js"],
  [PRODUCT_CONNECTIONS_CLIENT_JAVASCRIPT, "packages/adapter-web/assets/connections-client.js"],
  [PRODUCT_VISIBILITY_CATALOG_CLIENT_JAVASCRIPT, "packages/adapter-web/assets/visibility-catalog-client.js"],
]);

test("hosted product text assets are byte-identical to canonical sources", async () => {
  for (const [generated, relativePath] of expected) {
    assert.equal(generated, await readFile(new URL(relativePath, root), "utf8"), relativePath);
  }
});
