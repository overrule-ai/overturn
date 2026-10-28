"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, NativeSelect } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { client } from "@/lib/api";
import { pct } from "@/lib/utils";

/**
 * The capture scorecard: the number a claims leader reads. How much of the AI's work went
 * out untouched, who is fixing the rest, and why.
 */
export default function CapturePage() {
  const [days, setDays] = useState(30);
  const [agent, setAgent] = useState("");
  const stats = useQuery({
    queryKey: ["capture-stats", days, agent],
    queryFn: () => client.corrections.captureStats({ days, agent: agent || undefined }),
  });
  const s = stats.data;
  const maxWeek = Math.max(1, ...(s?.weekly.map((w) => w.captures) ?? [1]));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold">Capture</h1>
          <p className="text-sm text-muted-foreground">
            Every reply your experts sent from the tool they work in, scored: untouched means the draft went
            out as written.
          </p>
        </div>
        <div className="flex items-end gap-2">
          <Input
            placeholder="agent"
            className="w-40"
            value={agent}
            onChange={(e) => setAgent(e.target.value)}
          />
          <NativeSelect value={String(days)} onChange={(e) => setDays(Number(e.target.value))}>
            <option value="7">last 7 days</option>
            <option value="30">last 30 days</option>
            <option value="90">last 90 days</option>
            <option value="365">last year</option>
          </NativeSelect>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader>
            <CardDescription>Sent untouched</CardDescription>
            <CardTitle
              className="font-mono text-3xl font-normal tabular-nums"
              data-testid="capture-untouched"
            >
              {s ? pct(s.untouchedRate) : "—"}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {s ? `${s.untouched} of ${s.captures} drafts went out as written` : ""}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Expert fixes kept</CardDescription>
            <CardTitle className="font-mono text-3xl font-normal tabular-nums">
              {s ? s.edited : "—"}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {s ? (
              <Link className="underline" href="/cases">
                each one is a case and a training row
              </Link>
            ) : (
              ""
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Experts capturing</CardDescription>
            <CardTitle className="font-mono text-3xl font-normal tabular-nums">
              {s ? s.experts : "—"}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {s ? s.bySource.map((x) => `${x.source} ${x.count}`).join(" · ") : ""}
          </CardContent>
        </Card>
      </div>

      {s && s.captures === 0 ? (
        <Card>
          <CardContent className="py-8 text-sm text-muted-foreground">
            Nothing captured in this window. Install the Zendesk app or call <code>POST /v1/capture</code>{" "}
            from the tool your experts work in; the first reply they send shows up here.
          </CardContent>
        </Card>
      ) : null}

      {s && s.weekly.length > 0 ? (
        <Card>
          <CardHeader>
            <CardDescription>By week</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-end gap-1.5" style={{ height: 96 }}>
              {s.weekly.map((w) => (
                <div
                  key={w.weekStart}
                  className="flex flex-1 flex-col justify-end gap-0.5"
                  title={`${w.weekStart.slice(0, 10)}: ${w.captures} captured, ${w.edited} edited`}
                >
                  <div
                    className="w-full rounded-t-sm bg-foreground/80"
                    style={{ height: `${(w.edited / maxWeek) * 88}px` }}
                  />
                  <div
                    className="w-full bg-foreground/25"
                    style={{ height: `${((w.captures - w.edited) / maxWeek) * 88}px` }}
                  />
                </div>
              ))}
            </div>
            <div className="mt-2 text-xs text-muted-foreground">dark: edited · light: sent untouched</div>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardDescription>By expert</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <THead>
                <TR>
                  <TH>Expert</TH>
                  <TH className="text-right">Captured</TH>
                  <TH className="text-right">Edited</TH>
                  <TH className="text-right">Untouched</TH>
                </TR>
              </THead>
              <TBody>
                {(s?.byActor ?? []).map((a) => (
                  <TR key={a.actor ?? "-"}>
                    <TD>{a.actor ?? <span className="text-muted-foreground">unknown</span>}</TD>
                    <TD className="text-right tabular-nums">{a.captures}</TD>
                    <TD className="text-right tabular-nums">{a.edited}</TD>
                    <TD className="text-right tabular-nums">{pct(a.untouchedRate)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Why experts changed the draft</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <THead>
                <TR>
                  <TH>Reason</TH>
                  <TH className="text-right">Times</TH>
                </TR>
              </THead>
              <TBody>
                {(s?.byReason ?? []).map((r) => (
                  <TR key={r.reason}>
                    <TD>{r.reason}</TD>
                    <TD className="text-right tabular-nums">{r.count}</TD>
                  </TR>
                ))}
                {s && s.byReason.length === 0 ? (
                  <TR>
                    <TD colSpan={2} className="text-muted-foreground">
                      No reasons yet. Turn on "require a reason" in the Zendesk app to collect them.
                    </TD>
                  </TR>
                ) : null}
              </TBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      {s && s.byAgent.length > 1 ? (
        <Card>
          <CardHeader>
            <CardDescription>By workflow</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <THead>
                <TR>
                  <TH>Agent</TH>
                  <TH className="text-right">Captured</TH>
                  <TH className="text-right">Edited</TH>
                </TR>
              </THead>
              <TBody>
                {s.byAgent.map((a) => (
                  <TR key={a.agent}>
                    <TD>
                      <Link className="underline" href={`/cases?agent=${encodeURIComponent(a.agent)}`}>
                        {a.agent}
                      </Link>
                    </TD>
                    <TD className="text-right tabular-nums">{a.captures}</TD>
                    <TD className="text-right tabular-nums">{a.edited}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
