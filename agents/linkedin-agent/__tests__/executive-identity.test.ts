import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createLinkedInAgentWorkflow } from "../src/workflow/create-linkedin-agent-workflow.js";
import { fakeRouterSequence, finalTurn, makePromptStore, setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

const baseParams = { clientSlug: "acme", productId: "linkedin-agent", runKind: "recurring" as const };

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

/** Pulls the `input` object the draft agent's first turn actually saw, out of the fake router's captured call. */
function draftInputFromCall(router: ReturnType<typeof fakeRouterSequence>): Record<string, unknown> {
  const completeSpy = router.complete as unknown as ReturnType<typeof vi.fn>;
  expect(completeSpy).toHaveBeenCalled();
  const [prompt] = completeSpy.mock.calls[0] as [string, ...unknown[]];
  const parsed = JSON.parse(prompt) as { input: Record<string, unknown> };
  return parsed.input;
}

describe("identityScope: executive vs. company (legacy 'two-paths' posting identity)", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("identityScope: 'executive' with a configured executive list threads that executive's identity into the draft agent's input", async () => {
    await env.store.writeJson("acme", ["client", "executives"], [
      { name: "Jane Doe", title: "CEO" },
      { name: "John Smith", title: "CTO" },
    ]);
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn(goodDraft())]);
    const workflowFn = createLinkedInAgentWorkflow({
      tools: env.tools,
      promptStore,
      router,
      autoApprove: true,
      identityScope: "executive",
    });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, { ...baseParams, runId: "linkedin_run_exec_default" });

    expect(result.status).toBe("completed");

    const draftInput = draftInputFromCall(router);
    expect(draftInput.identity).toEqual({ scope: "executive", executiveName: "Jane Doe", executiveTitle: "CEO" });
  });

  it("selects the executive matching client config's requestedExecutiveName (case-insensitive), not just the first one", async () => {
    await env.store.writeJson("acme", ["client", "executives"], [
      { name: "Jane Doe", title: "CEO" },
      { name: "John Smith", title: "CTO" },
    ]);
    await env.store.writeJson("acme", ["client", "config"], { requestedExecutiveName: "john smith" });
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn(goodDraft())]);
    const workflowFn = createLinkedInAgentWorkflow({
      tools: env.tools,
      promptStore,
      router,
      autoApprove: true,
      identityScope: "executive",
    });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, { ...baseParams, runId: "linkedin_run_exec_named" });

    expect(result.status).toBe("completed");
    const draftInput = draftInputFromCall(router);
    expect(draftInput.identity).toEqual({ scope: "executive", executiveName: "John Smith", executiveTitle: "CTO" });
  });

  it("a client config requestedIdentityScope: 'executive' overrides the workflow-level 'company' default", async () => {
    await env.store.writeJson("acme", ["client", "executives"], [{ name: "Jane Doe", title: "CEO" }]);
    await env.store.writeJson("acme", ["client", "config"], { requestedIdentityScope: "executive" });
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn(goodDraft())]);
    // Note: no `identityScope` passed at all here -> workflow-level default is "company",
    // but this run's own config asks for "executive", which must win.
    const workflowFn = createLinkedInAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, { ...baseParams, runId: "linkedin_run_exec_config_override" });

    expect(result.status).toBe("completed");
    const draftInput = draftInputFromCall(router);
    expect(draftInput.identity).toEqual({ scope: "executive", executiveName: "Jane Doe", executiveTitle: "CEO" });
  });

  it("identityScope: 'executive' with no executives configured at all resolves to blocked_intake at step 00", async () => {
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn({ text: "unused — should never be reached" })]);
    const workflowFn = createLinkedInAgentWorkflow({
      tools: env.tools,
      promptStore,
      router,
      identityScope: "executive",
    });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, { ...baseParams, runId: "linkedin_run_exec_missing" });

    expect(result.status).toBe("blocked_intake");
    expect(router.complete).not.toHaveBeenCalled();

    const stepRecords = await durableStore.listSteps("linkedin_run_exec_missing");
    expect(stepRecords.map((s) => s.stepId)).toEqual(["00-channel-setup", "00-intake-check"]);
  });

  it("identityScope: 'executive' with an existing-but-empty executive list also resolves to blocked_intake", async () => {
    await env.store.writeJson("acme", ["client", "executives"], []);
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn({ text: "unused — should never be reached" })]);
    const workflowFn = createLinkedInAgentWorkflow({
      tools: env.tools,
      promptStore,
      router,
      identityScope: "executive",
    });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, { ...baseParams, runId: "linkedin_run_exec_empty" });

    expect(result.status).toBe("blocked_intake");
    expect(router.complete).not.toHaveBeenCalled();
  });

  it("identityScope: 'company' (explicit) behaves exactly like the default — completes, draft input carries the company identity", async () => {
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn(goodDraft())]);
    const workflowFn = createLinkedInAgentWorkflow({
      tools: env.tools,
      promptStore,
      router,
      autoApprove: true,
      identityScope: "company",
    });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, { ...baseParams, runId: "linkedin_run_company_explicit" });

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.output.topic).toBeTruthy();

    const draftInput = draftInputFromCall(router);
    expect(draftInput.identity).toEqual({ scope: "company" });
  });

  it("omitting identityScope entirely still defaults to company voice, unchanged from pre-existing behavior", async () => {
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn(goodDraft())]);
    const workflowFn = createLinkedInAgentWorkflow({ tools: env.tools, promptStore, router, autoApprove: true });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, { ...baseParams, runId: "linkedin_run_company_default" });

    expect(result.status).toBe("completed");
    const draftInput = draftInputFromCall(router);
    expect(draftInput.identity).toEqual({ scope: "company" });

    const stepRecords = await durableStore.listSteps("linkedin_run_company_default");
    expect(stepRecords).toHaveLength(27); // AU20 added the verified-dedupe step
  });

  it("threads an executive's full dossier (careerHistory, corePillars, offLimitsTopics, voiceTone) into the draft agent's input, not just name+title", async () => {
    await env.store.writeJson("acme", ["client", "executives"], [
      {
        name: "Jane Doe",
        title: "CEO",
        careerHistory:
          "Ran fulfillment ops at a logistics startup for six years before founding Acme, earning a first-hand view of the messy reality of scaling a warehouse network.",
        corePillars: ["operational scaling", "supply chain resilience", "founder-led hiring"],
        offLimitsTopics: ["macroeconomic forecasting", "public market commentary"],
        voiceTone: "plainspoken operator, dry humor, short sentences",
      },
      { name: "John Smith", title: "CTO" },
    ]);
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn(goodDraft())]);
    const workflowFn = createLinkedInAgentWorkflow({
      tools: env.tools,
      promptStore,
      router,
      autoApprove: true,
      identityScope: "executive",
    });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, { ...baseParams, runId: "linkedin_run_exec_dossier" });

    expect(result.status).toBe("completed");
    const draftInput = draftInputFromCall(router);
    expect(draftInput.identity).toEqual({
      scope: "executive",
      executiveName: "Jane Doe",
      executiveTitle: "CEO",
      careerHistory:
        "Ran fulfillment ops at a logistics startup for six years before founding Acme, earning a first-hand view of the messy reality of scaling a warehouse network.",
      corePillars: ["operational scaling", "supply chain resilience", "founder-led hiring"],
      offLimitsTopics: ["macroeconomic forecasting", "public market commentary"],
      voiceTone: "plainspoken operator, dry humor, short sentences",
    });
  });

  it("an executive configured with only name+title still threads cleanly, with no dossier fields fabricated", async () => {
    await env.store.writeJson("acme", ["client", "executives"], [{ name: "Jane Doe", title: "CEO" }]);
    const promptStore = makePromptStore();
    const router = fakeRouterSequence([finalTurn(goodDraft())]);
    const workflowFn = createLinkedInAgentWorkflow({
      tools: env.tools,
      promptStore,
      router,
      autoApprove: true,
      identityScope: "executive",
    });

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const result = await engine.run(workflowFn, { ...baseParams, runId: "linkedin_run_exec_no_dossier" });

    expect(result.status).toBe("completed");
    const draftInput = draftInputFromCall(router);
    expect(draftInput.identity).toEqual({ scope: "executive", executiveName: "Jane Doe", executiveTitle: "CEO" });
  });
});
