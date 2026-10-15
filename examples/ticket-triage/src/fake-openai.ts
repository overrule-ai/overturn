/**
 * A tiny OpenAI-compatible HTTP server backed by fake-triage.ts.
 * Serves POST /v1/chat/completions (and /chat/completions). Any model id works;
 * "fake-triage-weak" behaves worse on purpose. Used when OPENAI_API_KEY is unset.
 *
 *   pnpm --filter @overturn/example-ticket-triage fake-openai   # listens on :4010
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { fakeTriage } from "./fake-triage.js";

interface ChatRequest {
  model?: string;
  messages?: Array<{ role: string; content: string }>;
  stream?: boolean;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c: Buffer) => {
      data += c.toString();
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

export function completionFor(body: ChatRequest): Record<string, unknown> {
  const model = body.model ?? "fake-triage-v1";
  const system = body.messages?.find((m) => m.role === "system")?.content ?? "";
  const user = [...(body.messages ?? [])].reverse().find((m) => m.role === "user")?.content ?? "{}";
  let content: string;
  try {
    content = JSON.stringify(fakeTriage(system, user, model));
  } catch (err) {
    content = JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
  }
  const promptTokens = Math.ceil((system.length + user.length) / 4);
  const completionTokens = Math.ceil(content.length / 4);
  return {
    id: `chatcmpl-fake-${Date.now().toString(36)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content, refusal: null },
        finish_reason: "stop",
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

export function createFakeOpenAIServer(): Server {
  return createServer(async (req, res) => {
    const url = req.url ?? "";
    if (req.method === "GET" && (url === "/health" || url === "/v1/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ object: "list", data: [{ id: "fake-triage-v1" }, { id: "fake-triage-weak" }] }),
      );
      return;
    }
    if (req.method === "POST" && /\/chat\/completions$/.test(url)) {
      let body: ChatRequest;
      try {
        body = JSON.parse(await readBody(req)) as ChatRequest;
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "invalid json" } }));
        return;
      }
      const completion = completionFor(body);
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const msg = (completion.choices as Array<{ message: { content: string } }>)[0]!.message;
        const base = {
          id: completion.id,
          object: "chat.completion.chunk",
          created: completion.created,
          model: completion.model,
        };
        res.write(
          `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: msg.content }, finish_reason: null }] })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
        );
        res.write(`data: ${JSON.stringify({ ...base, choices: [], usage: completion.usage })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(completion));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: `no route for ${req.method} ${url}` } }));
  });
}

export function startFakeOpenAI(
  port = Number(process.env.FAKE_OPENAI_PORT ?? 4010),
): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createFakeOpenAIServer();
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const p = typeof addr === "object" && addr ? addr.port : port;
      resolve({ server, url: `http://127.0.0.1:${p}/v1` });
    });
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  startFakeOpenAI().then(({ url }) => {
    console.log(`fake OpenAI server listening at ${url}`);
  });
}
