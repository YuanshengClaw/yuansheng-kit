import { createHash } from "node:crypto";

import {
  issueTrustedPrincipal,
  type TrustedPrincipal,
} from "../../workflows/state-machine/principal";

export function canonicalOpenCodeSessionId(sessionId: string): string {
  if (
    sessionId.length === 0 ||
    sessionId.length > 1024 ||
    sessionId.includes("\0") ||
    sessionId !== sessionId.normalize("NFC")
  ) {
    throw new TypeError("OpenCode supplied an invalid session identity");
  }
  return `session:${createHash("sha256").update(sessionId, "utf8").digest("base64url")}`;
}

export function issueOpenCodePrincipal(input: {
  readonly agentId: string;
  readonly sessionId: string;
}): TrustedPrincipal {
  return issueTrustedPrincipal({
    agentId: input.agentId,
    sessionId: canonicalOpenCodeSessionId(input.sessionId),
  });
}
