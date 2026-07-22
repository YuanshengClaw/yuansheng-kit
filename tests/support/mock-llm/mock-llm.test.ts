import { describe, expect, test } from "bun:test";

import { canonicalizeJson } from "../../../tools/yuansheng-root-cause-blueprint/src/canonical-json";
import type { YuanshengRootCauseBlueprintV1Lite } from "../../../tools/yuansheng-root-cause-blueprint/src/generated/types/yuansheng-root-cause-blueprint-v1-lite";
import { validateYuanshengRootCauseBlueprintV1Lite } from "../../../tools/yuansheng-root-cause-blueprint/src/generated/validators";
import { checkYuanshengRootCauseBlueprintV1Lite } from "../../../tools/yuansheng-root-cause-blueprint/src/semantic-rules";
import { parseStrictJson } from "../../../tools/yuansheng-root-cause-blueprint/src/strict-json";
import { loadFixedDialogue, startMockLlm } from "./index";

const UTF8_ENCODER = new TextEncoder();

function assistantContent(sse: string): string {
  let content = "";
  for (const line of sse.split("\n")) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") {
      continue;
    }
    const event = JSON.parse(line.slice("data: ".length)) as {
      readonly choices?: readonly {
        readonly delta?: { readonly content?: unknown };
      }[];
    };
    const part = event.choices?.[0]?.delta?.content;
    if (typeof part === "string") {
      content += part;
    }
  }
  return content;
}

describe("scripted mock LLM", () => {
  test("replays fixed bytes and returns a valid v1-lite Blueprint", async () => {
    const dialogue = await loadFixedDialogue();
    const server = startMockLlm([dialogue]);
    const requestBody = canonicalizeJson(dialogue.request).text;

    try {
      const request = () =>
        fetch(`${server.baseUrl}/chat/completions`, {
          body: requestBody,
          headers: { "content-type": "application/json" },
          method: "POST",
        });
      const first = await request();
      const firstBytes = new Uint8Array(await first.arrayBuffer());
      const second = await request();
      const secondBytes = new Uint8Array(await second.arrayBuffer());

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(firstBytes).toEqual(secondBytes);

      const unexpected = await fetch(`${server.baseUrl}/chat/completions`, {
        body: '{"messages":[],"model":"unexpected","stream":true}',
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(unexpected.status).toBe(422);

      const content = assistantContent(new TextDecoder().decode(firstBytes));
      const blueprint = parseStrictJson(UTF8_ENCODER.encode(content));
      expect(validateYuanshengRootCauseBlueprintV1Lite(blueprint)).toBe(true);
      expect(
        checkYuanshengRootCauseBlueprintV1Lite(
          blueprint as unknown as YuanshengRootCauseBlueprintV1Lite,
        ),
      ).toEqual([]);
      expect(canonicalizeJson(blueprint).text).toBe(content);
      server.assertComplete();
    } finally {
      await server.stop();
    }
  });
});
