export const FILE_INGRESS_WIDGET_URI =
  "ui://mind-diary/file-ingress/v1.html" as const;
export const MCP_APPS_RESOURCE_MIME_TYPE =
  "text/html;profile=mcp-app" as const;

/**
 * Self-contained MCP Apps UI. Provider identifiers and temporary URLs remain
 * lexical values inside the iframe and one app-only tools/call request. Only
 * the server-issued staged ref plus the already model-visible target intent
 * are returned through the portable MCP Apps model-context bridge.
 */
export const FILE_INGRESS_WIDGET_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Stage a file</title>
  <style>
    :root { color-scheme: light dark; font: 14px/1.45 system-ui, sans-serif; }
    body { margin: 0; padding: 14px; }
    main { display: grid; gap: 10px; }
    h1 { font-size: 16px; margin: 0; }
    p { margin: 0; color: CanvasText; opacity: .78; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; }
    button { font: inherit; padding: 7px 11px; cursor: pointer; }
    button[hidden] { display: none; }
    #status { min-height: 1.45em; }
    #upload { position: fixed; inline-size: 1px; block-size: 1px; opacity: 0; pointer-events: none; }
  </style>
</head>
<body>
  <main>
    <h1>Stage one file for the selected Mind</h1>
    <p>The file stays outside the conversation. Only the staged receipt is returned.</p>
    <div class="actions">
      <button id="library" type="button" hidden>Choose from library</button>
      <button id="uploadButton" type="button" hidden>Upload a file</button>
      <input id="upload" type="file" tabindex="-1" aria-hidden="true">
    </div>
    <p id="status" role="status" aria-live="polite"></p>
  </main>
  <script>
    (() => {
      "use strict";
      const libraryButton = document.getElementById("library");
      const uploadButton = document.getElementById("uploadButton");
      const uploadInput = document.getElementById("upload");
      const status = document.getElementById("status");
      const pending = new Map();
      let nextRequestId = 1;
      let latestToolInput = null;

      function request(method, params) {
        const id = nextRequestId++;
        window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
        return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      }

      window.addEventListener("message", (event) => {
        if (event.source !== window.parent) return;
        const message = event.data;
        if (!message || message.jsonrpc !== "2.0") return;
        if (message.id !== undefined && pending.has(message.id)) {
          const operation = pending.get(message.id);
          pending.delete(message.id);
          if (message.error) operation.reject(message.error);
          else operation.resolve(message.result);
          return;
        }
        if (message.method === "ui/notifications/tool-input") {
          latestToolInput = message.params;
        }
      }, { passive: true });

      function toolInput() {
        const candidate = latestToolInput || window.openai?.toolInput;
        if (!candidate || typeof candidate.mind !== "string" ||
            typeof candidate.path !== "string" || candidate.path.length === 0 ||
            typeof candidate.idempotency_key !== "string") return null;
        return {
          mind: candidate.mind,
          path: candidate.path,
          idempotency_key: candidate.idempotency_key,
        };
      }

      function selectedFile(value) {
        if (!value || typeof value.fileId !== "string") return null;
        return {
          fileId: value.fileId,
          mimeType: typeof value.mimeType === "string" ? value.mimeType : undefined,
        };
      }

      function stagedFileRef(result) {
        const value = result?.structuredContent?.data?.staged_file?.staged_file_ref;
        return typeof value === "string" && value.length > 0 && value.length <= 512 &&
          !/[\u0000-\u001f\u007f]/u.test(value) ? value : null;
      }

      async function publishStagedContext(input, stagedRef) {
        await request("ui/update-model-context", {
          content: [{
            type: "text",
            text: "A private file is staged for Mind Diary. Use the structured target and staged receipt in the next explicit changeset.",
          }],
          structuredContent: {
            schema: "mind-diary/file-ingress-context/v1",
            action: "commit_staged_bundle_file",
            mind: input.mind,
            path: input.path,
            staged_file_ref: stagedRef,
          },
        });
      }

      async function stage(value) {
        const input = toolInput();
        const openai = window.openai;
        const file = selectedFile(value);
        if (!input || !file || !openai?.getFileDownloadUrl) {
          status.textContent = "This host cannot stage the selected file.";
          return;
        }
        status.textContent = "Staging…";
        libraryButton.disabled = true;
        uploadButton.disabled = true;
        try {
          const fresh = await openai.getFileDownloadUrl({ fileId: file.fileId });
          if (!fresh || typeof fresh.downloadUrl !== "string") throw new Error("download unavailable");
          const nativeFile = {
            file_id: file.fileId,
            download_url: fresh.downloadUrl,
            ...(file.mimeType === undefined ? {} : { mime_type: file.mimeType }),
          };
          const result = await request("tools/call", {
            name: "stage_bundle_file",
            arguments: {
              mind: input.mind,
              file: nativeFile,
              idempotency_key: input.idempotency_key,
              display_filename: "selected-file",
            },
          });
          if (result?.isError === true || result?.structuredContent?.ok === false) {
            throw new Error("stage rejected");
          }
          const stagedRef = stagedFileRef(result);
          if (stagedRef === null) throw new Error("stage receipt unavailable");
          try {
            await publishStagedContext(input, stagedRef);
          } catch {
            status.textContent = "File staged, but its receipt could not be passed to the conversation. Retry this selection before continuing.";
            return;
          }
          status.textContent = "File staged. Continue with your changeset when ready.";
        } catch {
          status.textContent = "The file was not staged. Choose it again or retry later.";
        } finally {
          libraryButton.disabled = false;
          uploadButton.disabled = false;
        }
      }

      const openai = window.openai;
      if (openai?.selectFiles) {
        libraryButton.hidden = false;
        libraryButton.addEventListener("click", async () => {
          status.textContent = "";
          try {
            const files = await openai.selectFiles();
            if (!Array.isArray(files) || files.length === 0) return;
            if (files.length !== 1) {
              status.textContent = "Choose exactly one file.";
              return;
            }
            await stage(files[0]);
          } catch {
            status.textContent = "No file was selected.";
          }
        });
      }
      if (openai?.uploadFile) {
        uploadButton.hidden = false;
        uploadButton.addEventListener("click", () => uploadInput.click());
        uploadInput.addEventListener("change", async () => {
          const local = uploadInput.files?.[0];
          uploadInput.value = "";
          if (!local) return;
          status.textContent = "Uploading…";
          try {
            const uploaded = await openai.uploadFile(local, { library: false });
            await stage({ fileId: uploaded.fileId, mimeType: local.type });
          } catch {
            status.textContent = "The file was not uploaded.";
          }
        });
      }
      if (libraryButton.hidden && uploadButton.hidden) {
        status.textContent = "This host does not expose a private file picker.";
      }
    })();
  </script>
</body>
</html>`;

export const FILE_INGRESS_WIDGET_META = Object.freeze({
  ui: Object.freeze({
    prefersBorder: true,
    csp: Object.freeze({
      connectDomains: Object.freeze([]),
      resourceDomains: Object.freeze([]),
    }),
  }),
  "openai/widgetDescription":
    "Choose one private file and stage it without placing file identifiers or bytes in the conversation.",
});
