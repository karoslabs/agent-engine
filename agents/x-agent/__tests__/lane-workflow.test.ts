import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createXAgentWorkflow } from "../src/workflow/create-x-agent-workflow.js";
import { fakeRouterSequence, finalTurn, makePromptStore, setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

const baseParams = { clientSlug: "acme", productId: "x-agent", runKind: "recurring" as const };

function goodPost(overrides: Record<string, unknown> = {}) {
  return {
    text: "More teams are testing 4-day weeks this quarter.",
    mainPostText: "More teams are testing 4-day weeks this quarter.",
    hook: "More teams are testing 4-day weeks this quarter.",
    angle: "trend-observation",
    lane: "knowledge",
    targetHandle: "@acmehq",
    ...overrides,
  };
}

/** Seeds a `memory.decisions` row directly (bypassing `memory.appendDecision`, whose input schema strips any field not named `decisionId`/`summary`/`rationale` — same pattern the rest of this suite already uses to seed `client.*` state). */
async function seedDecision(env: TestEnvironment, decisionId: string, lane: string, at: number) {
  await env.store.writeJson("acme", ["memory", "products", "x-agent", "decisions", decisionId], {
    decisionId,
    summary: `Posted about "${decisionId}" (lane: ${lane}, angle: trend-observation)`,
    at,
  });
}

describe("the lane system, end to end (Phase 2.5 batch 2.3)", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("the lane selector avoids repeating the immediately-prior run's recorded lane", async () => {
    await seedDecision(env, "prior_run__decision", "knowledge", Date.now() - 1000);

    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn(goodPost())]);
    const workflowFn = createXAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "x_run_lane_rotation" });

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.output.lane).not.toBe("knowledge");
    // 2026-09: the lane is narrowed to the content mode's lanes. The seeded
    // decision recorded no mode, so the rotation picks the heaviest mode
    // (deep-value), whose lanes are knowledge and build-in-public; knowledge
    // is the prior lane, so build-in-public is the one honest answer.
    expect(result.output.contentMode).toBe("deep-value");
    expect(result.output.lane).toBe("build-in-public");
  });

  it("an explicit requestedLane in the client config overrides the rotation", async () => {
    await env.store.writeJson("acme", ["client", "config"], { xHandle: "@acmehq", requestedLane: "build-in-public" });

    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn(goodPost({ lane: "build-in-public" }))]);
    const workflowFn = createXAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "x_run_lane_requested" });

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.output.lane).toBe("build-in-public");
  });

  it("holds the run once the engagement lane's daily cap is already met, before ever calling the model", async () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      await seedDecision(env, `prior_engagement_${i}`, "engagement", now - i * 60 * 1000);
    }
    await env.store.writeJson("acme", ["client", "config"], { xHandle: "@acmehq", requestedLane: "engagement" });

    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn(goodPost({ lane: "engagement" }))]);
    const workflowFn = createXAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "x_run_engagement_capped" });

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/engagement lane daily cap/i);

    // The cap held before drafting ever started — no model call spent.
    expect(router.complete).not.toHaveBeenCalled();

    const stepRecords = await durableStore.listSteps("x_run_engagement_capped");
    const ids = stepRecords.map((s) => s.stepId);
    expect(ids).toContain("09-check-engagement-cap");
    expect(ids).not.toContain("10-draft-post");
  });

  it("proceeds normally when the engagement lane is under its daily cap", async () => {
    const now = Date.now();
    for (let i = 0; i < 4; i++) {
      await seedDecision(env, `prior_engagement_${i}`, "engagement", now - i * 60 * 1000);
    }
    await env.store.writeJson("acme", ["client", "config"], { xHandle: "@acmehq", requestedLane: "engagement" });

    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn(goodPost({ lane: "engagement", targetPostHandle: "@someaccount", targetPostUrl: "https://x.com/someaccount/status/1" }))]);
    const workflowFn = createXAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "x_run_engagement_ok" });

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.output.lane).toBe("engagement");
  });

  it("engagement decisions older than the 24h window don't count toward the cap", async () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      await seedDecision(env, `stale_engagement_${i}`, "engagement", now - 48 * 60 * 60 * 1000 - i * 1000);
    }
    await env.store.writeJson("acme", ["client", "config"], { xHandle: "@acmehq", requestedLane: "engagement" });

    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn(goodPost({ lane: "engagement" }))]);
    const workflowFn = createXAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, { ...baseParams, runId: "x_run_engagement_stale" });

    expect(result.status).toBe("completed");
  });
});
