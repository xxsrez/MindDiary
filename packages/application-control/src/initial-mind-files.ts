import type { UtcInstant } from "@mind-diary/domain";

export function createInitialPersonalMindFiles(
  occurredAtUtc: UtcInstant,
): readonly Readonly<{ readonly path: string; readonly text: string }>[] {
  const date = occurredAtUtc.slice(0, 10);
  return Object.freeze([
    Object.freeze({
      path: "index.md",
      text: `---\nokf_version: "0.2"\n---\n\n# My Mind\n\nAdd the first Memory.\n`,
    }),
    Object.freeze({
      path: "log.md",
      text: `# Log\n\n## ${date}\n\n- **Create**: Created Personal Mind.\n`,
    }),
  ]);
}

export function createInitialOrdinaryMindFiles(
  occurredAtUtc: UtcInstant,
): readonly Readonly<{ readonly path: string; readonly text: string }>[] {
  const date = occurredAtUtc.slice(0, 10);
  return Object.freeze([
    Object.freeze({
      path: "index.md",
      text: `---\nokf_version: "0.2"\n---\n\n# Mind\n\nAdd the first Memory.\n`,
    }),
    Object.freeze({
      path: "log.md",
      text: `# Log\n\n## ${date}\n\n- **Create**: Created Mind.\n`,
    }),
  ]);
}
