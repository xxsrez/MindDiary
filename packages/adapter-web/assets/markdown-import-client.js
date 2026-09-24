(() => {
  const panel = document.querySelector("[data-markdown-import]");
  if (!panel) return;

  const csrf = document.querySelector('meta[name="mind-diary-csrf-token"]')?.content ?? "";
  const handle = panel.dataset.importHandle ?? "";
  let head = panel.dataset.headRevision ?? "";
  const input = panel.querySelector("[data-import-files]");
  const review = panel.querySelector("[data-plan-markdown-import]");
  const summary = panel.querySelector("[data-import-plan]");
  const confirm = panel.querySelector("[data-import-confirm]");
  const start = panel.querySelector("[data-start-markdown-import]");
  const cancel = panel.querySelector("[data-cancel-markdown-import]");
  const retryRecovery = panel.querySelector("[data-retry-markdown-import-status]");
  const replan = panel.querySelector("[data-replan-markdown-import]");
  const status = panel.querySelector("[data-import-status]");
  const form = panel.querySelector("[data-markdown-import-form]");
  const progressRegion = panel.querySelector("[data-import-progress-region]");
  const progress = panel.querySelector("[data-import-progress]");
  const progressText = panel.querySelector("[data-import-progress-text]");
  const phase = panel.querySelector("[data-import-phase]");
  const receipt = panel.querySelector("[data-import-receipt]");
  const pathCheck = panel.querySelector("[data-import-path-check]");
  const formatCheck = panel.querySelector("[data-import-format-check]");
  const capacityCheck = panel.querySelector("[data-import-capacity-check]");

  const openStates = new Set(["active", "validating", "validated", "finalizing"]);
  const terminalStates = new Set(["canceled", "expired", "validation_failed"]);
  const importIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
  const maxBatchFiles = 20;
  const utf8 = new TextEncoder();
  const strictUtf8 = new TextDecoder("utf-8", { fatal: true });
  let files = [];
  let plan = null;
  let session = null;
  let sessionPlan = null;
  let busy = false;
  let recoveryPending = false;
  let planAttemptKey = null;
  let sessionAttemptKey = null;

  const shown = (node, value) => {
    if (!node) return;
    node.hidden = !value;
    node.style.display = value ? "" : "none";
  };
  const say = (message) => {
    if (status) status.textContent = message;
  };
  const key = (prefix) => `${prefix}:${crypto.randomUUID()}`;
  const taggedError = (code, statusCode = 0, statusRead = false, details = null) => Object.assign(
    new Error("Import request failed"),
    { code, statusCode, statusRead, details },
  );
  const number = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;

  const capacityMessage = (code, details) => ({
    capacity_fairness_limit: `Another heavy operation is active${({ mind: " for this Mind", principal: " for this account", site: " on this Site" })[details?.space_scope] ?? ""}; retry the same plan after it finishes.`,
    capacity_soft_limit: details?.metric === "physical_canonical_bytes"
      ? "Stored content is near its limit. Reduce the new snapshot or wait for capacity to change, then retry the same plan."
      : details?.metric === "d1_metadata_bytes"
        ? "Metadata storage is near its limit. Reduce the file count or wait for capacity to change, then retry the same plan."
        : details?.metric === "temporary_bytes"
          ? "Temporary storage is near its limit. Finish or clean up earlier jobs, then retry the same plan."
          : "Storage capacity is near its limit. Reduce this snapshot or wait for capacity to change, then retry the same plan.",
    capacity_hard_limit: details?.metric === "d1_metadata_bytes"
      ? "Metadata storage is at its limit. Reduce the file count or wait for capacity to change before creating a new plan."
      : "This snapshot exceeds current storage capacity. Reduce its size or wait for capacity to change before creating a new plan.",
    capacity_accounting_untrusted: "Storage accounting is being reconciled; retry same plan/job after reconciliation finishes.",
  })[code] ?? "This snapshot cannot fit within the current import or storage capacity.";
  const projectedCapacityCode = (value) => value?.projected_utilization === "hard_limit"
    ? "capacity_hard_limit"
    : "capacity_soft_limit";

  const setCheck = (node, state, message) => {
    if (!node) return;
    node.dataset.checkState = state;
    node.textContent = message;
  };

  const setProgress = (label, value, message) => {
    const bounded = Math.max(0, Math.min(100, Math.round(value)));
    shown(progressRegion, true);
    if (phase) phase.textContent = label;
    if (progress) {
      progress.value = bounded;
      progress.textContent = `${bounded}%`;
    }
    if (progressText) progressText.value = message ?? `${bounded}%`;
  };

  const failMessage = (error) => {
    if (error?.code === "import_head_conflict") {
      return "This plan is based on an older revision. Reload the Mind and review a new plan.";
    }
    if (error?.code === "import_file_conflict") {
      return "The selected snapshot no longer matches the reviewed plan. Review the exact files again.";
    }
    if (error?.code?.startsWith("capacity_")) return capacityMessage(error.code, error.details);
    if (error?.code?.includes("limit")) return "This snapshot cannot fit within the current import or storage capacity.";
    if (error?.code?.includes("expired")) {
      return "The staged import expired. Review a fresh snapshot.";
    }
    return "The import step could not finish. The current revision was not partially changed.";
  };

  const json = async (method, path, body, idempotencyKey) => {
    const statusRead = method === "GET" && /^\/api\/v1\/markdown-imports\//u.test(path);
    const headers = { accept: "application/json", "x-csrf-token": csrf };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    let response;
    try {
      response = await fetch(path, {
        method,
        headers,
        credentials: "same-origin",
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw taggedError(statusRead ? "status_read_unavailable" : "operation_failed", 0, statusRead);
    }
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      // The fixed error below deliberately avoids reflecting an intermediary response.
    }
    if (!response.ok || payload?.ok !== true) {
      throw taggedError(payload?.error?.code ?? "operation_failed", response.status, statusRead, payload?.error?.details);
    }
    return payload.data;
  };

  const setStats = (value) => {
    for (const [selector, field] of [
      ["[data-import-additions]", "additions"],
      ["[data-import-replacements]", "replacements"],
      ["[data-import-deletions]", "deletions"],
      ["[data-import-unchanged]", "unchanged"],
    ]) {
      const node = panel.querySelector(selector);
      if (node) node.textContent = String(number(value?.[field]));
    }
    shown(summary, true);
  };

  const setPlanChecks = (value) => {
    setCheck(pathCheck, "passed", "Paths: normalized, relative and collision-free.");
    setCheck(formatCheck, "passed", "Format: every selected file is UTF-8 Markdown.");
    const utilization = value?.projected_utilization;
    if (utilization === "normal") {
      setCheck(capacityCheck, "passed", "Capacity: accepted by the current server plan.");
      return true;
    }
    if (utilization === "warning") {
      setCheck(capacityCheck, "warning", "Capacity: accepted, but projected usage is nearing the limit.");
      return true;
    }
    setCheck(capacityCheck, "failed", capacityMessage(projectedCapacityCode(value)));
    return false;
  };

  const showReceipt = (baseRevision, revisionId) => {
    const targetNode = panel.querySelector("[data-import-receipt-target]");
    const baseNode = panel.querySelector("[data-import-receipt-base]");
    const revisionNode = panel.querySelector("[data-import-receipt-revision]");
    if (targetNode) targetNode.textContent = `/${handle}`;
    if (baseNode) baseNode.textContent = baseRevision || head;
    if (revisionNode) revisionNode.textContent = revisionId;
    const currentRevisionNode = panel.querySelector("[data-import-base-revision]");
    if (currentRevisionNode) currentRevisionNode.textContent = revisionId;
    head = revisionId;
    panel.dataset.headRevision = revisionId;
    recoveryPending = false;
    shown(retryRecovery, false);
    shown(receipt, true);
    setProgress("Import complete", 100, "100%");
    say(`Import committed as revision ${revisionId}. No partial snapshot was visible.`);
  };

  const headConflict = () => {
    persist(null);
    recoveryPending = false;
    session = null;
    sessionPlan = null;
    plan = null;
    files = [];
    planAttemptKey = null;
    sessionAttemptKey = null;
    if (confirm) confirm.checked = false;
    shown(cancel, false);
    shown(retryRecovery, false);
    shown(replan, true);
    setCheck(capacityCheck, "failed", "Plan conflict: the current revision changed.");
    say("This plan is based on an older revision. Reload the Mind and review a new plan.");
  };

  const sync = () => {
    const canContinue = plan !== null ||
      session?.state === "validated" ||
      session?.state === "validating" ||
      session?.state === "finalizing" ||
      (session?.state === "active" && files.length > 0);
    if (start) start.disabled = busy || recoveryPending || confirm?.checked !== true || !canContinue;
    if (review) review.disabled = busy || recoveryPending;
    if (input) input.disabled = busy || recoveryPending;
    if (cancel) {
      cancel.disabled = busy;
      shown(cancel, session !== null && openStates.has(session.state));
    }
    if (retryRecovery) retryRecovery.disabled = busy;
  };

  const scalar = (left, right) => {
    const a = Array.from(left, (value) => value.codePointAt(0));
    const b = Array.from(right, (value) => value.codePointAt(0));
    for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
      if (a[index] !== b[index]) return a[index] - b[index];
    }
    return a.length - b.length;
  };
  const hex = (buffer) => Array.from(
    new Uint8Array(buffer),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  const digest = async (bytes) => `sha256:${hex(await crypto.subtle.digest("SHA-256", bytes))}`;

  const validPath = (path) => {
    const segments = path.split("/");
    if (
      path.length < 1 || path !== path.normalize("NFC") || path.startsWith("/") ||
      path.includes("\\") || path.includes("//") || !path.endsWith(".md") ||
      /^[a-z][a-z0-9+.-]*:/iu.test(path) || /^[a-z]:/iu.test(path) ||
      /%(?:00|2f|5c)/iu.test(path) || /[\u0000-\u001f\u007f]/u.test(path) ||
      utf8.encode(path).byteLength > 1024 ||
      segments.some((segment) => segment === "" || segment === "." || segment === ".." || segment === ".mind-diary" || utf8.encode(segment).byteLength > 255)
    ) return false;
    return true;
  };

  const scan = async () => {
    const selected = Array.from(input?.files ?? []);
    if (selected.length < 1) throw taggedError("empty_import_selection");
    if (selected.length > 10_000) throw taggedError("import_file_limit_exceeded");
    const raw = selected.map((file) => file.webkitRelativePath || file.name);
    const roots = raw.map((path) => path.includes("/") ? path.slice(0, path.indexOf("/")) : null);
    const strip = roots[0] !== null && roots.every((root) => root === roots[0]);
    const seen = new Set();
    let total = 0;
    const result = [];
    shown(receipt, false);
    shown(replan, false);
    shown(summary, true);
    setCheck(pathCheck, "pending", "Paths: checking selected names…");
    setCheck(formatCheck, "pending", "Format: checking UTF-8 Markdown…");
    setCheck(capacityCheck, "pending", "Capacity: waiting for server plan.");
    for (let index = 0; index < selected.length; index += 1) {
      const file = selected[index];
      const original = raw[index];
      const path = strip ? original.slice(original.indexOf("/") + 1) : original;
      if (!validPath(path) || seen.has(path)) throw taggedError("local_path_conflict");
      if (file.size > 1_048_576) throw taggedError("import_byte_limit_exceeded");
      seen.add(path);
      total += file.size;
      if (total > 67_108_864) throw taggedError("import_byte_limit_exceeded");
      setProgress("Reviewing selected files", ((index + 1) / selected.length) * 15, `${index + 1} of ${selected.length}`);
      const bytes = await file.arrayBuffer();
      try {
        strictUtf8.decode(bytes);
      } catch {
        throw taggedError("local_format_conflict");
      }
      result.push({ file, path, size: file.size, sha256: await digest(bytes) });
    }
    result.sort((left, right) => scalar(left.path, right.path));
    return result;
  };

  const fingerprint = async (selected) => digest(utf8.encode(JSON.stringify(
    selected.map(({ path, sha256, size }) => ({ path, sha256, size })),
  )));

  const batches = (selected) => {
    const result = [];
    let batch = [];
    let bytes = 0;
    for (const file of selected) {
      if (batch.length > 0 && (batch.length >= maxBatchFiles || bytes + file.size > 4_194_304)) {
        result.push(batch);
        batch = [];
        bytes = 0;
      }
      batch.push(file);
      bytes += file.size;
    }
    if (batch.length > 0) result.push(batch);
    return result;
  };

  const resumeParams = () => new URLSearchParams(location.hash.startsWith("#") ? location.hash.slice(1) : location.hash);
  const saved = () => {
    const params = resumeParams();
    const id = params.get("markdown-import");
    return params.get("markdown-import-mind") === handle && id !== null && importIdPattern.test(id) ? id : null;
  };
  const persist = (id) => {
    const params = resumeParams();
    if (id) {
      params.set("markdown-import", id);
      params.set("markdown-import-mind", handle);
    } else {
      params.delete("markdown-import");
      params.delete("markdown-import-mind");
    }
    const hash = params.toString();
    history.replaceState(null, "", `${location.pathname}${location.search}${hash ? `#${hash}` : ""}`);
  };
  const save = () => persist(session?.import_id ?? null);

  const progressForSession = (current, currentPlan) => {
    const fileCount = Math.max(1, number(currentPlan?.file_count));
    if (current.state === "active") {
      const count = Math.min(fileCount, number(current.staged_file_count));
      setProgress("Uploading bounded batches", 15 + (count / fileCount) * 35, `${count} of ${fileCount} files staged`);
      return;
    }
    if (current.state === "validating") {
      const count = Math.min(fileCount, number(current.validation_checkpoint));
      setProgress("Validating the snapshot", 50 + (count / fileCount) * 25, `${count} of ${fileCount} files checked`);
      return;
    }
    if (current.state === "validated") {
      setProgress("Snapshot validated", 75, `${fileCount} files checked`);
      return;
    }
    if (current.state === "finalizing") {
      const count = Math.min(fileCount, number(current.promotion_checkpoint));
      setProgress("Publishing one revision", 75 + (count / fileCount) * 24, `${count} of ${fileCount} files prepared`);
    }
  };

  const freshSession = async () => {
    if (!session?.import_id) throw taggedError("import_session_not_found");
    const current = await json("GET", `/api/v1/markdown-imports/${encodeURIComponent(session.import_id)}`);
    session = current.session;
    sessionPlan = current.plan;
    recoveryPending = false;
    shown(retryRecovery, false);
    setStats(sessionPlan);
    setPlanChecks(sessionPlan);
    progressForSession(session, sessionPlan);
    save();
    return current;
  };

  const stage = async () => {
    const grouped = batches(files);
    if (number(session.checkpoint) > grouped.length) throw taggedError("import_checkpoint_conflict");
    for (let index = number(session.checkpoint); index < grouped.length; index += 1) {
      const batch = grouped[index];
      setProgress("Uploading bounded batches", 15 + (index / grouped.length) * 35, `Batch ${index + 1} of ${grouped.length}`);
      const body = new FormData();
      const manifest = {
        expected_version: session.version,
        files: batch.map((item, fileIndex) => ({
          field: `file_${fileIndex}`,
          path: item.path,
          sha256: item.sha256,
          size: item.size,
        })),
      };
      body.append("manifest", JSON.stringify(manifest));
      batch.forEach((item, fileIndex) => body.append(`file_${fileIndex}`, item.file, item.file.name));
      const response = await fetch(
        `/api/v1/markdown-imports/${encodeURIComponent(session.import_id)}/batches/${index + 1}`,
        { method: "PUT", headers: { accept: "application/json", "x-csrf-token": csrf }, credentials: "same-origin", body },
      );
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        // Recovery reads the actor-owned checkpoint before any retry.
      }
      if (!response.ok || payload?.ok !== true) {
        throw taggedError(payload?.error?.code ?? "operation_failed", response.status, false, payload?.error?.details);
      }
      session = payload.data.session;
      save();
      progressForSession(session, sessionPlan);
    }
  };

  const unavailableSavedSession = () => {
    persist(null);
    recoveryPending = false;
    session = null;
    sessionPlan = null;
    plan = null;
    files = [];
    if (input) input.value = "";
    if (confirm) confirm.checked = false;
    shown(summary, false);
    shown(progressRegion, false);
    shown(receipt, false);
    shown(cancel, false);
    shown(retryRecovery, false);
    say("This staged import is unavailable to this account. No operation details were shown.");
  };

  const retriableSavedSession = () => {
    recoveryPending = true;
    shown(retryRecovery, true);
    say("Recovery status is temporarily unavailable. The saved import locator was kept; retry recovery or reload this page.");
  };

  const confirmedStatusUnavailable = (error) => error?.statusRead === true && (
    error.statusCode === 401 || error.statusCode === 403 ||
    error.code === "authentication_required" ||
    error.code === "registration_required" ||
    error.code === "forbidden" ||
    error.code === "import_session_not_found"
  );

  const handleStatusReadFailure = (error) => {
    if (confirmedStatusUnavailable(error)) unavailableSavedSession();
    else retriableSavedSession();
  };

  const terminalSession = (current, currentPlan) => {
    if (current.state === "validation_failed" && current.failures?.some((failure) => failure?.code === "import_head_conflict")) {
      setStats(currentPlan);
      setPlanChecks(currentPlan);
      headConflict();
      return;
    }
    persist(null);
    recoveryPending = false;
    session = null;
    sessionPlan = null;
    shown(cancel, false);
    shown(retryRecovery, false);
    say(current.state === "canceled"
      ? "The staged import was canceled. The current revision was unchanged."
      : current.state === "expired"
        ? "The staged import expired. Review a fresh snapshot."
        : "Validation stopped safely. The current revision was unchanged; review a fresh snapshot.");
  };

  const loadSaved = async () => {
    const id = saved();
    if (!id) return;
    const disclosure = panel.closest("details.md-disclosure");
    if (disclosure) disclosure.open = true;
    recoveryPending = true;
    sync();
    say("Checking the saved import status…");
    try {
      const data = await json("GET", `/api/v1/markdown-imports/${encodeURIComponent(id)}`);
      session = data.session;
      sessionPlan = data.plan;
      recoveryPending = false;
      shown(retryRecovery, false);
      if (session.state === "committed") {
        persist(null);
        showReceipt(session.expected_revision_id ?? head, session.revision_id);
        session = null;
        sessionPlan = null;
        return;
      }
      if (terminalStates.has(session.state)) {
        terminalSession(session, sessionPlan);
        return;
      }
      setStats(sessionPlan);
      setPlanChecks(sessionPlan);
      if (confirm) confirm.checked = false;
      progressForSession(session, sessionPlan);
      say(session.state === "active"
        ? "A staged import was recovered. Reselect and review the exact folder before resuming upload."
        : session.state === "validating"
          ? "Snapshot validation can resume from its saved checkpoint. Confirm to continue."
          : session.state === "finalizing"
            ? "Revision publication can resume from its saved checkpoint. Confirm to continue."
            : "The uploaded snapshot is validated. Confirm to publish its one revision.");
    } catch (error) {
      handleStatusReadFailure(error);
    } finally {
      sync();
    }
  };

  input?.addEventListener("change", () => {
    files = [];
    plan = null;
    planAttemptKey = null;
    if (confirm) confirm.checked = false;
    shown(receipt, false);
    shown(replan, false);
    if (session?.state === "active") {
      say("Review the reselected snapshot before resuming its saved upload checkpoint.");
    } else {
      shown(summary, false);
      shown(progressRegion, false);
      say("Review the selected files before importing.");
    }
    sync();
  });
  confirm?.addEventListener("change", sync);

  review?.addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    sync();
    try {
      files = await scan();
      const descriptorHash = await fingerprint(files);
      if (session?.state === "active") {
        const current = await freshSession();
        if (current.session.state !== "active") throw taggedError("import_state_conflict");
        if (current.plan.descriptor_hash !== descriptorHash) throw taggedError("import_file_conflict");
        setStats(current.plan);
        if (!setPlanChecks(current.plan)) throw taggedError(projectedCapacityCode(current.plan));
        say("The recovered snapshot matches its plan. Confirm exact replacement to resume upload.");
      } else {
        planAttemptKey ??= key("import-plan");
        const data = await json(
          "POST",
          `/api/v1/minds/${encodeURIComponent(handle)}/markdown-import-plans`,
          { expected_revision_id: head, files: files.map(({ path, sha256, size }) => ({ path, sha256, size })) },
          planAttemptKey,
        );
        if (data.plan.descriptor_hash !== descriptorHash) throw taggedError("import_file_conflict");
        plan = data.plan;
        setStats(plan);
        if (!setPlanChecks(plan)) throw taggedError(projectedCapacityCode(plan));
        setProgress("Plan ready", 15, `${files.length} files reviewed`);
        say("Review the add, replace and delete counts, then confirm snapshot replacement.");
      }
      if (confirm) confirm.checked = false;
    } catch (error) {
      plan = null;
      if (error?.statusRead === true) {
        handleStatusReadFailure(error);
      } else if (error?.code === "local_path_conflict") {
        setCheck(pathCheck, "failed", "Path conflict: use unique normalized relative .md paths.");
        setCheck(formatCheck, "pending", "Format: not checked after the path conflict.");
        setCheck(capacityCheck, "pending", "Capacity: no server plan was created.");
      } else if (error?.code === "local_format_conflict") {
        setCheck(pathCheck, "passed", "Paths: normalized, relative and collision-free.");
        setCheck(formatCheck, "failed", "Format conflict: every file must be valid UTF-8 Markdown.");
        setCheck(capacityCheck, "pending", "Capacity: no server plan was created.");
      } else if (error?.code === "empty_import_selection") {
        shown(summary, true);
        setCheck(pathCheck, "failed", "Select at least one Markdown file.");
        setCheck(formatCheck, "pending", "Format: waiting for a selection.");
        setCheck(capacityCheck, "pending", "Capacity: no server plan was created.");
      } else if (error?.code === "import_head_conflict") {
        headConflict();
      } else if (error?.code === "import_file_conflict") {
        setCheck(pathCheck, "failed", "Path conflict: the server rejected a selected path or the selection changed.");
      } else if (error?.code?.startsWith("capacity_")) {
        setCheck(capacityCheck, "failed", capacityMessage(error.code, error.details));
      } else if (error?.code?.includes("limit")) {
        setCheck(capacityCheck, "failed", "Capacity conflict: reduce the snapshot before starting.");
      }
      if (error?.statusRead !== true && error?.code !== "import_head_conflict") say(failMessage(error));
    } finally {
      busy = false;
      sync();
    }
  });

  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy || confirm?.checked !== true) return;
    busy = true;
    sync();
    try {
      if (session !== null) {
        const current = await freshSession();
        if (current.session.state === "committed") {
          persist(null);
          showReceipt(current.session.expected_revision_id ?? head, current.session.revision_id);
          session = null;
          sessionPlan = null;
          return;
        }
        if (terminalStates.has(current.session.state)) {
          terminalSession(current.session, current.plan);
          return;
        }
      }
      if (session === null) {
        if (plan === null || files.length === 0) throw taggedError("invalid_import_request");
        sessionAttemptKey ??= key("import-session");
        const data = await json(
          "POST",
          `/api/v1/minds/${encodeURIComponent(handle)}/markdown-imports`,
          { plan_id: plan.plan_id },
          sessionAttemptKey,
        );
        session = data.session;
        sessionPlan = {
          file_count: files.length,
          descriptor_hash: plan.descriptor_hash,
          additions: plan.additions,
          replacements: plan.replacements,
          deletions: plan.deletions,
          unchanged: plan.unchanged,
          projected_utilization: plan.projected_utilization,
        };
        save();
      }
      if (session.state === "active") {
        if (files.length === 0) throw taggedError("invalid_import_request");
        await stage();
      }
      while (session.state === "active" || session.state === "validating") {
        progressForSession(session, sessionPlan);
        session = (await json(
          "POST",
          `/api/v1/markdown-imports/${encodeURIComponent(session.import_id)}/validate`,
          { expected_version: session.version },
        )).session;
        save();
      }
      if (session.state !== "validated" && session.state !== "finalizing") throw taggedError("import_state_conflict");
      let committed = null;
      while (session.state === "validated" || session.state === "finalizing") {
        progressForSession(session, sessionPlan);
        const result = await json(
          "POST",
          `/api/v1/markdown-imports/${encodeURIComponent(session.import_id)}/commit`,
          { expected_version: session.version, summary: "Import Markdown snapshot" },
        );
        if (result.session) {
          session = result.session;
          save();
        } else {
          committed = result;
          break;
        }
      }
      if (!committed) throw taggedError("import_state_conflict");
      const baseRevision = plan?.expected_revision_id ?? session?.expected_revision_id ?? head;
      persist(null);
      showReceipt(baseRevision, committed.revision_id);
      session = null;
      sessionPlan = null;
      plan = null;
      files = [];
      planAttemptKey = null;
      sessionAttemptKey = null;
      if (input) input.value = "";
      if (confirm) confirm.checked = false;
      shown(cancel, false);
    } catch (error) {
      if (error?.statusRead === true) {
        handleStatusReadFailure(error);
      } else if (error?.code === "import_head_conflict") {
        headConflict();
      } else if (error?.code === "import_validation_failed" && session?.import_id) {
        try {
          const current = await freshSession();
          if (current.session.failures?.some((failure) => failure?.code === "import_head_conflict")) {
            headConflict();
          } else {
            const safeFailures = Array.isArray(current.session.failures) ? current.session.failures.slice(0, 3) : [];
            const sample = safeFailures.map((item) => `${item.path} (${item.code})`).join(", ");
            persist(null);
            session = null;
            sessionPlan = null;
            say(`Validation stopped with ${safeFailures.length} reported file error(s)${sample ? `: ${sample}` : ""}. The current revision was unchanged.`);
          }
        } catch (statusError) {
          handleStatusReadFailure(statusError);
        }
      } else {
        say(failMessage(error));
      }
    } finally {
      busy = false;
      sync();
    }
  });

  cancel?.addEventListener("click", async () => {
    if (busy || session === null) return;
    busy = true;
    sync();
    try {
      await json(
        "DELETE",
        `/api/v1/markdown-imports/${encodeURIComponent(session.import_id)}`,
        { expected_version: session.version },
      );
      persist(null);
      recoveryPending = false;
      session = null;
      sessionPlan = null;
      plan = null;
      files = [];
      planAttemptKey = null;
      sessionAttemptKey = null;
      if (input) input.value = "";
      if (confirm) confirm.checked = false;
      shown(summary, false);
      shown(progressRegion, false);
      shown(retryRecovery, false);
      say("Staged import canceled. The current revision was unchanged; cleanup is queued.");
    } catch (error) {
      say(failMessage(error));
    } finally {
      busy = false;
      sync();
    }
  });

  retryRecovery?.addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    sync();
    try {
      await loadSaved();
    } finally {
      busy = false;
      sync();
    }
  });

  replan?.addEventListener("click", () => {
    persist(null);
    location.assign(`${location.pathname}${location.search}`);
  });

  sync();
  void loadSaved();
})();
