"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

export function JsonView({
  value,
  className,
  collapsedAt = 1200,
}: {
  value: unknown;
  className?: string;
  collapsedAt?: number;
}) {
  const [open, setOpen] = useState(false);
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const long = (text ?? "").length > collapsedAt;
  return (
    <div className={cn("relative", className)}>
      <pre
        className={cn(
          "max-w-full overflow-auto whitespace-pre-wrap break-words rounded-md border bg-background p-3 text-xs leading-5 text-foreground/90",
          !open && long && "max-h-64",
        )}
      >
        {value === undefined || value === null ? <span className="text-muted-foreground">—</span> : text}
      </pre>
      {long && (
        <button
          type="button"
          className="mt-1 text-xs text-muted-foreground underline"
          onClick={() => setOpen((o) => !o)}
        >
          {open ? "collapse" : "expand"}
        </button>
      )}
    </div>
  );
}
