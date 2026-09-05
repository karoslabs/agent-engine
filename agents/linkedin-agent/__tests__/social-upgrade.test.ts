import { describe, expect, it, afterEach, beforeEach } from "vitest";
import type { AgentTool } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createLinkedInAgentWorkflow } from "../src/workflow/create-linkedin-agent-workflow.js";
import { checkLinkedInFormatting, reflowLinkedInText } from "../src/workflow/linkedin-format.js";
import { renderLinkedInDraftsMarkdown } from "../src/workflow/render-drafts-markdown.js";
import { fakeRouterSequence, finalTurn, makePromptStore, setupTestEnvironment, type TestEnvironment } from "./test-helpers.js";

/**
 * The 2026-09 elite-tier upgrade on the LinkedIn agent: the shape is
 * enforced in code (short lines, blank lines between, the takeaway present),
 * the content mode rotates and steers the archetype family, the draft gets
 * the research, and the scout takes the slot only where the old fallback did.
 */

const baseParams = { clientSlug: "acme", productId: "linkedin-agent", runKind: "recurring" as const };

const TAKEAWAY = "Predictability, not enforcement, is what made the schedule stick.";

function goodDraft(overrides: Record<string, unknown> = {}) {
  return {
    headline: "Anchor days cut scheduling friction",
    hook: "We looked at attendance data across our hybrid client base this quarter, and the pattern surprised us.",
    body: "Teams with a fixed two-day in-office schedule reported meaningfully fewer scheduling conflicts than teams with fully flexible policies.",
    takeaway: TAKEAWAY,
    hashtags: ["HybridWork"],
    callToAction: "If your team is still negotiating its hybrid policy week to week, a fixed anchor-day structure might be worth testing.",
    targetAudience: "People leaders evaluating hybrid work policies",
    archetype: "teardown-framework",
    text:
      "We looked at attendance data across our hybrid client base this quarter, and the pattern surprised us.\n\n" +
      "Teams with a fixed two-day in-office schedule reported meaningfully fewer scheduling conflicts than teams with fully flexible policies.\n\n" +
      `${TAKEAWAY}\n\n` +
      "If your team is still negotiating its hybrid policy week to week, a fixed anchor-day structure might be worth testing.\n\n" +
      "#HybridWork",
    ...overrides,
  };
}

function draftInputOf(router: ReturnType<typeof fakeRouterSequence>, callIndex: number): Record<string, unknown> {
  const call = (router.complete as unknown as { mock: { calls: unknown[][] } }).mock.calls[callIndex]!;
  return (JSON.parse(call[0] as string) as { input: Record<string, unknown> }).input;
}

describe("reflowLinkedInText: LinkedIn's shape, without touching a word", () => {
  it("splits a paragraph of three or more sentences into one sentence per line with blank lines between", () => {
    const wall = "We tried it. It worked better than we expected. Nobody wanted to go back to the old way, and the calendar finally calmed down.";
    const out = reflowLinkedInText(wall);
    expect(out).toBe("We tried it. It worked better than we expected.\n\nNobody wanted to go back to the old way, and the calendar finally calmed down.");
    // Every word survives, in order.
    expect(out.replace(/\s+/g, " ")).toBe(wall.replace(/\s+/g, " "));
  });

  it("leaves a post that already has the rhythm byte-identical", () => {
    const text = goodDraft().text as string;
    expect(reflowLinkedInText(text)).toBe(text);
  });

  it("never splits a hashtag row or a list, and keeps decimals intact", () => {
    const text = "Three things moved.\n\n- 3.5 percent fewer conflicts. Really.\n- One fewer meeting a week. Two, some weeks. Three at best.\n\n#Hybrid #Teams";
    const out = reflowLinkedInText(text);
    expect(out).toContain("- 3.5 percent fewer conflicts. Really.\n- One fewer meeting a week. Two, some weeks. Three at best.");
    expect(out.endsWith("#Hybrid #Teams")).toBe(true);
  });

  it("works on Hebrew, which has no capitals to key on", () => {
    const text = "בדקנו את הנתונים. התוצאה הפתיעה אותנו. הצוותים עם ימי עוגן דיווחו על פחות התנגשויות ביומן.";
    const out = reflowLinkedInText(text);
    expect(out.split("\n\n")).toHaveLength(2);
  });
});

describe("checkLinkedInFormatting", () => {
  it("reports a missing takeaway and an over-long line, and passes the clean shape", () => {
    const clean = checkLinkedInFormatting(goodDraft().text as string, TAKEAWAY);
    expect(clean.ok).toBe(true);
    const missing = checkLinkedInFormatting(goodDraft().text as string, "A takeaway that is not in the post.");
    expect(missing.ok).toBe(false);
    expect(missing.notes.join(" ")).toMatch(/takeaway does not appear/);
    const wall = checkLinkedInFormatting("A".repeat(300), undefined);
    expect(wall.notes.join(" ")).toMatch(/runs 300 characters/);
  });
});

describe("linkedin-agent 2026-09 upgrade, end to end", () => {
  let env: TestEnvironment;
  beforeEach(async () => {
    env = await setupTestEnvironment();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it("re-flows the shipped text, records the shape check, hands the draft the research digest and the mode, and carries the takeaway", async () => {
    const wall =
      "We looked at attendance data across our hybrid client base this quarter, and the pattern surprised us. Teams with a fixed two-day in-office schedule reported fewer scheduling conflicts. The difference was predictability.\n\n" +
      `${TAKEAWAY}\n\n#HybridWork`;
    const router = fakeRouterSequence([finalTurn(goodDraft({ text: wall }))]);
    const store = new MemoryDurableStepStore();
    const workflowFn = createLinkedInAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router, autoApprove: true });
    const result = await new WorkflowEngine(store).run(workflowFn, { ...baseParams, runId: "li_up_1" });
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");

    // One sentence per line where the model wrote a wall; the takeaway survives verbatim.
    expect(result.output.preview.split("\n\n")).toHaveLength(5);
    expect(result.output.preview).toContain(TAKEAWAY);
    expect(result.output.takeaway).toBe(TAKEAWAY);
    expect(result.output.formattingNotes).toEqual([]);
    expect(result.output.contentMode).toBe("deep-value");
    expect(result.output.mediaStatus).toBe("none");

    const ids = (await store.listSteps("li_up_1")).map((s) => s.stepId);
    expect(ids).toContain("09b-verify-formatting");
    expect(ids).toContain("14b-resolve-media");
    expect(ids).not.toContain("07a-trend-scout");

    const input = draftInputOf(router, 0);
    expect(input["contentMode"]).toBe("deep-value");
    const research = input["research"] as Array<{ title: string; excerpt: string }>;
    expect(research.length).toBeGreaterThan(0);
    expect(research[0]!.excerpt.length).toBeGreaterThan(0);

    // The excerpt window records the RE-FLOWED text, so future dedupe compares like with like.
    const history = await env.store.readJson<Array<{ excerpt: string }>>("acme", ["ledger", "output-history", "linkedin-agent"]);
    expect(history?.[0]?.excerpt).toBe(result.output.preview);
  });

  it("rotates the content mode away from the prior run's and draws the archetype from that mode's family", async () => {
    await env.store.writeJson("acme", ["memory", "products", "linkedin-agent", "decisions", "prior"], {
      decisionId: "prior",
      summary: 'Posted about "x" (archetype: teardown-framework, mode: deep-value)',
      at: Date.now() - 1000,
    });
    const router = fakeRouterSequence([finalTurn(goodDraft({ archetype: "industry-reaction" }))]);
    const store = new MemoryDurableStepStore();
    const workflowFn = createLinkedInAgentWorkflow({ tools: env.tools, promptStore: makePromptStore(), router, autoApprove: true });
    const result = await new WorkflowEngine(store).run(workflowFn, { ...baseParams, runId: "li_up_2" });
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.output.contentMode).toBe("hot-news");
    expect(["industry-reaction", "contrarian-take"]).toContain(draftInputOf(router, 0)["archetype"]);
    const decisions = await env.store.listJson<{ summary: string }>("acme", ["memory", "products", "linkedin-agent", "decisions"]);
    expect(decisions.some((d) => d.data.summary.includes("mode: hot-news"))).toBe(true);
  });

  it("runs the scout when the catalog is empty and takes an on-brand trend", async () => {
    await env.store.writeJson("acme", ["topics", "catalog"], []);
    const research: AgentTool = {
      name: "research.pull",
      version: "1.2.0",
      inputSchema: { parse: (v: unknown) => v } as never,
      async execute(args: unknown) {
        return {
          status: "success",
          result: {
            runId: "r",
            query: (args as { query: string }).query,
            fromCache: false,
            result: {
              provider: "stub",
              documents: [{ title: "Hybrid policy report lands", url: "https://example.test/report", publishedAt: "2026-09-03", content: "A new report on hybrid policies." }],
            },
          },
        };
      },
    } as unknown as AgentTool;
    const candidate = {
      topic: "what the new hybrid policy report means for people leaders",
      headline: "Hybrid policy report lands",
      mode: "deep-value",
      brandFit: 5,
      brandFitReason: "Acme advises exactly these teams on hybrid policy.",
      angle: "The report measures the wrong thing.",
      hook: "The new hybrid report counts days, not decisions.",
      whyNow: "Published this week.",
      sourceUrls: ["https://example.test/report"],
      hasNumbers: false,
      mediaHint: "none",
    };
    const router = fakeRouterSequence([finalTurn({ candidates: [candidate], skipped: [] }), finalTurn(goodDraft())]);
    const store = new MemoryDurableStepStore();
    const workflowFn = createLinkedInAgentWorkflow({ tools: { ...env.tools, "research.pull": research }, promptStore: makePromptStore(), router, autoApprove: true });
    const result = await new WorkflowEngine(store).run(workflowFn, { ...baseParams, runId: "li_up_3" });
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("unreachable");
    expect(result.output.topic).toBe(candidate.topic);
    const ids = (await store.listSteps("li_up_3")).map((s) => s.stepId);
    expect(ids).toContain("07a-trend-scout");
    expect((draftInputOf(router, 1)["trendCandidate"] as { brandFitReason: string }).brandFitReason).toBe(candidate.brandFitReason);
  });

  it("renders the Takeaway and Media meta bullets the portal parser reads", () => {
    const md = renderLinkedInDraftsMarkdown({
      identity: { scope: "company" },
      companyName: "Acme",
      archetype: "teardown-framework",
      topic: "hybrid",
      draft: goodDraft() as never,
      media: {
        status: "stock",
        rationale: "a real photograph",
        attempts: [],
        asset: { path: ".media-cache/r/n1.jpg", url: "https://storage.example/n1.jpg", description: "x", provider: "unsplash", licenseConfidence: "blanket", requiresCredit: false },
      },
    });
    expect(md).toContain(`- **Takeaway:** ${TAKEAWAY}`);
    expect(md).toContain("- **Media:** https://storage.example/n1.jpg");
  });
});
