(() => {
  const panel = document.querySelector("[data-export-workflow]");
  if (!panel) return;

  const csrf = document.querySelector('meta[name="mind-diary-csrf-token"]')?.content ?? "";
  const mindRef = panel.dataset.exportMindRef ?? "";
  const targetRoute = panel.dataset.exportRoute ?? "";
  const targetName = panel.dataset.exportName ?? "";
  const headRevision = panel.dataset.exportHeadRevision ?? "";
  const form = panel.querySelector("[data-export-form]");
  const current = panel.querySelector("[data-export-current]");
  const historical = panel.querySelector("[data-export-historical]");
  const revisionInput = panel.querySelector("[data-export-revision-id]");
  const profileInput = panel.querySelector("[data-export-profile]");
  const startButton = panel.querySelector("[data-export-start]");
  const checkButton = panel.querySelector("[data-export-check]");
  const newButton = panel.querySelector("[data-export-new]");
  const status = panel.querySelector("[data-export-status]");
  const jobPanel = panel.querySelector("[data-export-job]");
  const jobRevision = panel.querySelector("[data-export-job-revision]");
  const jobState = panel.querySelector("[data-export-job-state]");
  const receipt = panel.querySelector("[data-export-receipt]");
  const receiptFormat = panel.querySelector("[data-export-receipt-format]");
  const receiptFilename = panel.querySelector("[data-export-receipt-filename]");
  const receiptSize = panel.querySelector("[data-export-receipt-size]");
  const receiptSha = panel.querySelector("[data-export-receipt-sha]");
  const receiptExpiry = panel.querySelector("[data-export-receipt-expiry]");
  const downloadButton = panel.querySelector("[data-export-verify-download]");
  const downloadStatus = panel.querySelector("[data-export-download-status]");

  const safeRef = mindRef === "me" || /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(mindRef);
  const safeRoute = targetRoute === (mindRef === "me" ? "/me" : "/" + mindRef);
  const safeName = targetName.length > 0 && targetName.length <= 200 && !/[\u0000-\u001f\u007f]/.test(targetName);
  const safeRevision = (value) => typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
  const safeJobId = (value) => typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f/]/.test(value);
  const safeProfile = (value) => value === "MD-BUNDLE-ZIP-1" || value === "MD-OKF-ZIP-1";
  const shown = (node, value) => {
    if (!node) return;
    node.hidden = !value;
    node.style.display = value ? "" : "none";
  };
  const say = (message) => { if (status) status.textContent = message; };
  const sayDownload = (message) => { if (downloadStatus) downloadStatus.textContent = message; };
  const failureMessage = (code) => ({
    capacity_fairness_limit: "Another heavy operation is active; retry same plan/job after it finishes.",
    capacity_soft_limit: "Storage headroom is low; clean up completed imports or exports, then retry the same plan/job.",
    capacity_hard_limit: "This archive exceeds the supported size or capacity; reduce it and create a new job.",
    capacity_accounting_untrusted: "Storage accounting is being reconciled; retry same plan/job after reconciliation finishes.",
    revision_not_found: "The exact revision no longer exists. Start another export from a revision you can still read.",
    revision_integrity_failure: "The exact revision failed integrity verification. No archive was published.",
    okf_validation_failed: "The exact revision failed OKF validation. No archive was published.",
    archive_limit_exceeded: "The exact revision exceeds the supported deterministic ZIP limits. No partial archive was published.",
    export_profile_required: "This revision contains attachments. Start another export with All canonical files.",
    export_access_denied: "Current access no longer permits this export. No archive was published.",
  })[code] ?? "The export build failed. Current content was not changed and no partial archive was published.";
  const storageKey = "mind-diary:export:v1:" + encodeURIComponent(mindRef);
  let saved = null;
  let busy = false;
  let volatileDownload = null;
  let polling = 0;
  let pollTimer = null;
  let pollEpoch = 0;

  const readStored = () => {
    try {
      const value = JSON.parse(sessionStorage.getItem(storageKey) ?? "null");
      const selector = value?.selector;
      if (
        value?.version !== 1 ||
        value.mindRef !== mindRef ||
        !safeProfile(value.profile) ||
        typeof value.idempotencyKey !== "string" ||
        !/^export-ui:[0-9a-f-]{36}$/.test(value.idempotencyKey) ||
        (value.jobId !== null && !safeJobId(value.jobId)) ||
        (selector?.kind !== "head" && !(selector?.kind === "revision" && safeRevision(selector.revisionId)))
      ) return null;
      return value;
    } catch {
      return null;
    }
  };
  const writeStored = () => {
    try {
      if (saved === null) sessionStorage.removeItem(storageKey);
      else sessionStorage.setItem(storageKey, JSON.stringify(saved));
    } catch {
      // A disabled storage surface must not prevent a fresh, safe export.
    }
  };
  const selectorFromForm = () => {
    if (historical?.checked) {
      const revisionId = revisionInput?.value.trim() ?? "";
      if (!safeRevision(revisionId)) throw Object.assign(new Error("revision"), { code: "invalid_revision" });
      return { kind: "revision", revisionId };
    }
    return { kind: "head" };
  };
  const sameSelector = (left, right) => left?.kind === right?.kind && (left?.kind !== "revision" || left.revisionId === right.revisionId);
  const makePending = (selector, profile) => ({
    version: 1,
    mindRef,
    selector,
    profile,
    idempotencyKey: "export-ui:" + crypto.randomUUID(),
    jobId: null,
  });
  const clearPoll = () => {
    pollEpoch += 1;
    if (pollTimer !== null) window.clearTimeout(pollTimer);
    pollTimer = null;
    polling = 0;
  };
  const schedulePoll = (delayMs) => {
    const epoch = pollEpoch;
    const timer = window.setTimeout(() => {
      if (pollEpoch !== epoch || pollTimer !== timer) return;
      pollTimer = null;
      void checkStatus(true);
    }, delayMs);
    pollTimer = timer;
  };
  const resetReceipt = () => {
    volatileDownload = null;
    shown(receipt, false);
    sayDownload("");
  };
  const setRevisionControls = () => {
    if (revisionInput) revisionInput.disabled = historical?.checked !== true || busy || saved !== null;
  };
  const setBusy = (value) => {
    busy = value;
    const lockSelection = value || saved !== null;
    if (startButton) startButton.disabled = value;
    if (checkButton) checkButton.disabled = value;
    if (newButton) newButton.disabled = value;
    if (profileInput) profileInput.disabled = lockSelection;
    if (current) current.disabled = lockSelection;
    if (historical) historical.disabled = lockSelection;
    setRevisionControls();
  };
  const requestJson = async (method, path, body, idempotencyKey) => {
    const headers = { accept: "application/json" };
    if (method !== "GET") headers["x-csrf-token"] = csrf;
    if (body !== undefined) headers["content-type"] = "application/json";
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    const response = await fetch(path, {
      method,
      headers,
      credentials: "same-origin",
      cache: "no-store",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let payload = null;
    try { payload = await response.json(); } catch {}
    if (!response.ok || payload?.ok !== true) {
      const error = new Error("Export request failed");
      error.code = payload?.error?.code ?? "operation_failed";
      error.status = response.status;
      throw error;
    }
    return payload.data;
  };
  const showJob = (revisionId, state) => {
    shown(jobPanel, true);
    if (jobRevision) jobRevision.textContent = revisionId;
    if (jobState) jobState.textContent = state;
  };
  const validReceipt = (job) => {
    if (
      job?.status !== "succeeded" ||
      !safeProfile(job.archive_format) ||
      job.media_type !== "application/zip" ||
      typeof job.filename !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.zip$/.test(job.filename) ||
      !Number.isSafeInteger(job.size) || job.size < 0 ||
      typeof job.sha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(job.sha256) ||
      typeof job.download_url !== "string" ||
      typeof job.download_expires_at !== "string" || Number.isNaN(Date.parse(job.download_expires_at))
    ) return null;
    let url;
    try { url = new URL(job.download_url, location.origin); } catch { return null; }
    if (
      url.origin !== location.origin ||
      !/^\/api\/v1\/exports\/[A-Za-z0-9._~-]+$/.test(url.pathname) ||
      url.search !== "" || url.hash !== "" || url.username !== "" || url.password !== ""
    ) return null;
    return {
      archiveFormat: job.archive_format,
      mediaType: job.media_type,
      filename: job.filename,
      size: job.size,
      sha256: job.sha256,
      expiresAt: job.download_expires_at,
      path: url.pathname,
    };
  };
  const renderReceipt = (value) => {
    volatileDownload = value;
    if (receiptFormat) receiptFormat.textContent = value.archiveFormat;
    if (receiptFilename) receiptFilename.textContent = value.filename;
    if (receiptSize) receiptSize.textContent = value.size.toLocaleString() + " bytes";
    if (receiptSha) receiptSha.textContent = value.sha256;
    if (receiptExpiry) {
      receiptExpiry.dateTime = value.expiresAt;
      receiptExpiry.textContent = new Date(value.expiresAt).toLocaleString();
    }
    shown(receipt, true);
    shown(newButton, true);
  };
  const unavailable = () => {
    clearPoll();
    resetReceipt();
    saved = null;
    writeStored();
    showJob("Unavailable", "Unavailable");
    say("This export is no longer available. Reload the Mind and start a fresh export if you still have access.");
    shown(checkButton, false);
    shown(newButton, true);
  };
  const checkStatus = async (automatic = false) => {
    if (busy || saved === null || !safeJobId(saved.jobId)) return;
    setBusy(true);
    try {
      const data = await requestJson("GET", "/api/v1/export-jobs/" + encodeURIComponent(saved.jobId));
      const job = data?.job;
      if (!safeJobId(job?.job_id) || job.job_id !== saved.jobId || !safeRevision(job.revision_id)) throw new Error("unsafe status");
      if (job.status === "queued" || job.status === "running") {
        resetReceipt();
        showJob(job.revision_id, job.status === "queued" ? "Queued" : "Building archive");
        say(job.status === "queued" ? "Export queued. This page checks a bounded number of times." : "Building the exact revision archive…");
        shown(checkButton, true);
        shown(newButton, false);
        if (automatic && polling < 3) {
          polling += 1;
          schedulePoll(5000);
        } else if (automatic) {
          say("Export is still running. Use Check status, or submit Start export again to resume this exact job; the page will not poll indefinitely.");
        }
        return;
      }
      clearPoll();
      if (job.status === "succeeded") {
        const ready = validReceipt(job);
        if (ready === null) throw new Error("unsafe receipt");
        showJob(job.revision_id, "Ready");
        renderReceipt(ready);
        say("Archive ready. Verify its size and SHA-256 while downloading.");
        shown(checkButton, true);
        return;
      }
      resetReceipt();
      showJob(job.revision_id, job.status === "expired" ? "Expired" : "Failed");
      if (job.status === "expired") {
        say("This export expired. Start a fresh export for the same exact revision.");
      } else {
        // Keep the exact selector, profile and idempotency key, but make the
        // next submit call start_export again so the failed durable job is
        // rescheduled instead of merely re-reading its terminal status.
        saved = { ...saved, jobId: null };
        writeStored();
        say(failureMessage(job.last_failure_code) + " Submit Start export to retry this exact job.");
      }
      shown(checkButton, false);
      shown(newButton, true);
    } catch (error) {
      if (error?.status === 404 || error?.code === "export_job_not_found") unavailable();
      else {
        say("Export status could not be verified. Try Check status; starting again is not required.");
        shown(checkButton, true);
      }
    } finally {
      setBusy(false);
    }
  };
  const startExport = async () => {
    const selector = selectorFromForm();
    const profile = profileInput?.value ?? "";
    if (!safeProfile(profile)) throw Object.assign(new Error("profile"), { code: "invalid_profile" });
    clearPoll();
    if (saved === null || !sameSelector(saved.selector, selector) || saved.profile !== profile) {
      resetReceipt();
      saved = makePending(selector, profile);
      writeStored();
    }
    const bodySelector = selector.kind === "head"
      ? { kind: "head" }
      : { kind: "revision", revision_id: selector.revisionId };
    const data = await requestJson(
      "POST",
      "/api/v1/minds/" + encodeURIComponent(mindRef) + "/exports",
      { revision_selector: bodySelector, profile },
      saved.idempotencyKey,
    );
    if (!safeJobId(data?.job?.job_id) || !safeRevision(data.job.revision_id)) throw new Error("unsafe start response");
    saved = { ...saved, jobId: data.job.job_id };
    writeStored();
    showJob(data.job.revision_id, data.job.status === "running" ? "Building archive" : "Queued");
    say(data.replayed ? "Recovered the existing export without creating a duplicate." : "Export started for the exact selected revision.");
    polling = 0;
    return true;
  };
  const hex = (buffer) => Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const verifyAndSave = async () => {
    const expected = volatileDownload;
    if (busy || expected === null) return;
    if (Date.parse(expected.expiresAt) <= Date.now()) {
      volatileDownload = null;
      sayDownload("The short-lived download expired. Check status to request a fresh one.");
      return;
    }
    setBusy(true);
    if (downloadButton) downloadButton.disabled = true;
    sayDownload("Downloading and checking every byte…");
    try {
      const response = await fetch(expected.path, {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers: { accept: "application/zip" },
      });
      volatileDownload = null;
      if (!response.ok) throw Object.assign(new Error("download unavailable"), { code: "download_unavailable" });
      const length = Number(response.headers.get("content-length"));
      const disposition = response.headers.get("content-disposition") ?? "";
      if (
        response.headers.get("content-type")?.split(";", 1)[0].trim() !== expected.mediaType ||
        !Number.isSafeInteger(length) || length !== expected.size ||
        disposition !== 'attachment; filename="' + expected.filename + '"'
      ) throw Object.assign(new Error("receipt mismatch"), { code: "integrity_mismatch" });
      const bytes = await response.arrayBuffer();
      const digest = "sha256:" + hex(await crypto.subtle.digest("SHA-256", bytes));
      if (bytes.byteLength !== expected.size || digest !== expected.sha256) {
        throw Object.assign(new Error("byte mismatch"), { code: "integrity_mismatch" });
      }
      const objectUrl = URL.createObjectURL(new Blob([bytes], { type: expected.mediaType }));
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = expected.filename;
      anchor.hidden = true;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
      sayDownload("Verified " + expected.size.toLocaleString() + " bytes and " + expected.sha256 + ". Archive saved.");
    } catch (error) {
      sayDownload(error?.code === "integrity_mismatch"
        ? "Archive not saved: size, headers, or SHA-256 did not match the ready receipt."
        : "Archive not saved. The short-lived download is unavailable; Check status before trying again.");
    } finally {
      setBusy(false);
      if (downloadButton) downloadButton.disabled = false;
    }
  };
  const startAnother = () => {
    clearPoll();
    resetReceipt();
    saved = null;
    writeStored();
    shown(jobPanel, false);
    shown(checkButton, false);
    shown(newButton, false);
    say("Choose the current HEAD or one exact historical revision.");
    setBusy(false);
  };

  if (!safeRef || !safeRoute || !safeName || !safeRevision(headRevision) || !form || !crypto?.randomUUID || !crypto?.subtle) {
    form?.setAttribute("hidden", "");
    say("Export is unavailable in this page context.");
    return;
  }
  current?.addEventListener("change", setRevisionControls);
  historical?.addEventListener("change", () => { setRevisionControls(); revisionInput?.focus(); });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    let shouldCheck = false;
    try {
      shouldCheck = await startExport();
    } catch (error) {
      if (error?.code === "invalid_revision") {
        say("Enter one exact historical revision ID.");
        revisionInput?.focus();
      } else if (error?.code === "export_profile_required") {
        saved = null;
        writeStored();
        if (profileInput) profileInput.value = "MD-BUNDLE-ZIP-1";
        profileInput?.focus();
        say("This revision contains attachments. Use the full bundle profile; nothing was silently omitted.");
      } else if (typeof error?.code === "string" && error.code.startsWith("capacity_")) {
        say(failureMessage(error.code));
      } else {
        say("The start result could not be confirmed. Submit again to reuse the same idempotent request; do not choose Start another.");
      }
      shown(checkButton, safeJobId(saved?.jobId));
    } finally {
      setBusy(false);
    }
    if (shouldCheck) schedulePoll(10_000);
  });
  checkButton?.addEventListener("click", () => { clearPoll(); polling = 0; void checkStatus(true); });
  newButton?.addEventListener("click", startAnother);
  downloadButton?.addEventListener("click", () => { void verifyAndSave(); });

  saved = readStored();
  if (saved) {
    const disclosure = panel.closest("details.md-disclosure");
    if (disclosure) disclosure.open = true;
  }
  if (saved !== null) {
    if (saved.selector.kind === "revision") {
      if (historical) historical.checked = true;
      if (current) current.checked = false;
      if (revisionInput) revisionInput.value = saved.selector.revisionId;
    } else {
      if (current) current.checked = true;
      if (historical) historical.checked = false;
      if (revisionInput) revisionInput.value = "";
    }
    if (profileInput) profileInput.value = saved.profile;
    // A persisted tuple without a job is an ambiguous start, not a fresh form.
    // Restore the full selection lock before the user can interact so the only
    // available submit is an exact replay under the stored idempotency key.
    setBusy(false);
    if (safeJobId(saved.jobId)) {
      showJob(saved.selector.kind === "revision" ? saved.selector.revisionId : headRevision, "Recovering status");
      say("Recovering the actor-owned export status without starting another job…");
      polling = 0;
      schedulePoll(10_000);
    } else {
      say("A previous start result was not confirmed. Submit again to reuse the same idempotent request.");
    }
  } else {
    writeStored();
    setRevisionControls();
    say("Choose the current HEAD or one exact historical revision.");
  }
})();
