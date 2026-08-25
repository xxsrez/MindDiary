import {
  createProductSiteRuntime,
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
  createRuntime: createProductSiteRuntime,
  staticFetch: createProductUiStaticAssetResponse,
  readConfig: (request: Request, environment: ProductEnv) =>
    readRuntimeConfig(request, environment),
  fallbackFetch: (request: Request, environment: ProductEnv, context: ExecutionContext) =>
    handler.fetch(request, environment, context),
});

export default worker;
