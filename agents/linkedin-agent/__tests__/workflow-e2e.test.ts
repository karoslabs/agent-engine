import { describe, expect, it, afterEach, beforeEach } from "vitest";
import {
  MemoryDurableStepStore,
  WorkflowEngine,
  serializeToDynamicAgentRunReport,
  type DynamicAgentStepDescriptor,
} from "@agent-engine/workflow";
import { createLinkedInAgentWorkflow } from "../src/workflow/create-linkedin-agent-workflow.js";
import { fakeRouterSequence, finalTurn, makePromptStore, setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

const params = { runId: "linkedin_run_1", clientSlug: "acme", productId: "linkedin-agent", runKind: "recurring" as const };

const ALL_19_STEP_IDS = [
  "00-channel-setup",
  "00-intake-check",
  "01-load-client-context",
  "02-load-memory-shelf",
  "03-load-recent-decisions",
  "04-research-pull",
  // The read side of the feedback flywheel: what this client asked for on
  // previous runs, injected into the drafting prompt.
  "04e-read-past-feedback",
  // The shipped-output window (dedup) and the client intel report, read
  // once each — see history-dedup.ts in packages/workflow.
  "read-output-history",
  "read-intel-context",
  "05-extract-candidate-summary",
  "06-reserve-topic",
  "07-select-candidate",
  // 2026-09: the content-mode rotation. The trend scout (07a) does NOT appear
  // here: the seeded catalog planned this run's topic, so the scout never runs.
  "07b-select-content-mode",
  "08-determine-archetype",
  "09-draft-post",
  // AU20: the VERIFIED half of de-duplication. `recentPosts` in the drafting
  // prompt only asks the model not to repeat itself; 09a scores the finished
  // draft against the same excerpt window, inside the drafting pass, so the
  // reviewer is never shown a draft that was not measured.
  "09a-verify-not-duplicate",
  // 2026-09: the shape check after the deterministic reflow — notes, never a hold.
  "09b-verify-formatting",
  "10-verify-numbers-sourced",
  "11-verify-brand-compliance",
  "12-render-preview-check",
  "13-verify-no-placeholder",
  "14-verify-no-leak",
  // 2026-09: the media resolver. Always a step; with no media tools in this
  // registry and no brief on the draft it records `none` and moves on.
  "14b-resolve-media",
  // Revision-scoped: `-r0` is the first review round. A `revise` decision
  // registers `-r1` after re-drafting.
  "15-batch-review-r0",
  "16-persist-deliverable",
  "17-persist-manifest",
  "18-commit-and-record",
];

function goodDraft() {
  return {
    headline: "Anchor days cut scheduling friction",
    hook: "We looked at attendance data across our hybrid client base this quarter, and the pattern surprised us.",
    body: "Teams with a fixed two-day in-office schedule reported meaningfully fewer scheduling conflicts than teams with fully flexible policies.",
    hashtags: ["HybridWork", "FutureOfWork"],
    callToAction: "If your team is still negotiating its hybrid policy week to week, a fixed anchor-day structure might be worth testing.",
    takeaway: "Predictability, not enforcement, is what made the schedule stick.",
    targetAudience: "People leaders evaluating hybrid work policies",
    archetype: "teardown-framework" as const,
    text:
      "We looked at attendance data across our hybrid client base this quarter, and the pattern surprised us.\n\n" +
      "Teams with a fixed two-day in-office schedule reported meaningfully fewer scheduling conflicts than teams with fully flexible policies.\n\n" +
      "If your team is still negotiating its hybrid policy week to week, a fixed anchor-day structure might be worth testing.\n\n" +
      "#HybridWork #FutureOfWork",
  };
}

function goodDraftRouter() {
  return fakeRouterSequence([finalTurn(goodDraft())]);
}

describe("end-to-end: the 20-step LinkedIn agent workflow", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("executes all 20 steps and resolves to completed / domainOutcome: delivered (auto-approved gate)", async () => {
    const promptStore = makePromptStore();
    const router = goodDraftRouter();
    const workflowFn = createLinkedInAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, params);

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.output.topic).toBeTruthy();
    expect(result.output.targetAudience).toBe("People leaders evaluating hybrid work policies");
    expect(result.totalCostUsd).toBeGreaterThan(0);

    const stepRecords = await durableStore.listSteps(params.runId);
    const executedIds = stepRecords.map((s) => s.stepId).sort();
    expect(executedIds).toEqual([...ALL_19_STEP_IDS].sort());
    expect(stepRecords.every((s) => s.status === "completed")).toBe(true);

    // The deliverable really landed on the real file-backed WorkspaceStore, tenant-scoped.
    const deliverables = await env.store.listJson("acme", ["ledger", "deliverables", params.runId, "_"]);
    expect(deliverables.map((d) => d.id)).toEqual(["linkedin-post"]);

    // The reserved topic was actually committed (consumed) at step 18, not left dangling.
    const catalog = await env.store.readJson<Array<{ status: string }>>("acme", ["topics", "catalog"]);
    expect(catalog?.some((t) => t.status === "committed")).toBe(true);

    const descriptors: DynamicAgentStepDescriptor[] = ALL_19_STEP_IDS.map((stepId) => ({
      stepId,
      label: stepId,
      type: stepId === "09-draft-post" ? "ai" : "code",
    }));
    const runRecord = await durableStore.getRun(params.runId);
    const report = serializeToDynamicAgentRunReport({
      specId: "spec_linkedin_agent",
      specVersion: 1,
      steps: descriptors,
      stepRecords,
      slotRecords: [],
      ...(runRecord !== undefined ? { runRecord } : {}),
    });

    expect(report.domainOutcome).toBe("delivered");
    expect(report.steps.every((s) => s.status === "done")).toBe(true);
    const draftStep = report.steps.find((s) => s.stepId === "09-draft-post")!;
    expect(draftStep.costUsd).toBeGreaterThan(0);
    expect(draftStep.model).toBe("claude-sonnet-4-6");
  });

  it("pauses at the human batch-review gate by default, then resumes to completed on approval (RFC-01 §8.3)", async () => {
    const promptStore = makePromptStore();
    const router = goodDraftRouter();
    const workflowFn = createLinkedInAgentWorkflow({ tools: env.tools, promptStore, router });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const first = await engine.run(workflowFn, params);
    expect(first.status).toBe("awaiting_gate");
    if (first.status !== "awaiting_gate") throw new Error("unreachable");
    expect(first.pendingGateId).toContain("15-batch-review-r0");

    const deliverablesBeforeApproval = await env.store.listJson("acme", ["ledger", "deliverables", params.runId, "_"]);
    expect(deliverablesBeforeApproval).toHaveLength(0);

    await engine.resolveGate(params.runId, "15-batch-review-r0", {
      decision: "approve",
      actor: "jane@karoslabs.com",
      at: new Date(2026, 7, 16).toISOString(),
    });

    const second = await engine.run(workflowFn, params);
    expect(second.status).toBe("completed");
    expect(router.complete).toHaveBeenCalledTimes(1);

    const deliverables = await env.store.listJson("acme", ["ledger", "deliverables", params.runId, "_"]);
    expect(deliverables.map((d) => d.id)).toEqual(["linkedin-post"]);

    // THE GATE IS A STEP RECORD TOO, now that `wf.step.gate` checkpoints
    // itself (`kind: "gate"`) — so the full id list appears here, gate
    // included, and this suite's own "N-step workflow" name is finally
    // literally true. This assertion used to filter "15-batch-review" OUT,
    // under a comment explaining that a gate never reaches `listSteps()`;
    // that absence is exactly what made a real run's step sequence read
    // straight past its human review step in the portal.
    const stepRecords = await durableStore.listSteps(params.runId);
    expect(stepRecords.map((s) => s.stepId).sort()).toEqual([...ALL_19_STEP_IDS].sort());
    expect(stepRecords.every((s) => s.status === "completed")).toBe(true);
    // And the checkpoint carries the DECISION, which is the only place the
    // run records that a human approved this and who they were.
    const gateStep = stepRecords.find((s) => s.kind === "gate");
    expect(gateStep?.stepId).toBe("15-batch-review-r0");
    expect(gateStep?.output).toMatchObject({ decision: "approve", actor: "jane@karoslabs.com" });
  });

  it("rejects the batch review with a reason -> held, and the deliverable never ships", async () => {
    const promptStore = makePromptStore();
    const router = goodDraftRouter();
    const workflowFn = createLinkedInAgentWorkflow({ tools: env.tools, promptStore, router });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    await engine.run(workflowFn, params);
    await engine.resolveGate(params.runId, "15-batch-review-r0", {
      decision: "reject",
      actor: "jane@karoslabs.com",
      reason: "not on brand this week",
      at: new Date(2026, 7, 16).toISOString(),
    });

    const result = await engine.run(workflowFn, params);
    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    // `runReviewCycle` is generic across agents, so the wording is
    // "review rejected" rather than anything channel-specific.
    expect(result.reason).toMatch(/review rejected/i);

    const deliverables = await env.store.listJson("acme", ["ledger", "deliverables", params.runId, "_"]);
    expect(deliverables).toHaveLength(0);
  });
});
