# Профиль `ship-work-release` для Mind Diary

Статус: accepted project configuration, revision 2, 2026-08-20.

Документ задаёт project-specific параметры Mind Diary по
[provider-neutral profile contract](../specs/ship-work-release-project-profile.md).
Нормативные orchestration semantics находятся в
[delivery specification](../specs/ship-work-release.md), команды пользователя —
в [operator runbook](ship-work-release.md), а Linear mapping — в
[adapter specification](../specs/ship-work-release-linear.md).

## Canonical profile

~~~yaml
schema: ship-work-release/project-profile/v1
profile_id: mind-diary
profile_revision: 2

context:
  schema: ship-work-release/context-bindings/v1
  bindings:
    run.candidate_sha:
      { source: canonical_run_state, pointer: /candidate_sha, type: git-sha, nullable: false }
    run.expected_integration_sha:
      { source: canonical_run_state, pointer: /expected_integration_sha, type: git-sha, nullable: false }
    run.batch_manifest:
      source: current_batch_manifest
      pointer: ""
      schema: ship-work-release/batch-manifest/v1
      nullable: false
      max_serialized_bytes: 1048576
    run.batch_manifest.changed_capability_ids:
      { source: current_batch_manifest, pointer: /changed_capability_ids, type: string-set, nullable: false }
    run.batch_manifest.has_changed_release_surface:
      { source: current_batch_manifest, pointer: /has_changed_release_surface, type: boolean, nullable: false }
    run.scope_snapshot:
      source: task_manager_scope_snapshot
      pointer: ""
      schema: ship-work-release/task-manager-snapshot/v1
      nullable: false
      max_serialized_bytes: 2097152
    run.scope_snapshot.required_evidence_capability_ids:
      { source: task_manager_scope_snapshot, pointer: /required_evidence_capability_ids, type: string-set, nullable: false }
    run.uat_source_digest:
      { source: current_batch_manifest, pointer: /release_source_digest, type: sha256, nullable: false }
    run.uat_predeploy_receipt.has_current_deployment:
      { source: uat_predeploy_receipt, pointer: /has_current_deployment, type: boolean, nullable: false }
    run.uat_deployment_id:
      { source: current_uat_cut, pointer: /deployment_ref/id, type: id, nullable: false }
    run.uat_previous_deployment_id:
      { source: current_uat_cut, pointer: /previous_stable_deployment/id, type: id, nullable: true }
    run.final_candidate_sha:
      { source: scope_release_receipt, pointer: /final_candidate_sha, type: git-sha, nullable: false }
    run.scope_uat_release_sha:
      { source: scope_release_receipt, pointer: /scope_uat_release_sha, type: git-sha, nullable: false }
    run.scope_completion:
      source: scope_release_receipt
      pointer: /scope_completion
      type: enum
      values: [accepted, engineering-complete, blocked, aborted]
      nullable: false
    dev.resolved_url:
      { source: dev_launch_receipt, pointer: /resolved_url, type: url, nullable: false }
    effect.idempotency_key:
      { source: current_effect, pointer: /idempotency_key, type: id, nullable: false }
    effect.version_id:
      { source: current_effect, pointer: /desired_state/version_id, type: id, nullable: false }
    effect.deployment_id:
      { source: current_effect, pointer: /external_identity/deployment_id, type: id, nullable: false }
    effect.expected_current_deployment_id:
      { source: current_effect, pointer: /expected_old/deployment_id, type: id, nullable: true }
    uat.target.id:
      { source: resolved_profile_ref, pointer: /uat/target/id, type: id, nullable: false }

task_management:
  adapter:
    id: linear
    contract: ship-work-release/task-manager-adapter/v1
    specification: docs/specs/ship-work-release-linear.md
    runtime_reference: references/task-manager-linear.md
  provider_instance:
    id: null
    id_source:
      kind: adapter_capability
      capability: linear/organization.identity.read/v1
      expected_type: uuid
  collection:
    provider: linear
    kind: project
    id: 6c07eabb-e588-4184-8eaa-5974ad67fdda
    display_name: Mind Diary
  default_scope:
    selector: current_project_milestone
    parameters: {}
  pagination:
    request_timeout_seconds: 60
    connections:
      project_milestones: { page_size: 100, max_pages: 10, max_records: 1000 }
      scope_issues: { page_size: 100, max_pages: 100, max_records: 10000 }
      issue_relations: { page_size: 100, max_pages: 100, max_records: 10000 }
      sub_issues: { page_size: 100, max_pages: 100, max_records: 10000 }
      projection_evidence: { page_size: 100, max_pages: 100, max_records: 10000 }
      team_status_catalogs: { page_size: 100, max_pages: 10, max_records: 1000 }
  scope_fact_projection:
    mode: native_scope
    target:
      provider: linear
      kind: project
      id: 6c07eabb-e588-4184-8eaa-5974ad67fdda
      display_name: Mind Diary
    resource_kind: project-status-update
    capability: linear/project-status-update/v1
    marker_schema: ship-work-release/linear-scope-fact-marker/v1
    identity_after_create: exact-status-update-id
    reconcile: exact-marker-and-status-update-id
    unavailable_behavior: block-terminal-projection

repository:
  root: .
  repository_ref:
    provider: github
    kind: repository
    id: R_kgDOTu4dNw
    display_name: xxsrez/MindDiary
  integration:
    remote: origin
    branch: main
    ref: refs/heads/main
    update_mode: expected-old-fast-forward
  commands:
    install:
      schema: ship-work-release/command/v1
      id: repository.install
      argv: [npm, ci]
      cwd: .
      environment:
        inherit:
          - { name: PATH, classification: public-runtime }
          - { name: HOME, classification: public-runtime }
          - { name: TMPDIR, classification: public-runtime }
        set: {}
      stdin: closed
      timeout_seconds: 900
      exit:
        mode: finite
        success_codes: [0]
      output:
        capture: bounded
        max_bytes_per_stream: 4194304
      termination:
        soft_signal: SIGTERM
        soft_grace_seconds: 10
        hard_signal: SIGKILL
    full_gate:
      schema: ship-work-release/command/v1
      id: repository.full-gate
      argv: [npm, run, check]
      cwd: .
      environment:
        inherit:
          - { name: PATH, classification: public-runtime }
          - { name: HOME, classification: public-runtime }
          - { name: TMPDIR, classification: public-runtime }
        set:
          CI: "true"
      stdin: closed
      timeout_seconds: 1800
      exit:
        mode: finite
        success_codes: [0]
      output:
        capture: bounded
        max_bytes_per_stream: 4194304
      termination:
        soft_signal: SIGTERM
        soft_grace_seconds: 10
        hard_signal: SIGKILL
    diff_check:
      schema: ship-work-release/command/v1
      id: repository.diff-check
      argv:
        - git
        - diff
        - --check
        - template: "{base_sha}..{candidate_sha}"
          variables: [base_sha, candidate_sha]
      cwd: .
      environment:
        inherit:
          - { name: PATH, classification: public-runtime }
          - { name: HOME, classification: public-runtime }
          - { name: TMPDIR, classification: public-runtime }
        set: {}
      stdin: closed
      timeout_seconds: 120
      exit:
        mode: finite
        success_codes: [0]
      output:
        capture: bounded
        max_bytes_per_stream: 1048576
      termination:
        soft_signal: SIGTERM
        soft_grace_seconds: 5
        hard_signal: SIGKILL
  targeted_checks:
    source:
      kind: capability
      capability: ship-work-release/targeted-check-resolver/v1
      output_schema: ship-work-release/targeted-check-manifest/v1
      inputs:
        - run.work_item_acceptance
        - run.ownership_paths
        - repository.instructions
      empty_result: fail

ci:
  required: true
  provider:
    id: github-actions
    contract: ship-work-release/ci-provider/v1
  repository_ref:
    provider: github
    kind: repository
    id: R_kgDOTu4dNw
    display_name: xxsrez/MindDiary
  workflow_ref:
    provider: github-actions
    kind: workflow
    id: "328602767"
    display_name: .github/workflows/ci.yml
  exact_candidate_required: true
  projection:
    update:
      id: ci.integration-ref.cas
      provider: git
      capability: git/ref.compare-and-set/v1
      effect: true
      inputs:
        remote: { literal: origin }
        ref: { literal: refs/heads/main }
        expected_old_sha: { value_from: run.expected_integration_sha }
        new_sha: { value_from: run.candidate_sha }
        fast_forward_only: { literal: true }
      timeout_seconds: 120
      result:
        schema: ship-work-release/git-ref-update-result/v1
        identity_fields: [remote, ref, new_sha]
        success: { path: /status, operator: eq, value: applied }
      replay:
        policy: reconcile-before-retry
        reconcile_operation: ci.integration-ref.read
    reconcile:
      id: ci.integration-ref.read
      provider: git
      capability: git/ref.read/v1
      effect: false
      inputs:
        remote: { literal: origin }
        ref: { literal: refs/heads/main }
      timeout_seconds: 60
      result:
        schema: ship-work-release/git-ref-read-result/v1
        identity_fields: [remote, ref, sha]
        success: { path: /status, operator: eq, value: resolved }
  query:
    operation:
      id: ci.required-run.wait
      provider: github-actions
      capability: github-actions/workflow-run.wait/v1
      effect: false
      inputs:
        repository: { ref_from: ci.repository_ref }
        workflow: { ref_from: ci.workflow_ref }
        ref: { literal: refs/heads/main }
        head_sha: { value_from: run.candidate_sha }
      timeout_seconds: 1200
      result:
        schema: ship-work-release/ci-run-result/v1
        identity_fields: [run_id, run_attempt, head_sha]
        success: { path: /conclusion, operator: eq, value: success }
    poll_interval_seconds: 15
    selection: single-run-id-highest-attempt
    ambiguity: fail
    terminal_success: [completed-success]
    terminal_failure:
      - completed-failure
      - completed-cancelled
      - completed-timed-out
      - completed-action-required

release:
  default_cadence: continuous-uat
  review_policy: manual

dev:
  configured: true
  target_class: localhost
  data_class: isolated-local-test
  secrets_class: local-test-only
  launch:
    command:
      schema: ship-work-release/command/v1
      id: dev.launch
      argv: [npm, run, dev]
      cwd: .
      environment:
        inherit:
          - { name: PATH, classification: public-runtime }
          - { name: HOME, classification: public-runtime }
          - { name: TMPDIR, classification: public-runtime }
        set: {}
      stdin: closed
      timeout_seconds: 120
      exit:
        mode: long-running
        cleanup_codes: [0, 143]
      output:
        capture: bounded
        max_bytes_per_stream: 4194304
      termination:
        soft_signal: SIGTERM
        soft_grace_seconds: 10
        hard_signal: SIGKILL
  url_resolution:
    kind: launcher_event
    event_schema: ship-work-release/dev-ready/v1
    url_pointer: /url
    allowed_hosts: [localhost, 127.0.0.1, "::1"]
  readiness:
    kind: launcher_event
    event_schema: ship-work-release/dev-ready/v1
    interval_seconds: 1
    timeout_seconds: 120
    success: { path: /ready, operator: eq, value: true }
  configuration_fingerprint:
    kind: launcher_event
    event_schema: ship-work-release/dev-ready/v1
    pointer: /configuration_fingerprint
    secret_values_included: false
  cleanup:
    kind: launched_process_tree
    soft_signal: SIGTERM
    soft_grace_seconds: 10
    hard_signal: SIGKILL
    timeout_seconds: 20
  smoke_rows:
    - dev.authenticated-web-control
    - dev.persistence-restart
    - dev.mcp-modern
    - dev.mcp-compat
    - dev.synthetic-multi-principal
    - dev.oauth-direct-plugin
    - dev.mind-bindings
    - dev.changed-surface

uat:
  configured: true
  product_environment: uat
  platform_deployment_class: openai-sites-production-deployment
  target_class: prod-like-hosted
  provider:
    id: openai-sites
    contract: ship-work-release/uat-provider/v1
  target:
    provider: openai-sites
    kind: project
    id_source:
      kind: json_pointer
      document: apps/mind-diary-site/.openai/hosting.json
      pointer: /project_id
      expected_type: string
      expected_pattern: '^appgprj_[a-z0-9]+$'
    display_name: Mind Diary UAT
  url: https://mind-diary.example.invalid
  source:
    kind: repository_directory
    path: apps/mind-diary-site
  artifact_build:
    schema: ship-work-release/command/v1
    id: uat.artifact.build
    timing: after-repository-gate-before-version-save
    argv: [npm, --prefix, apps/mind-diary-site, run, build]
    cwd: .
    stdin: closed
    timeout_seconds: 900
    output:
      directory: apps/mind-diary-site/dist
      required_entries:
        - server/index.js
        - .openai/hosting.json
      freshness: built-for-exact-candidate-after-gate
    save_semantics:
      candidate_version: immutable
      stale_or_wrong_saved_artifact: fail-batch-and-forward-fix
  audience:
    class: restricted-test-principals
    baseline_actor_class: single-principal-owner
    additional_actor_source: explicit-test-principal-reference
  data_class: isolated-uat
  secrets_class: provider-managed-uat
  deploy_authority: ship-work-release
  operations:
    current_read:
      id: uat.current.read
      provider: openai-sites
      capability: openai-sites/project.current-deployment.get/v1
      effect: false
      inputs:
        project: { ref_from: uat.target }
      timeout_seconds: 120
      result:
        schema: ship-work-release/sites-current-deployment-result/v1
        identity_fields: [project_id, deployment_id, version_id]
        success: { path: /status, operator: in, value: [resolved, empty-target] }
    version_save:
      id: uat.version.save
      provider: openai-sites
      capability: openai-sites/version.save/v1
      effect: true
      inputs:
        project: { ref_from: uat.target }
        source_directory: { literal: apps/mind-diary-site }
        candidate_sha: { value_from: run.candidate_sha }
        source_digest: { value_from: run.uat_source_digest }
        idempotency_key: { value_from: effect.idempotency_key }
      timeout_seconds: 900
      result:
        schema: ship-work-release/sites-version-result/v1
        identity_fields: [project_id, version_id, source_digest]
        success: { path: /status, operator: eq, value: saved }
      replay:
        policy: reconcile-before-retry
        reconcile_operation: uat.version.find
    version_find:
      id: uat.version.find
      provider: openai-sites
      capability: openai-sites/version.find/v1
      effect: false
      inputs:
        project: { ref_from: uat.target }
        candidate_sha: { value_from: run.candidate_sha }
        source_digest: { value_from: run.uat_source_digest }
      timeout_seconds: 120
      result:
        schema: ship-work-release/sites-version-result/v1
        identity_fields: [project_id, version_id, source_digest]
        success: { path: /status, operator: in, value: [saved, absent] }
    deployment_deploy:
      id: uat.deployment.deploy
      provider: openai-sites
      capability: openai-sites/version.deploy/v1
      effect: true
      inputs:
        project: { ref_from: uat.target }
        version_id: { value_from: effect.version_id }
        expected_current_deployment_id: { value_from: effect.expected_current_deployment_id }
        idempotency_key: { value_from: effect.idempotency_key }
      timeout_seconds: 900
      result:
        schema: ship-work-release/sites-deployment-result/v1
        identity_fields: [project_id, version_id, deployment_id]
        success: { path: /status, operator: eq, value: succeeded }
      replay:
        policy: reconcile-before-retry
        reconcile_operation: uat.deployment.find
    deployment_find:
      id: uat.deployment.find
      provider: openai-sites
      capability: openai-sites/deployment.find-by-version/v1
      effect: false
      inputs:
        project: { ref_from: uat.target }
        version_id: { value_from: effect.version_id }
      timeout_seconds: 120
      result:
        schema: ship-work-release/sites-deployment-result/v1
        identity_fields: [project_id, version_id, deployment_id]
        success: { path: /status, operator: in, value: [succeeded, pending, failed, absent] }
    deployment_get:
      id: uat.deployment.get
      provider: openai-sites
      capability: openai-sites/deployment.get/v1
      effect: false
      inputs:
        project: { ref_from: uat.target }
        deployment_id: { value_from: effect.deployment_id }
      timeout_seconds: 120
      result:
        schema: ship-work-release/sites-deployment-result/v1
        identity_fields: [project_id, version_id, deployment_id]
        success: { path: /status, operator: in, value: [succeeded, pending, failed] }
  rollback:
    supported: true
    stable_selector:
      kind: last-compatible-stable-receipt
      match: [profile_id, target.provider, target.kind, target.id]
    bootstrap:
      when_missing_stable_receipt: require-explicit-current-baseline
      current_operation: uat.current.read
    deploy_operation: uat.deployment.deploy
    reconcile_operation: uat.deployment.find
    post_rollback_rows:
      - rollback.authenticated-web-control
      - rollback.mcp-modern
  smoke_rows:
    - uat.exact-artifact-lineage
    - uat.authenticated-web-control
    - uat.persistence-redeploy
    - uat.mcp-modern
    - uat.mcp-compat
    - uat.mind-bindings
    - uat.changed-surface
    - uat.multi-principal
    - uat.oauth-direct-plugin-canary

production:
  configured: false
  target: null
  url: null
  promotion_workflow_ref: null
  deploy_authority: manual-only
  ship_work_release_deploy_allowed: false
  handoff_rows:
    - handoff.exact-artifact
    - handoff.scope-uat-accepted
  promotion_requires:
    - explicit-user-production-prompt
    - separate-final-confirmation
    - exact-artifact-without-rebuild
    - complete-scope-uat-acceptance
    - provisioned-production-target
    - production-rollback-plan

evidence:
  facts:
    - id: run.changed_capabilities
      type: string-set
      source: run.batch_manifest.changed_capability_ids
    - id: run.has_changed_product_surface
      type: boolean
      source: run.batch_manifest.has_changed_release_surface
    - id: run.scope_required_capabilities
      type: string-set
      source: run.scope_snapshot.required_evidence_capability_ids
    - id: uat.has_previous_deployment
      type: boolean
      source: run.uat_predeploy_receipt.has_current_deployment
  redaction_policies:
    - id: release-evidence-default
      mode: allowlist-first
      allowed_fields:
        - schema
        - status
        - started_at
        - completed_at
        - duration_ms
        - candidate_sha
        - project_id
        - version_id
        - deployment_id
        - resolved_url
        - actor_class
        - run_fingerprint
        - actor_fingerprints
        - binding_namespace
        - credential_fingerprint
        - client
        - client_version
        - marketplace_candidate_sha
        - marketplace_tree_sha
        - plugin_version
        - plugin_snapshot_sha256
        - protocol_version
        - route
        - assertions
        - external_ui_canary
        - requirement
        - claim
        - artifact_sha256
        - screenshot_ref
        - failure_class
        - redacted_summary
      never_store:
        - credential_value
        - authorization_header
        - cookie
        - csrf_token
        - bearer_token
        - private_mind_content
        - raw_request_body
        - raw_response_body
        - download_url
      actor_storage: class-and-opaque-fingerprint-only
      redact_before_persist: true
  rows:
    - id: dev.authenticated-web-control
      stage: dev
      requirement: required
      when: { always: true }
      probe:
        kind: runtime_capability
        capability: mind-diary/dev-smoke/v1
        inputs:
          scenario: { literal: authenticated-web-control }
          base_url: { value_from: dev.resolved_url }
          actor_class: { literal: synthetic-owner }
      success: { path: /status, operator: eq, value: passed }
      artifact:
        schema: mind-diary/smoke-evidence/v1
        media_type: application/json
        storage: content-addressed-reference
        max_bytes: 1048576
        required_fields: [status, candidate_sha, resolved_url, assertions, artifact_sha256]
      redaction_policy: release-evidence-default
    - id: dev.persistence-restart
      stage: dev
      requirement: required
      when: { always: true }
      probe:
        kind: runtime_capability
        capability: mind-diary/dev-smoke/v1
        inputs:
          scenario: { literal: persistence-across-runtime-restart }
          base_url: { value_from: dev.resolved_url }
          actor_class: { literal: synthetic-owner }
      success: { path: /status, operator: eq, value: passed }
      artifact:
        schema: mind-diary/smoke-evidence/v1
        media_type: application/json
        storage: content-addressed-reference
        max_bytes: 1048576
        required_fields: [status, candidate_sha, resolved_url, assertions, artifact_sha256]
      redaction_policy: release-evidence-default
    - id: dev.mcp-modern
      stage: dev
      requirement: required
      when: { always: true }
      probe:
        kind: runtime_capability
        capability: mind-diary/dev-smoke/v1
        inputs:
          scenario: { literal: mcp-modern-2026-07-28 }
          route: { literal: /api/mcp }
          base_url: { value_from: dev.resolved_url }
          actor_class: { literal: synthetic-owner }
      success: { path: /status, operator: eq, value: passed }
      artifact:
        schema: mind-diary/mcp-smoke-evidence/v1
        media_type: application/json
        storage: content-addressed-reference
        max_bytes: 1048576
        required_fields: [status, candidate_sha, protocol_version, route, assertions, artifact_sha256]
      redaction_policy: release-evidence-default
    - id: dev.mcp-compat
      stage: dev
      requirement: conditional
      when:
        any:
          - { fact: run.changed_capabilities, operator: contains, value: mcp.compat.2025-11-25 }
          - { fact: run.scope_required_capabilities, operator: contains, value: mcp.compat.2025-11-25 }
      probe:
        kind: runtime_capability
        capability: mind-diary/dev-smoke/v1
        inputs:
          scenario: { literal: mcp-compat-2025-11-25 }
          route: { literal: /api/mcp/2025-11-25 }
          base_url: { value_from: dev.resolved_url }
          actor_class: { literal: synthetic-owner }
      success: { path: /status, operator: eq, value: passed }
      artifact:
        schema: mind-diary/mcp-smoke-evidence/v1
        media_type: application/json
        storage: content-addressed-reference
        max_bytes: 1048576
        required_fields: [status, candidate_sha, protocol_version, route, assertions, artifact_sha256]
      redaction_policy: release-evidence-default
    - id: dev.changed-surface
      stage: dev
      requirement: conditional
      when:
        all:
          - { fact: run.has_changed_product_surface, operator: eq, value: true }
      probe:
        kind: runtime_capability
        capability: mind-diary/changed-surface-smoke/v1
        inputs:
          environment: { literal: dev }
          base_url: { value_from: dev.resolved_url }
          manifest: { value_from: run.batch_manifest }
      success: { path: /status, operator: eq, value: passed }
      artifact:
        schema: mind-diary/changed-surface-evidence/v1
        media_type: application/json
        storage: content-addressed-reference
        max_bytes: 2097152
        required_fields: [status, candidate_sha, assertions, artifact_sha256]
      redaction_policy: release-evidence-default
    - id: dev.synthetic-multi-principal
      stage: dev
      requirement: required
      when: { always: true }
      probe:
        kind: runtime_capability
        capability: mind-diary/synthetic-multi-principal-smoke/v1
        implementation:
          command: [npm, run, gate:synthetic-multi-principal, "--", --candidate-sha, "{candidate_sha}", --evidence-out, "{private-temp-evidence-path}"]
          runbook: docs/operations/synthetic-multi-principal-runbook.md
          composition: isolated-test-only
          storage_seed: forbidden
        inputs:
          candidate_sha: { value_from: run.candidate_sha }
          actor_class: { literal: synthetic-principal }
          binding_namespace: { literal: synthetic-test }
      success: { path: /status, operator: eq, value: passed }
      artifact:
        schema: mind-diary/synthetic-multi-principal-evidence/v1
        media_type: application/json
        storage: content-addressed-reference
        max_bytes: 2097152
        required_fields: [status, candidate_sha, actor_class, binding_namespace, run_fingerprint, actor_fingerprints, assertions, artifact_sha256]
      redaction_policy: release-evidence-default
    - id: dev.oauth-direct-plugin
      stage: dev
      requirement: required
      when: { always: true }
      probe:
        kind: runtime_capability
        capability: mind-diary/oauth-direct-plugin-smoke/v1
        implementation:
          command: [npm, run, gate:oauth-direct-plugin, "--", --candidate-sha, "{candidate_sha}", --evidence-out, "{private-temp-evidence-path}"]
          specification: docs/specs/plugin-connector.md
          decision: docs/decisions/0012-synthetic-principal-release-gates.md
          context: fresh-temporary-codex-plugin
          marketplace_source: clean-sibling-checkout
        inputs:
          candidate_sha: { value_from: run.candidate_sha }
          route: { literal: /api/mcp }
          installation: { literal: AVAILABLE }
          authentication: { literal: ON_USE }
          binding_namespace: { literal: synthetic-test }
      success: { path: /status, operator: eq, value: passed }
      artifact:
        schema: mind-diary/oauth-direct-plugin-evidence/v1
        media_type: application/json
        storage: content-addressed-reference
        max_bytes: 2097152
        required_fields: [status, candidate_sha, marketplace_candidate_sha, marketplace_tree_sha, plugin_version, plugin_snapshot_sha256, client, client_version, route, binding_namespace, external_ui_canary, assertions, artifact_sha256]
      redaction_policy: release-evidence-default
    - id: dev.mind-bindings
      stage: dev
      requirement: required
      when: { always: true }
      probe:
        kind: receipt_assertion
        receipt_ids:
          - dev.synthetic-multi-principal
          - dev.oauth-direct-plugin
        required_assertion_ids:
          - bindings.initial-empty
          - bindings.multi-read-idempotent
          - bindings.single-write-current-target
          - bindings.current-target-exactly-one-revision
          - bindings.rebind-stale-no-side-effect
          - bindings.concurrent-rebind-cas
          - bindings.restart-persistence
          - bindings.detach-unbind-fail-closed
          - bindings.mind-delete-invalidates-target
          - bindings.owner-revoke-invalidates-state
          - oauth.explicit-write-binding-readback
          - oauth.connected-app-binding-revoke
          - oauth.reconnect-empty-binding-generation
        assertions:
          - { left: run.candidate_sha, operator: all-equal }
      success: { path: /status, operator: eq, value: passed }
      artifact:
        schema: mind-diary/mind-bindings-join-evidence/v1
        media_type: application/json
        storage: inline-bounded
        max_bytes: 65536
        required_fields: [status, candidate_sha, receipt_ids, assertions, artifact_sha256]
      redaction_policy: release-evidence-default
    - id: uat.exact-artifact-lineage
      stage: uat
      requirement: required
      when: { always: true }
      probe:
        kind: receipt_assertion
        receipt_ids:
          - repository.full-gate
          - dev.launch
          - ci.integration-ref.cas
          - ci.required-run.wait
          - uat.version.save
          - uat.deployment.deploy
        assertions:
          - { left: run.candidate_sha, operator: all-equal }
          - { left: uat.target.id, operator: all-equal }
      success: { path: /status, operator: eq, value: passed }
      artifact:
        schema: ship-work-release/lineage-evidence/v1
        media_type: application/json
        storage: inline-bounded
        max_bytes: 65536
        required_fields: [status, candidate_sha, project_id, version_id, deployment_id, artifact_sha256]
      redaction_policy: release-evidence-default
    - id: uat.authenticated-web-control
      stage: uat
      requirement: required
      when: { always: true }
      probe:
        kind: runtime_capability
        capability: mind-diary/uat-smoke/v1
        inputs:
          scenario: { literal: authenticated-web-control }
          base_url: { literal: "https://mind-diary.example.invalid" }
          actor_class: { literal: single-principal-owner }
          credential_ref: { literal: provider-session/openai-sites-current-principal }
      success: { path: /status, operator: eq, value: passed }
      artifact:
        schema: mind-diary/smoke-evidence/v1
        media_type: application/json
        storage: content-addressed-reference
        max_bytes: 2097152
        required_fields: [status, candidate_sha, deployment_id, resolved_url, actor_class, assertions, artifact_sha256]
      redaction_policy: release-evidence-default
    - id: uat.persistence-redeploy
      stage: uat
      requirement: conditional
      when:
        all:
          - { fact: uat.has_previous_deployment, operator: eq, value: true }
      probe:
        kind: runtime_capability
        capability: mind-diary/uat-smoke/v1
        inputs:
          scenario: { literal: persistence-across-redeploy }
          base_url: { literal: "https://mind-diary.example.invalid" }
          before_deployment: { value_from: run.uat_previous_deployment_id }
          after_deployment: { value_from: run.uat_deployment_id }
          actor_class: { literal: single-principal-owner }
          credential_ref: { literal: provider-session/openai-sites-current-principal }
      success: { path: /status, operator: eq, value: passed }
      artifact:
        schema: mind-diary/persistence-smoke-evidence/v1
        media_type: application/json
        storage: content-addressed-reference
        max_bytes: 1048576
        required_fields: [status, candidate_sha, deployment_id, assertions, artifact_sha256]
      redaction_policy: release-evidence-default
    - id: uat.mcp-modern
      stage: uat
      requirement: required
      when: { always: true }
      probe:
        kind: runtime_capability
        capability: mind-diary/uat-mcp-smoke/v1
        inputs:
          scenario: { literal: codex-modern-2026-07-28 }
          route: { literal: /api/mcp }
          base_url: { literal: "https://mind-diary.example.invalid" }
          actor_class: { literal: single-principal-owner }
          credential_ref: { literal: provider-session/openai-sites-current-principal }
      success: { path: /status, operator: eq, value: passed }
      artifact:
        schema: mind-diary/mcp-smoke-evidence/v1
        media_type: application/json
        storage: content-addressed-reference
        max_bytes: 1048576
        required_fields: [status, candidate_sha, deployment_id, client, client_version, protocol_version, route, assertions, artifact_sha256]
      redaction_policy: release-evidence-default
    - id: uat.mcp-compat
      stage: uat
      requirement: conditional
      when:
        any:
          - { fact: run.changed_capabilities, operator: contains, value: mcp.compat.2025-11-25 }
          - { fact: run.scope_required_capabilities, operator: contains, value: mcp.compat.2025-11-25 }
      probe:
        kind: runtime_capability
        capability: mind-diary/uat-mcp-smoke/v1
        inputs:
          scenario: { literal: codex-compat-2025-11-25 }
          route: { literal: /api/mcp/2025-11-25 }
          base_url: { literal: "https://mind-diary.example.invalid" }
          actor_class: { literal: single-principal-owner }
          credential_ref: { literal: provider-session/openai-sites-current-principal }
      success: { path: /status, operator: eq, value: passed }
      artifact:
        schema: mind-diary/mcp-smoke-evidence/v1
        media_type: application/json
        storage: content-addressed-reference
        max_bytes: 1048576
        required_fields: [status, candidate_sha, deployment_id, client, client_version, protocol_version, route, assertions, artifact_sha256]
      redaction_policy: release-evidence-default
    - id: uat.mind-bindings
      stage: uat
      requirement: required
      when: { always: true }
      probe:
        kind: runtime_capability
        capability: mind-diary/uat-mind-bindings/v1
        inputs:
          scenario: { literal: exact-candidate-two-mind-binding-matrix }
          base_url: { literal: "https://mind-diary.example.invalid" }
          deployment_id: { value_from: run.uat_deployment_id }
          actor_class: { literal: single-principal-owner }
          credential_ref: { literal: fresh-installed-marketplace-plugin }
          targets: { literal: two-clearly-synthetic-private-minds }
          routes: { literal: [/api/mcp, /api/mcp/2025-11-25] }
        required_assertion_ids:
          - bindings.read-two-exact-targets
          - bindings.target-a-commit-and-capture
          - bindings.prepare-a-rebind-b-stale-no-side-effect
          - bindings.target-b-commit-exactly-once
          - bindings.target-a-head-unchanged-after-stale
          - bindings.detach-unbind-fail-closed
          - bindings.persistence-after-redeploy
          - bindings.oauth-refresh-preserves-generation
          - bindings.oauth-revoke-invalidates-generation
          - bindings.fresh-reconnect-empty-generation
          - bindings.modern-compat-shared-state
          - plugin.fresh-install-exact-version
      success: { path: /status, operator: eq, value: passed }
      artifact:
        schema: mind-diary/uat-mind-bindings-evidence/v1
        media_type: application/json
        storage: content-addressed-reference
        max_bytes: 2097152
        required_fields: [status, candidate_sha, deployment_id, plugin_version, client, client_version, routes, target_fingerprints, assertions, artifact_sha256]
      redaction_policy: release-evidence-default
    - id: uat.changed-surface
      stage: uat
      requirement: conditional
      when:
        all:
          - { fact: run.has_changed_product_surface, operator: eq, value: true }
      probe:
        kind: runtime_capability
        capability: mind-diary/changed-surface-smoke/v1
        inputs:
          environment: { literal: uat }
          base_url: { literal: "https://mind-diary.example.invalid" }
          deployment_id: { value_from: run.uat_deployment_id }
          manifest: { value_from: run.batch_manifest }
      success: { path: /status, operator: eq, value: passed }
      artifact:
        schema: mind-diary/changed-surface-evidence/v1
        media_type: application/json
        storage: content-addressed-reference
        max_bytes: 2097152
        required_fields: [status, candidate_sha, deployment_id, assertions, artifact_sha256]
      redaction_policy: release-evidence-default
    - id: uat.multi-principal
      stage: uat
      requirement: informational
      when: { always: true }
      probe:
        kind: runtime_capability
        capability: mind-diary/uat-multi-principal-smoke/v1
        implementation:
          command: [npm, run, uat:multi-principal, "--"]
          runbook: docs/operations/uat-multi-principal-runbook.md
          phases: [setup, verify, cleanup]
          redeploy_boundary: required-between-setup-and-verify
        inputs:
          base_url: { literal: "https://mind-diary.example.invalid" }
          deployment_id: { value_from: run.uat_deployment_id }
          actor_source: { literal: explicit-test-principal-reference }
          scope: { value_from: run.scope_snapshot }
      success: { path: /status, operator: eq, value: passed }
      artifact:
        schema: mind-diary/multi-principal-evidence/v1
        media_type: application/json
        storage: content-addressed-reference
        max_bytes: 2097152
        required_fields: [status, candidate_sha, deployment_id, actor_class, actor_fingerprints, assertions, artifact_sha256]
      redaction_policy: release-evidence-default
    - id: uat.oauth-direct-plugin-canary
      stage: uat
      requirement: informational
      when: { always: true }
      probe:
        kind: runtime_capability
        capability: mind-diary/uat-oauth-direct-plugin-canary/v1
        inputs:
          scenario: { literal: real-external-codex-install-oauth-ui }
          base_url: { literal: "https://mind-diary.example.invalid" }
          deployment_id: { value_from: run.uat_deployment_id }
          actor_source: { literal: explicit-test-principal-reference }
          route: { literal: /api/mcp }
      success: { path: /status, operator: eq, value: passed }
      artifact:
        schema: mind-diary/oauth-direct-plugin-canary-evidence/v1
        media_type: application/json
        storage: content-addressed-reference
        max_bytes: 2097152
        required_fields: [status, candidate_sha, deployment_id, plugin_version, client, client_version, assertions, artifact_sha256]
      redaction_policy: release-evidence-default
    - id: rollback.authenticated-web-control
      stage: rollback
      requirement: required
      when: { always: true }
      probe:
        kind: runtime_capability
        capability: mind-diary/uat-smoke/v1
        inputs:
          scenario: { literal: authenticated-web-control }
          base_url: { literal: "https://mind-diary.example.invalid" }
          actor_class: { literal: single-principal-owner }
          credential_ref: { literal: provider-session/openai-sites-current-principal }
      success: { path: /status, operator: eq, value: passed }
      artifact:
        schema: mind-diary/smoke-evidence/v1
        media_type: application/json
        storage: content-addressed-reference
        max_bytes: 1048576
        required_fields: [status, deployment_id, resolved_url, assertions, artifact_sha256]
      redaction_policy: release-evidence-default
    - id: rollback.mcp-modern
      stage: rollback
      requirement: required
      when: { always: true }
      probe:
        kind: runtime_capability
        capability: mind-diary/uat-mcp-smoke/v1
        inputs:
          scenario: { literal: codex-modern-2026-07-28 }
          route: { literal: /api/mcp }
          base_url: { literal: "https://mind-diary.example.invalid" }
          actor_class: { literal: single-principal-owner }
          credential_ref: { literal: provider-session/openai-sites-current-principal }
      success: { path: /status, operator: eq, value: passed }
      artifact:
        schema: mind-diary/mcp-smoke-evidence/v1
        media_type: application/json
        storage: content-addressed-reference
        max_bytes: 1048576
        required_fields: [status, deployment_id, client, protocol_version, route, assertions, artifact_sha256]
      redaction_policy: release-evidence-default
    - id: handoff.exact-artifact
      stage: handoff
      requirement: required
      when: { always: true }
      probe:
        kind: receipt_assertion
        receipt_ids: [uat.exact-artifact-lineage]
        assertions:
          - { left: run.final_candidate_sha, operator: eq, right: run.scope_uat_release_sha }
      success: { path: /status, operator: eq, value: passed }
      artifact:
        schema: ship-work-release/handoff-evidence/v1
        media_type: application/json
        storage: inline-bounded
        max_bytes: 65536
        required_fields: [status, candidate_sha, deployment_id, artifact_sha256]
      redaction_policy: release-evidence-default
    - id: handoff.scope-uat-accepted
      stage: handoff
      requirement: required
      when: { always: true }
      probe:
        kind: receipt_assertion
        receipt_ids: [run.scope-uat-release]
        assertions:
          - { left: run.scope_completion, operator: eq, right: accepted }
      success: { path: /status, operator: eq, value: passed }
      artifact:
        schema: ship-work-release/handoff-evidence/v1
        media_type: application/json
        storage: inline-bounded
        max_bytes: 65536
        required_fields: [status, candidate_sha, deployment_id, artifact_sha256]
      redaction_policy: release-evidence-default

runtime:
  grace:
    default_seconds: 300
    min_seconds: 30
    max_seconds: 900
  quiet_heartbeat_seconds: 600
  lanes:
    default_writable: 1
    max_writable: 3
  retention:
    receipts:
      policy: keep-until-explicit-prune
      terminal_min_days: 30
    transient_logs_days: 7
  deadline_enforcement:
    required_for_bounded_grace: true
    capability: codex/runtime-active-deadline/v1
    unavailable_behavior: reject-bounded-grace
~~~

## Resolution rules

Accepted [Mind binding contract](../specs/mind-bindings.md) имеет отдельные
blocking `dev.mind-bindings` и `uat.mind-bindings` rows. Candidate, который
включает binding runtime changes, нельзя продвигать по прежней MCP matrix как
будто она достаточна: exact-candidate receipts обязаны доказать persistence,
concurrency, revoke/delete, stale-writer/no-side-effect, OAuth
revoke/reconnect-generation и fresh-plugin behavior до terminal UAT result.
Contract-only `MD-229` проверяется docs validator и diff check и не является
hosted functionality.

Linear collection разрешается только по immutable project ID
`6c07eabb-e588-4184-8eaa-5974ad67fdda`; имя `Mind Diary` остаётся display
metadata. Default selector должен вернуть один exact nonterminal milestone и
сохранить его stable ID в scope snapshot.

Sites project ID читается из tracked
`apps/mind-diary-site/.openai/hosting.json#/project_id` на exact candidate.
Resolved ID, hash manifest-а, saved version, deployment и live URL сохраняются
в UAT receipt. Там же независимо фиксируются product class `uat` и provider
class `openai-sites-production-deployment` — платформенный термин OpenAI Sites
«production deployment». Он не означает product production. Ни repository
name, ни URL, ни старый receipt не используются вместо target resolution.

## Command и environment boundaries

Все commands выполняются прямым `argv` без shell. Канонический full dev launcher
проекта — root `npm run dev`; его machine event сообщает loopback URL,
readiness и non-secret configuration fingerprint. Dev получает только
local/test data. UAT credentials остаются в provider-managed session и в
receipts представлены только actor class и opaque fingerprint.

Exact diff check всегда получает закрытый range
`{base_sha}..{candidate_sha}`. Full gate относится к exact integrated candidate,
а CI query принимает только run workflow `328602767` с тем же full SHA.

Deployable Sites archive собирается отдельной командой
`npm --prefix apps/mind-diary-site run build` уже после checkout exact candidate
и успешного full gate. Root `npm run check` компилирует workspace packages, но
не является vinext build и не доказывает свежесть
`apps/mind-diary-site/dist`. Публикуемый `.tgz` имеет один top-level `dist/` и
обязан содержать `dist/server/index.js` и `dist/.openai/hosting.json`; archive,
повторивший content hash предыдущей версии после runtime change, считается
stale и не deploy-ится. Если Sites дедуплицировал saved version по уже
использованному `commit_sha`, сначала нужен новый exact candidate SHA, а не
повторный save другого archive под прежним source identity.

## Performance gate

Изменения metadata/runtime/MCP read path, search storage или locator layout
требуют отдельного exact-candidate performance receipt. Канонический runner:

```text
npm run gate:performance -- --scenario <private-scenario.json> --telemetry-jsonl <private-telemetry.jsonl> --candidate-sha <40-hex> --deployment-id <exact-id> --output <private-report.json>
```

Scenario и telemetry живут только в private temporary evidence storage.
Credential values передаются runner-у исключительно через имена environment
variables внутри scenario; report не сохраняет headers, token, query, body,
Mind/revision IDs или raw response. Scenario связывает exact environment,
deployment и SHA, содержит минимум 20 warm samples на request и заявляет
фактически подготовленную matrix: `1/10/100` Minds, `1/20/100/1000` revisions,
Brain Markdown profile не меньше `1741` files / `5,681,704` bytes и mixed corpus
не меньше `590,000,000` bytes. До готовности MD-245 mixed corpus row остаётся
непроверенной и performance acceptance не может стать terminal.

For MD-265–MD-268/MD-260 the same exact-candidate receipt additionally records
delta R2/D1 bytes, reservation/headroom state, export/cleanup queue age, peak
buffered bytes and bounded import checkpoints according to
[ADR-0016](../decisions/0016-sites-storage-capacity-import.md). MD-264 is
contract-only and does not claim hosted capacity evidence.

Ненулевые blocking budgets:

- server telemetry p95: `list_minds`, `browse_entries`, `search` ≤ `2000 ms`,
  `fetch` ≤ `1000 ms`;
- connector-observed read p95 ≤ `5000 ms`, authenticated home p95 ≤ `3000 ms`;
- каждый first-observed request ≤ `5000 ms`; это честная observational метрика,
  а не утверждение о provider cold isolate без отдельного provider signal;
- point read при `10x` history имеет p95 не выше `1.2x` соответствующего `1x`
  profile.

Runner завершает процесс ненулевым кодом при превышении, менее чем 20 samples,
неполной matrix, отсутствии server telemetry или history comparison. Local/dev
receipt не заменяет UAT receipt; UAT receipt обязан ссылаться на exact Sites
deployment и тот же candidate SHA.

## UAT и production boundary

Обычный hosted release публикует saved Sites version в UAT project и после
неопределённого provider outcome сначала reconciles version/deployment. Первый
cut без stable receipt требует explicit acceptance текущего deployment как
baseline; timestamp либо “предыдущая версия” по списку не выбираются
автоматически.

Текущий Site является UAT. `production.configured=false`, поэтому этот profile
не содержит production target, URL или promotion workflow. Даже после их
добавления `ship_work_release_deploy_allowed` остаётся `false`: skill сможет
подготовить только exact handoff, а production effect принадлежит отдельному
manual workflow с новым prompt и финальным подтверждением.

## Evidence interpretation

Required rows доказывают только перечисленные assertions exact environment и
candidate. `dev.synthetic-multi-principal` и `dev.oauth-direct-plugin` всегда
blocking; `dev.mind-bindings` join-ит их exact-SHA assertions, а
`uat.mind-bindings` всегда blocking для текущего binding candidate.
Compatibility, changed-surface и persistence-after-redeploy rows становятся
обязательными по machine condition. Значение `not-applicable`
допустимо только при false condition; отсутствие required runtime capability
или artifact является failure, а не основанием пропустить проверку.

`uat.multi-principal` и `uat.oauth-direct-plugin-canary` — informational real-
platform observations. Missing actor reference, unavailable external UI или
failed canary сохраняются как non-passing observation и запрещают claim о
проверенной canary surface, но не блокируют UAT cut 0.1. Они не удовлетворяют
blocking dev rows и не переименовывают historical receipt schemas.

Automated UAT smoke оставляет owner observation в
`pending-owner-observation`. Никакая evidence row не сохраняет token, cookie,
authorization header, private Mind content или raw response body.
