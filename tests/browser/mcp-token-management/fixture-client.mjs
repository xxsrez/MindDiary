import { installMcpTokenManagement } from "/ui/token-management.js";

const syntheticPrefix = "mdp_v1_Alpha1…";
let tokens = [
  {
    tokenId: "tok_fixture_active",
    name: "Codex fixture",
    displayPrefix: syntheticPrefix,
    scopes: ["content:read", "content:write"],
    state: "active",
    createdAt: "2026-08-05T22:00:00.000Z",
    expiresAt: "2026-11-03T22:00:00.000Z",
    lastUsedAt: "2026-08-06T12:00:00.000Z",
    revokedAt: null,
  },
];
let nextToken = 1;

const cloneToken = (token) => ({ ...token, scopes: [...token.scopes] });

const adapter = {
  async listTokens() {
    return tokens.map(cloneToken);
  },
  async issueToken(command) {
    const token = {
      tokenId: `tok_fixture_created_${nextToken}`,
      name: command.name,
      displayPrefix: `mdp_v1_Demo0${nextToken}…`,
      scopes: command.scopes.includes("content:write")
        ? ["content:read", "content:write"]
        : ["content:read"],
      state: "active",
      createdAt: "2026-08-07T00:00:00.000Z",
      expiresAt: command.expiresAt,
      lastUsedAt: null,
      revokedAt: null,
    };
    nextToken += 1;
    tokens = [token, ...tokens];
    let secret = "[synthetic one-time secret — not a credential]";
    return {
      token: cloneToken(token),
      secret: {
        consumeSecret() {
          const value = secret;
          secret = null;
          return value;
        },
      },
    };
  },
  async revokeToken(tokenId) {
    const current = tokens.find((token) => token.tokenId === tokenId);
    if (!current) throw new Error("Synthetic token was not found.");
    const revoked = {
      ...current,
      state: "revoked",
      revokedAt: "2026-08-07T00:01:00.000Z",
    };
    tokens = tokens.map((token) => (token.tokenId === tokenId ? revoked : token));
    return cloneToken(revoked);
  },
};

installMcpTokenManagement(adapter, document, {
  now: () => new Date("2026-08-07T00:00:00.000Z"),
});
