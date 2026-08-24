# Reconciliation baseline Release 0.1

Статус: verified commit inventory, 2026-08-24. Это engineering reconciliation
MD-301, а не UAT или terminal product receipt.

## Fresh исходное состояние

- planning baseline: `main` at
  `469c96c8d708ac4c9081ed6366f8a35987bb1019`;
- engineering candidate: `1df46ec79604470956acceb9cb2ceef58d17eec0`;
- common ancestor: `eca34007eaa691e0913e0486955d5726c2959db1`;
- fresh divergence immediately before reconciliation: `7 / 21` for
  `main...1df46ec`;
- integration method: conflict-aware replay on a clean lane; direct merge was
  rejected because it mixed the accepted Release 0.1 boundary with post-MVP
  file/scale work and stale profile changes.

The committed candidate lineage remains preserved under the local branch
`codex/shiptask-uat-dc091da-20260823` and the remote preservation ref declared
below. Its dirty worktree-only profile revision is not part of any commit and
was rejected because it made post-MVP connector/storage/capacity/generated
rows blocking again.

## Bounded disposition всех 21 commits

| # | Candidate commit | Disposition | Release 0.1 result |
|---:|---|---|---|
| 1 | `32dcaa761f11c485f0a3db4ecb818989f8bb3756` | post-MVP preserve | Hosted generated file ingress stays on the preserved lineage; excluded by ADR-0019. |
| 2 | `97a511cf513e794968d4c466a2f79a02f64a4bb2` | integrate | Replayed as `ff218dd`: operator canary owns setup/verify/cleanup and directory join. |
| 3 | `186878c8f550b5ec44f4889bb357330afddf3581` | semantic integrate | Current Task Manager mapping was retained; missing bounded pagination, anchor projection and runtime reference were completed in `b66d1d5`. |
| 4 | `4de0a4a5d9f5a6ef6ad6d8914e7a9aab0e943666` | already superseded | Baseline already had no repository-local Shipliner runtime or active package gate; `b66d1d5` verifies the current Task Manager path. |
| 5 | `457bc453eeb97fa1a8e71c05d519f4aaf89d764c` | semantic integrate | Runtime identity, historical Linear provenance and operational boundary are preserved in `b66d1d5`. |
| 6 | `6613400d69f4a7c7d209cafe0e794ca53d296b7d` | post-MVP preserve | Connector object bridge remains available on the preservation ref, outside 0.1. |
| 7 | `5fb418dba92412bd330f9b71797c51451205b327` | integrate | Replayed as `f7ccd68`; provider privacy receipt CLI is part of the P0 operator evidence path. |
| 8 | `e3f5c5ef074475b86b5383bace8947fe22357f97` | integrate | Replayed as `c9e89f2`; temporary canary Mind must have the exact writable role. |
| 9 | `2f1932d0048778bf767fa2a69a5f33af91516743` | post-MVP preserve | Large/storage matrix runner remains on the preservation ref. |
| 10 | `865d8bfb43c66e7b11aedb71314b595328ec0a96` | post-MVP preserve | Hosted upload intents remain post-MVP. |
| 11 | `dbcea1a9281b25abfb85be2fb0b3b448e6451eb5` | equivalent integrate | Cleaner recovery replay `62774fb` was integrated as `4148b1e`, preserving request-triggered exact-revision recovery. |
| 12 | `97c132a7a9611689248c39f46364d6d646ea4dae` | post-MVP preserve | Connector materialization fence remains on the preservation ref. |
| 13 | `e42ae021dbb7997feb169efb1a2d618a7341abb7` | post-MVP preserve | Restricted generated-ingress canary remains post-MVP. |
| 14 | `77f410dbb134a65ba8e339e0843831b9fc063320` | post-MVP preserve | Hosted connector upload advertisement remains post-MVP. |
| 15 | `227ef4b665dde5cdde9f2c4f46a8a5c4505ebea9` | equivalent integrate | Starter/small-data rework `2074bac` was integrated as `6fd7bc2`; Brain-scale release claims were not restored. |
| 16 | `ec0b9cfdc44103ac95293a962eb55c80e3660ee8` | post-MVP preserve | Restricted capacity profile remains post-MVP. |
| 17 | `c29662e4edc0bef19f4963e7886934ece310a679` | post-MVP preserve | Capacity-fence lineage test remains post-MVP. |
| 18 | `2933ed3ba5cef57116ba07115bb6151c0f4455ca` | post-MVP preserve | Generated-canary target classification remains post-MVP. |
| 19 | `f27feecc6cf7934c7808a99826b94a59472d5c2d` | integrate | Replayed as `6f0e560`; web telemetry uses the benchmark correlation ID contract. |
| 20 | `8c3a8306b3f20eacc0c2bf795655a784375481a3` | equivalent integrate | Starter/small provenance rework `20c63e4` was integrated as `8ae2965`; recovery-factory architecture was retained. |
| 21 | `1df46ec79604470956acceb9cb2ceef58d17eec0` | split integrate | Cache-generation test replayed as `61c0157`; missing fingerprint inputs were completed in `b66d1d5`. |

No candidate commit is silently dropped: every P0 semantic change is present
once, every superseded change is explained, and every post-MVP commit remains
reachable from the preservation ref.

## Verification boundary

Before the exact final baseline cut, targeted integration verification passed
111/111 tests covering Task Manager profile, operator lifecycle/join,
provider-privacy receipt, request recovery, starter/small performance,
Product Site/MCP runtime and Sites persistence. Project-docs validation passed
for 70 documents and 327 local links; the documentation check passed for 72
Markdown files; `git diff --check` passed.

The canonical full `npm run check`, final `main` push/read-back and clean
worktree evidence are intentionally recorded only for the later exact tip.
UAT deployment and product acceptance remain outside MD-301.

## Preservation ref

Committed post-MVP lineage target:
`refs/heads/codex/archive/release-01-post-mvp-candidate-20260824` at
`1df46ec79604470956acceb9cb2ceef58d17eec0`. The ref preserves code history; it
does not activate those capabilities in Release 0.1 and is not release truth.
