import { describe, expect, it } from "vitest";
import type { AgentContext, AgentTool, AgentToolRegistry } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "../src/index.js";
import {
  buildTrendQueries,
  mergeResearchPulls,
  parseContentModeFromSummary,
  resolveSocialMedia,
  analyzeAttachedMedia,
  selectContentMode,
  selectTrendCandidate,
  type TrendCandidate,
  type ResearchPullResult,
} from "../src/index.js";

/**
 * The shared social primitives (2026-09): trend queries, the merged pull, the
 * content-mode rotation, brand-fit selection, and the media resolver's tier
 * order. The agents' own suites prove these are wired; this file proves the
 * rules themselves.
 */

const pull = (query: string, documents: unknown[]): ResearchPullResult =>
  ({ runId: `r-${query}`, query, fromCache: false, result: { provider: "stub", documents } }) as ResearchPullResult;

describe("buildTrendQueries", () => {
  it("asks the strategist's questions, most specific first, de-duplicated and capped", () => {
    const queries = buildTrendQueries({
      industry: "B2B SaaS",
      companyName: "Acme",
      configuredQueries: ["OpenAI new model", "Israeli startup exit", "openai new model"],
      requestedTopic: "four-day weeks",
    });
    expect(queries[0]).toBe("four-day weeks");
    expect(queries).toContain("OpenAI new model");
    expect(queries).not.toContain("openai new model");
    expect(queries).toHaveLength(4);
  });

  it("falls back to the industry defaults, and to nothing when there is nothing to ask about", () => {
    expect(buildTrendQueries({ industry: "fintech" })).toEqual(["fintech news this week", "fintech launch announcement funding acquisition report"]);
    expect(buildTrendQueries({})).toEqual([]);
  });
});

describe("mergeResearchPulls", () => {
  it("de-duplicates documents by URL, keeps the first query as the fallback topic, and unions prior topics", () => {
    const merged = mergeResearchPulls([
      pull("a", [{ title: "One", url: "https://x/1", content: "c" }, { title: "Two", url: "https://x/2" }]),
      pull("b", [{ title: "One again", url: "https://X/1" }, { title: "Three", url: "https://x/3" }]),
    ]);
    expect(merged.query).toBe("a");
    expect(merged.result?.documents?.map((d) => d.title)).toEqual(["One", "Two", "Three"]);
  });
});

describe("selectContentMode", () => {
  it("never repeats the prior mode, prefers the least used, breaks ties by weight, and honours a request", () => {
    expect(selectContentMode([])).toBe("deep-value");
    expect(selectContentMode(["deep-value"])).toBe("hot-news");
    expect(selectContentMode(["deep-value", "hot-news"])).toBe("open-discussion");
    expect(selectContentMode(["deep-value", "hot-news", "open-discussion"])).toBe("deep-value");
    expect(selectContentMode(["deep-value"], "deep-value")).toBe("deep-value");
    expect(selectContentMode(["deep-value"], "not-a-mode")).toBe("hot-news");
  });

  it("parses the mode back out of a decision summary wherever it sits in the parenthesis", () => {
    expect(parseContentModeFromSummary('Posted about "x" (lane: knowledge, angle: data-point, mode: hot-news)')).toBe("hot-news");
    expect(parseContentModeFromSummary('Posted about "x" (archetype: teardown-framework)')).toBeUndefined();
  });
});

describe("selectTrendCandidate", () => {
  const candidate = (over: Partial<TrendCandidate>): TrendCandidate => ({
    topic: "t",
    headline: "h",
    mode: "deep-value",
    brandFit: 4,
    brandFitReason: "r",
    angle: "a",
    hook: "k",
    whyNow: "w",
    sourceUrls: [],
    hasNumbers: false,
    mediaHint: "none",
    ...over,
  });

  it("refuses everything below the brand-fit floor, prefers the requested mode, then fit, then numbers", () => {
    expect(selectTrendCandidate([candidate({ brandFit: 2 }), candidate({ brandFit: 1 })], "hot-news")).toBeUndefined();
    const picked = selectTrendCandidate(
      [
        candidate({ topic: "deep-5", mode: "deep-value", brandFit: 5 }),
        candidate({ topic: "hot-3", mode: "hot-news", brandFit: 3 }),
        candidate({ topic: "hot-4-numbers", mode: "hot-news", brandFit: 4, hasNumbers: true }),
        candidate({ topic: "hot-4", mode: "hot-news", brandFit: 4 }),
      ],
      "hot-news",
    );
    expect(picked?.topic).toBe("hot-4-numbers");
    // No candidate in the requested mode: the rotation is a steer, not a wall.
    expect(selectTrendCandidate([candidate({ topic: "deep-5", brandFit: 5 })], "hot-news")?.topic).toBe("deep-5");
  });

  it("skips a candidate that overlaps a subject already covered", () => {
    const picked = selectTrendCandidate([candidate({ topic: "four-day weeks", brandFit: 5 }), candidate({ topic: "onboarding", brandFit: 4 })], "deep-value", {
      avoidTopics: ['Posted about "four-day weeks" (lane: knowledge)'],
    });
    expect(picked?.topic).toBe("onboarding");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The media resolver's tier order, driven with fake tools
// ─────────────────────────────────────────────────────────────────────────────

const ctx: AgentContext = { runId: "run_1", clientSlug: "acme", productId: "x-agent", runKind: "recurring", metadata: {} };

function fakeTool(name: string, calls: string[], result: unknown | ((args: unknown) => unknown)): AgentTool {
  return {
    name,
    version: "1.0.0",
    inputSchema: { parse: (v: unknown) => v } as never,
    async execute(args: unknown) {
      calls.push(name);
      const r = typeof result === "function" ? (result as (a: unknown) => unknown)(args) : result;
      return r as never;
    },
  } as unknown as AgentTool;
}

const ok = (result: unknown) => ({ status: "success", result });
const inspection = (ref: string, over: Record<string, unknown> = {}) => ({
  ref,
  description: "d",
  subjects: [],
  textInImage: [],
  mood: "",
  hasPeople: false,
  looksLikeScreenshot: false,
  hasWatermark: false,
  looksAiGenerated: false,
  quality: "usable",
  qualityReason: "",
  fitsBrief: true,
  fitScore: 4,
  fitReason: "fits",
  ...over,
});

async function runResolver(tools: AgentToolRegistry, brief: unknown, attached?: unknown) {
  const store = new MemoryDurableStepStore();
  const engine = new WorkflowEngine(store);
  const result = await engine.run(
    async (wf) =>
      resolveSocialMedia(wf, tools, ctx, {
        stepId: "media",
        repoRoot: "/repo",
        platform: "x",
        brief: brief as never,
        attached: attached as never,
        sources: [{ url: "https://example.test/a", title: "A" }],
        postText: "the post",
      }),
    { runId: "run_1", clientSlug: "acme", productId: "x-agent", runKind: "recurring" },
  );
  if (result.status !== "completed") throw new Error(`unexpected ${result.status}`);
  return result.output as { status: string; asset?: { path: string; url?: string; requiresCredit: boolean }; attempts: string[] };
}

describe("resolveSocialMedia", () => {
  it("ships text when the draft asked for no visual, calling no media tool at all", async () => {
    const calls: string[] = [];
    const tools: AgentToolRegistry = { "media.findImages": fakeTool("media.findImages", calls, ok({ candidates: [] })) };
    const plan = await runResolver(tools, { needsVisual: false, kind: "none", rationale: "a take reads better bare" });
    expect(plan.status).toBe("none");
    expect(calls).toEqual([]);
  });

  it("walks screenshot → article → stock → generation, stopping at the first tier vision accepts, and never generates first", async () => {
    const calls: string[] = [];
    const tools: AgentToolRegistry = {
      "media.screenshotPage": fakeTool("media.screenshotPage", calls, { status: "content_fail", reason: "cookie wall" }),
      "media.harvestArticleImages": fakeTool("media.harvestArticleImages", calls, ok({ candidates: [{ path: ".media-cache/run_1/art.png", description: "lead", provider: "article-harvest", licenseConfidence: "unknown", sourceUrl: "https://example.test/a" }], unmet: [] })),
      "media.inspectImages": fakeTool("media.inspectImages", calls, (args: unknown) => {
        const refs = (args as { images: Array<{ ref: string }> }).images.map((i) => i.ref);
        // The article image contradicts the brief; stock fits.
        return ok({ inspections: refs.map((ref) => inspection(ref, ref.startsWith("article") ? { fitScore: 1, fitsBrief: false } : {})), unreadable: [], model: "m" });
      }),
      "media.findImages": fakeTool("media.findImages", calls, ok({ candidates: [{ path: ".media-cache/run_1/stock.jpg", description: "s", provider: "unsplash", licenseConfidence: "blanket" }], unmet: [], provider: "unsplash", providersUsed: ["unsplash"] })),
      "image.generate": fakeTool("image.generate", calls, ok({ candidates: [{ path: ".media-cache/run_1/gen.png", description: "g", provider: "gemini-image", licenseConfidence: "generated" }], unmet: [], model: "m" })),
      "media.stageAsset": fakeTool("media.stageAsset", calls, ok({ url: "https://signed/stock.jpg", gcsUri: "gs://b/stock.jpg", contentType: "image/jpeg", bytes: 1 })),
    };
    const plan = await runResolver(tools, { needsVisual: true, kind: "screenshot", sourceUrl: "https://example.test/a", query: "warehouse team briefing", rationale: "the page is the story" });
    expect(plan.status).toBe("stock");
    expect(plan.asset?.url).toBe("https://signed/stock.jpg");
    expect(plan.asset?.requiresCredit).toBe(false);
    expect(calls).toEqual(["media.screenshotPage", "media.harvestArticleImages", "media.inspectImages", "media.findImages", "media.inspectImages", "media.stageAsset"]);
    expect(calls).not.toContain("image.generate");
  });

  it("generates only as the last resort, with the realism notes, and only for a photo brief", async () => {
    const calls: string[] = [];
    let generateArgs: Record<string, unknown> | undefined;
    const tools: AgentToolRegistry = {
      "media.findImages": fakeTool("media.findImages", calls, { status: "content_fail", reason: "nothing" }),
      "media.harvestArticleImages": fakeTool("media.harvestArticleImages", calls, { status: "content_fail", reason: "no lead image" }),
      "image.generate": fakeTool("image.generate", calls, (args: unknown) => {
        generateArgs = args as Record<string, unknown>;
        return ok({ candidates: [{ path: ".media-cache/run_1/gen.png", description: "g", provider: "gemini-image", licenseConfidence: "generated" }], unmet: [], model: "m" });
      }),
    };
    const plan = await runResolver(tools, { needsVisual: true, kind: "photo", query: "shipping yard at dawn", rationale: "a real scene" });
    expect(plan.status).toBe("generated");
    expect(calls).toEqual(["media.harvestArticleImages", "media.findImages", "image.generate"]);
    expect(String((generateArgs?.["art"] as { notes: string }).notes)).toMatch(/Photorealistic/);
    expect((generateArgs?.["aspectRatio"] as string)).toBe("16:9");

    // A screenshot brief never reaches generation: a screenshot cannot be invented.
    const calls2: string[] = [];
    const tools2: AgentToolRegistry = { "image.generate": fakeTool("image.generate", calls2, ok({ candidates: [], unmet: [], model: "m" })) };
    const plan2 = await runResolver(tools2, { needsVisual: true, kind: "screenshot", sourceUrl: "https://example.test/a", rationale: "x" });
    expect(plan2.status).toBe("none");
    expect(calls2).toEqual([]);
  });

  it("a client-attached image wins over every tier, brief or no brief", async () => {
    const calls: string[] = [];
    const tools: AgentToolRegistry = {
      "media.findImages": fakeTool("media.findImages", calls, ok({ candidates: [] })),
      "media.stageAsset": fakeTool("media.stageAsset", calls, ok({ url: "https://signed/up.png", gcsUri: "gs://b/up.png", contentType: "image/png", bytes: 1 })),
    };
    const plan = await runResolver(
      tools,
      { needsVisual: true, kind: "photo", query: "anything", rationale: "x" },
      { analyses: [{ path: ".media-cache/run_1/n1-client0.png", description: "the client's photo", subjects: [], textInImage: [], mood: "", looksLikeScreenshot: false }] },
    );
    expect(plan.status).toBe("attached");
    expect(plan.asset?.url).toBe("https://signed/up.png");
    expect(calls).toEqual(["media.stageAsset"]);
  });
});

describe("analyzeAttachedMedia", () => {
  it("returns undefined with no image attachments (a video is not one), and describes uploads from labels when there is no vision backend", async () => {
    const store = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(store);
    const calls: string[] = [];
    const tools: AgentToolRegistry = {
      "media.ingestAssets": fakeTool("media.ingestAssets", calls, ok({ candidates: [{ path: ".media-cache/run_1/n1-client0.png", description: "upload" }], unmet: [] })),
    };
    const result = await engine.run(
      async (wf) => ({
        none: await analyzeAttachedMedia(wf, tools, ctx, { stepId: "a", repoRoot: "/repo", assets: [{ uri: "gs://b/ep.mp4", role: "source", contentType: "video/mp4" }] }),
        labelled: await analyzeAttachedMedia(wf, tools, ctx, { stepId: "b", repoRoot: "/repo", assets: [{ uri: "https://u/pic.png", role: "source", label: "our rota" }] }),
      }),
      { runId: "run_1", clientSlug: "acme", productId: "x-agent", runKind: "recurring" },
    );
    if (result.status !== "completed") throw new Error(result.status);
    const out = result.output as { none: unknown; labelled: { analyses: Array<{ description: string; label?: string }>; note?: string } };
    expect(out.none).toBeUndefined();
    expect(out.labelled.analyses[0]!.description).toBe("our rota");
    expect(out.labelled.note).toMatch(/media.inspectImages is not registered/);
  });
});
