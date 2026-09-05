import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { AgentTool, AgentToolRegistry } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createXAgentWorkflow } from "../src/workflow/create-x-agent-workflow.js";
import { renderXDraftsMarkdown } from "../src/workflow/render-drafts-markdown.js";
import { fakeRouterSequence, finalTurn, makePromptStore, setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

/**
 * The 2026-09 elite-tier upgrade, end to end on the real workflow:
 *
 * - the trend scout takes the slot only where the old code fell back to
 *   "first headline with a number", and only for an on-brand candidate;
 * - the content-mode rotation never repeats the prior mode and steers the lane;
 * - the draft receives the RESEARCH (title/url/excerpt), not a headline;
 * - a thread is one deliverable with checked parts and 1/N markers;
 * - client-attached media is analysed BEFORE drafting and wins the media slot;
 * - the media resolver answers the draft's brief and never holds a run.
 */

const baseParams = { clientSlug: "acme", productId: "x-agent", runKind: "recurring" as const };

function goodPost(overrides: Record<string, unknown> = {}) {
  return {
    text: "Four-day weeks are spreading through mid-sized teams this quarter.",
    mainPostText: "Four-day weeks are spreading through mid-sized teams this quarter.",
    hook: "Four-day weeks are spreading through mid-sized teams this quarter.",
    angle: "trend-observation",
    lane: "knowledge",
    targetHandle: "@acmehq",
    ...overrides,
  };
}

/** A `research.pull` stand-in returning the same documents for every query. */
function stubResearchPull(documents: unknown[]): AgentTool {
  return {
    name: "research.pull",
    version: "1.2.0",
    inputSchema: { parse: (v: unknown) => v } as never,
    async execute(args: unknown) {
      return {
        status: "success",
        result: { runId: "run-1", query: (args as { query: string }).query, fromCache: false, result: { provider: "stub", documents } },
      };
    },
  } as unknown as AgentTool;
}

const DOCS = [
  {
    title: "Acme rival ships four-day-week scheduling for SaaS teams",
    url: "https://example.test/launch",
    publishedAt: "2026-09-04",
    content: "A scheduling vendor launched a four-day-week planner. Early customers report 31% fewer meeting hours.",
  },
  { title: "Celebrity opens a bakery", url: "https://example.test/bakery", publishedAt: "2026-09-04", content: "A famous actor opened a bakery downtown." },
];

function scoutTurn(candidates: unknown[], skipped: unknown[] = []) {
  return finalTurn({ candidates, skipped });
}

const ON_BRAND = {
  topic: "four-day-week scheduling tools for SaaS teams",
  headline: "Acme rival ships four-day-week scheduling for SaaS teams",
  mode: "hot-news",
  brandFit: 5,
  brandFitReason: "Acme sells scheduling software to exactly these teams.",
  angle: "The tooling caught up with the trend; the hard part is still the calendar.",
  hook: "The four-day week just got a scheduler.",
  whyNow: "Launched this week.",
  sourceUrls: ["https://example.test/launch"],
  publishedAt: "2026-09-04",
  hasNumbers: true,
  mediaHint: "screenshot",
};

const OFF_BRAND = { ...ON_BRAND, topic: "a celebrity bakery", headline: "Celebrity opens a bakery", brandFit: 1, brandFitReason: "No connection to B2B SaaS.", sourceUrls: ["https://example.test/bakery"] };

/** The step's checkpointed output, typed loosely. */
async function stepOutput<T>(store: MemoryDurableStepStore, runId: string, stepId: string): Promise<T | undefined> {
  const steps = await store.listSteps(runId);
  return steps.find((s) => s.stepId === stepId)?.output as T | undefined;
}

/** The `input` the fake router saw on its Nth call, parsed out of BaseAgent's turn prompt. */
function draftInputOf(router: ReturnType<typeof fakeRouterSequence>, callIndex: number): Record<string, unknown> {
  const call = (router.complete as unknown as { mock: { calls: unknown[][] } }).mock.calls[callIndex]!;
  const prompt = JSON.parse(call[0] as string) as { input: Record<string, unknown> };
  return prompt.input;
}

describe("x-agent 2026-09 upgrade", () => {
  let env: TestEnvironment;
  beforeEach(async () => {
    env = await setupTestEnvironment();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it("runs the trend scout only when the catalog is empty, and an on-brand candidate takes the slot", async () => {
    // Drain the seeded catalog: no planned topic, no request.
    await env.store.writeJson("acme", ["topics", "catalog"], []);
    const router = fakeRouterSequence([scoutTurn([OFF_BRAND, ON_BRAND]), finalTurn(goodPost({ lane: "news-reaction", angle: ON_BRAND.angle }))]);
    const store = new MemoryDurableStepStore();
    const workflowFn = createXAgentWorkflow({ tools: { ...env.tools, "research.pull": stubResearchPull(DOCS) }, promptStore: makePromptStore(), router, autoApprove: true });

    const result = await new WorkflowEngine(store).run(workflowFn, { ...baseParams, runId: "x_scout_1" });
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");

    const ids = (await store.listSteps("x_scout_1")).map((s) => s.stepId);
    expect(ids).toContain("07a-trend-scout");
    const selected = await stepOutput<{ source: string; topic: string; trend?: { brandFit: number } }>(store, "x_scout_1", "07-select-candidate");
    expect(selected?.source).toBe("trend");
    expect(selected?.topic).toBe(ON_BRAND.topic);
    expect(selected?.trend?.brandFit).toBe(5);
    expect(result.output.topic).toBe(ON_BRAND.topic);

    // The scout saw the research and the client's own context.
    const scoutInput = draftInputOf(router, 0);
    expect(scoutInput["channel"]).toBe("x");
    expect(Array.isArray(scoutInput["research"])).toBe(true);
    expect((scoutInput["research"] as unknown[]).length).toBe(2);

    // The draft received the research digest, the trend candidate and the mode — not a bare headline.
    const draftInput = draftInputOf(router, 1);
    expect(draftInput["contentMode"]).toBeDefined();
    expect((draftInput["trendCandidate"] as { brandFitReason: string }).brandFitReason).toBe(ON_BRAND.brandFitReason);
    const research = draftInput["research"] as Array<{ url: string; excerpt: string }>;
    expect(research.map((r) => r.url)).toContain("https://example.test/launch");
    expect(research[0]!.excerpt.length).toBeGreaterThan(0);
  });

  it("never forces an off-brand trend: below the brand-fit floor it falls back to the research candidate", async () => {
    await env.store.writeJson("acme", ["topics", "catalog"], []);
    const router = fakeRouterSequence([scoutTurn([OFF_BRAND], [{ headline: "Celebrity opens a bakery", reason: "no connection" }]), finalTurn(goodPost())]);
    const store = new MemoryDurableStepStore();
    const workflowFn = createXAgentWorkflow({ tools: { ...env.tools, "research.pull": stubResearchPull(DOCS) }, promptStore: makePromptStore(), router, autoApprove: true });

    const result = await new WorkflowEngine(store).run(workflowFn, { ...baseParams, runId: "x_scout_2" });
    expect(result.status).toBe("completed");
    const selected = await stepOutput<{ source: string }>(store, "x_scout_2", "07-select-candidate");
    expect(selected?.source).toBe("research");
  });

  it("does not run the scout when the catalog planned this run's topic (one model call, as before)", async () => {
    const router = fakeRouterSequence([finalTurn(goodPost())]);
    const store = new MemoryDurableStepStore();
    const workflowFn = createXAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router, autoApprove: true });
    const result = await new WorkflowEngine(store).run(workflowFn, { ...baseParams, runId: "x_scout_3" });
    expect(result.status).toBe("completed");
    expect(router.complete).toHaveBeenCalledTimes(1);
    const ids = (await store.listSteps("x_scout_3")).map((s) => s.stepId);
    expect(ids).not.toContain("07a-trend-scout");
    const selected = await stepOutput<{ source: string }>(store, "x_scout_3", "07-select-candidate");
    expect(selected?.source).toBe("reserved");
  });

  it("rotates the content mode: never the prior run's mode, and the lane follows the mode", async () => {
    await env.store.writeJson("acme", ["memory", "products", "x-agent", "decisions", "prior"], {
      decisionId: "prior",
      summary: 'Posted about "x" (lane: knowledge, angle: data-point, mode: deep-value)',
      at: Date.now() - 1000,
    });
    const router = fakeRouterSequence([finalTurn(goodPost({ lane: "news-reaction" }))]);
    const store = new MemoryDurableStepStore();
    const workflowFn = createXAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router, autoApprove: true });
    const result = await new WorkflowEngine(store).run(workflowFn, { ...baseParams, runId: "x_mode_1" });
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.output.contentMode).not.toBe("deep-value");
    // hot-news outweighs open-discussion at equal (zero) usage.
    expect(result.output.contentMode).toBe("hot-news");
    expect(["news-reaction", "quote-comment"]).toContain(result.output.lane);
    // And the decision written back carries the mode for the NEXT run.
    const decisions = await env.store.listJson<{ summary: string }>("acme", ["memory", "products", "x-agent", "decisions"]);
    expect(decisions.some((d) => d.data.summary.includes("mode: hot-news"))).toBe(true);
  });

  it("honours an explicit requestedMode on the run input", async () => {
    const router = fakeRouterSequence([finalTurn(goodPost({ lane: "pov" }))]);
    const store = new MemoryDurableStepStore();
    const workflowFn = createXAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router, autoApprove: true });
    const result = await new WorkflowEngine(store).run(workflowFn, { ...baseParams, runId: "x_mode_2", input: { requestedMode: "open-discussion" } });
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.output.contentMode).toBe("open-discussion");
  });

  it("ships a thread as one deliverable: every part checked, 1/N markers rendered, the whole thread recorded", async () => {
    const thread = ["Part two carries the mechanism: the calendar, not the headcount, is what moves.", "Part three lands it: pilot the schedule before the policy."];
    const router = fakeRouterSequence([finalTurn(goodPost({ thread }))]);
    const store = new MemoryDurableStepStore();
    const workflowFn = createXAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router, autoApprove: true });
    const result = await new WorkflowEngine(store).run(workflowFn, { ...baseParams, runId: "x_thread_1" });
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.output.parts).toBe(3);
    const ids = (await store.listSteps("x_thread_1")).map((s) => s.stepId);
    expect(ids).toContain("13b-verify-thread");

    const deliverables = await env.store.listJson<{ deliverable: { draftsMarkdown: string; thread: string[] } }>("acme", ["ledger", "deliverables", "x_thread_1", "_"]);
    const md = deliverables[0]!.data.deliverable.draftsMarkdown;
    expect(md).toContain("**1/3**");
    expect(md).toContain("**3/3**");
    expect(md).toContain(`> ${thread[1]}`);
    expect(deliverables[0]!.data.deliverable.thread).toEqual(thread);
  });

  it("holds a thread whose part exceeds the X limit, before review", async () => {
    const router = fakeRouterSequence([finalTurn(goodPost({ thread: ["x".repeat(300)] }))]);
    const store = new MemoryDurableStepStore();
    const workflowFn = createXAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router });
    const result = await new WorkflowEngine(store).run(workflowFn, { ...baseParams, runId: "x_thread_2" });
    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/thread part 2 exceeds/);
  });

  it("holds a thread for an account whose charter forbids threads (xAllowThreads: false)", async () => {
    await env.store.writeJson("acme", ["client", "config"], { xHandle: "@acmehq", xAllowThreads: false });
    const router = fakeRouterSequence([finalTurn(goodPost({ thread: ["A second part."] }))]);
    const store = new MemoryDurableStepStore();
    const workflowFn = createXAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router });
    const result = await new WorkflowEngine(store).run(workflowFn, { ...baseParams, runId: "x_thread_3" });
    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/does not publish threads/);
  });

  it("a single post keeps the marker-free DRAFTS.md shape byte for byte", () => {
    const draft = { ...goodPost(), mediaRefs: [], thread: [] } as never;
    const md = renderXDraftsMarkdown({ targetHandle: "@acmehq", lane: "knowledge", angle: "trend-observation", draft });
    expect(md).not.toContain("**1/");
    expect(md).toContain("# Account 1 · @acmehq");
    expect(md).toContain("## Avenue 1 · Knowledge");
  });

  it("with no media tools and no brief, the media step records `none` and the post ships as text", async () => {
    const router = fakeRouterSequence([finalTurn(goodPost())]);
    const store = new MemoryDurableStepStore();
    const workflowFn = createXAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router, autoApprove: true });
    const result = await new WorkflowEngine(store).run(workflowFn, { ...baseParams, runId: "x_media_0" });
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.output.mediaStatus).toBe("none");
    const plan = await stepOutput<{ status: string; attempts: string[] }>(store, "x_media_0", "14e-resolve-media");
    expect(plan?.status).toBe("none");
  });

  it("answers a screenshot brief with the cited page, vision-checked, staged to a URL the portal can fetch", async () => {
    const repoRoot = path.join(env.rootDir, "repo");
    await fs.mkdir(path.join(repoRoot, ".media-cache", "x_media_1"), { recursive: true });
    await fs.writeFile(path.join(repoRoot, ".media-cache", "x_media_1", "screenshot-abc.png"), Buffer.from("png"));
    const calls: string[] = [];
    const fakeTool = (name: string, result: unknown): AgentTool =>
      ({
        name,
        version: "1.0.0",
        inspectionSchema: undefined,
        inputSchema: { parse: (v: unknown) => v } as never,
        async execute() {
          calls.push(name);
          return { status: "success", result };
        },
      }) as unknown as AgentTool;
    const media: AgentToolRegistry = {
      "media.screenshotPage": fakeTool("media.screenshotPage", {
        candidate: { path: ".media-cache/x_media_1/screenshot-abc.png", description: "screenshot of the launch page", provider: "screenshot", licenseConfidence: "unknown", sourceUrl: "https://example.test/launch" },
      }),
      "media.inspectImages": fakeTool("media.inspectImages", {
        inspections: [{ ref: "screenshot-1", description: "the article headline and a chart", subjects: ["headline"], textInImage: ["31% fewer meeting hours"], mood: "clinical", hasPeople: false, looksLikeScreenshot: true, hasWatermark: false, looksAiGenerated: false, quality: "usable", qualityReason: "legible", fitsBrief: true, fitScore: 5, fitReason: "the cited page" }],
        unreadable: [],
        model: "gemini-2.5-flash",
      }),
      "media.stageAsset": fakeTool("media.stageAsset", { url: "https://storage.example/signed.png", gcsUri: "gs://bucket/agent-engine/x_media_1/screenshot-abc.png", contentType: "image/png", bytes: 3 }),
    };
    const router = fakeRouterSequence([
      finalTurn(goodPost({ mediaBrief: { needsVisual: true, kind: "screenshot", sourceUrl: "https://example.test/launch", rationale: "the launch page is the story" } })),
    ]);
    const store = new MemoryDurableStepStore();
    const workflowFn = createXAgentWorkflow({
      tools: { ...env.tools, ...media, "research.pull": stubResearchPull(DOCS) },
      promptStore: makePromptStore(),
      router,
      autoApprove: true,
      repoRoot,
    });
    const result = await new WorkflowEngine(store).run(workflowFn, { ...baseParams, runId: "x_media_1" });
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.output.mediaStatus).toBe("screenshot");
    expect(calls).toEqual(["media.screenshotPage", "media.inspectImages", "media.stageAsset"]);

    const deliverables = await env.store.listJson<{ deliverable: { mediaRefs: string[]; media: { url: string; requiresCredit: boolean; creditUrl: string }; draftsMarkdown: string } }>(
      "acme",
      ["ledger", "deliverables", "x_media_1", "_"],
    );
    const d = deliverables[0]!.data.deliverable;
    expect(d.mediaRefs).toEqual(["https://storage.example/signed.png"]);
    expect(d.media.requiresCredit).toBe(true);
    expect(d.media.creditUrl).toBe("https://example.test/launch");
    expect(d.draftsMarkdown).toContain("**Media:** https://storage.example/signed.png");
  });

  it("analyses client-attached media BEFORE drafting, hands the description to the writer, and attaches that image", async () => {
    const repoRoot = path.join(env.rootDir, "repo");
    await fs.mkdir(path.join(repoRoot, ".media-cache", "x_media_2"), { recursive: true });
    await fs.writeFile(path.join(repoRoot, ".media-cache", "x_media_2", "n1-client0.png"), Buffer.from("png"));
    const fakeTool = (name: string, result: unknown): AgentTool =>
      ({ name, version: "1.0.0", inputSchema: { parse: (v: unknown) => v } as never, async execute() { return { status: "success", result }; } }) as unknown as AgentTool;
    const media: AgentToolRegistry = {
      "media.ingestAssets": fakeTool("media.ingestAssets", { candidates: [{ path: ".media-cache/x_media_2/n1-client0.png", description: "client upload" }], unmet: [] }),
      "media.inspectImages": fakeTool("media.inspectImages", {
        inspections: [{ ref: "attached-1", description: "a whiteboard covered in a four-day rota", subjects: ["whiteboard", "calendar"], textInImage: ["Mon-Thu"], mood: "busy", hasPeople: false, looksLikeScreenshot: false, hasWatermark: false, looksAiGenerated: false, quality: "usable", qualityReason: "sharp", suggestedAngle: "open on the rota itself" }],
        unreadable: [],
        model: "gemini-2.5-flash",
      }),
    };
    const router = fakeRouterSequence([finalTurn(goodPost())]);
    const store = new MemoryDurableStepStore();
    const workflowFn = createXAgentWorkflow({ tools: { ...env.tools, ...media }, promptStore: makePromptStore(), router, autoApprove: true, repoRoot });
    const result = await new WorkflowEngine(store).run(workflowFn, {
      ...baseParams,
      runId: "x_media_2",
      input: { mediaAssets: [{ uri: "https://uploads.example/rota.png", role: "source", label: "our rota" }] },
    });
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.output.mediaStatus).toBe("attached");
    const ids = (await store.listSteps("x_media_2")).map((s) => s.stepId);
    expect(ids).toContain("09b-analyze-attached-media");
    const draftInput = draftInputOf(router, 0);
    const attached = draftInput["attachedMedia"] as Array<{ description: string; suggestedAngle: string; label: string }>;
    expect(attached[0]!.description).toBe("a whiteboard covered in a four-day rota");
    expect(attached[0]!.suggestedAngle).toBe("open on the rota itself");
    expect(attached[0]!.label).toBe("our rota");
  });
});
