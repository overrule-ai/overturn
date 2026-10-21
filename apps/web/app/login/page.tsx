"use client";

import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { client } from "@/lib/api";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const send = useMutation({ mutationFn: () => client.magicLink(email) });
  return (
    <div className="relative flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Logo /> Sign in to Overturn
          </CardTitle>
          <CardDescription>
            We email you a link. No password. New here? Same box: your workspace is created on first sign-in.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {send.data ? (
            <div className="space-y-3 text-sm">
              <p>
                {send.data.sent ? (
                  <>
                    Check <strong>{email}</strong> for a sign-in link. It is valid for 15 minutes.
                  </>
                ) : (
                  <>
                    Email sending is not configured on this server (no <code>RESEND_API_KEY</code>), so here
                    is your link:
                  </>
                )}
              </p>
              {send.data.devUrl && (
                <a
                  className="block break-all rounded-md bg-muted p-2 text-xs underline"
                  href={send.data.devUrl}
                >
                  {send.data.devUrl}
                </a>
              )}
            </div>
          ) : (
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                send.mutate();
              }}
            >
              <div className="space-y-1">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  required
                  autoFocus
                  placeholder="you@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              {send.error && <p className="text-sm text-destructive">{send.error.message}</p>}
              <Button type="submit" className="w-full" disabled={send.isPending}>
                {send.isPending ? "Sending…" : "Send sign-in link"}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
      <p className="absolute bottom-4 text-xs text-muted-foreground">
        <a className="hover:text-foreground" href="https://github.com/overrule-ai/overturn#readme">
          Docs
        </a>
        <span className="mx-2">·</span>
        <a className="hover:text-foreground" href="https://github.com/overrule-ai/overturn/issues">
          Issues
        </a>
        <span className="mx-2">·</span>
        <span>Open source, Apache-2.0</span>
      </p>
    </div>
  );
}
