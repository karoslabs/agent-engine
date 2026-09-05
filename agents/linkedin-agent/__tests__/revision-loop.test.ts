import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createLinkedInAgentWorkflow } from "../src/workflow/create-linkedin-agent-workflow.js";
import { fakeRouterSequence, finalTurn, makePromptStore, setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

/**
 * The universal approve / revise / reject cycle, as linkedin-agent uses it.
 *
 * Identical mechanics to instagram-agent's and x-agent's — that is the point
 * of `runReviewCycle` being generic rather than reimplemented per channel.
 */

const params = { runId: "linkedin_rev", clientSlug: "acme", productId: "linkedin-agent", runKind: "recurring" as const };

function draft(text: string) {
  return finalTurn({
    headline: "Anchor days cut scheduling friction",
    hook: text.slice(0, 60),
    body: text,
    hashtags: ["HybridWork", "FutureOfWork"],
    callToAction: "If your team is still negotiating its hybrid policy, a fixed anchor-day structure might be worth testing.",
    takeaway: "Predictability, not enforcement, is what made the schedule stick.",
    targetAudience: "People leaders evaluating hybrid work policies",
    archetype: "teardown-framework" as const,
    text,
  });
}

const FIRST =
  "We looked at attendance data across our hybrid client base this quarter, and the pattern surprised us.\n\n" +
  "Teams with a fixed two-day in-office schedule reported meaningfully fewer scheduling conflicts than teams with fully flexible policies.\n\n" +
  "#HybridWork #FutureOfWork";
const REVISED =
  "Hybrid policies are converging on one shape: fixed anchor days.\n\n" +
  "Teams with a fixed two-day in-office schedule reported meaningfully fewer scheduling conflicts than teams with fully flexible policies.\n\n" +
  "#HybridWork #FutureOfWork";

describe("linkedin-agent revision loop", () => {
  let env: TestEnvironment;
  beforeEach(async () => {
    env = await setupTestEnvironment();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it("re-drafts with the reviewer's feedback, then delivers on approval", async () => {
    const router = fakeRouterSequence([draft(FIRST), draft(REVISED)]);
    const workflowFn = createLinkedInAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const r0 = await engine.run(workflowFn, params);
    expect(r0.status).toBe("awaiting_gate");

    await engine.resolveGate(params.runId, "15-batch-review-r0", {
      decision: "revise",
      actor: "jane@karoslabs.com",
      feedback: "Lead with the trend, not the internal data.",
      at: new Date().toISOString(),
    });

    const r1 = await engine.run(workflowFn, params);
    expect(r1.status).toBe("awaiting_gate");
    if (r1.status !== "awaiting_gate") throw new Error("unreachable");
    expect(r1.pendingGateId).toContain("15-batch-review-r1");

    await engine.resolveGate(params.runId, "15-batch-review-r1", {
      decision: "approve",
      actor: "jane@karoslabs.com",
      at: new Date().toISOString(),
    });
    const final = await engine.run(workflowFn, params);
    expect(final.status).toBe("completed");

    const ids = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    // Round 1's drafting steps are revision-scoped, so they genuinely re-ran.
    expect(ids).toContain("09-draft-post");
    expect(ids).toContain("09-draft-post-r1");
    expect(ids).toContain("10-verify-numbers-sourced-r1");
    // Everything upstream — including the merged channel-setup pre-flight —
    // kept its id and was reused, which is why the revision is in-run rather
    // than a fresh run.
    expect(ids.filter((i) => i === "00-channel-setup")).toHaveLength(1);
    expect(ids.filter((i) => i === "04-research-pull")).toHaveLength(1);
    expect(ids).not.toContain("04-research-pull-r1");
    expect(ids).not.toContain("06-reserve-topic-r1");
  }, 60000);

  it("saves the reviewer's words to client memory, on a revision and on an approval alike", async () => {
    const router = fakeRouterSequence([draft(FIRST)]);
    const workflowFn = createLinkedInAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router });
    const engine = new WorkflowEngine(new MemoryDurableStepStore());
    const runId = "linkedin_rev_memory";

    await engine.run(workflowFn, { ...params, runId });
    await engine.resolveGate(runId, "15-batch-review-r0", {
      decision: "approve",
      actor: "jane@karoslabs.com",
      feedback: "The anchor-day framing is working, keep doing that.",
      at: new Date().toISOString(),
    });
    const final = await engine.run(workflowFn, { ...params, runId });
    expect(final.status).toBe("completed");

    const remembered = await env.store.listJson<{ note: string; decision: string; productId: string }>("acme", [
      "memory",
      "feedback",
    ]);
    expect(remembered.map((r) => r.data.note)).toContain("The anchor-day framing is working, keep doing that.");
    expect(remembered.map((r) => r.data.decision)).toContain("approve");
    // Scoped to the product, so a later linkedin-agent run reads its own history first.
    expect(remembered.map((r) => r.data.productId)).toContain("linkedin-agent");
  }, 60000);

  it("still holds on an outright rejection, because the gate exists to be able to say no", async () => {
    const router = fakeRouterSequence([draft(FIRST)]);
    const workflowFn = createLinkedInAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router });
    const engine = new WorkflowEngine(new MemoryDurableStepStore());
    const runId = "linkedin_rev_reject";

    await engine.run(workflowFn, { ...params, runId });
    await engine.resolveGate(runId, "15-batch-review-r0", {
      decision: "reject",
      actor: "jane@karoslabs.com",
      reason: "off-brand this week",
      at: new Date().toISOString(),
    });
    const result = await engine.run(workflowFn, { ...params, runId });
    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/review rejected/i);
  }, 60000);
});
