import {
  HostedFileUploadIntentClientFailure,
  createHostedFileUploadIntentClient,
} from "@mind-diary/adapter-mcp";
import {
  LocalCompanionHostedFailure,
  LocalFileCompanion,
} from "@mind-diary/application-content";
import { createNodeLocalCompanionFileSystem } from "./local-companion-node-filesystem.mjs";

/**
 * Reference runtime behind the installable local MCP connector. OAuth remains
 * in the hosted Mind Diary MCP; this process receives only a one-use same-
 * origin upload URL after prepare_local_file has produced path-free metadata.
 */
export function createMindDiaryLocalCompanionRuntime(options = {}) {
  const filesystem = createNodeLocalCompanionFileSystem({
    localRoots: options.localRoots,
    workspaceRoots: options.workspaceRoots ?? [],
  });
  const client = createHostedFileUploadIntentClient({
    publicOrigin: options.publicOrigin,
    ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
  });
  const transport = Object.freeze({
    async upload({ uploadUrl, stream, signal }) {
      try {
        const result = await client.upload({
          uploadUrl,
          bytes: readableStream(stream),
          ...(signal === undefined ? {} : { signal }),
        });
        return result.staged_file;
      } catch (error) {
        if (error instanceof HostedFileUploadIntentClientFailure) {
          throw new LocalCompanionHostedFailure(
            error.code,
            error.retryable,
            error.unknownOutcome,
          );
        }
        throw new LocalCompanionHostedFailure(
          "file_ingress_transport_unavailable",
          true,
          true,
        );
      }
    },
  });
  return new LocalFileCompanion({
    filesystem,
    transport,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.nextLocalFileRef === undefined
      ? {}
      : { nextLocalFileRef: options.nextLocalFileRef }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.preparedTtlMilliseconds === undefined
      ? {}
      : { preparedTtlMilliseconds: options.preparedTtlMilliseconds }),
    ...(options.maxPreparedFiles === undefined
      ? {}
      : { maxPreparedFiles: options.maxPreparedFiles }),
  });
}

function readableStream(iterable) {
  const iterator = iterable[Symbol.asyncIterator]();
  return new ReadableStream({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await iterator.return?.(reason);
    },
  });
}
