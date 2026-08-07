import type {
  DeletedPrincipalId,
  PrincipalId,
  RevisionAuthorReference,
  RevisionId,
  SpaceId,
  UtcInstant,
} from "@mind-diary/domain";
import { MARKDOWN_MEDIA_TYPE } from "@mind-diary/domain";
import { OKF_VERSION, type OkfBundleFixture } from "@mind-diary/okf-codec";

export const FIXED_NOW = "2026-08-06T12:00:00.000Z" as UtcInstant;

export function createFixtureClock(initial = FIXED_NOW) {
  let current = initial;
  return {
    now: () => current,
    set: (next: UtcInstant) => {
      current = next;
    },
  };
}

export const PRINCIPALS = Object.freeze({
  owner: {
    principalId: "principal_owner_0001" as PrincipalId,
    displayName: "Fixture Owner",
  },
  editor: {
    principalId: "principal_editor_0001" as PrincipalId,
    displayName: "Fixture Editor",
  },
  outsider: {
    principalId: "principal_outsider_0001" as PrincipalId,
    displayName: "Fixture Outsider",
  },
});

export const REVISION_AUTHORS = Object.freeze({
  active: {
    kind: "principal",
    principalId: PRINCIPALS.owner.principalId,
  } satisfies RevisionAuthorReference,
  deleted: {
    kind: "deleted-principal",
    tombstoneId: "deleted_principal_editor_0001" as DeletedPrincipalId,
  } satisfies RevisionAuthorReference,
});

export const MINDS = Object.freeze({
  personal: {
    spaceId: "space_personal_0001" as SpaceId,
    route: "/me",
    isPersonal: true,
    visibility: "private" as const,
  },
  ordinary: {
    spaceId: "space_research_0001" as SpaceId,
    route: "/research-notes",
    handle: "research-notes",
    isPersonal: false,
    visibility: "private" as const,
  },
});

export const REVISIONS = Object.freeze({
  initial: {
    revisionId: "revision_0001" as RevisionId,
    revisionNumber: 1,
    parentRevisionId: null,
    committedAt: FIXED_NOW,
  },
  next: {
    revisionId: "revision_0002" as RevisionId,
    revisionNumber: 2,
    parentRevisionId: "revision_0001" as RevisionId,
    committedAt: "2026-08-06T12:01:00.000Z" as UtcInstant,
  },
});

export const OKF_FILES = Object.freeze([
  {
    path: "concepts/baseline.md",
    text: `---\ntype: Engineering Fixture\ntitle: Reproducible baseline\ndescription: Deterministic OKF 0.2 fixture for engineering checks.\nstatus: stable\ngenerated:\n  by: mind-diary-fixtures/0.0.0\n  at: 2026-08-06T12:00:00Z\nproducer_extension: preserved-by-future-codec\n---\n\n# Reproducible baseline\n\nThis is public synthetic fixture content.\n`,
  },
  {
    path: "index.md",
    text: `---\nokf_version: "${OKF_VERSION}"\n---\n\n# Fixture Mind\n\n- [Reproducible baseline](concepts/baseline.md) - Deterministic test content.\n`,
  },
  {
    path: "log.md",
    text: `# Fixture Log\n\n## 2026-08-06\n\n- **Create**: Added [Reproducible baseline](concepts/baseline.md).\n`,
  },
]);

export const OKF_BUNDLE: OkfBundleFixture = Object.freeze({
  revisionId: REVISIONS.initial.revisionId,
  files: OKF_FILES,
});

export const CANONICAL_REVISION_FILES = Object.freeze(
  OKF_FILES.map((file) =>
    Object.freeze({
      path: file.path,
      mediaType: MARKDOWN_MEDIA_TYPE,
      bytes: new TextEncoder().encode(file.text),
    }),
  ),
);

export const FIXTURE_MANIFEST_SHA256 =
  "c5f9e8eb128f3cf929d9aba5bf4aa0a32f1dec00b59c4a690fe299ad447f277c" as const;
