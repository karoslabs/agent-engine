import { describe, expect, it, afterEach, beforeEach } from "vitest";
import type { AgentToolRegistry } from "@agent-engine/core";
import { MemoryDurableStepStore, WorkflowEngine } from "@agent-engine/workflow";
import { createInstagramAgentWorkflow } from "../src/workflow/create-instagram-agent-workflow.js";
import {
  checkExpectedScript,
  languageGateText,
  resolveExpectedScript,
  MIN_EXPECTED_SCRIPT_RATIO,
} from "../src/workflow/language-gate.js";
import type { InstagramCopyOutput } from "../src/workflow/types.js";
import {
  SIX_RESEARCH_FACTS,
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

/**
 * SCRUM-310 (AU32) — the language-compliance gate, both stages, both halves.
 *
 * The client here is modelled on the real one the gate exists for: geektime,
 * a Hebrew-only outlet whose carousel shipped in fluent English because no
 * language dimension existed anywhere in the QA chain.
 *
 * Stage 1 (`07e-language-script`) is deterministic and is NEVER stubbed in
 * this file — the English fixtures really are checked by the real code.
 * Stage 2 (`07f-language-fluency`) is a model call, stubbed through this
 * package's established `fakeRouterSequence`/`finalTurn` helpers (the same
 * mechanism `visual-qa-retry.test.ts` uses for `instagram-visual-qa`), so
 * nothing here depends on a live model.
 */

/** The brand kit a Hebrew-only client has: `language` is AU31's structured field, read by step 02d. */
const HEBREW_BRAND = { name: "Geektime", language: "Hebrew" };

function testTools(env: TestEnvironment): AgentToolRegistry {
  return { ...env.tools, "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!) };
}

/**
 * Fluent, ordinary Hebrew: a real caption and six real slide bodies, one per
 * research fact. `sourceRef` stays the English fact claim verbatim — step 07
 * requires that, the field is never rendered, and the gate deliberately does
 * not read it.
 */
const GOOD_HEBREW_BODIES = [
  "צוותים שהפכו את הדוח השבועי לאוטומטי חסכו בממוצע ארבע שעות בכל שבוע.",
  "צוות התמיכה שלנו סגר שלושים אחוז יותר פניות אחרי המעבר לתהליך המיון החדש.",
  "לקוחות שעברו הטמעה עם רשימת הבדיקה החדשה הגיעו לערך הראשון שלהם מהר יותר בפעמיים.",
  "סקרים פנימיים הראו עלייה של עשרים וחמישה אחוז בשביעות הרצון של הצוות אחרי שינוי התהליך.",
  "צוות העיצוב צמצם את סבבי התיקונים מחמישה סבבים לשניים בממוצע.",
  "זמן ההטמעה ירד מארבעה עשר ימים לשבעה ימים אחרי ההשקה.",
];

/**
 * Hebrew script, broken Hebrew: real words in mangled agreement and word
 * order, the shape a model produces when it is translating word by word
 * instead of writing. Passes the script check (every letter is Hebrew) and
 * is exactly what stage 2 exists to catch.
 */
const BAD_HEBREW_BODIES = [
  "צוותים אשר אוטומטי הדוח השבועי היה, חסכה ארבע שעה בתוך שבועות, וזה הוא טוב עבור של החברה.",
  "התמיכה צוות סגרה שלושים האחוז יותר של פניות, אחרי אשר עברנו אל תהליך מיון החדשה מאוד.",
  "לקוחות אשר הטמעה עשה עם הרשימה בדיקה, הגיע ערך ראשונה שלהם יותר מהר בשני של ימים.",
  "סקר פנימי הראה עלייה של עשרים וחמש אחוזים בתוך שביעות רצון הצוות, אחרי אשר התהליך שונה היה.",
  "העיצוב צוות צמצמה את הסבבים תיקונים, מן חמישה אל שניים, בתוך ממוצע של הרבעון האחרונה.",
  "הזמן של ההטמעה ירדה מן ארבעה עשר של ימים, אל שבעה ימים, אחרי אשר ההשקה קרה.",
];

function hebrewCopy(bodies: readonly string[], caption: string): InstagramCopyOutput {
  const base = goodCopyOutput();
  return {
    format: "carousel",
    caption,
    slides: base.slides.map((slide, i) => ({
      ...slide,
      headline: `ממצא מספר ${slide.n}`,
      body: bodies[i]!,
      // Unchanged on purpose: `sourceRef` must match a step-04 research
      // fact's claim verbatim, and `visualNeed` is a stock-photo query.
      sourceRef: SIX_RESEARCH_FACTS[i]!.claim,
    })),
  };
}

const goodHebrewCopy = () => hebrewCopy(GOOD_HEBREW_BODIES, "מבט קצר על השינויים בתהליכי העבודה שבאמת הזיזו את המחט ברבעון הזה, ועל מה שצוותים עשו אחרת.");
const badHebrewCopy = () => hebrewCopy(BAD_HEBREW_BODIES, "מבט של קצר על השינויים אשר בתוך תהליכי עבודה, אשר באמת עשה את ההבדל בתוך הרבעון הזה של אחרון.");

const FLUENT_VERDICT = { fluent: true, issues: [] };
const NOT_FLUENT_VERDICT = {
  fluent: false,
  issues: ["broken agreement and word order throughout", "reads as word-by-word machine translation"],
  evidence: "צוותים אשר אוטומטי הדוח השבועי היה",
};

// ─────────────────────────────────────────────────────────────────────────
// Stage 1, in isolation: pure, deterministic, no model, no workflow.
// ─────────────────────────────────────────────────────────────────────────

describe("stage 1 — checkExpectedScript (deterministic, no model call)", () => {
  const goodHebrewText = languageGateText(goodHebrewCopy());
  const englishText = languageGateText(goodCopyOutput());

  it("passes real Hebrew copy for a Hebrew client", () => {
    expect(checkExpectedScript(goodHebrewText, "Hebrew")).toEqual({ ok: true });
  });

  it("FAILS English copy for a Hebrew client, naming the script and the ratio", () => {
    const verdict = checkExpectedScript(englishText, "Hebrew");
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.reason).toMatch(/not written in the Hebrew script/);
    expect(verdict.reason).toMatch(/0%\) are Hebrew/);
  });

  it("resolves the language from a BCP-47 tag as well as a plain name", () => {
    expect(resolveExpectedScript("he-IL")?.name).toBe("Hebrew");
    expect(resolveExpectedScript("he")?.name).toBe("Hebrew");
    expect(resolveExpectedScript("HEBREW")?.name).toBe("Hebrew");
    expect(checkExpectedScript(englishText, "he-IL").ok).toBe(false);
  });

  it("is symmetric: Hebrew copy for an English client fails too", () => {
    expect(checkExpectedScript(goodHebrewText, "English").ok).toBe(false);
    expect(checkExpectedScript(englishText, "English")).toEqual({ ok: true });
  });

  it("tolerates the Latin-script product names real Hebrew tech copy is full of", () => {
    const mixed = `${goodHebrewText}\n\nOpenAI Anthropic Google Gemini Claude Vertex Kubernetes`;
    const letters = mixed.match(/\p{L}/gu)!.length;
    const hebrew = mixed.match(/\p{Script=Hebrew}/gu)!.length;
    expect(hebrew / letters).toBeGreaterThan(MIN_EXPECTED_SCRIPT_RATIO);
    expect(checkExpectedScript(mixed, "Hebrew")).toEqual({ ok: true });
  });

  it("has no opinion about a language it has never heard of, rather than failing every draft", () => {
    expect(checkExpectedScript(englishText, "Klingon")).toEqual({ ok: true });
    expect(resolveExpectedScript("Klingon")).toBeUndefined();
  });

  it("has no opinion about text too short to judge", () => {
    expect(checkExpectedScript("Acme Q3", "Hebrew")).toEqual({ ok: true });
  });

  it("reads the caption and on-image prose only — never sourceRef or visualNeed", () => {
    const text = languageGateText(goodHebrewCopy());
    expect(text).toContain("ממצא מספר 1");
    expect(text).toContain(GOOD_HEBREW_BODIES[0]);
    expect(text).not.toContain(SIX_RESEARCH_FACTS[0]!.claim);
    expect(text).not.toContain(goodCopyOutput().slides[0]!.visualNeed);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Both stages, end to end, through the real workflow.
// ─────────────────────────────────────────────────────────────────────────

describe("07e/07f — the language-compliance gate in the instagram self-check loop", () => {
  let env: TestEnvironment;

  beforeEach(async () => {
    env = await setupTestEnvironment();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  function workflowFor(router: ReturnType<typeof fakeRouterSequence>) {
    return createInstagramAgentWorkflow({
      tools: testTools(env),
      promptStore: makePromptStore(),
      router,
      repoRoot: env.repoRoot,
      imageCandidatePool: goodImageCandidatePool(),
      autoApprove: true,
    });
  }

  it("PASSES: good Hebrew clears stage 1 deterministically and stage 2's judge, and the run completes", async () => {
    await env.store.writeJson("acme", ["client", "brand"], HEBREW_BRAND);
    const router = fakeRouterSequence([
      finalTurn(goodResearchOutput()),
      finalTurn(goodHebrewCopy()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(FLUENT_VERDICT),
      finalTurn(goodVisualQaOutput()),
    ]);
    const params = { runId: "instagram_run_lang_pass", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(workflowFor(router), params);

    expect(result.status).toBe("completed");
    expect(router.complete).toHaveBeenCalledTimes(5);

    const stepIds = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    expect(stepIds).toContain("02d-load-target-language");
    expect(stepIds).toContain("07e-language-script-attempt-1");
    expect(stepIds).toContain("07f-language-fluency-attempt-1");
    // One pass only: nothing sent it back to step 05.
    expect(stepIds).not.toContain("05-write-copy-attempt-2");

    const language = (await durableStore.getStep(params.runId, "02d-load-target-language")) as { output: string };
    expect(language.output).toBe("Hebrew");
    const script = (await durableStore.getStep(params.runId, "07e-language-script-attempt-1")) as { output: { ok: boolean } };
    expect(script.output.ok).toBe(true);
    const fluency = (await durableStore.getStep(params.runId, "07f-language-fluency-attempt-1")) as {
      output: { finalOutput: { fluent: boolean } };
    };
    expect(fluency.output.finalOutput.fluent).toBe(true);
    // The gate ran BEFORE the render, which is the whole point.
    expect(stepIds.indexOf("07f-language-fluency-attempt-1")).toBeLessThan(stepIds.indexOf("08-render-carousel-attempt-1"));
  }, 60000);

  it("FAILS stage 1: an English draft for a Hebrew client never reaches the judge, never renders, and holds", async () => {
    await env.store.writeJson("acme", ["client", "brand"], HEBREW_BRAND);
    // Three full attempts of copy + vetting and NOT ONE fluency turn — the
    // deterministic stage rejects each draft before stage 2 costs anything.
    const router = fakeRouterSequence([
      finalTurn(goodResearchOutput()),
      finalTurn(goodCopyOutput()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodCopyOutput()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodCopyOutput()),
      finalTurn(goodImageVettingOutput()),
    ]);
    const params = { runId: "instagram_run_lang_script_fail", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(workflowFor(router), params);

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/self-check never passed after 3 attempt/i);
    expect(result.reason).toMatch(/deterministic language\/script check/i);
    expect(result.reason).toMatch(/not written in the Hebrew script/i);

    // Stage 2 was never asked: 1 research + 3 x (copy + vetting).
    expect(router.complete).toHaveBeenCalledTimes(7);

    const stepIds = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    expect(stepIds).toContain("07e-language-script-attempt-1");
    expect(stepIds).toContain("07e-language-script-attempt-3");
    expect(stepIds).not.toContain("07f-language-fluency-attempt-1");
    expect(stepIds).not.toContain("08-render-carousel-attempt-1");
    expect(stepIds).not.toContain("09b-deliver-and-log");

    const script = (await durableStore.getStep(params.runId, "07e-language-script-attempt-1")) as { output: { ok: boolean; reason: string } };
    expect(script.output.ok).toBe(false);
    expect(script.output.reason).toMatch(/only 0\//);

    const deliverables = await env.store.listJson("acme", ["ledger", "deliverables", params.runId, "_"]);
    expect(deliverables).toHaveLength(0);
  }, 60000);

  it("FAILS stage 2: Hebrew-script nonsense clears the script check and is caught by the judge, then holds", async () => {
    await env.store.writeJson("acme", ["client", "brand"], HEBREW_BRAND);
    const router = fakeRouterSequence([
      finalTurn(goodResearchOutput()),
      finalTurn(badHebrewCopy()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(NOT_FLUENT_VERDICT),
      finalTurn(badHebrewCopy()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(NOT_FLUENT_VERDICT),
      finalTurn(badHebrewCopy()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(NOT_FLUENT_VERDICT),
    ]);
    const params = { runId: "instagram_run_lang_fluency_fail", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(workflowFor(router), params);

    expect(result.status).toBe("held");
    if (result.status !== "held") throw new Error("unreachable");
    expect(result.reason).toMatch(/not fluent Hebrew on attempt 3/i);
    expect(result.reason).toMatch(/machine translation/i);
    expect(router.complete).toHaveBeenCalledTimes(10);

    const stepIds = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    // Stage 1 passed on every attempt — the copy really is in Hebrew script.
    const script = (await durableStore.getStep(params.runId, "07e-language-script-attempt-1")) as { output: { ok: boolean } };
    expect(script.output.ok).toBe(true);
    expect(stepIds).toContain("07f-language-fluency-attempt-3");
    expect(stepIds).not.toContain("08-render-carousel-attempt-1");
    expect(stepIds).not.toContain("09b-deliver-and-log");
  }, 60000);

  it("PASSES stage 2 on a redraft: bad Hebrew is sent back to step 05 and good Hebrew ships", async () => {
    await env.store.writeJson("acme", ["client", "brand"], HEBREW_BRAND);
    const router = fakeRouterSequence([
      finalTurn(goodResearchOutput()),
      finalTurn(badHebrewCopy()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(NOT_FLUENT_VERDICT),
      finalTurn(goodHebrewCopy()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(FLUENT_VERDICT),
      finalTurn(goodVisualQaOutput()),
    ]);
    const params = { runId: "instagram_run_lang_redraft", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(workflowFor(router), params);

    expect(result.status).toBe("completed");
    expect(router.complete).toHaveBeenCalledTimes(8);

    const first = (await durableStore.getStep(params.runId, "07f-language-fluency-attempt-1")) as { output: { finalOutput: { fluent: boolean } } };
    expect(first.output.finalOutput.fluent).toBe(false);
    const second = (await durableStore.getStep(params.runId, "07f-language-fluency-attempt-2")) as { output: { finalOutput: { fluent: boolean } } };
    expect(second.output.finalOutput.fluent).toBe(true);
  }, 60000);

  it("a judge that cannot complete never blocks a draft (fail open, loudly — same posture as runTopicGuardrail)", async () => {
    await env.store.writeJson("acme", ["client", "brand"], HEBREW_BRAND);
    const router = fakeRouterSequence([
      finalTurn(goodResearchOutput()),
      finalTurn(goodHebrewCopy()),
      finalTurn(goodImageVettingOutput()),
      // Malformed against the judge's own output schema -> `content_fail`,
      // which this gate reports as `error`, not as a failed draft.
      finalTurn({ nonsense: true }),
      finalTurn(goodVisualQaOutput()),
    ]);
    const params = { runId: "instagram_run_lang_judge_error", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(workflowFor(router), params);

    expect(result.status).toBe("completed");
    const stepIds = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    expect(stepIds).toContain("07f-language-fluency-attempt-1");
    expect(stepIds).not.toContain("05-write-copy-attempt-2");
  }, 60000);

  it("costs nothing for a client with no declared language: no gate steps, no extra model call", async () => {
    // No `client/brand` written at all — the default fixture client.
    const router = fakeRouterSequence([
      finalTurn(goodResearchOutput()),
      finalTurn(goodCopyOutput()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodVisualQaOutput()),
    ]);
    const params = { runId: "instagram_run_lang_none", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" as const };

    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(workflowFor(router), params);

    expect(result.status).toBe("completed");
    expect(router.complete).toHaveBeenCalledTimes(4);
    const stepIds = (await durableStore.listSteps(params.runId)).map((s) => s.stepId);
    expect(stepIds).toContain("02d-load-target-language");
    expect(stepIds).not.toContain("07e-language-script-attempt-1");
    expect(stepIds).not.toContain("07f-language-fluency-attempt-1");
  }, 60000);
});
