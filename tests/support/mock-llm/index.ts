import { canonicalizeJson } from "../../../tools/yuansheng-root-cause-blueprint/src/canonical-json";
import {
  type JsonObject,
  type JsonValue,
  parseStrictJson,
} from "../../../tools/yuansheng-root-cause-blueprint/src/strict-json";

const CHAT_COMPLETIONS_PATH = "/v1/chat/completions";
const FIXED_DIALOGUE_URL = new URL("./fixed-dialogue.json", import.meta.url);
const UTF8_ENCODER = new TextEncoder();

export interface MockDialogue {
  readonly assistant: JsonValue;
  readonly request: JsonValue;
}

export interface MockLlmServer {
  readonly baseUrl: string;
  assertComplete(): void;
  stop(): Promise<void>;
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function completionChunk(delta: JsonObject, finishReason: "stop" | null): JsonObject {
  return {
    choices: [
      {
        delta,
        finish_reason: finishReason,
        index: 0,
      },
    ],
    created: 0,
    id: "chatcmpl-yuansheng-fixture",
    model: "yuansheng-trace-fixture",
    object: "chat.completion.chunk",
  };
}

function encodeSse(assistant: JsonValue): Uint8Array {
  const content = canonicalizeJson(assistant).text;
  const events: readonly JsonObject[] = [
    completionChunk({ role: "assistant" }, null),
    completionChunk({ content }, null),
    completionChunk({}, "stop"),
    {
      choices: [],
      created: 0,
      id: "chatcmpl-yuansheng-fixture",
      model: "yuansheng-trace-fixture",
      object: "chat.completion.chunk",
      usage: {
        completion_tokens: 0,
        prompt_tokens: 0,
        total_tokens: 0,
      },
    },
  ];
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  return UTF8_ENCODER.encode(body);
}

function errorResponse(status: number, code: string): Response {
  return Response.json({ error: code }, { status });
}

export async function loadFixedDialogue(): Promise<MockDialogue> {
  const bytes = new Uint8Array(await Bun.file(FIXED_DIALOGUE_URL).arrayBuffer());
  const value = parseStrictJson(bytes);
  if (!isJsonObject(value) || value.request === undefined || value.assistant === undefined) {
    throw new Error("Fixed mock dialogue must contain request and assistant JSON values");
  }
  return { assistant: value.assistant, request: value.request };
}

export function startMockLlm(dialogues: readonly MockDialogue[]): MockLlmServer {
  if (dialogues.length === 0) {
    throw new Error("A mock LLM server requires at least one dialogue");
  }

  const responses = new Map<string, Uint8Array>();
  for (const dialogue of dialogues) {
    const requestKey = canonicalizeJson(dialogue.request).text;
    if (responses.has(requestKey)) {
      throw new Error("Mock LLM dialogue requests must be unique after canonicalization");
    }
    responses.set(requestKey, encodeSse(dialogue.assistant));
  }

  const matched = new Set<string>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "POST" || url.pathname !== CHAT_COMPLETIONS_PATH) {
        return errorResponse(404, "unsupported_mock_llm_endpoint");
      }

      let requestValue: JsonValue;
      try {
        requestValue = parseStrictJson(new Uint8Array(await request.arrayBuffer()));
      } catch {
        return errorResponse(400, "invalid_mock_llm_request_json");
      }

      const requestKey = canonicalizeJson(requestValue).text;
      const responseBody = responses.get(requestKey);
      if (responseBody === undefined) {
        return errorResponse(422, "unexpected_mock_llm_request");
      }

      matched.add(requestKey);
      return new Response(responseBody.slice(), {
        headers: {
          "cache-control": "no-store",
          "content-type": "text/event-stream; charset=utf-8",
        },
      });
    },
  });

  return {
    baseUrl: `http://${server.hostname}:${server.port}/v1`,
    assertComplete() {
      if (matched.size !== responses.size) {
        throw new Error(
          `Mock LLM expected ${responses.size} unique requests, received ${matched.size}`,
        );
      }
    },
    async stop() {
      await server.stop(true);
    },
  };
}
