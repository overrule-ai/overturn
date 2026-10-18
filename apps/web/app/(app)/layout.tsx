"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/input";
import { ApiError, client, currentProjectId, setCurrentProjectId } from "@/lib/api";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/runs", label: "Runs" },
  { href: "/cases", label: "Cases" },
  { href: "/replays", label: "Replays" },
  { href: "/settings", label: "Settings" },
];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const qc = useQueryClient();
  const session = useQuery({ queryKey: ["session"], queryFn: client.session, retry: false });

  useEffect(() => {
    if (session.error instanceof ApiError && session.error.status === 401)
      router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [session.error, router, pathname]);

  if (session.isLoading) return <div className="p-8 text-sm text-muted-foreground">Loading…</div>;
  if (!session.data) {
    const err = session.error;
    const unauthorized = err instanceof ApiError && err.status === 401;
    return (
      <div className="p-8 text-sm text-muted-foreground">
        {unauthorized
          ? "Redirecting to sign in…"
          : `Cannot reach the Overturn API: ${err?.message ?? "unknown error"}`}
      </div>
    );
  }
  const s = session.data;

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4 sm:gap-6">
          <Link href="/runs" className="flex shrink-0 items-center gap-2 font-semibold">
            <Logo /> <span className="hidden sm:inline">Overturn</span>
          </Link>
          <nav className="flex min-w-0 items-center gap-1 overflow-x-auto">
            {NAV.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                className={cn(
                  "whitespace-nowrap rounded-md px-2 py-1.5 text-sm hover:bg-accent sm:px-3",
                  pathname.startsWith(n.href) ? "bg-accent font-medium" : "text-muted-foreground",
                )}
              >
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex shrink-0 items-center gap-3">
            {s.projects.length > 1 && (
              <NativeSelect
                value={currentProjectId() ?? s.project.id}
                onChange={(e) => {
                  setCurrentProjectId(e.target.value);
                  qc.clear();
                  router.refresh();
                  window.location.reload();
                }}
              >
                {s.projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.organizationName} / {p.name}
                  </option>
                ))}
              </NativeSelect>
            )}
            <span className="hidden text-sm text-muted-foreground md:inline">
              {s.user?.email ?? s.project.name}
            </span>
            {s.user && (
              <Button
                variant="ghost"
                size="sm"
                onClick={async () => {
                  await client.logout();
                  setCurrentProjectId(null);
                  qc.clear();
                  router.replace("/login");
                }}
              >
                Sign out
              </Button>
            )}
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">{children}</main>
    </div>
  );
}
