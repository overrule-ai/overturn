"use client";

import { CorrectButton } from "@overturn-ai/sdk/react";
import { useRouter } from "next/navigation";

export function Review({ runId, output }: { runId: string; output: unknown }) {
  const router = useRouter();
  return (
    <CorrectButton
      endpoint="/api/overturn/correct"
      runId={runId}
      original={output}
      onDone={() => router.refresh()}
    />
  );
}
