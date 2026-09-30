// Hosted bundles pin this object at build time. Node runners use an explicit
// private command environment; request/runtime env cannot change the pin.
export const ACCEPTANCE_ORIGIN = typeof __MD_ACCEPTANCE_ORIGIN__ !== "undefined" ? __MD_ACCEPTANCE_ORIGIN__ :
  (typeof process !== "undefined" ? process.env.MIND_DIARY_ACCEPTANCE_ORIGIN : undefined) ?? "https://mind-diary-acceptance.example.invalid";
export const ACCEPTANCE_PROJECT = typeof __MD_ACCEPTANCE_PROJECT__ !== "undefined" ? __MD_ACCEPTANCE_PROJECT__ :
  (typeof process !== "undefined" ? process.env.MIND_DIARY_ACCEPTANCE_PROJECT : undefined) ?? "appgprj_example8ca2ca9e5243cfd6";
export const ACCEPTANCE_LIMITS = Object.freeze({
  maxParallelRuns: 2, maxActorsPerRun: 8, maxRunSeconds: 3600,
  maxSessionSeconds: 900, maxExchangeSeconds: 60,
});

export function assertAcceptanceTarget(request, environment) {
  if (new URL(request.url).origin !== ACCEPTANCE_ORIGIN
    || environment.MIND_DIARY_PUBLIC_ORIGIN !== ACCEPTANCE_ORIGIN
    || environment.MD_ACCEPTANCE_PROJECT_ID !== ACCEPTANCE_PROJECT) {
    throw new Error("acceptance_target_mismatch");
  }
  if (environment.MIND_DIARY_SERVICE_OPERATOR_PRINCIPAL_IDS?.trim()) {
    throw new Error("external_operator_allowlist_forbidden");
  }
}
