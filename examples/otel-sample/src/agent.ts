/**
 * A toy agent instrumented with plain OpenTelemetry and the GenAI semantic
 * conventions. No Overturn SDK: the OTLP exporter points at the Overturn API.
 *
 * Spans:
 *   invoke_agent (root)            -> the run
 *     execute_tool lookup_customer -> tool_call step
 *     chat <model>                 -> llm_call step
 *     execute_tool set_priority    -> tool_call step (side effect)
 */
import { context, type Span, SpanStatusCode, type Tracer, trace } from "@opentelemetry/api";

export interface Ticket {
  id: string;
  subject: string;
  body: string;
  customerEmail: string;
}

export function makeOtelAgent(tracer: Tracer = trace.getTracer("otel-sample")) {
  const lookupCustomer = (email: string) => ({
    email,
    plan: email.endsWith("acme.com") ? "enterprise" : "free",
  });
  const decide = (ticket: Ticket, plan: string) => ({
    priority: /down|outage/i.test(ticket.subject) ? (plan === "enterprise" ? "P0" : "P1") : "P3",
    team: /down|outage/i.test(ticket.subject) ? "infrastructure" : "support",
  });

  return async function triage(ticket: Ticket): Promise<{ priority: string; team: string }> {
    return tracer.startActiveSpan("invoke_agent ticket-triage", async (root: Span) => {
      root.setAttributes({
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.agent.name": "ticket-triage",
        "overturn.agent.version": "otel-1.0.0",
        "overturn.external_id": ticket.id,
        "overturn.input": JSON.stringify(ticket),
        "overturn.tags": ["otel-sample"],
      });
      try {
        const customer = await tracer.startActiveSpan("execute_tool lookup_customer", async (span: Span) => {
          const args = { email: ticket.customerEmail };
          span.setAttributes({
            "gen_ai.operation.name": "execute_tool",
            "gen_ai.tool.name": "lookup_customer",
            "gen_ai.tool.call.arguments": JSON.stringify(args),
          });
          const result = lookupCustomer(args.email);
          span.setAttribute("gen_ai.tool.call.result", JSON.stringify(result));
          span.end();
          return result;
        });

        const decision = await tracer.startActiveSpan("chat fake-model", async (span: Span) => {
          const messages = [
            { role: "system", content: "Triage the ticket." },
            { role: "user", content: JSON.stringify({ ticket, customer }) },
          ];
          span.setAttributes({
            "gen_ai.operation.name": "chat",
            "gen_ai.system": "openai",
            "gen_ai.request.model": "fake-model",
            "gen_ai.request.temperature": 0,
            "gen_ai.input.messages": JSON.stringify(messages),
          });
          const out = decide(ticket, customer.plan);
          span.setAttributes({
            "gen_ai.response.model": "fake-model-2026",
            "gen_ai.output.messages": JSON.stringify([{ role: "assistant", content: JSON.stringify(out) }]),
            "gen_ai.response.finish_reasons": ["stop"],
            "gen_ai.usage.input_tokens": 42,
            "gen_ai.usage.output_tokens": 7,
          });
          span.end();
          return out;
        });

        await tracer.startActiveSpan("execute_tool set_priority", async (span: Span) => {
          const args = { ticketId: ticket.id, priority: decision.priority };
          span.setAttributes({
            "gen_ai.operation.name": "execute_tool",
            "gen_ai.tool.name": "set_priority",
            "gen_ai.tool.call.arguments": JSON.stringify(args),
            "gen_ai.tool.call.result": JSON.stringify({ ok: true }),
            "overturn.side_effect": true,
          });
          span.end();
        });

        root.setAttribute("overturn.output", JSON.stringify(decision));
        root.setStatus({ code: SpanStatusCode.OK });
        return decision;
      } catch (err) {
        root.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        throw err;
      } finally {
        root.end();
      }
    });
  };
}

export const _context = context;
