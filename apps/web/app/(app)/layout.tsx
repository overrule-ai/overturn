"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FlaskConical, ListTree, LogOut, RotateCcw, Settings } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { Logo } from "@/components/logo";
import { NativeSelect } from "@/components/ui/input";
import { ApiError, client, currentProjectId, setCurrentProjectId } from "@/lib/api";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/runs", label: "Runs", icon: ListTree },
  { href: "/cases", label: "Cases", icon: FlaskConical },
  { href: "/replays", label: "Replays", icon: RotateCcw },
  { href: "/settings", label: "Settings", icon: Settings },
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
  const section = NAV.find((n) => pathname.startsWith(n.href));

  return (
    <div className="flex min-h-screen flex-col sm:flex-row">
      {/* icon rail: top bar on phones, left rail from sm */}
      <aside className="flex shrink-0 items-center gap-1 border-b bg-card px-2 sm:w-12 sm:flex-col sm:border-b-0 sm:border-r sm:px-0 sm:py-2">
        <Link href="/runs" className="flex h-11 w-11 items-center justify-center" title="Overturn">
          <Logo className="h-5 w-5" cutout="fill-card" />
        </Link>
        <nav className="flex items-center gap-1 sm:mt-2 sm:flex-col">
          {NAV.map((n) => {
            const active = pathname.startsWith(n.href);
            return (
              <Link
                key={n.href}
                href={n.href}
                title={n.label}
                aria-label={n.label}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-9 w-9 items-center justify-center rounded-md transition-colors",
                  active
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                )}
              >
                <n.icon className="h-[18px] w-[18px]" strokeWidth={1.75} />
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto flex items-center gap-1 sm:mt-auto sm:ml-0 sm:flex-col">
          {s.user && (
            <button
              type="button"
              title={`Sign out (${s.user.email})`}
              aria-label="Sign out"
              className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/60 hover:text-foreground"
              onClick={async () => {
                await client.logout();
                setCurrentProjectId(null);
                qc.clear();
                router.replace("/login");
              }}
            >
              <LogOut className="h-[18px] w-[18px]" strokeWidth={1.75} />
            </button>
          )}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-11 shrink-0 items-center gap-3 border-b px-4 text-[13px]">
          <span className="text-muted-foreground">{s.project.name}</span>
          {section && (
            <>
              <span className="text-muted-foreground/50">/</span>
              <span className="font-medium">{section.label}</span>
            </>
          )}
          <div className="ml-auto flex items-center gap-3">
            {s.projects.length > 1 && (
              <NativeSelect
                className="h-7 text-xs"
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
            <span className="hidden text-xs text-muted-foreground md:inline">{s.user?.email}</span>
          </div>
        </header>
        <main className="min-w-0 flex-1 px-4 py-5 sm:px-6">{children}</main>
      </div>
    </div>
  );
}
