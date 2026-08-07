export function createBarrier(parties) {
  if (!Number.isSafeInteger(parties) || parties < 1) {
    throw new TypeError("barrier parties must be a positive safe integer");
  }

  let arrivals = 0;
  let open;
  const opened = new Promise((resolve) => {
    open = resolve;
  });

  return Object.freeze({
    async arriveAndWait() {
      arrivals += 1;
      if (arrivals === parties) open();
      await opened;
    },
  });
}

export function createGate() {
  let markReached;
  let open;
  let reachedOnce = false;
  const reached = new Promise((resolve) => {
    markReached = resolve;
  });
  const opened = new Promise((resolve) => {
    open = resolve;
  });

  return Object.freeze({
    reached,
    async wait() {
      if (!reachedOnce) {
        reachedOnce = true;
        markReached();
      }
      await opened;
    },
    release() {
      open();
    },
  });
}

export function interceptPort(port, interceptors) {
  if (typeof port !== "object" || port === null) {
    throw new TypeError("intercepted port must be an object");
  }
  return new Proxy(port, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      const interceptor =
        typeof property === "string" ? interceptors[property] : undefined;
      if (interceptor !== undefined) {
        if (typeof value !== "function" || typeof interceptor !== "function") {
          throw new TypeError("port interceptors must wrap methods");
        }
        return (...args) => interceptor(value.bind(target), ...args);
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export function createMutableClock(initialInstant) {
  let current = initialInstant;
  return Object.freeze({
    now: () => current,
    set(nextInstant) {
      current = nextInstant;
    },
  });
}
