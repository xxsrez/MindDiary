import vinext from "vinext";
import { defineConfig } from "vite";
import hostingConfig from "./.openai/hosting.json";

const PLACEHOLDER_DATABASE_ID = "00000000-0000-4000-8000-000000000000";
const isCodexSeatbelt = process.env.CODEX_SANDBOX === "seatbelt";

export default defineConfig(async () => {
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";
  const { cloudflare } = await import("@cloudflare/vite-plugin");
  return {
    server: isCodexSeatbelt ? { watch: { useFsEvents: false, usePolling: true } } : undefined,
    plugins: [
      vinext(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: {
          main: "./worker/index.ts",
          compatibility_flags: ["nodejs_compat"],
          d1_databases: [{ binding: hostingConfig.d1, database_name: "mind-diary-product", database_id: PLACEHOLDER_DATABASE_ID }],
          r2_buckets: [{ binding: hostingConfig.r2, bucket_name: "mind-diary-product" }],
        },
      }),
    ],
  };
});
