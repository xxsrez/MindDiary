/**
 * Small persistent containers used by the metadata adapter's transaction
 * roots.  A fork keeps the previous root as its read base and records only
 * changed keys.  Values are cloned lazily when a caller asks for a mutable
 * value; immutable values can be shared between roots.
 */

export interface CopyOnWriteStats {
  mapForks: number;
  setForks: number;
  valueClones: number;
  writes: number;
  deletes: number;
  iterations: number;
}

export function newCopyOnWriteStats(): CopyOnWriteStats {
  return {
    mapForks: 0,
    setForks: 0,
    valueClones: 0,
    writes: 0,
    deletes: 0,
    iterations: 0,
  };
}

/** Clone a value at the first write-visible access to a forked root. */
export function cloneCopyOnWriteValue<Value>(value: Value): Value {
  if (value === null || typeof value !== "object") return value;
  return structuredClone(value);
}

const COW_MAP = Symbol("mind-diary.copy-on-write-map");
const COW_SET = Symbol("mind-diary.copy-on-write-set");

type OverlayValue<Value> = { readonly present: true; readonly value: Value } | {
  readonly present: false;
};

/** Map-compatible persistent overlay. */
export class CopyOnWriteMap<Key, Value> extends Map<Key, Value> {
  readonly [COW_MAP] = true;
  readonly #base: ReadonlyMap<Key, Value>;
  readonly #overlay = new Map<Key, OverlayValue<Value>>();
  readonly #cloneOnGet: ((value: Value, key: Key) => Value) | undefined;
  readonly #stats: CopyOnWriteStats;
  #cleared = false;
  #size: number;
  readonly #readded = new Set<Key>();

  constructor(
    base: ReadonlyMap<Key, Value>,
    cloneOnGet?: ((value: Value, key: Key) => Value) | undefined,
    stats: CopyOnWriteStats = newCopyOnWriteStats(),
  ) {
    super();
    this.#base = base;
    this.#cloneOnGet = cloneOnGet;
    this.#stats = stats;
    this.#size = base.size;
    this.#stats.mapForks += 1;
  }

  get size(): number {
    return this.#size;
  }

  get copyOnWriteStats(): CopyOnWriteStats {
    return this.#stats;
  }

  has(key: Key): boolean {
    return this.#lookupWithoutClone(key).present;
  }

  get(key: Key): Value | undefined {
    const local = this.#overlay.get(key);
    if (local !== undefined) {
      return local.present ? local.value : undefined;
    }
    const lookup = this.#lookupWithoutClone(key);
    if (!lookup.present) return undefined;
    const value = lookup.value as Value;
    if (this.#cloneOnGet === undefined) return value;
    const cloned = this.#cloneOnGet(value as Value, key);
    this.#stats.valueClones += 1;
    this.#overlay.set(key, { present: true, value: cloned });
    return cloned;
  }

  set(key: Key, value: Value): this {
    const had = this.has(key);
    if (!had && !this.#cleared && this.#base.has(key)) {
      this.#readded.add(key);
    }
    if (!had && this.#overlay.has(key)) {
      // A delete followed by a set appends the key, matching Map semantics.
      this.#overlay.delete(key);
    }
    this.#overlay.set(key, { present: true, value });
    if (!had) this.#size += 1;
    this.#stats.writes += 1;
    return this;
  }

  delete(key: Key): boolean {
    const had = this.has(key);
    if (!had) return false;
    this.#readded.delete(key);
    this.#overlay.set(key, { present: false });
    this.#size -= 1;
    this.#stats.deletes += 1;
    return true;
  }

  clear(): void {
    if (this.#size === 0) return;
    this.#cleared = true;
    this.#overlay.clear();
    this.#size = 0;
    this.#stats.deletes += 1;
  }

  *keys(): IterableIterator<Key> {
    this.#stats.iterations += 1;
    const entries = new Map<Key, Value>();
    this.#collectEntries(entries);
    yield* entries.keys();
  }

  *values(): IterableIterator<Value> {
    for (const key of this.keys()) {
      const value = this.get(key);
      if (value !== undefined || this.has(key)) yield value as Value;
    }
  }

  *entries(): IterableIterator<[Key, Value]> {
    for (const key of this.keys()) {
      const value = this.get(key);
      if (value !== undefined || this.has(key)) yield [key, value as Value];
    }
  }

  [Symbol.iterator](): IterableIterator<[Key, Value]> {
    return this.entries();
  }

  forEach(callbackfn: (value: Value, key: Key, map: Map<Key, Value>) => void, thisArg?: unknown): void {
    for (const [key, value] of this.entries()) callbackfn.call(thisArg, value, key, this);
  }

  /** Materialize this root for a durable checkpoint. */
  materialize(): Map<Key, Value> {
    return new Map(this.entries());
  }

  /** Resolve a key through a persistent chain without charging inner roots. */
  #lookupWithoutClone(key: Key): { readonly present: boolean; readonly value?: Value } {
    const overlay = this.#overlay.get(key);
    if (overlay !== undefined) {
      return overlay.present
        ? { present: true, value: overlay.value }
        : { present: false };
    }
    if (this.#cleared) return { present: false };
    if (this.#base instanceof CopyOnWriteMap) {
      return this.#base.#lookupWithoutClone(key);
    }
    if (!this.#base.has(key)) return { present: false };
    return { present: true, value: this.#base.get(key) as Value };
  }

  #collectEntries(target: Map<Key, Value>): void {
    if (!this.#cleared) {
      if (this.#base instanceof CopyOnWriteMap) {
        this.#base.#collectEntries(target);
      } else {
        for (const [key, value] of this.#base) target.set(key, value);
      }
      for (const key of this.#readded) target.delete(key);
    }
    for (const [key, overlay] of this.#overlay) {
      if (overlay.present) target.set(key, overlay.value);
      else target.delete(key);
    }
  }
}

/** Set-compatible persistent overlay. */
export class CopyOnWriteSet<Value> extends Set<Value> {
  readonly [COW_SET] = true;
  readonly #base: ReadonlySet<Value>;
  readonly #added = new Set<Value>();
  readonly #deleted = new Set<Value>();
  readonly #stats: CopyOnWriteStats;
  #cleared = false;
  readonly #readded = new Set<Value>();

  constructor(
    base: ReadonlySet<Value>,
    stats: CopyOnWriteStats = newCopyOnWriteStats(),
  ) {
    super();
    this.#base = base;
    this.#stats = stats;
    this.#stats.setForks += 1;
  }

  get size(): number {
    let size = this.#cleared ? 0 : this.#base.size;
    for (const value of this.#deleted) if (!this.#cleared && this.#base.has(value)) size -= 1;
    for (const value of this.#added) {
      if (this.#cleared || !this.#base.has(value)) size += 1;
    }
    return size;
  }

  get copyOnWriteStats(): CopyOnWriteStats {
    return this.#stats;
  }

  has(value: Value): boolean {
    if (this.#deleted.has(value)) return false;
    return this.#added.has(value) || (!this.#cleared && this.#base.has(value));
  }

  add(value: Value): this {
    if (this.has(value)) return this;
    if (!this.#cleared && this.#base.has(value)) this.#readded.add(value);
    if (this.#added.has(value)) this.#added.delete(value);
    this.#deleted.delete(value);
    this.#added.add(value);
    this.#stats.writes += 1;
    return this;
  }

  delete(value: Value): boolean {
    if (!this.has(value)) return false;
    this.#readded.delete(value);
    this.#added.delete(value);
    if (!this.#cleared && this.#base.has(value)) this.#deleted.add(value);
    this.#stats.deletes += 1;
    return true;
  }

  clear(): void {
    if (this.size === 0) return;
    this.#cleared = true;
    this.#added.clear();
    this.#deleted.clear();
    this.#stats.deletes += 1;
  }

  *values(): IterableIterator<Value> {
    this.#stats.iterations += 1;
    const values = new Set<Value>();
    this.#collectValues(values);
    yield* values;
  }

  keys(): IterableIterator<Value> { return this.values(); }
  entries(): IterableIterator<[Value, Value]> {
    return (function* (values: IterableIterator<Value>) {
      for (const value of values) yield [value, value] as [Value, Value];
    })(this.values());
  }
  [Symbol.iterator](): IterableIterator<Value> { return this.values(); }
  forEach(callbackfn: (value: Value, value2: Value, set: Set<Value>) => void, thisArg?: unknown): void {
    for (const value of this.values()) callbackfn.call(thisArg, value, value, this);
  }
  materialize(): Set<Value> { return new Set(this.values()); }

  #collectValues(target: Set<Value>): void {
    if (!this.#cleared) {
      if (this.#base instanceof CopyOnWriteSet) {
        this.#base.#collectValues(target);
      } else {
        for (const value of this.#base) target.add(value);
      }
      for (const value of this.#readded) target.delete(value);
    }
    for (const value of this.#deleted) target.delete(value);
    for (const value of this.#added) target.add(value);
  }
}

export function isCopyOnWriteMap<Key, Value>(
  value: ReadonlyMap<Key, Value>,
): value is CopyOnWriteMap<Key, Value>;
export function isCopyOnWriteMap(value: unknown): value is CopyOnWriteMap<unknown, unknown>;
export function isCopyOnWriteMap(value: unknown): value is CopyOnWriteMap<unknown, unknown> {
  return typeof value === "object" && value !== null && (value as { [COW_MAP]?: unknown })[COW_MAP] === true;
}

export function isCopyOnWriteSet<Value>(
  value: ReadonlySet<Value>,
): value is CopyOnWriteSet<Value>;
export function isCopyOnWriteSet(value: unknown): value is CopyOnWriteSet<unknown>;
export function isCopyOnWriteSet(value: unknown): value is CopyOnWriteSet<unknown> {
  return typeof value === "object" && value !== null && (value as { [COW_SET]?: unknown })[COW_SET] === true;
}

export function copyOnWriteMap<Key, Value>(
  source: ReadonlyMap<Key, Value>,
  cloneOnGet?: ((value: Value, key: Key) => Value) | undefined,
  stats?: CopyOnWriteStats,
): CopyOnWriteMap<Key, Value> {
  return new CopyOnWriteMap(
    source,
    cloneOnGet,
    stats ?? (source instanceof CopyOnWriteMap ? source.copyOnWriteStats : undefined),
  );
}

export function copyOnWriteSet<Value>(
  source: ReadonlySet<Value>,
  stats?: CopyOnWriteStats,
): CopyOnWriteSet<Value> {
  return new CopyOnWriteSet(
    source,
    stats ?? (source instanceof CopyOnWriteSet ? source.copyOnWriteStats : undefined),
  );
}

export function copyOnWriteStats(value: CopyOnWriteStats): Readonly<CopyOnWriteStats> {
  return Object.freeze({ ...value });
}
