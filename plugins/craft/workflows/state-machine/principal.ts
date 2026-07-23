import type { PrincipalAudit } from "../artifacts/generated";
import { isYsCraftAgentId, type YsCraftAgentId } from "./phases";

const OPAQUE_ID = /^[a-z][a-z0-9-]*:[A-Za-z0-9_-]{16,128}$/u;

export interface TrustedPrincipal {
  readonly source: "trusted-platform-tool-context";
}

const PRINCIPALS = new WeakMap<TrustedPrincipal, PrincipalAudit>();

export class TrustedPrincipalError extends Error {
  readonly code = "UNTRUSTED_PRINCIPAL";

  constructor(message: string) {
    super(`UNTRUSTED_PRINCIPAL: ${message}`);
    this.name = "TrustedPrincipalError";
  }
}

export function issueTrustedPrincipal(input: {
  readonly agentId: string;
  readonly sessionId: string;
}): TrustedPrincipal {
  if (!isYsCraftAgentId(input.agentId)) {
    throw new TrustedPrincipalError(`Unsupported Yuansheng Craft agent identity: ${input.agentId}`);
  }
  if (!OPAQUE_ID.test(input.sessionId)) {
    throw new TrustedPrincipalError("Trusted platform session ID is not a valid opaque identity");
  }
  const handle = Object.freeze({
    source: "trusted-platform-tool-context" as const,
  });
  PRINCIPALS.set(
    handle,
    Object.freeze({
      agent_id: input.agentId,
      session_id: input.sessionId,
    }),
  );
  return handle;
}

export function auditTrustedPrincipal(
  principal: TrustedPrincipal,
): PrincipalAudit & { readonly agent_id: YsCraftAgentId } {
  const audit = PRINCIPALS.get(principal);
  if (audit === undefined || !isYsCraftAgentId(audit.agent_id)) {
    throw new TrustedPrincipalError("Principal was not issued from trusted platform tool context");
  }
  return {
    agent_id: audit.agent_id,
    session_id: audit.session_id,
  };
}

export function principalsEqual(left: PrincipalAudit, right: PrincipalAudit): boolean {
  return left.agent_id === right.agent_id && left.session_id === right.session_id;
}
