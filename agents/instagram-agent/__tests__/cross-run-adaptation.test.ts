import { describe, expect, it, afterEach, beforeEach } from "vitest";
import type { AgentContext, AgentToolRegistry } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { MemoryTemplateStore, TemplateDefinitionSchema } from "@agent-engine/tool-karos-templates";
import { createInstagramAgentWorkflow } from "../src/workflow/create-instagram-agent-workflow.js";
import {
  fakeRenderCarousel,
  fakeRouterSequence,
  finalTurn,
  goodCopyOutput,
  goodImageCandidatePool,
  goodImageVettingOutput,
  goodResearchOutput,
  goodVisualQaOutput,
  makePromptStore,
  setupTestEnvironment,
  type TestEnvironment,
} from "./test-helpers.js";
import fsp from "node:fs/promises";
import pathMod from "node:path";

/**
 * IGSTYLE-5 — cross-run adaptation: the memory a run WRITES is the memory
 * the NEXT run READS.
 *
 * IGSTYLE-3 made a revision's own directive reach its own render (Layer 2,
 * in-run, binding). IGSTYLE-4 gave the distillation math its own pure,
 * unit-tested home. Neither, on its own, changes what a FRESH run drafts —
 * that only happens once `02h` actually calls `memory.readFeedback` +
 * `distillStylePreferences`, and once the three writers this ticket touches
 * (`persistReviewFeedback`'s round-decision row, the per-slide template
 * critique row, and the edit-deltas row) actually persist a STRUCTURED style
 * pick rather than only a prose note. This file is the wiring's own proof.
 */

const base = { clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

const PLAIN_BRAND = {
  name: "Plain Co",
  colors: { neutralDark: "#17181C", neutralLight: "#F2F2F2" },
  visualStyle: "Dark Mode",
};

function tools(env: TestEnvironment, extra: Record<string, unknown> = {}): AgentToolRegistry {
  return {
    ...env.tools,
    "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!),
    ...extra,
  } as AgentToolRegistry;
}

function draftTurns(copyOutput: ReturnType<typeof goodCopyOutput>) {
  return [finalTurn(copyOutput), finalTurn(goodImageVettingOutput()), finalTurn(goodVisualQaOutput())];
}

describe("cross-run adaptation (IGSTYLE-5)", () => {
  let env: TestEnvironment;
  beforeEach(async () => {
    // More than the default 6 seed topics: this file's flywheel test runs
    // TWO full workflows (run A, then run B) against the SAME topics
    // catalog, and `topics.reserve`'s own cadence floor (Fix 1: never leave
    // a lane below 5 unused rows) would otherwise hold run B for an entirely
    // unrelated reason.
    env = await setupTestEnvironment({
      seedTopics: [
        "5 automation wins from this quarter",
        "how our team cut onboarding time in half",
        "a behind-the-scenes look at our design process",
        "customer story: scaling from 10 to 100 clients",
        "the tool stack we switched to this year",
        "lessons from our biggest product launch",
        "why we rebuilt our onboarding flow",
        "a year of shipping in public",
        "the metric we stopped chasing",
        "what our support queue taught us",
      ],
    });
  });
  afterEach(async () => {
    await env.cleanup();
  });

  function workflowFn(router: ReturnType<typeof fakeRouterSequence>, extraTools: Record<string, unknown> = {}) {
    return createInstagramAgentWorkflow({
      tools: tools(env, extraTools),
      promptStore: makePromptStore(),
      router,
      repoRoot: env.repoRoot,
      imageCandidatePool: goodImageCandidatePool(),
    });
  }

  it("flywheel: run B's revision-0 render reflects run A's approved direction, with no human input", async () => {
    await env.store.writeJson("acme", ["client", "brand"], PLAIN_BRAND);
    const copy = goodCopyOutput();
    // Run B's own draft, deliberately DIFFERENT prose from run A's — the two
    // runs share `env.store`, so `04e-read-output-history`'s dedupe check
    // (correctly) sees run A's already-delivered post and would otherwise
    // hold run B for looking identical, which has nothing to do with what
    // this test is actually proving.
    const DIFFERENT_BODIES = [
      "We shipped a brand-new pricing page and signups doubled in a week.",
      "Support tickets dropped after we rewrote the error messages from scratch.",
      "A customer told us this was the smoothest rollout they'd ever seen.",
      "The engineering team paired up and cut deploy time by half.",
      "We retired three legacy tools and nobody missed them.",
      "A single config change fixed a bug that had lingered for a year.",
    ];
    const copyForRunB = {
      format: "carousel" as const,
      caption: "None of this happened last quarter — a completely fresh set of updates.",
      // `sourceRef` stays the ORIGINAL research fact's claim, verbatim — the
      // terminal self-check requires every slide's `sourceRef` to match a
      // real research fact exactly, and both runs share the same research
      // output. Only the reader-facing prose (`headline`/`body`) differs.
      slides: copy.slides.map((s, i) => ({ ...s, headline: `Spotlight ${i + 1}`, body: DIFFERENT_BODIES[i]! })),
    };

    // ── Run A: revise (a STRUCTURED `edits.style` pick — Tier 0), then
    // approve. Rule 4 (IGSTYLE-4): "structured contributes 1.0 × recency...
    // one deliberate pick suffices; one parsed sentence does not." Only the
    // APPROVE round ever carries a resolved style directive as durable
    // evidence — the revise round's own draft precedes the feedback it is
    // busy submitting, so it resolves to nothing yet (this mirrors
    // IGSTYLE-3's own "revision 0 resolves to `{}` unconditionally"
    // invariant: a round's directive is always built from notes ALREADY
    // accumulated, never the note it is itself supplying). One structured
    // pick, recorded on the approve that follows it, is exactly enough —
    // this is "one deliberate pick suffices" in its simplest possible shape.
    const routerA = fakeRouterSequence([finalTurn(goodResearchOutput()), ...draftTurns(copy), ...draftTurns(copy)]);
    const durableStoreA = new MemoryDurableStepStore();
    const engineA = new WorkflowEngine(durableStoreA);
    const runIdA = "igstyle5_flywheel_run_a";

    const a0 = await engineA.run(workflowFn(routerA), { ...base, runId: runIdA });
    expect(a0.status).toBe("awaiting_gate");

    await engineA.resolveGate(runIdA, "09a-batch-review-r0", {
      decision: "revise",
      actor: "jane@karoslabs.com",
      feedback: "make the background darker and the text a warm accent",
      // A proven-safe pair (IGSTYLE-3's own "re-derives with the merged
      // overrides..." test uses this exact combo) — a real reviewer using
      // the (not-yet-built, IGSTYLE-6) portal colour controls.
      edits: { style: { ground: "#000000", fg: "#eeeeee" } },
      at: new Date().toISOString(),
    });
    const a1 = await engineA.run(workflowFn(routerA), { ...base, runId: runIdA });
    expect(a1.status).toBe("awaiting_gate");

    await engineA.resolveGate(runIdA, "09a-batch-review-r1", {
      decision: "approve",
      actor: "jane@karoslabs.com",
      at: new Date().toISOString(),
    });
    const aFinal = await engineA.run(workflowFn(routerA), { ...base, runId: runIdA });
    expect(aFinal.status).toBe("completed");

    // ── Run B: a FRESH workflow/run id, same clientSlug+productId, SHARED
    // `env.store` — no gate resolved yet, so revision 0 has had zero human
    // input this run.
    const routerB = fakeRouterSequence([finalTurn(goodResearchOutput()), ...draftTurns(copyForRunB)]);
    const durableStoreB = new MemoryDurableStepStore();
    const engineB = new WorkflowEngine(durableStoreB);
    const runIdB = "igstyle5_flywheel_run_b";

    const b0 = await engineB.run(workflowFn(routerB), { ...base, runId: runIdB });
    expect(b0.status).toBe("awaiting_gate");

    const round0Html = await fsp.readFile(pathMod.join(env.repoRoot, ".template-cache", runIdB, "slide.html"), "utf8");
    // Different from the plain baseline — the learned prior, not a directive
    // (revision 0 had no `feedback`/`edits.style` of its own this run).
    expect(round0Html).not.toContain("--bg: #17181C;");
    expect(round0Html).not.toContain("--fg: #F2F2F2;");
    expect(round0Html).toContain("--fg: #eeeeee;");

    // 02h itself actually distilled something, rather than the inert `{}`.
    const learnedStep = (await durableStoreB.listSteps(runIdB)).find((s) => s.stepId === "02h-learned-style-preferences");
    const learned = learnedStep?.output as { overrides: Record<string, string>; evidence: string[] };
    expect(learned.overrides.fg).toBe("#eeeeee");
    expect(learned.overrides.ground).toBe("#000000");
    expect(learned.evidence.length).toBeGreaterThan(0);

    // Run B's gate payload carries the evidence lines (the spec's own
    // acceptance line, verbatim).
    const gateB = await durableStoreB.getGate(`${runIdB}__09a-batch-review-r0`);
    const payloadB = gateB?.payload as { learnedStylePreferences?: { evidence: string[]; overrides: Record<string, string> } };
    expect(payloadB.learnedStylePreferences?.evidence.length).toBeGreaterThan(0);
    expect(payloadB.learnedStylePreferences?.overrides.fg).toBe("#eeeeee");
  }, 90000);

  it("a different clientSlug on the same store is unaffected (explicit isolation assert)", async () => {
    await env.store.writeJson("acme", ["client", "brand"], PLAIN_BRAND);
    // Seed a durable style row directly (cheaper than running a full
    // workflow) — the isolation this asserts is `memory.readFeedback`'s own
    // per-clientSlug scoping, not anything about how the row was produced.
    const append = env.tools["memory.appendFeedback"]!;
    const ctxAcme: AgentContext = { runId: "seed", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring", metadata: {} };
    await append.execute(
      {
        feedbackId: "seed-acme-style",
        productId: "instagram-agent",
        decision: "approve",
        actor: "jane@karoslabs.com",
        note: "darker background, orange text",
        revision: 0,
        style: { overrides: { fg: "#FFA500" }, source: "structured", intents: [], applied: [] },
      },
      { ctx: ctxAcme },
    );

    const read = env.tools["memory.readFeedback"]!;
    const otherSlugCtx: AgentContext = { runId: "probe", clientSlug: "not-acme", productId: "instagram-agent", runKind: "recurring", metadata: {} };
    const outcome = await read.execute({ productId: "instagram-agent", limit: 50 }, { ctx: otherSlugCtx });
    expect(outcome.status).toBe("success");
    expect((outcome as { result: { entries: unknown[] } }).result.entries).toEqual([]);
  });

  it("a different productId on the same clientSlug is unaffected", async () => {
    const append = env.tools["memory.appendFeedback"]!;
    const ctx: AgentContext = { runId: "seed", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring", metadata: {} };
    await append.execute(
      {
        feedbackId: "seed-acme-style-2",
        productId: "instagram-agent",
        decision: "approve",
        actor: "jane@karoslabs.com",
        note: "darker background, orange text",
        revision: 0,
        style: { overrides: { fg: "#FFA500" }, source: "structured", intents: [], applied: [] },
      },
      { ctx },
    );

    const read = env.tools["memory.readFeedback"]!;
    const outcome = await read.execute({ productId: "some-other-product", limit: 50 }, { ctx });
    expect(outcome.status).toBe("success");
    expect((outcome as { result: { entries: unknown[] } }).result.entries).toEqual([]);
  });

  it("memory.readFeedback absent ⇒ the run drafts exactly as today (02h stays inert, revision 0 unconditional)", async () => {
    await env.store.writeJson("acme", ["client", "brand"], PLAIN_BRAND);
    const copy = goodCopyOutput();
    const router = fakeRouterSequence([finalTurn(goodResearchOutput()), ...draftTurns(copy)]);

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const runId = "igstyle5_no_memory_tool";

    const r0 = await engine.run(workflowFn(router, { "memory.readFeedback": undefined }), {
      ...base,
      runId,
    });
    expect(r0.status).toBe("awaiting_gate");

    const learnedStep = (await durableStore.listSteps(runId)).find((s) => s.stepId === "02h-learned-style-preferences");
    expect(learnedStep?.output).toEqual({ overrides: {}, strength: {}, intents: [], evidence: [] });

    const directiveStep = (await durableStore.listSteps(runId)).find((s) => s.stepId === "04g-style-directive");
    expect(directiveStep?.output).toEqual({ overrides: {}, applied: [], intents: [], refusals: [], source: "none" });
  }, 60000);

  it("template critique produces a durable memory row (scope: \"template\") in addition to the registry write, which is not replaced", async () => {
    const store = new MemoryTemplateStore([
      TemplateDefinitionSchema.parse({
        id: "ai:quote:1",
        archetypeId: "quote_card",
        name: "Experimental quote card",
        layoutType: "typographic",
        htmlTemplate: "<html><head></head><body>{{quoteText}}{{attribution}}</body></html>",
        source: "ai_generated",
        qualityScore: 40,
      }),
    ]);

    const first = goodCopyOutput();
    const copy = {
      ...first,
      slides: first.slides.map((s) =>
        s.n === 2 ? { ...s, layout: "quote_card" as const, quote: { text: "Ship it.", attribution: "A lead" } } : s,
      ),
    };
    const pool = goodImageCandidatePool();
    const photoNs = first.slides.filter((s) => s.n !== 2).map((s) => s.n);
    const vetting = {
      selections: photoNs.map((n) => ({
        n,
        imagePath: pool[0]!.path,
        reason: "matches",
        license: "CC0",
        rightsUsable: true,
        watermarkFree: true,
      })),
    };
    const router = fakeRouterSequence([finalTurn(goodResearchOutput()), finalTurn(copy), finalTurn(vetting), finalTurn(goodVisualQaOutput())]);

    const workflowFnWithTemplates = createInstagramAgentWorkflow({
      tools: tools(env),
      promptStore: makePromptStore(),
      router,
      repoRoot: env.repoRoot,
      imageCandidatePool: pool,
      templateStore: store,
    });
    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const runId = "igstyle5_template_feedback_durable_row";

    const r0 = await engine.run(workflowFnWithTemplates, { ...base, runId });
    expect(r0.status).toBe("awaiting_gate");

    await engine.resolveGate(runId, "09a-batch-review-r0", {
      decision: "approve",
      actor: "jane@karoslabs.com",
      templateFeedback: [
        { slide: 2, templateId: "ai:quote:1", verdict: "approved", note: "the tighter mark reads better at feed size", promote: true },
      ],
      at: new Date().toISOString(),
    });
    const final = await engine.run(workflowFnWithTemplates, { ...base, runId });
    expect(final.status).toBe("completed");

    // The registry write still happened — this ticket adds a row, it never
    // replaces this one.
    const updated = await store.get("ai:quote:1");
    expect(updated!.qualityScore).toBe(45);

    // AND a durable `memory.appendFeedback` row exists for this same
    // critique, scoped "template" so it never mixes into ordinary
    // post-level distillation.
    const read = env.tools["memory.readFeedback"]!;
    const outcome = await read.execute({ productId: "instagram-agent", limit: 50 }, { ctx: { runId: "probe", ...base, metadata: {} } });
    expect(outcome.status).toBe("success");
    const entries = (outcome as { result: { entries: Array<{ feedbackId: string; scope?: string; slide?: number; note: string }> } }).result
      .entries;
    const templateRow = entries.find((e) => e.feedbackId === `${runId}-r0-s2-tpl`);
    expect(templateRow).toBeDefined();
    expect(templateRow?.scope).toBe("template");
    expect(templateRow?.slide).toBe(2);
    expect(templateRow?.note).toBe("the tighter mark reads better at feed size");
  }, 60000);
});
