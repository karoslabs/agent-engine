import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import type { AgentToolRegistry } from "@agent-engine/core";
import { createLinkedInAgentWorkflow } from "../src/workflow/create-linkedin-agent-workflow.js";
import { fakeRouterSequence, finalTurn, makePromptStore, setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

const params = { runId: "linkedin_run_resume", clientSlug: "acme", productId: "linkedin-agent", runKind: "recurring" as const };

/** Wraps every tool's `execute` in a spy so we can prove a resumed run never re-invokes an already-checkpointed step. */
function spyOnAllTools(tools: AgentToolRegistry): { spied: AgentToolRegistry; callCounts: () => Record<string, number> } {
  const spies: Record<string, ReturnType<typeof vi.fn>> = {};
  const spied: AgentToolRegistry = {};
  for (const [name, tool] of Object.entries(tools)) {
    const spy = vi.fn(tool.execute.bind(tool));
    spies[name] = spy;
    spied[name] = { ...tool, execute: spy } as AgentToolRegistry[string];
  }
  return {
    spied,
    callCounts: () => Object.fromEntries(Object.entries(spies).map(([name, spy]) => [name, spy.mock.calls.length])),
  };
}

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

describe("checkpoint resume idempotency (RFC-01 §8.1)", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("re-running engine.run() with the same runId does not re-execute any already-completed step", async () => {
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn(goodDraft())]);
    const { spied, callCounts } = spyOnAllTools(env.tools);
    const workflowFn = createLinkedInAgentWorkflow({ tools: spied, promptStore, router, autoApprove: true });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const first = await engine.run(workflowFn, params);
    expect(first.status).toBe("completed");
    const countsAfterFirst = callCounts();
    expect(router.complete).toHaveBeenCalledTimes(1);
    expect(Object.values(countsAfterFirst).some((n) => n > 0)).toBe(true);

    const second = await engine.run(workflowFn, params);
    expect(second.status).toBe("completed");
    if (first.status !== "completed" || second.status !== "completed") throw new Error("unreachable");
    expect(second.output).toEqual(first.output);

    // Nothing ran again: the router turn, and every tool call, stayed at their first-run counts.
    expect(router.complete).toHaveBeenCalledTimes(1);
    expect(callCounts()).toEqual(countsAfterFirst);

    const stepRecords = await durableStore.listSteps(params.runId);
    expect(stepRecords).toHaveLength(27); // AU20 added the verified-dedupe step
    expect(stepRecords.every((s) => s.status === "completed")).toBe(true);
  });

  it("resumes correctly after a mid-run crash: earlier steps aren't redone, the run still reaches completed", async () => {
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn(goodDraft())]);
    const { spied, callCounts } = spyOnAllTools(env.tools);

    // A wrapper that throws once persistence starts (after step 16), simulating a crash
    // partway through, then behaves normally afterwards.
    let deliverablePersisted = false;
    const crashOnceTools: AgentToolRegistry = {
      ...spied,
      "ledger.writeDeliverable": {
        ...spied["ledger.writeDeliverable"]!,
        execute: vi.fn(async (input: unknown, opts: unknown) => {
          const result = await spied["ledger.writeDeliverable"]!.execute(input as never, opts as never);
          deliverablePersisted = true;
          return result;
        }),
      },
      "ledger.dashboardSnapshot": {
        ...spied["ledger.dashboardSnapshot"]!,
        execute: vi.fn(async (input: unknown, opts: unknown) => {
          if (deliverablePersisted) {
            deliverablePersisted = false; // only crash the first time we get here
            throw new Error("simulated crash right after persisting the deliverable");
          }
          return spied["ledger.dashboardSnapshot"]!.execute(input as never, opts as never);
        }),
      },
    };
    const workflowFn = createLinkedInAgentWorkflow({ tools: crashOnceTools, promptStore, router, autoApprove: true });

    const runId = "linkedin_run_resume_crash";
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const first = await engine.run(workflowFn, { ...params, runId });
    expect(first.status).toBe("degraded");

    const stepsAfterCrash = await durableStore.listSteps(runId);
    const step14 = stepsAfterCrash.find((s) => s.stepId === "16-persist-deliverable");
    const step15 = stepsAfterCrash.find((s) => s.stepId === "17-persist-manifest");
    expect(step14?.status).toBe("completed");
    // step 17's own tool call threw, so its checkpoint is recorded but as "failed" — not
    // "completed" — which is exactly what makes step-code re-run it (not skip it) on resume.
    expect(step15?.status).toBe("failed");

    const draftCallCountAfterCrash = callCounts()["ledger.writeDeliverable"];
    expect(router.complete).toHaveBeenCalledTimes(1);

    const second = await engine.run(workflowFn, { ...params, runId });
    expect(second.status).toBe("completed");

    // The draft/persist step from before the crash was NOT redone; only the steps
    // after the crash point ran on resume.
    expect(router.complete).toHaveBeenCalledTimes(1);
    expect(callCounts()["ledger.writeDeliverable"]).toBe(draftCallCountAfterCrash);

    const finalSteps = await durableStore.listSteps(runId);
    expect(finalSteps).toHaveLength(27); // AU20 added the verified-dedupe step
    expect(finalSteps.every((s) => s.status === "completed")).toBe(true);
  });
});
