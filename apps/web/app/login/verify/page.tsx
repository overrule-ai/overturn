"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { client } from "@/lib/api";

function Verify() {
  const params = useSearchParams();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const token = params.get("token");
    if (!token) {
      setError("Missing token");
      return;
    }
    client
      .verify(token)
      .then(() => router.replace("/runs"))
      .catch((e: Error) => setError(e.message));
  }, [params, router]);
  return (
    <div className="flex min-h-screen items-center justify-center p-4 text-sm">
      {error ? (
        <div className="space-y-2 text-center">
          <p className="text-destructive">{error}</p>
          <a className="underline" href="/login">
            Request a new link
          </a>
        </div>
      ) : (
        <p className="text-muted-foreground">Signing you in…</p>
      )}
    </div>
  );
}

export default function VerifyPage() {
  return (
    <Suspense fallback={null}>
      <Verify />
    </Suspense>
  );
}
