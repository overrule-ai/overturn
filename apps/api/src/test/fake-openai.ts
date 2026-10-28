/**
 * Minimal OpenAI-compatible chat server for replay tests. The model id picks the behaviour:
 *   echo-<base64 json>   -> returns that JSON as the assistant content
 *   tool-<name>          -> returns one tool call to <name> with the first tool's required args echoed from the prompt
 *   fail-429             -> first call 429s, then behaves like echo-{"ok":true}
 *   judge-pass / judge-fail -> returns {"pass":true/false,"reason":"…"} (judge model stand-in)
 */
import { createServer, type Server } from "node:http";

export function startFakeOpenAI(): Promise<{
  server: Server;
  url: string;
  calls: Array<Record<string, unknown>>;
  close: () => Promise<void>;
}> {
  const calls: Array<Record<string, unknown>> = [];
  const fineTunes = new Map<string, { polls: number; model: string; suffix: string }>();
  let failed = false;
  const server = createServer((req, res) => {
    let data = "";
    req.on("data", (c: Buffer) => {
      data += c.toString();
    });
    req.on("end", () => {
      const json = (o: unknown, status = 200) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(o));
      };
      const url = req.url ?? "";
      // ---- a fake Together fine-tuning API: upload, create, poll (completes on the second poll) ----
      if (url.startsWith("/v1/files/upload")) {
        calls.push({ upload: data.length });
        return json({ id: "file-fake-1", object: "file", purpose: "fine-tune", bytes: data.length });
      }
      if (url.startsWith("/v1/fine-tunes") && req.method === "POST") {
        const body = JSON.parse(data || "{}") as Record<string, unknown>;
        calls.push({ fineTune: body });
        fineTunes.set("ft-fake-1", {
          polls: 0,
          model: String(body.model),
          suffix: String(body.suffix ?? ""),
        });
        return json({ id: "ft-fake-1", status: "pending", model: body.model });
      }
      if (url.startsWith("/v1/fine-tunes/") && req.method === "GET") {
        const id = url.slice("/v1/fine-tunes/".length).split(/[/?]/)[0]!;
        const ft = fineTunes.get(id);
        if (!ft) return json({ error: { message: "not found" } }, 404);
        ft.polls++;
        const done = ft.polls >= 2;
        // the "trained" model answers like echo-<suffix-encoded>: tests encode the wanted answer in the suffix
        return json({
          id,
          status: done ? "completed" : "running",
          model: ft.model,
          model_output_name: done ? `fake-org/${ft.model.split("/").pop()}-${ft.suffix}` : undefined,
          token_count: 1234,
          total_price: 50,
        });
      }
      const body = JSON.parse(data || "{}") as Record<string, unknown>;
      calls.push(body);
      const model = String(body.model ?? "");
      if (model === "fail-429" && !failed) {
        failed = true;
        return json({ error: { message: "rate limited", type: "rate_limit" } }, 429);
      }
      let message: Record<string, unknown> = { role: "assistant", content: '{"ok":true}' };
      let finish = "stop";
      const echoAt = model.indexOf("echo-");
      if (echoAt >= 0)
        message = {
          role: "assistant",
          content: Buffer.from(model.slice(echoAt + 5), "base64url").toString(),
        };
      else if (model.startsWith("judge-"))
        message = {
          role: "assistant",
          content: JSON.stringify({
            pass: model === "judge-pass",
            reason: `fake judge says ${model.slice(6)}`,
          }),
        };
      else if (model.startsWith("tool-")) {
        const name = model.slice(5);
        message = {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name, arguments: JSON.stringify({ ticketId: "T-1", priority: "P1" }) },
            },
          ],
        };
        finish = "tool_calls";
      }
      const usage = { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 };
      json({
        id: "cmpl",
        object: "chat.completion",
        created: 1,
        model,
        choices: [{ index: 0, message, finish_reason: finish }],
        usage,
      });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        server,
        url: `http://127.0.0.1:${port}/v1`,
        calls,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

export function echoModel(content: unknown, priced = false): string {
  const b64 = Buffer.from(typeof content === "string" ? content : JSON.stringify(content)).toString(
    "base64url",
  );
  return priced ? `fake/gpt-4.1-mini-echo-${b64}` : `fake/echo-${b64}`;
}
