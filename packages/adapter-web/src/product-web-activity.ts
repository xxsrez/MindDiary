import type { ControlBoundaryMarker } from "@mind-diary/application-control";

export type ProductWebRegisteredActor = Extract<
  ControlBoundaryMarker["actor"],
  { readonly kind: "registered_principal" }
>;

export type ProductWebActivityKind = "page" | "control_read" | "control_write";

export interface ProductWebActivityRecorder {
  recordSuccessful(
    actor: ProductWebRegisteredActor,
    surface: "web",
    kind: ProductWebActivityKind,
  ): void | Promise<void>;
}

export type ProductWebActivityDeferrer = (promise: Promise<unknown>) => void;

interface PendingProductWebActivity {
  actor: ProductWebRegisteredActor;
  kind: ProductWebActivityKind;
  revision: number;
  promise: Promise<void>;
}

/**
 * Keeps best-effort activity writes off the foreground response path while
 * coalescing repeated navigation by the same principal.
 */
export class ProductWebActivityCoordinator {
  readonly #recorder: ProductWebActivityRecorder | undefined;
  readonly #windowMs: number;
  readonly #pendingByPrincipal = new Map<string, PendingProductWebActivity>();

  constructor(recorder: ProductWebActivityRecorder | undefined, windowMs: number) {
    this.#recorder = recorder;
    this.#windowMs = windowMs;
  }

  async record(
    defer: ProductWebActivityDeferrer | undefined,
    actor: ProductWebRegisteredActor,
    kind: ProductWebActivityKind,
  ): Promise<void> {
    if (this.#recorder === undefined) return;
    if (defer === undefined) {
      try {
        await this.#recorder.recordSuccessful(actor, "web", kind);
      } catch {
        // Activity is observational and must never change the product response.
      }
      return;
    }

    const principalKey = String(actor.principalId);
    let pending = this.#pendingByPrincipal.get(principalKey);
    let ownsDeferral = false;
    if (pending === undefined) {
      ownsDeferral = true;
      pending = {
        actor,
        kind,
        revision: 0,
        promise: Promise.resolve(),
      };
      const entry = pending;
      entry.promise = (async () => {
        if (this.#windowMs > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, this.#windowMs));
        }
        let recordedRevision = -1;
        while (recordedRevision !== entry.revision) {
          recordedRevision = entry.revision;
          const currentActor = entry.actor;
          const currentKind = entry.kind;
          try {
            await this.#recorder!.recordSuccessful(currentActor, "web", currentKind);
          } catch {
            // Best-effort activity failures never affect the foreground result.
          }
        }
      })().finally(() => {
        if (this.#pendingByPrincipal.get(principalKey) === entry) {
          this.#pendingByPrincipal.delete(principalKey);
        }
      });
      this.#pendingByPrincipal.set(principalKey, entry);
    } else if (
      Date.parse(actor.occurredAtUtc) >= Date.parse(pending.actor.occurredAtUtc)
    ) {
      pending.actor = actor;
      pending.kind = kind;
      pending.revision += 1;
    }

    // A coalesced promise belongs to the request context that created it.
    // Registering that same promise with later Worker contexts makes each
    // navigation inherit the original best-effort write lifetime on Sites.
    if (!ownsDeferral) return;

    try {
      defer(pending.promise);
      return;
    } catch {
      // Fall through to the bounded foreground fallback when host deferral fails.
    }
    await pending.promise;
  }
}
