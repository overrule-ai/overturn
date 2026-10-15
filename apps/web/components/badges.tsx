import { Badge } from "@/components/ui/badge";

export function VerdictBadge({ verdict }: { verdict: string | null | undefined }) {
  if (!verdict) return <span className="text-muted-foreground">—</span>;
  const variant =
    verdict === "regression"
      ? "danger"
      : verdict === "fixed"
        ? "success"
        : verdict === "pass"
          ? "info"
          : verdict === "fail"
            ? "warning"
            : "muted";
  return <Badge variant={variant}>{verdict}</Badge>;
}

export function KindBadge({ kind }: { kind: string }) {
  const variant =
    kind === "approve" ? "success" : kind === "edit" ? "info" : kind === "reject" ? "danger" : "warning";
  return <Badge variant={variant}>{kind}</Badge>;
}

export function StatusBadge({ status }: { status: string }) {
  const variant =
    status === "completed"
      ? "success"
      : status === "failed"
        ? "danger"
        : status === "running"
          ? "info"
          : "muted";
  return <Badge variant={variant}>{status}</Badge>;
}
