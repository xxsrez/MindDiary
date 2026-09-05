export const ACCEPTANCE_ORIGIN = "https://mind-diary-acceptance.example.invalid";
export const ACCEPTANCE_PROJECT = "appgprj_example8ca2ca9e5243cfd6";
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
