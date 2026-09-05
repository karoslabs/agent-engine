import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { DEDUPE_SIMILARITY_THRESHOLD, similarity, type AgentContext } from "@agent-engine/core";
import { createLinkedInAgentWorkflow } from "../src/workflow/create-linkedin-agent-workflow.js";
import { fakeRouterSequence, finalTurn, makePromptStore, setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

/**
 * AU20 (SCRUM-304): the acceptance criterion — a planted NEAR-duplicate is
 * caught before the draft can pass review.
 *
 * "Near", not byte-identical, on purpose: this agent's only anti-repetition
 * mechanism was the `recentPosts` directive in the drafting prompt, which is
 * advisory. A model that reorders its own paragraphs and swaps a few words is
 * still repeating itself, and nothing downstream ever measured whether it had.
 * The planted draft below scores well over `evaluateDedupe`'s calibrated
 * threshold while sharing no whole paragraph verbatim with the published post
 * it recycles — exactly the case a prompt-only check sails past.
 */

const params = { runId: "li_dedupe_1", clientSlug: "acme", productId: "linkedin-agent", runKind: "recurring" as const };

/** Already shipped for this client, sitting in `ledger.recordOutputExcerpt`'s window. */
const PUBLISHED =
  "Most teams pick a hybrid schedule and then never revisit it.\n\n" +
  "We looked at attendance across our client base last quarter and the pattern repeated everywhere: the schedule was set once, in a rush, by whoever booked the room.\n\n" +
  "The teams that fixed it did one thing differently. They wrote down which work needs a room and which work needs quiet, then built the week around that answer instead of around habit.\n\n" +
  "Two days together, three days apart, and nobody defends it because nobody chose it.";

/** This run's first draft: the same post, paragraphs reordered and lightly reworded. */
const NEAR_DUPLICATE =
  "Two days together, three days apart, and nobody defends it because nobody actually chose it.\n\n" +
  "The teams that fixed this did one thing differently. They wrote down which work needs a room and which work needs quiet, then built the week around that answer instead of around habit.\n\n" +
  "We looked at attendance across our client base last quarter and the same pattern repeated everywhere: the schedule was set once, in a rush, by whoever booked the room.\n\n" +
  "Most teams pick a hybrid schedule and then never revisit it.";

/** The redraft: a genuinely different hook, structure and subject. */
const FRESH =
  "Nobody wants another manager training programme.\n\n" +
  "What actually moved the needle for us was a standing thirty minute slot where two managers swap one hard conversation each and rehearse it out loud before it happens.\n\n" +
  "No slides, no framework, no facilitator. Just the sentence you are dreading, said once to somebody who is not the person you have to say it to.\n\n" +
  "Six weeks in, the escalations we used to get on a Friday afternoon have mostly stopped arriving.";

function draft(text: string) {
  return finalTurn({
    headline: "Anchor days cut scheduling friction",
    hook: text.split("\n\n")[0],
    body: text,
    hashtags: ["HybridWork", "FutureOfWork"],
    callToAction: "Worth testing on your own team before the next planning cycle.",
    takeaway: "Predictability, not enforcement, is what made the schedule stick.",
    targetAudience: "People leaders evaluating hybrid work policies",
    archetype: "teardown-framework" as const,
    text,
  });
}

describe("linkedin-agent verified de-duplication (AU20)", () => {
  let env: TestEnvironment;
  beforeEach(async () => {
    env = await setupTestEnvironment();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it("catches a planted near-duplicate before review, redrafts, and ships the fresh draft", async () => {
    // The plant really is a near-duplicate and really is not a copy: an
    // exact-match or substring check would not fire on it.
    expect(NEAR_DUPLICATE).not.toBe(PUBLISHED);
    expect(similarity(NEAR_DUPLICATE, PUBLISHED)).toBeGreaterThanOrEqual(DEDUPE_SIMILARITY_THRESHOLD);
    expect(similarity(FRESH, PUBLISHED)).toBeLessThan(DEDUPE_SIMILARITY_THRESHOLD);

    const seedCtx: AgentContext = { runId: "prior-run", clientSlug: "acme", productId: "linkedin-agent", runKind: "recurring", metadata: {} };
    await env.tools["ledger.recordOutputExcerpt"]!.execute({ agentId: "linkedin-agent", runId: "prior-run", excerpt: PUBLISHED }, { ctx: seedCtx });

    const router = fakeRouterSequence([draft(NEAR_DUPLICATE), draft(FRESH)]);
    const workflowFn = createLinkedInAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router, autoApprove: true });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);

    const result = await engine.run(workflowFn, params);
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");

    // The headline claim, asserted first so a regression here reads as what it
    // is: without the verified check the near-duplicate is what ships.
    expect(result.output.preview).toBe(FRESH);

    // The advisory half was present and was not enough: the do-not-repeat
    // directive reached the first drafting prompt, and the model returned the
    // near-duplicate anyway. Only the verified check stopped it.
    const calls = (router.complete as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(String(calls[0]![0])).toContain("RECENTLY PUBLISHED");

    const flagged = await durableStore.getStep(params.runId, "09a-verify-not-duplicate");
    expect(flagged?.status).toBe("completed");
    const verdict = flagged?.output as { status: string; maxSimilarity: number; comparedCount: number; mostSimilarRunId?: string };
    expect(verdict.status).toBe("similar");
    expect(verdict.mostSimilarRunId).toBe("prior-run");
    expect(verdict.comparedCount).toBe(1);
    expect(verdict.maxSimilarity).toBeGreaterThanOrEqual(DEDUPE_SIMILARITY_THRESHOLD);

    // The hit COST the draft: a second drafting pass ran, steered by the
    // offending post, and cleared the same check.
    const ids = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    expect(ids).toContain("09-draft-post-attempt-2");
    const cleared = await durableStore.getStep(params.runId, "09a-verify-not-duplicate-attempt-2");
    expect((cleared?.output as { status: string }).status).toBe("ok");

    // The near-duplicate never reached the reviewer, and never shipped.
    const history = await env.store.readJson<Array<{ runId: string; excerpt: string }>>("acme", ["ledger", "output-history", "linkedin-agent"]);
    expect(history?.map((e) => e.excerpt)).toContain(FRESH);
    expect(history?.map((e) => e.excerpt)).not.toContain(NEAR_DUPLICATE);
  }, 60000);
});
