import { BadRequestException, Body, Controller, Headers, HttpCode, Post, UseGuards } from "@nestjs/common";
import { ApiKeyGuard, Auth } from "../auth/api-key.guard";
import type { AuthContext } from "../auth/api-keys.service";
import { IngestService } from "../ingest/ingest.service";
import { mapOtlpTraces, type OtlpExportTraceServiceRequest } from "./otlp-mapper";
import { decodeProtobufTraces } from "./otlp-protobuf";

/**
 * OTLP/HTTP traces receiver. Point an OpenTelemetry exporter at
 *   OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://<api>/v1/traces
 *   OTEL_EXPORTER_OTLP_HEADERS="authorization=Bearer ov_live_..."
 * Accepts application/json and application/x-protobuf.
 */
@Controller()
@UseGuards(ApiKeyGuard)
export class OtlpController {
  constructor(private readonly ingest: IngestService) {}

  @Post(["v1/traces", "v1/otlp/v1/traces"])
  @HttpCode(200)
  async traces(
    @Auth() auth: AuthContext,
    @Headers("content-type") contentType: string | undefined,
    @Body() body: unknown,
  ): Promise<{
    partialSuccess?: { rejectedSpans: number; errorMessage: string };
    runs: number;
    steps: number;
  }> {
    let request: OtlpExportTraceServiceRequest;
    if (contentType?.includes("protobuf")) {
      if (!Buffer.isBuffer(body)) throw new BadRequestException("expected a protobuf body");
      request = decodeProtobufTraces(body);
    } else if (body && typeof body === "object") {
      request = body as OtlpExportTraceServiceRequest;
    } else {
      throw new BadRequestException("expected an OTLP ExportTraceServiceRequest (JSON or protobuf)");
    }
    const mapped = mapOtlpTraces(request);
    const res = await this.ingest.ingest(auth.projectId, { v: 1, runs: mapped.runs, steps: mapped.steps });
    return { runs: res.runs, steps: res.steps };
  }
}
