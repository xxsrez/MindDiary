const STRICT_CHANNELS = new Set(["log", "trace", "error"]);
const SENSITIVE_FIELD = /(?:authorization|cookie|csrf|secret|verifier|verified_?email|private_?(?:body|query)|download_?(?:url|grant))/iu;
const SAFE_MARKERS = new Set(["[REDACTED]", "[PRESENT]", "[OMITTED]"]);

function violation(channel, location) {
  throw new Error(
    `privacy-safe observer rejected ${channel} evidence at ${location}`,
  );
}

function scan(value, context, location, visited) {
  if (typeof value === "string") {
    for (const sensitive of context.sensitiveValues) {
      if (value.includes(sensitive)) violation(context.channel, location);
    }
    return;
  }
  if (
    value === null ||
    value === undefined ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    typeof value === "symbol" ||
    typeof value === "function"
  ) {
    return;
  }
  if (visited.has(value)) return;
  visited.add(value);

  if (value instanceof Headers) {
    for (const [name, headerValue] of value.entries()) {
      scan(headerValue, context, `${location}.headers.${name}`, visited);
      if (
        context.strict &&
        SENSITIVE_FIELD.test(name) &&
        !SAFE_MARKERS.has(headerValue)
      ) {
        violation(context.channel, `${location}.headers.${name}`);
      }
    }
    return;
  }
  if (value instanceof Error) {
    scan(value.name, context, `${location}.name`, visited);
    scan(value.message, context, `${location}.message`, visited);
    scan(value.cause, context, `${location}.cause`, visited);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      scan(item, context, `${location}[${index}]`, visited);
    });
    return;
  }

  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) continue;
    const fieldValue = descriptor.value;
    if (
      context.strict &&
      SENSITIVE_FIELD.test(key) &&
      !(typeof fieldValue === "string" && SAFE_MARKERS.has(fieldValue)) &&
      fieldValue !== null &&
      fieldValue !== undefined
    ) {
      violation(context.channel, `${location}.${key}`);
    }
    scan(fieldValue, context, `${location}.${key}`, visited);
  }
}

/**
 * Checks evidence synchronously and retains counts only. Raw events are never
 * stored, so the helper cannot become a second accidental log sink.
 */
export function createPrivacySafeObserver({ sensitiveValues = [] } = {}) {
  if (
    !Array.isArray(sensitiveValues) ||
    sensitiveValues.some(
      (value) => typeof value !== "string" || value.length === 0,
    )
  ) {
    throw new TypeError("sensitiveValues must contain non-empty strings");
  }
  const protectedValues = new Set(sensitiveValues);
  const counts = new Map();

  function observe(channel, value) {
    if (typeof channel !== "string" || channel.length === 0) {
      throw new TypeError("observer channel is required");
    }
    scan(
      value,
      {
        channel,
        strict: STRICT_CHANNELS.has(channel),
        sensitiveValues: protectedValues,
      },
      "$",
      new Set(),
    );
    counts.set(channel, (counts.get(channel) ?? 0) + 1);
    return value;
  }

  return Object.freeze({
    observe,
    protect(...values) {
      if (values.some((value) => typeof value !== "string" || value.length === 0)) {
        throw new TypeError("protected values must be non-empty strings");
      }
      for (const value of values) protectedValues.add(value);
    },
    logger(channel = "log") {
      return Object.freeze({ record: (event) => observe(channel, event) });
    },
    summary() {
      return Object.freeze(
        Object.fromEntries([...counts.entries()].sort(([left], [right]) =>
          left.localeCompare(right),
        )),
      );
    },
  });
}
