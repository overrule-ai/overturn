import { describe, expect, it } from "vitest";
import { customers, tickets } from "./data.js";
import { fakeTriage } from "./fake-triage.js";
import { PROMPTS } from "./prompts.js";

function input(ticketId: string) {
  const ticket = tickets.find((t) => t.id === ticketId)!;
  const customer = customers.find((c) => c.email === ticket.customerEmail)!;
  return JSON.stringify({ ticket, customer, articles: [] });
}

describe("fakeTriage", () => {
  it("classifies a full outage as P0 infrastructure", () => {
    expect(fakeTriage(PROMPTS.v1!, input("T-1001"), "fake-triage-v1")).toMatchObject({
      priority: "P0",
      team: "infrastructure",
    });
  });
  it("classifies a feature request as P3", () => {
    expect(fakeTriage(PROMPTS.v1!, input("T-1007"), "fake-triage-v1").priority).toBe("P3");
  });
  it("v2 prompt bumps enterprise customers one level", () => {
    expect(fakeTriage(PROMPTS.v1!, input("T-1004"), "fake-triage-v1").priority).toBe("P2");
    expect(fakeTriage(PROMPTS.v2!, input("T-1004"), "fake-triage-v1").priority).toBe("P1");
    // but not pro customers
    expect(fakeTriage(PROMPTS.v2!, input("T-1005"), "fake-triage-v1").priority).toBe("P2");
  });
  it("the weak model demotes outages", () => {
    expect(fakeTriage(PROMPTS.v1!, input("T-1001"), "fake-triage-weak").priority).toBe("P1");
    expect(fakeTriage(PROMPTS.weak!, input("T-1001"), "fake-triage-v1").priority).toBe("P1");
  });
  it("is deterministic over every ticket", () => {
    for (const t of tickets) {
      const a = fakeTriage(PROMPTS.v1!, input(t.id), "fake-triage-v1");
      const b = fakeTriage(PROMPTS.v1!, input(t.id), "fake-triage-v1");
      expect(a).toEqual(b);
    }
  });
});
