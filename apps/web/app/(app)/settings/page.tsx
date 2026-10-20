"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label, NativeSelect } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { client } from "@/lib/api";
import { ago } from "@/lib/utils";

const SCORERS = [
  "",
  "equals",
  "json_match",
  "tool_choice",
  "semantic",
  "judge",
  "not_equals",
  "should_escalate",
];

export default function SettingsPage() {
  const qc = useQueryClient();
  const project = useQuery({ queryKey: ["project"], queryFn: client.project.get });
  const keys = useQuery({ queryKey: ["api-keys"], queryFn: client.keys.list });
  const members = useQuery({ queryKey: ["members"], queryFn: client.members.list });
  const [newKey, setNewKey] = useState<{ name: string; key: string } | null>(null);
  const [keyName, setKeyName] = useState("default");
  const [email, setEmail] = useState("");
  const [form, setForm] = useState<Record<string, string> | null>(null);

  const createKey = useMutation({
    mutationFn: () => client.keys.create(keyName || "default"),
    onSuccess: (k) => {
      setNewKey({ name: keyName, key: k.key });
      qc.invalidateQueries({ queryKey: ["api-keys"] });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => client.keys.revoke(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["api-keys"] }),
  });
  const addMember = useMutation({
    mutationFn: () => client.members.add(email),
    onSuccess: () => {
      setEmail("");
      qc.invalidateQueries({ queryKey: ["members"] });
    },
  });
  const removeMember = useMutation({
    mutationFn: (id: string) => client.members.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["members"] }),
  });
  const webhookTest = useMutation({ mutationFn: () => client.project.webhookTest() });
  const save = useMutation({
    mutationFn: () =>
      client.project.patch({
        name: form!.name,
        settings: {
          defaultScorer: (form!.defaultScorer || null) as never,
          judgeModel: form!.judgeModel,
          embeddingModel: form!.embeddingModel,
          implicitApproveAfterDays: Number(form!.implicitApproveAfterDays),
          retentionDays: Number(form!.retentionDays),
          reviewWebhookUrl: (form!.reviewWebhookUrl ?? "").trim() || null,
        },
      }),
    onSuccess: () => {
      setForm(null);
      qc.invalidateQueries({ queryKey: ["project"] });
    },
  });

  const p = project.data;
  const f =
    form ??
    (p
      ? {
          name: p.name,
          defaultScorer: p.settings.defaultScorer ?? "",
          judgeModel: p.settings.judgeModel,
          embeddingModel: p.settings.embeddingModel,
          implicitApproveAfterDays: String(p.settings.implicitApproveAfterDays),
          retentionDays: String(p.settings.retentionDays),
          reviewWebhookUrl: p.settings.reviewWebhookUrl ?? "",
        }
      : null);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <h1 className="text-xl font-semibold">Settings</h1>

      <Card>
        <CardHeader>
          <CardTitle>API keys</CardTitle>
          <CardDescription>
            For the SDKs, the CLI and OpenTelemetry exporters. Keys are shown once.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {newKey && (
            <div className="rounded-md border border-success/30 bg-success/10 p-3 text-sm">
              <div className="mb-1 font-medium">
                New key “{newKey.name}” — copy it now, it will not be shown again
              </div>
              <code
                className="block break-all rounded border bg-background p-2 text-xs"
                data-testid="new-key"
              >
                OVERTURN_API_KEY={newKey.key}
              </code>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Input
              className="w-56 max-w-full"
              value={keyName}
              onChange={(e) => setKeyName(e.target.value)}
              placeholder="key name"
            />
            <Button
              onClick={() => createKey.mutate()}
              disabled={createKey.isPending}
              data-testid="create-key"
            >
              Create key
            </Button>
          </div>
          <Table>
            <THead>
              <TR>
                <TH>Name</TH>
                <TH>Prefix</TH>
                <TH>Last used</TH>
                <TH>Created</TH>
                <TH />
              </TR>
            </THead>
            <TBody>
              {keys.data
                ?.filter((k) => !k.revokedAt)
                .map((k) => (
                  <TR key={k.id}>
                    <TD>{k.name}</TD>
                    <TD className="font-mono text-xs">{k.prefix}…</TD>
                    <TD className="text-muted-foreground">{k.lastUsedAt ? ago(k.lastUsedAt) : "never"}</TD>
                    <TD className="text-muted-foreground">{ago(k.createdAt)}</TD>
                    <TD className="text-right">
                      <Button size="sm" variant="ghost" onClick={() => revoke.mutate(k.id)}>
                        Revoke
                      </Button>
                    </TD>
                  </TR>
                ))}
            </TBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Project</CardTitle>
          <CardDescription>
            Default scorer, judge model, implicit approval, retention and the Slack review webhook.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {f && (
            <form
              className="grid gap-3 sm:grid-cols-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (!form) setForm(f);
                save.mutate();
              }}
            >
              <div className="space-y-1 sm:col-span-2">
                <Label>Project name</Label>
                <Input value={f.name} onChange={(e) => setForm({ ...f, name: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label>Default scorer</Label>
                <NativeSelect
                  className="w-full"
                  value={f.defaultScorer}
                  onChange={(e) => setForm({ ...f, defaultScorer: e.target.value })}
                >
                  {SCORERS.map((s) => (
                    <option key={s} value={s}>
                      {s || "by shape of expected"}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div className="space-y-1">
                <Label>Judge model</Label>
                <Input value={f.judgeModel} onChange={(e) => setForm({ ...f, judgeModel: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label>Embedding model</Label>
                <Input
                  value={f.embeddingModel}
                  onChange={(e) => setForm({ ...f, embeddingModel: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label>Implicitly approve uncorrected runs after (days, 0 = off)</Label>
                <Input
                  type="number"
                  min="0"
                  value={f.implicitApproveAfterDays}
                  onChange={(e) => setForm({ ...f, implicitApproveAfterDays: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label>Retention (days; runs without a case are deleted after this)</Label>
                <Input
                  type="number"
                  min="1"
                  value={f.retentionDays}
                  onChange={(e) => setForm({ ...f, retentionDays: e.target.value })}
                />
              </div>
              <div className="space-y-1 sm:col-span-2">
                <Label>Review webhook (Slack incoming webhook URL)</Label>
                <div className="flex flex-wrap gap-2">
                  <Input
                    className="min-w-0 flex-1"
                    placeholder="https://hooks.slack.com/services/…"
                    value={f.reviewWebhookUrl}
                    onChange={(e) => setForm({ ...f, reviewWebhookUrl: e.target.value })}
                    data-testid="review-webhook"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!p?.settings.reviewWebhookUrl || !!form || webhookTest.isPending}
                    onClick={() => webhookTest.mutate()}
                    data-testid="webhook-test"
                  >
                    Send test
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Every completed run is posted there with Review and Approve buttons. Save before sending a
                  test.
                  {webhookTest.data &&
                    (webhookTest.data.ok
                      ? " Test message sent."
                      : ` Test failed: ${webhookTest.data.error ?? `HTTP ${webhookTest.data.status}`}`)}
                </p>
              </div>
              <div className="sm:col-span-2">
                <Button type="submit" disabled={!form || save.isPending}>
                  Save
                </Button>
                {save.error && <span className="ml-3 text-sm text-destructive">{save.error.message}</span>}
              </div>
            </form>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Members</CardTitle>
          <CardDescription>
            Members sign in with a magic link and see every project in this workspace.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              addMember.mutate();
            }}
          >
            <Input
              type="email"
              className="w-72 max-w-full"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="teammate@company.com"
            />
            <Button type="submit" disabled={addMember.isPending}>
              Add member
            </Button>
          </form>
          {addMember.error && <p className="text-sm text-destructive">{addMember.error.message}</p>}
          <Table>
            <THead>
              <TR>
                <TH>Email</TH>
                <TH>Role</TH>
                <TH>Since</TH>
                <TH />
              </TR>
            </THead>
            <TBody>
              {members.data?.map((m) => (
                <TR key={m.id}>
                  <TD>{m.email}</TD>
                  <TD>{m.role}</TD>
                  <TD className="text-muted-foreground">{ago(m.createdAt)}</TD>
                  <TD className="text-right">
                    <Button size="sm" variant="ghost" onClick={() => removeMember.mutate(m.id)}>
                      Remove
                    </Button>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
