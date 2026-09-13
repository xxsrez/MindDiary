import {
  createProductSiteRuntime,
  createProductUiAnonymousResponse,
  createProductUiStaticAssetResponse,
} from "@mind-diary/composition-root";
import handler from "vinext/server/app-router-entry";
import { createMindDiaryProductWorker } from "./request-recovery";
import { readRuntimeConfig, type ProductEnv } from "./runtime-config";

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

const worker = createMindDiaryProductWorker({
  createRuntime: (options) => createProductSiteRuntime({
    ...(options as Parameters<typeof createProductSiteRuntime>[0]),
    systemBackupUnexpectedError: (error: unknown) => {
      const message = error instanceof TypeError ? error.message : "";
      // Backup validators construct these messages from static schema labels,
      // counts and typeof values; never log arbitrary provider errors or data.
      const diagnostic = /^system backup [a-zA-Z0-9 _=;:(),.-]{1,220}$/u.test(message)
        ? message : "unexpected provider failure";
      console.error(JSON.stringify({ event: "mind-diary-backup-failure", diagnostic }));
    },
  }),
  anonymousFetch: createProductUiAnonymousResponse,
  staticFetch: createProductUiStaticAssetResponse,
  readConfig: (request: Request, environment: ProductEnv) =>
    readRuntimeConfig(request, environment),
  fallbackFetch: (request: Request, environment: ProductEnv, context: ExecutionContext) =>
    handler.fetch(request, environment, context),
});

export default worker;
