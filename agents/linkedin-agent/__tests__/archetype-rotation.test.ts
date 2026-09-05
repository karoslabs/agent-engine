import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import type { ModelRouter } from "@agent-engine/core";
import { createLinkedInAgentWorkflow } from "../src/workflow/create-linkedin-agent-workflow.js";
import type { LinkedInArchetype } from "../src/workflow/types.js";
import { fakeRouterSequence, finalTurn, makePromptStore, setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

const baseParams = { clientSlug: "acme", productId: "linkedin-agent", runKind: "recurring" as const };

function goodDraft(archetype: LinkedInArchetype = "teardown-framework") {
  return {
    headline: "A headline",
    hook: "We tried something new with our rollout process this month.",
    body: "The team documented every step and the change stuck because everyone could see why it mattered.",
    hashtags: ["HybridWork"],
    callToAction: "Worth comparing notes if your team is mid-rollout too.",
    takeaway: "Predictability, not enforcement, is what made the schedule stick.",
    targetAudience: "Operations leaders",
    archetype,
    text:
      "We tried something new with our rollout process this month.\n\n" +
      "The team documented every step and the change stuck because everyone could see why it mattered.\n\n" +
      "Worth comparing notes if your team is mid-rollout too.\n\n" +
      "#HybridWork",
  };
}

/** Pulls the `input` object the draft agent's first turn actually saw, out of the fake router's captured call — same helper shape as executive-identity.test.ts. */
function draftInputFromCall(router: ReturnType<typeof fakeRouterSequence>): Record<string, unknown> {
  const completeSpy = router.complete as unknown as ReturnType<typeof vi.fn>;
  expect(completeSpy).toHaveBeenCalled();
  const [prompt] = completeSpy.mock.calls[0] as [string, ...unknown[]];
  const parsed = JSON.parse(prompt) as { input: Record<string, unknown> };
  return parsed.input;
}

describe("archetype mix-tracking: the restored lane/rotation decision tree (lanes.md §2)", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("with no prior decisions at all, the first run gets the default rotation's first archetype (teardown-framework)", async () => {
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn(goodDraft())]);
    const workflowFn = createLinkedInAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, { ...baseParams, runId: "linkedin_run_archetype_first" });

    expect(result.status).toBe("completed");
    const draftInput = draftInputFromCall(router);
    expect(draftInput.archetype).toBe("teardown-framework");
  });

  it("never repeats the immediately-prior run's archetype — rotation skips past it to the next slot", async () => {
    // Seed a prior decision recording "teardown-framework" as the last archetype posted —
    // exactly the shape memory.appendDecision itself writes at step 18 (product-scoped
    // under this product's own bucket, matching baseParams.productId).
    await env.store.writeJson("acme", ["memory", "products", "linkedin-agent", "decisions", "seed_prior"], {
      decisionId: "seed_prior",
      summary: 'Posted about "rollout process" (archetype: teardown-framework)',
      at: Date.now() - 60_000,
    });
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn(goodDraft())]);
    const workflowFn = createLinkedInAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, { ...baseParams, runId: "linkedin_run_archetype_no_repeat" });

    expect(result.status).toBe("completed");
    const draftInput = draftInputFromCall(router);
    // "teardown-framework" would normally be picked again (it's first in the
    // default rotation) — the never-same-lane rule must skip it.
    expect(draftInput.archetype).not.toBe("teardown-framework");
    expect(draftInput.archetype).toBe("lesson-learned");
  });

  it("picks the most recent decision by timestamp, not by decisionId/filename order, when several prior decisions exist", async () => {
    await env.store.writeJson("acme", ["memory", "products", "linkedin-agent", "decisions", "seed_older"], {
      decisionId: "seed_older",
      summary: 'Posted about "hiring" (archetype: lesson-learned)',
      at: Date.now() - 120_000,
    });
    // "seed_newer" sorts BEFORE "seed_older" alphabetically, but is the more
    // recent decision by `at` — proving selection uses recency, not filename order.
    await env.store.writeJson("acme", ["memory", "products", "linkedin-agent", "decisions", "seed_newer_but_alpha_first"], {
      decisionId: "seed_newer_but_alpha_first",
      summary: 'Posted about "customer wins" (archetype: customer-story)',
      at: Date.now() - 1_000,
    });
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn(goodDraft())]);
    const workflowFn = createLinkedInAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, { ...baseParams, runId: "linkedin_run_archetype_recency" });

    expect(result.status).toBe("completed");
    const draftInput = draftInputFromCall(router);
    expect(draftInput.archetype).not.toBe("customer-story");
  });

  it("an explicit requestedArchetype in client config wins even when it repeats the immediately-prior run's archetype", async () => {
    await env.store.writeJson("acme", ["memory", "products", "linkedin-agent", "decisions", "seed_prior"], {
      decisionId: "seed_prior",
      summary: 'Posted about "rollout process" (archetype: teardown-framework)',
      at: Date.now() - 60_000,
    });
    await env.store.writeJson("acme", ["client", "config"], { requestedArchetype: "teardown-framework" });
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn(goodDraft())]);
    const workflowFn = createLinkedInAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, { ...baseParams, runId: "linkedin_run_archetype_requested_repeat" });

    expect(result.status).toBe("completed");
    const draftInput = draftInputFromCall(router);
    expect(draftInput.archetype).toBe("teardown-framework");
  });

  it("an invalid requestedArchetype string in client config is ignored, falling back to the rotation", async () => {
    await env.store.writeJson("acme", ["client", "config"], { requestedArchetype: "not-a-real-archetype" });
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn(goodDraft())]);
    const workflowFn = createLinkedInAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, { ...baseParams, runId: "linkedin_run_archetype_invalid_request" });

    expect(result.status).toBe("completed");
    const draftInput = draftInputFromCall(router);
    expect(draftInput.archetype).toBe("teardown-framework");
  });

  it("the final workflow result and the recorded decision both carry the draft agent's own echoed archetype", async () => {
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn(goodDraft("community-question"))]);
    const workflowFn = createLinkedInAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, { ...baseParams, runId: "linkedin_run_archetype_echo" });

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.output.archetype).toBe("community-question");

    const decisions = await env.store.listJson<{ summary: string }>("acme", ["memory", "products", "linkedin-agent", "decisions"]);
    const recorded = decisions.find((d) => d.id === "linkedin_run_archetype_echo__decision");
    expect(recorded?.data.summary).toContain("archetype: community-question");
  });

  it("AU24: a same-client DIFFERENT PRODUCT's decision must not disable the never-repeat rule, even one shaped exactly like LinkedIn's own", async () => {
    // LinkedIn's own real last post — a real archetype to never-repeat.
    await env.store.writeJson("acme", ["memory", "products", "linkedin-agent", "decisions", "seed_linkedin_older"], {
      decisionId: "seed_linkedin_older",
      summary: 'Posted about "rollout process" (archetype: teardown-framework)',
      at: Date.now() - 120_000,
    });
    // Same client, a DIFFERENT product ("x-agent"), a LATER timestamp than LinkedIn's own
    // last post, AND — deliberately — a summary shaped exactly like LinkedIn's own
    // "(archetype: ...)" format, so this row would still parse as an archetype-bearing
    // decision if it were visible here. Before AU24's fix, decisions were keyed by
    // clientSlug alone: every product for a client shared one bucket, so this row (more
    // recent, and pattern-matching) would win the "most recent archetype-bearing decision"
    // sort and silently make the rotation think LinkedIn's own last archetype was something
    // else entirely — the rule would still *look* enforced (a "prior" archetype was found
    // and skipped) while actually enforcing it against the wrong channel's history. Product
    // scoping means this row lives in a completely different bucket and is never read here
    // regardless of timestamp or summary shape.
    await env.store.writeJson("acme", ["memory", "products", "x-agent", "decisions", "seed_other_product_newer"], {
      decisionId: "seed_other_product_newer",
      summary: 'Posted about "quarterly roadmap" (archetype: customer-story)',
      at: Date.now() - 1_000,
    });
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn(goodDraft())]);
    const workflowFn = createLinkedInAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, { ...baseParams, runId: "linkedin_run_archetype_multichannel" });

    expect(result.status).toBe("completed");
    const draftInput = draftInputFromCall(router);
    // priorArchetype resolves to "teardown-framework" (LinkedIn's own, only, decision) —
    // the x-agent row is invisible here, so it's not "correctly filtered out by regex," it
    // structurally never arrives. With summaries.length=1, rotationIndex=1, landing on
    // "lesson-learned": the first candidate in the rotated order that isn't the excluded
    // prior archetype. (If the x-agent row had leaked in, summaries.length would be 2 and
    // it would additionally corrupt the rotation's own starting index, not just
    // lastArchetype — see the package README's migration note for why this matters beyond
    // just this one rule.)
    expect(draftInput.archetype).not.toBe("teardown-framework");
    expect(draftInput.archetype).not.toBe("customer-story");
    expect(draftInput.archetype).toBe("lesson-learned");
  });

  it("Phase 2.5 fix-batch: 6 consecutive real runs touch more than 2 distinct archetypes, never repeating back-to-back (regression test for the 2-cycle rotation bug)", async () => {
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const seenArchetypes: LinkedInArchetype[] = [];

    for (let i = 0; i < 6; i++) {
      const promptStore = makePromptStore();
      // Each turn's draft agent echoes back whatever archetype the workflow's
      // own rotation actually assigned it, rather than always claiming
      // "teardown-framework" regardless of what step 08 picked — using a
      // fixed archetype here would mask the very bug this test exists to catch.
      const router = {
        complete: vi.fn(async (prompt: string) => {
          const parsed = JSON.parse(prompt) as { input: { archetype: LinkedInArchetype } };
          return {
            output: { type: "final" as const, output: goodDraft(parsed.input.archetype) },
            modelUsed: "claude-sonnet-4-6",
            inputTokens: { cached: 0, uncached: 100 },
            outputTokens: 30,
          };
        }),
        completeAlias: vi.fn(async () => {
          throw new Error("completeAlias not used in this test");
        }),
      } as unknown as ModelRouter;
      const workflowFn = createLinkedInAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });
      const result = await engine.run(workflowFn, { ...baseParams, runId: `linkedin_run_rotation_breadth_${i}` });

      expect(result.status).toBe("completed");
      if (result.status !== "completed") throw new Error("unreachable");
      seenArchetypes.push(result.output.archetype);
    }

    // No two consecutive turns repeat.
    for (let i = 1; i < seenArchetypes.length; i++) {
      expect(seenArchetypes[i]).not.toBe(seenArchetypes[i - 1]);
    }
    // The old bug oscillated between exactly 2 archetypes forever; a real
    // rotation must visit more than 2 distinct ones across 6 consecutive runs.
    expect(new Set(seenArchetypes).size).toBeGreaterThan(2);
  });
});
