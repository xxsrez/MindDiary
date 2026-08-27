import { escapeUntrustedText } from "./ui-shell.js";

export interface ProductExportWorkflowTarget {
  readonly mindRef: "me" | string;
  readonly route: "/me" | `/${string}`;
  readonly name: string;
  readonly headRevisionId: string;
}

const HANDLE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SAFE_VALUE = /^[^\u0000-\u001f\u007f]{1,512}$/u;

function safeTarget(target: ProductExportWorkflowTarget): Readonly<{
  mindRef: string;
  route: string;
  name: string;
  headRevisionId: string;
}> | null {
  const personal = target.mindRef === "me" && target.route === "/me";
  const ordinary = HANDLE.test(target.mindRef) && target.route === `/${target.mindRef}`;
  if (
    (!personal && !ordinary) ||
    typeof target.name !== "string" ||
    target.name.trim().length === 0 ||
    target.name.length > 200 ||
    typeof target.headRevisionId !== "string" ||
    !SAFE_VALUE.test(target.headRevisionId)
  ) {
    return null;
  }
  return Object.freeze({
    mindRef: target.mindRef,
    route: target.route,
    name: target.name,
    headRevisionId: target.headRevisionId,
  });
}

/**
 * A Site-owned exact-revision export control. It exposes no content, object
 * locator, signed URL or service identity in the server-rendered document.
 */
export function renderProductExportWorkflowPanel(
  target: ProductExportWorkflowTarget,
): string {
  const safe = safeTarget(target);
  if (safe === null) {
    return `<section class="md-setup-card" aria-labelledby="export-unavailable-heading" data-export-unavailable>
      <div><p class="md-eyebrow">Exact revision export</p><h2 id="export-unavailable-heading">Export is unavailable</h2><p>Reload the current Mind before starting an export.</p></div>
    </section>`;
  }
  return `<section class="md-setup-card md-export-workflow" aria-labelledby="mind-export-heading" data-export-workflow data-export-mind-ref="${escapeUntrustedText(safe.mindRef)}" data-export-route="${escapeUntrustedText(safe.route)}" data-export-name="${escapeUntrustedText(safe.name)}" data-export-head-revision="${escapeUntrustedText(safe.headRevisionId)}">
    <div>
      <p class="md-eyebrow">Exact revision export</p>
      <h2 id="mind-export-heading">Download one revision</h2>
      <p>This is separate from import. It does not change the Mind, restore content, or include the full revision history.</p>
      <p class="md-export-target"><strong>Target Mind:</strong> <span data-export-target-name>${escapeUntrustedText(safe.name)}</span> <code data-export-target-route>${escapeUntrustedText(safe.route)}</code></p>
    </div>
    <form class="md-form" data-export-form>
      <fieldset class="md-export-choice" data-export-revision-choice>
        <legend>Revision</legend>
        <label><input type="radio" name="revision_mode" value="head" checked data-export-current> Current HEAD <code>${escapeUntrustedText(safe.headRevisionId)}</code></label>
        <label><input type="radio" name="revision_mode" value="revision" data-export-historical> Exact historical revision</label>
        <div class="md-field">
          <label for="mind-export-revision">Historical revision ID</label>
          <input id="mind-export-revision" name="revision_id" type="text" maxlength="512" autocomplete="off" spellcheck="false" disabled data-export-revision-id aria-describedby="mind-export-revision-help">
          <p id="mind-export-revision-help">Use an exact immutable revision ID. There is no fallback to current HEAD.</p>
        </div>
      </fieldset>
      <div class="md-field">
        <label for="mind-export-profile">Archive content</label>
        <select id="mind-export-profile" name="profile" data-export-profile>
          <option value="MD-BUNDLE-ZIP-1" selected>All canonical files — MD-BUNDLE-ZIP-1</option>
          <option value="MD-OKF-ZIP-1">Markdown only — MD-OKF-ZIP-1</option>
        </select>
        <p>Choose the full bundle profile for a revision that contains attachments. Markdown-only export never silently omits them.</p>
      </div>
      <p class="md-form__status" role="status" aria-live="polite" data-export-status></p>
      <div class="md-export-actions">
        <button class="md-button md-button--primary" type="submit" data-export-start>Start export</button>
        <button class="md-button md-button--secondary" type="button" data-export-check hidden style="display:none">Check status</button>
        <button class="md-button md-button--secondary" type="button" data-export-new hidden style="display:none">Start another export</button>
      </div>
    </form>
    <section class="md-export-job" aria-labelledby="mind-export-job-heading" data-export-job hidden style="display:none">
      <h3 id="mind-export-job-heading">Export status</h3>
      <dl class="md-personal-summary">
        <div><dt>Target</dt><dd><span data-export-job-target>${escapeUntrustedText(safe.name)}</span> <code>${escapeUntrustedText(safe.route)}</code></dd></div>
        <div><dt>Revision</dt><dd><code data-export-job-revision>Waiting for exact revision</code></dd></div>
        <div><dt>State</dt><dd data-export-job-state>Not started</dd></div>
      </dl>
      <div class="md-export-receipt" data-export-receipt hidden style="display:none">
        <p class="md-caveat"><strong>Ready receipt.</strong> Verify the downloaded bytes against both values before keeping the archive.</p>
        <dl class="md-personal-summary">
          <div><dt>Format</dt><dd><code data-export-receipt-format></code></dd></div>
          <div><dt>File</dt><dd data-export-receipt-filename></dd></div>
          <div><dt>Size</dt><dd data-export-receipt-size></dd></div>
          <div><dt>SHA-256</dt><dd><code data-export-receipt-sha></code></dd></div>
          <div><dt>Download expires</dt><dd><time data-export-receipt-expiry></time></dd></div>
        </dl>
        <button class="md-button md-button--primary" type="button" data-export-verify-download>Verify and save archive</button>
        <p class="md-form__status" role="status" aria-live="polite" data-export-download-status></p>
      </div>
    </section>
  </section>`;
}
