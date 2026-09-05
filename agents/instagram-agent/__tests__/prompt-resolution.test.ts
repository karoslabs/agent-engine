import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { MockAgent, type AgentContext, type BaseAgentRuntime } from "@agent-engine/core";
import { z } from "zod";
import { InstagramResearchAgent } from "../src/agent/instagram-research-agent.js";
import { InstagramCopyAgent } from "../src/agent/instagram-copy-agent.js";
import { InstagramImageVettingAgent } from "../src/agent/instagram-image-vetting-agent.js";
import { fakeRouterSequence, finalTurn, goodCopyOutput, goodImageVettingOutput, goodResearchOutput, makePromptStore, PROMPTS_ROOT } from "./test-helpers.js";

const ctx: AgentContext = { runId: "run_1", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring", metadata: {} };

describe("PromptStore resolution (RFC-01 §16.1) — nothing here is a hardcoded prompt literal", () => {
  it("resolves each craft skillRef to its real prompts/<id>/1.md file content", async () => {
    const promptStore = makePromptStore();
    expect(await promptStore.getPrompt("instagram-research", "1")).toContain("Extract, don't invent");
    expect(await promptStore.getPrompt("instagram-copy", "1")).toContain("Six to eight slides, one idea each");
    // v2 keeps everything v1 said and adds the photographability rules.
    expect(await promptStore.getPrompt("instagram-copy", "2")).toContain("single photographable scene");
    // v3 keeps all of that and, unlike v1/v2, obeys its own dash ban.
    const v3 = await promptStore.getPrompt("instagram-copy", "3");
    expect(v3).toContain("Six to eight slides, one idea each");
    expect(v3).toContain("single photographable scene");
    expect(v3).not.toMatch(/[—–]/);
    expect(await promptStore.getPrompt("instagram-image-vet", "1")).toContain("No viable candidate is a real, valid answer");
  });

  it("resolves each skillRef with no version to prompts/<id>/latest.md", async () => {
    const promptStore = makePromptStore();
    for (const id of ["instagram-research", "instagram-copy", "instagram-image-vet"]) {
      const resolved = await promptStore.getPrompt(id);
      expect(resolved.length).toBeGreaterThan(0);
    }
  });

  it("InstagramResearchAgent actually passes the resolved prompt content as the system prompt at runtime", async () => {
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn(goodResearchOutput())]);
    const runtime: BaseAgentRuntime = { router, tools: {}, promptStore };
    const agent = new InstagramResearchAgent(runtime);

    await agent.run(ctx, { topic: "x", rawPayload: {}, rawPayloadRef: "r1" });

    const expectedPrompt = readFileSync(path.join(PROMPTS_ROOT, "instagram-research", "1.md"), "utf8");
    // SCRUM-298: `system` now also carries the response contract, appended
    // after the resolved skill body — assert the prefix, not exact equality.
    const call = (router.complete as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    const opts = call[3] as { system?: string };
    expect(opts.system?.startsWith(`${expectedPrompt}\n\n`)).toBe(true);
  });

  it("InstagramCopyAgent and InstagramImageVettingAgent likewise resolve their own skillRefs, not an inline string", async () => {
    const promptStore = makePromptStore();

    const copyRouter = fakeRouterSequence([finalTurn(goodCopyOutput())]);
    const copyAgent = new InstagramCopyAgent({ router: copyRouter, tools: {}, promptStore });
    await copyAgent.run(ctx, { topic: "x", facts: [], styleConfig: {}, brandTokens: {} });
    // 10.md: the copy agent is pinned to `instagram-copy@11` (T-A9's
    // brandingGuidelines section, on top of v9's client-knowledge-and-
    // recent-posts section: intel context + do-not-repeat constraints). v1
    // to v9 stay on disk frozen.
    const expectedCopyPrompt = readFileSync(path.join(PROMPTS_ROOT, "instagram-copy", "11.md"), "utf8");
    // SCRUM-298: `system` now also carries the response contract, appended
    // after the resolved skill body — assert the prefix, not exact equality.
    const copyCall = (copyRouter.complete as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    const copyOpts = copyCall[3] as { system?: string };
    expect(copyOpts.system?.startsWith(`${expectedCopyPrompt}\n\n`)).toBe(true);

    const vetRouter = fakeRouterSequence([finalTurn(goodImageVettingOutput())]);
    const vetAgent = new InstagramImageVettingAgent({ router: vetRouter, tools: {}, promptStore });
    await vetAgent.run(ctx, { slides: [], candidatePool: [] });
    const expectedVetPrompt = readFileSync(path.join(PROMPTS_ROOT, "instagram-image-vet", "2.md"), "utf8");
    const vetCall = (vetRouter.complete as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    const vetOpts = vetCall[3] as { system?: string };
    expect(vetOpts.system?.startsWith(`${expectedVetPrompt}\n\n`)).toBe(true);
  });

  it("produces tooling_error, not a crash, when skillRef names a prompt the store doesn't have", async () => {
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn({ text: "unused" })]);
    const runtime: BaseAgentRuntime = { router, tools: {}, promptStore };
    const agent = new MockAgent(runtime, {
      id: "broken-skill-probe",
      description: "probe",
      allowedTools: [],
      outputSchema: z.object({ text: z.string() }),
      modelPolicy: { policy: "pinned", model: "claude-sonnet-4-6" },
      skillRef: "does-not-exist@99",
    });
    const result = await agent.run(ctx, {});
    expect(result.status).toBe("tooling_error");
  });
});
