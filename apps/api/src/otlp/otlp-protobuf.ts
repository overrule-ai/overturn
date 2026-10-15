import root from "@opentelemetry/otlp-transformer/build/src/generated/root.js";
import type { OtlpExportTraceServiceRequest } from "./otlp-mapper";

interface ProtoType {
  decode(buf: Uint8Array): unknown;
  encode(message: unknown): { finish(): Uint8Array };
  fromObject(obj: unknown): unknown;
  toObject(message: unknown, options: { longs: unknown; enums: unknown; bytes: unknown }): unknown;
}

const ExportTraceServiceRequest = (
  root as unknown as {
    opentelemetry: { proto: { collector: { trace: { v1: { ExportTraceServiceRequest: ProtoType } } } } };
  }
).opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest;

/** Decodes a protobuf ExportTraceServiceRequest into the OTLP/JSON shape (ids base64, enums as names). */
export function decodeProtobufTraces(buf: Uint8Array): OtlpExportTraceServiceRequest {
  const message = ExportTraceServiceRequest.decode(buf);
  return ExportTraceServiceRequest.toObject(message, {
    longs: String,
    enums: String,
    bytes: String,
  }) as OtlpExportTraceServiceRequest;
}

/** Test helper: encodes an OTLP/JSON-shaped request (ids as base64 or Buffers) to protobuf. */
export function encodeProtobufTraces(req: unknown): Uint8Array {
  return ExportTraceServiceRequest.encode(ExportTraceServiceRequest.fromObject(req)).finish();
}
