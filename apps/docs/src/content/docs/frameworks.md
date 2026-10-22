---
title: Frameworks
description: LangChain, LlamaIndex, CrewAI, Vercel AI SDK and anything else — which path records what.
---

Overturn has two ways in. Pick by how much of the trajectory you need to replay.

| Path | Records | Replay |
| --- | --- | --- |
| **SDK wrappers** (`ov.wrapOpenAI`, `ov.wrapAnthropic`, `ov.aiMiddleware()`, `ov.tool()`) | every model call with its exact request, every tool call with arguments *and* result, fingerprints | step and trajectory |
| **OpenTelemetry** (`/v1/traces`, OTLP/HTTP) | whatever your instrumentation puts on the spans | step; trajectory where tool spans carry results |

## Vercel AI SDK

```ts
import { generateText, wrapLanguageModel } from "ai";
const model = wrapLanguageModel({ model: openai("gpt-4.1-mini"), middleware: ov.aiMiddleware() });
```

Tools declared with `ov.tool()` are recorded with fingerprints; `generateText`/`streamText` calls become model steps.

## LangChain, LlamaIndex, CrewAI, AutoGen, …

Use the framework's OpenTelemetry instrumentation and point it at Overturn. With [OpenLLMetry](https://github.com/traceloop/openllmetry) (Python or JS):

```bash
pip install traceloop-sdk
export TRACELOOP_BASE_URL=https://api.overturn.run    # the SDK appends /v1/traces
export TRACELOOP_HEADERS="authorization=Bearer ov_live_…"
```

```python
from traceloop.sdk import Traceloop
Traceloop.init(app_name="my-agent")   # before importing the framework
```

Spans with `gen_ai.*` attributes become model steps; `execute_tool` spans with `gen_ai.tool.call.arguments` and `gen_ai.tool.call.result` become tool recordings. Mark side-effect tools with the span attribute `overturn.side_effect = true` so replay refuses them. The run page tells you what the trace can prove: **replay-ready**, **partially replayable** (tool spans without results) or **not replayable**.

To correct from inside the framework, call the API directly (`POST /v1/corrections`) or use the SDK's `ov.correct()` next to your framework code: the run id is the trace id.

## Raw OpenAI / Anthropic clients in another language

`POST /v1/ingest` takes the same batches the SDKs send; the schema is in `/openapi.json`. Fingerprints are documented in the [fingerprint contract](/fingerprint/) so any language can produce matching ones.
