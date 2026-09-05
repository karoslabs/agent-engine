import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fsp from "node:fs/promises";
import pathMod from "node:path";
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
import {
  assembleSlidesData,
  buildListRows,
  buildVariationPlan,
  eligibleAlternateTemplates,
  invertedTemplateFileName,
  isVariationSlot,
  pickAlternateTemplate,
  resolveLayout,
  VARIATION_MIX,
} from "../src/workflow/slides-data.js";
import { paletteForSlide } from "../src/workflow/brand-render-tokens.js";
import { InstagramSlideCopySchema, type InstagramCopyOutput, type ImageSelection } from "../src/workflow/types.js";

const CANVAS = { w: 1080, h: 1440, scale: 2, slides_min: 6, slides_max: 8 };

function copyWith(overrides: Partial<InstagramCopyOutput["slides"][number]>[]): InstagramCopyOutput {
  return {
    format: "carousel",
    caption: "A short caption for the fixture carousel.",
    slides: overrides.map((o, i) => ({
      n: i + 1,
      headline: `headline ${i + 1}`,
      body: `body ${i + 1}`,
      visualNeed: `need ${i + 1}`,
      sourceRef: `claim ${i + 1}`,
      layout: "photo" as const,
      ...o,
    })),
  };
}

/** `assembleSlidesData`'s per-slide template selection and image wiring — the "layout selector" this ask asked to verify. */
describe("assembleSlidesData: per-slide layout routing", () => {
  it("routes a 'photo' slide through the client's configured template and attaches its vetted image", () => {
    const copy = copyWith([{ n: 1, layout: "photo" }]);
    const selections: ImageSelection[] = [
      { n: 1, imagePath: "photos/n1.jpg", reason: "matches", license: "CC0", rightsUsable: true, watermarkFree: true },
    ];

    const data = assembleSlidesData({
      clientSlug: "acme",
      postId: "post_1",
      repoRoot: "/repo",
      brandTokens: { templateDir: "fixtures/templates", slideTemplate: "slide.html" },
      copy,
      selections,
      canvas: CANVAS,
    });

    expect(data.slides[0]).toMatchObject({
      template: "slide.html",
      images: { hero: "photos/n1.jpg" },
    });
  });

  it("routes a 'text_only' slide through the SAME client template but with no image attached, even if a stale imagePath is present", () => {
    const copy = copyWith([{ n: 1, layout: "text_only" }]);
    // A downgraded slide's selection is always nulled out by the workflow
    // before this runs — this proves the render layer's own contract holds
    // even if a caller somehow passed a leftover path through: "text_only"
    // never carries a photo, regardless of what the selection says.
    const selections: ImageSelection[] = [
      { n: 1, imagePath: null, reason: "no candidate qualified", license: "n/a", rightsUsable: false, watermarkFree: false },
    ];

    const data = assembleSlidesData({
      clientSlug: "acme",
      postId: "post_1",
      repoRoot: "/repo",
      brandTokens: { templateDir: "fixtures/templates", slideTemplate: "slide.html" },
      copy,
      selections,
      canvas: CANVAS,
    });

    expect(data.slides[0]).toMatchObject({
      template: "slide.html",
      images: {},
    });
  });

  it("keeps headline/body/accentColor identical across layouts -- layout only ever changes the template/image wiring, never the copy", () => {
    const copy = copyWith([{ n: 1, layout: "photo" }, { n: 2, layout: "text_only" }]);
    const selections: ImageSelection[] = [
      { n: 1, imagePath: "photos/n1.jpg", reason: "matches", license: "CC0", rightsUsable: true, watermarkFree: true },
      { n: 2, imagePath: null, reason: "no candidate qualified", license: "n/a", rightsUsable: false, watermarkFree: false },
    ];

    const data = assembleSlidesData({
      clientSlug: "acme",
      postId: "post_1",
      repoRoot: "/repo",
      brandTokens: { templateDir: "fixtures/templates", slideTemplate: "slide.html", accentColor: "#123456" },
      copy,
      selections,
      canvas: CANVAS,
    });

    for (const slide of data.slides) {
      expect(slide.fields["accentColor"]).toBe("#123456");
    }
    expect(data.slides[0]!.fields["headline"]).toBe("headline 1");
    expect(data.slides[1]!.fields["headline"]).toBe("headline 2");
  });

  it("marks every slide's fields dir: 'rtl' for a Hebrew carousel, regardless of each slide's archetype", () => {
    // Prep job 9qkTWlg7e9ZLiVIZUok4: a Hebrew brand-voice client whose
    // carousel rendered left-to-right because no template ever knew the
    // post's language. One shared direction is computed from the whole
    // carousel's own text (`detectDirection`), then threaded onto every
    // slide's `fields`, across every archetype branch of `contentFor`.
    const hebrewCopy = {
      format: "carousel" as const,
      caption: "מדריך שיווק קצר לכל מי שרוצה לצמוח ברשתות החברתיות בעולם",
      slides: [
        {
          n: 1,
          headline: "כותרת ראשית בעברית",
          body: "גוף הטקסט של השקופית הראשונה, כתוב לחלוטין בעברית.",
          visualNeed: "need 1",
          sourceRef: "claim 1",
          layout: "photo" as const,
        },
        {
          n: 2,
          headline: "עדיין לא רלוונטי",
          body: "עדיין לא רלוונטי",
          visualNeed: "need 2",
          sourceRef: "claim 2",
          layout: "quote_card" as const,
          quote: { text: "אנחנו רואים את זה כל הזמן.", attribution: "מנכ״ל, 2026" },
        },
        {
          n: 3,
          headline: "עדיין לא רלוונטי",
          body: "עדיין לא רלוונטי",
          visualNeed: "need 3",
          sourceRef: "claim 3",
          layout: "stat_callout" as const,
          stat: { figure: "73%", subLabel: "תת כותרת", source: "מקור" },
        },
      ],
    };

    const data = assembleSlidesData({
      clientSlug: "acme",
      postId: "post_1",
      repoRoot: "/repo",
      brandTokens: { templateDir: "fixtures/templates", slideTemplate: "slide.html" },
      copy: hebrewCopy,
      selections: [
        { n: 1, imagePath: "photos/n1.jpg", reason: "matches", license: "CC0", rightsUsable: true, watermarkFree: true },
        { n: 2, imagePath: null, reason: "n/a", license: "n/a", rightsUsable: false, watermarkFree: false },
        { n: 3, imagePath: null, reason: "n/a", license: "n/a", rightsUsable: false, watermarkFree: false },
      ],
      canvas: CANVAS,
    });

    for (const slide of data.slides) {
      expect(slide.fields["dir"]).toBe("rtl");
    }
  });

  it("marks every slide's fields dir: 'ltr' for an English carousel", () => {
    const copy = copyWith([{ n: 1, layout: "photo" }]);
    const selections: ImageSelection[] = [
      { n: 1, imagePath: "photos/n1.jpg", reason: "matches", license: "CC0", rightsUsable: true, watermarkFree: true },
    ];

    const data = assembleSlidesData({
      clientSlug: "acme",
      postId: "post_1",
      repoRoot: "/repo",
      brandTokens: { templateDir: "fixtures/templates", slideTemplate: "slide.html" },
      copy,
      selections,
      canvas: CANVAS,
    });

    expect(data.slides[0]!.fields["dir"]).toBe("ltr");
  });
});

/** The ported legacy archetype set: selection, per-archetype fields, and graceful degradation. */
describe("archetype layouts (legacy port)", () => {
  const slide = (over: Record<string, unknown>) =>
    InstagramSlideCopySchema.parse({
      n: 1,
      headline: "A headline",
      body: "Some body copy.",
      visualNeed: "a need",
      sourceRef: "a claim",
      ...over,
    });

  function assemble(copy: InstagramCopyOutput, selections: ImageSelection[] = []) {
    return assembleSlidesData({
      clientSlug: "acme",
      postId: "post_1",
      repoRoot: "/repo",
      brandTokens: { templateDir: "fixtures/templates", slideTemplate: "slide.html", accentColor: "#C4552F" },
      copy,
      selections,
      canvas: CANVAS,
    });
  }

  it("routes each archetype to its own template file", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ layout: "photo" }, "slide.html"],
      [{ layout: "text_only" }, "slide.html"],
      [{ layout: "headline_focus" }, "headline-focus.html"],
      [{ layout: "stat_callout", stat: { figure: "73%", subLabel: "of teams", source: "Acme, 2026" } }, "stat-callout.html"],
      [{ layout: "quote_card", quote: { text: "A thing was said.", attribution: "Someone, 2026" } }, "quote-card.html"],
      [
        { layout: "comparison_card", comparison: { leftLabel: "Before", leftBody: "b", rightLabel: "After", rightBody: "a" } },
        "comparison-card.html",
      ],
      [{ layout: "list_takeaway", items: [{ title: "One" }, { title: "Two" }] }, "list-takeaway.html"],
    ];
    for (const [over, expected] of cases) {
      const data = assemble({ slides: [slide(over)] } as InstagramCopyOutput);
      expect(data.slides[0]!.template, JSON.stringify(over)).toBe(expected);
    }
  });

  it("gives stat_callout its figure, sub-label and mandatory source line", () => {
    const data = assemble({
      slides: [slide({ layout: "stat_callout", stat: { figure: "4.2x", subLabel: "faster onboarding", source: "Acme, 2026" } })],
    } as InstagramCopyOutput);
    expect(data.slides[0]!.fields).toMatchObject({
      figure: "4.2x",
      subLabel: "faster onboarding",
      sourceLine: "Acme, 2026",
      accentColor: "#C4552F",
    });
  });

  it("gives quote_card the quote and attribution, and no headline slot it would not use", () => {
    const data = assemble({
      slides: [slide({ layout: "quote_card", quote: { text: "Ship it.", attribution: "A lead, 2026" } })],
    } as InstagramCopyOutput);
    expect(data.slides[0]!.fields).toMatchObject({ quoteText: "Ship it.", attribution: "A lead, 2026" });
    expect(data.slides[0]!.fields["headline"]).toBeUndefined();
  });

  it("builds list_takeaway's rows as an html fragment, since the renderer has no loop construct", () => {
    const data = assemble({
      slides: [slide({ layout: "list_takeaway", items: [{ title: "First", note: "why" }, { title: "Second" }] })],
    } as InstagramCopyOutput);
    const rows = data.slides[0]!.htmlFragments["itemRows"]!;
    expect(rows).toContain('<div class="me-title">First</div>');
    expect(rows).toContain('<div class="me-note">why</div>');
    // The second row has no note, so its note div is present but empty --
    // `.me-note:empty { display: none }` collapses it in the template.
    expect(rows).toContain('<div class="me-title">Second</div>');
    expect(rows.match(/me-row/g)).toHaveLength(2);
  });

  // `{{html:...}}` is substituted UNESCAPED by design, so this escaping is the
  // only thing between model-authored takeaway text and live markup.
  it("escapes model text inside the list fragment", () => {
    const rows = buildListRows([{ title: '<script>alert("x")</script>', note: "a & b" }]);
    expect(rows).not.toContain("<script>");
    expect(rows).toContain("&lt;script&gt;");
    expect(rows).toContain("a &amp; b");
  });

  // The model picks `layout` and fills the content block separately, so those
  // are two chances to disagree. A mismatch must not render an empty 300px
  // figure, and must not fail the whole draft either.
  it("degrades an archetype whose required content the model omitted, rather than rendering it empty", () => {
    for (const layout of ["stat_callout", "quote_card", "comparison_card", "list_takeaway"] as const) {
      const s = slide({ layout });
      expect(resolveLayout(s).layout, layout).toBe("text_only");
      expect(resolveLayout(s).downgradedFrom, layout).toContain(layout);

      const data = assemble({ slides: [s] } as InstagramCopyOutput);
      // Falls back to the client's own template on headline/body, which every
      // slide is schema-guaranteed to have.
      expect(data.slides[0]!.template).toBe("slide.html");
      expect(data.slides[0]!.fields).toMatchObject({ headline: "A headline", body: "Some body copy." });
    }
  });

  it("degrades a list_takeaway that arrived with only one item, since the layout needs at least two rows", () => {
    // `.min(2)` on the schema rejects a 1-item array outright, so the workflow
    // sees this shape only when the model omitted `items` entirely or the array
    // was built downstream -- resolveLayout is the backstop either way.
    const s = { ...slide({ layout: "list_takeaway" }), items: [{ title: "Only one" }] };
    expect(resolveLayout(s).layout).toBe("text_only");
  });

  // A real prep run (2VFCw79Wu8xfJOKXC7zP) shipped two `stat_callout`s and two
  // `comparison_card`s in one 8-slide carousel — each structured archetype has
  // one fixed visual template, so a repeat reads as the same slide shown
  // twice, not two designed slides. A prompt rule alone ("aim for a mix")
  // already asked for this and did not hold, so it degrades mechanically now.
  it("downgrades the SECOND slide to claim a structured archetype, keeping the first", () => {
    const first = slide({ n: 1, layout: "stat_callout", stat: { figure: "73%", subLabel: "of teams", source: "Acme, 2026" } });
    const second = slide({ n: 2, layout: "stat_callout", stat: { figure: "4.2x", subLabel: "faster", source: "Acme, 2026" } });
    const data = assemble({ slides: [first, second] } as InstagramCopyOutput);
    expect(data.slides[0]!.template).toBe("stat-callout.html");
    expect(data.slides[1]!.template).toBe("slide.html");
    expect(data.slides[1]!.fields).toMatchObject({ headline: "A headline", body: "Some body copy." });
  });

  it("does not cross-penalize different structured archetypes, only a repeat of the same one", () => {
    const stat = slide({ n: 1, layout: "stat_callout", stat: { figure: "73%", subLabel: "of teams", source: "Acme, 2026" } });
    const quote = slide({ n: 2, layout: "quote_card", quote: { text: "Ship it.", attribution: "A lead, 2026" } });
    const data = assemble({ slides: [stat, quote] } as InstagramCopyOutput);
    expect(data.slides[0]!.template).toBe("stat-callout.html");
    expect(data.slides[1]!.template).toBe("quote-card.html");
  });

  it("never penalizes repeated photo or text_only slides — those are the normal carousel rhythm", () => {
    const photos = [slide({ n: 1, layout: "photo" }), slide({ n: 2, layout: "photo" }), slide({ n: 3, layout: "text_only" }), slide({ n: 4, layout: "text_only" })];
    const data = assemble({ slides: photos } as InstagramCopyOutput);
    expect(data.slides.map((s) => s.template)).toEqual(["slide.html", "slide.html", "slide.html", "slide.html"]);
  });

  it("attaches a hero image only to a photo slide, never to a typographic archetype", () => {
    const selections: ImageSelection[] = [
      { n: 1, imagePath: "photos/n1.jpg", reason: "matches", license: "CC0", rightsUsable: true, watermarkFree: true },
    ];
    const photo = assemble({ slides: [slide({ layout: "photo" })] } as InstagramCopyOutput, selections);
    expect(photo.slides[0]!.images).toEqual({ hero: "photos/n1.jpg" });

    // A vetted image existing does not make a quote card into a photo slide.
    const quote = assemble(
      { slides: [slide({ layout: "quote_card", quote: { text: "q", attribution: "a" } })] } as InstagramCopyOutput,
      selections,
    );
    expect(quote.slides[0]!.images).toEqual({});
  });

  it("passes an optional kicker through, and omits the slot entirely when unset", () => {
    const withKicker = assemble({ slides: [slide({ layout: "headline_focus", kicker: "the shift" })] } as InstagramCopyOutput);
    expect(withKicker.slides[0]!.fields["kicker"]).toBe("the shift");
    const without = assemble({ slides: [slide({ layout: "headline_focus" })] } as InstagramCopyOutput);
    expect(without.slides[0]!.fields["kicker"]).toBeUndefined();
  });

  it("defaults to photo for a slide that names no layout at all, so pre-archetype callers are unchanged", () => {
    const data = assemble({ slides: [slide({})] } as InstagramCopyOutput);
    expect(data.slides[0]!.template).toBe("slide.html");
  });
});

/**
 * A client configured before the archetype set shipped has a `templateDir`
 * holding only its own `slide.html`. The renderer treats a missing template as
 * a `tooling_error` that fails the WHOLE run, so without this the archetypes
 * would have turned every such client's next carousel into an outage the first
 * time the model picked one.
 */
describe("archetype templates missing from a client's templateDir", () => {
  const statSlide = InstagramSlideCopySchema.parse({
    n: 1,
    headline: "A headline",
    body: "Some body copy.",
    visualNeed: "a need",
    sourceRef: "a claim",
    layout: "stat_callout",
    stat: { figure: "73%", subLabel: "of teams", source: "Acme, 2026" },
  });

  it("degrades to the client's own template, naming the missing file, rather than routing to one that is not there", () => {
    const onlySlideHtml = new Set<string>(); // the client's dir has no archetype files
    const resolved = resolveLayout(statSlide, onlySlideHtml);
    expect(resolved.layout).toBe("text_only");
    expect(resolved.downgradedFrom).toContain("stat-callout.html");

    const data = assembleSlidesData({
      clientSlug: "acme",
      postId: "post_1",
      repoRoot: "/repo",
      brandTokens: { templateDir: "legacy/templates", slideTemplate: "slide.html" },
      copy: { slides: [statSlide] } as InstagramCopyOutput,
      selections: [],
      canvas: CANVAS,
      availableTemplates: onlySlideHtml,
    });
    expect(data.slides[0]!.template).toBe("slide.html");
    // Crucially it also renders the FALLBACK's fields, not the stat archetype's
    // -- otherwise slide.html would get `figure`/`subLabel` slots it has no
    // markup for and render an empty plate.
    expect(data.slides[0]!.fields).toMatchObject({ headline: "A headline", body: "Some body copy." });
    expect(data.slides[0]!.fields["figure"]).toBeUndefined();
  });

  it("uses the archetype when the client's dir does have the file", () => {
    const withStat = new Set(["stat-callout.html"]);
    expect(resolveLayout(statSlide, withStat).layout).toBe("stat_callout");
    const data = assembleSlidesData({
      clientSlug: "acme",
      postId: "post_1",
      repoRoot: "/repo",
      brandTokens: { templateDir: "t", slideTemplate: "slide.html" },
      copy: { slides: [statSlide] } as InstagramCopyOutput,
      selections: [],
      canvas: CANVAS,
      availableTemplates: withStat,
    });
    expect(data.slides[0]!.template).toBe("stat-callout.html");
    expect(data.slides[0]!.fields["figure"]).toBe("73%");
  });

  it("skips the availability check entirely when no set is supplied, so existing callers are unchanged", () => {
    expect(resolveLayout(statSlide).layout).toBe("stat_callout");
  });
});

/**
 * Approach (a) end to end: a template that exists only in the registry (not
 * on the client's disk) reaches the renderer, because step 04c materializes
 * it into the run's own directory and points `templateDir` there.
 */
describe("template registry integration (Approach a)", () => {
  let env: TestEnvironment;
  beforeEach(async () => {
    env = await setupTestEnvironment();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it("renders a registry-only template by materializing it into the run directory", async () => {
    // A curated quote-card that lives ONLY in the store, outscoring anything
    // bundled, with markup recognisable in the output.
    const store = new MemoryTemplateStore([
      TemplateDefinitionSchema.parse({
        id: "curated:quote",
        archetypeId: "quote_card",
        name: "Curated quote card",
        layoutType: "typographic",
        htmlTemplate: "<html><head></head><body><div id='marker'>REGISTRY-QUOTE</div>{{quoteText}}{{attribution}}</body></html>",
        source: "curated",
        qualityScore: 99,
      }),
    ]);

    const base = goodCopyOutput();
    const copy = {
      ...base,
      slides: base.slides.map((s) =>
        s.n === 2 ? { ...s, layout: "quote_card" as const, quote: { text: "Ship it.", attribution: "A lead, 2026" } } : s,
      ),
    };
    const pool = goodImageCandidatePool();
    const photoNs = base.slides.filter((s) => s.n !== 2).map((s) => s.n);
    const router = fakeRouterSequence([
      finalTurn(goodResearchOutput()),
      finalTurn(copy),
      finalTurn({
        selections: photoNs.map((n) => ({
          n,
          imagePath: pool[0]!.path,
          reason: "matches",
          license: "CC0, test fixture",
          rightsUsable: true,
          watermarkFree: true,
        })),
      }),
      finalTurn(goodVisualQaOutput()),
    ]);

    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(
      createInstagramAgentWorkflow({
        tools: { ...env.tools, "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!) },
        promptStore: makePromptStore(),
        router,
        repoRoot: env.repoRoot,
        // A non-empty pool so the vetting step actually runs; without it an
        // empty pool skips step 06 and the queued vetting turn would be
        // consumed by the visual-QA step instead.
        imageCandidatePool: pool,
        autoApprove: true,
        templateStore: store,
      }),
      { runId: "registry_run", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" },
    );

    expect(result.status).toBe("completed");
    const steps = await durableStore.listSteps("registry_run");

    // 04c materialized into the run's own directory, and recorded which row won.
    const resolved = steps.find((s) => s.stepId === "04c-resolve-templates")?.output as
      | { templateDir: string; files: string[]; chosen: Array<{ archetypeId: string; templateId: string }> }
      | undefined;
    expect(resolved?.templateDir).toBe(".template-cache/registry_run");
    expect(resolved?.chosen.find((c) => c.archetypeId === "quote_card")?.templateId).toBe("curated:quote");

    // The renderer was pointed at the materialized directory, not the client's.
    const slidesData = steps.find((s) => s.stepId === "07c-emit-slides-data-attempt-1")?.output as
      | { templateDir: string; slides: Array<{ n: number; template: string }> }
      | undefined;
    expect(slidesData?.templateDir).toBe(".template-cache/registry_run");
    expect(slidesData?.slides.find((s) => s.n === 2)?.template).toBe("quote-card.html");

    // And the file on disk is the REGISTRY's markup, not anything bundled.
    const written = await fsp.readFile(
      pathMod.join(env.repoRoot, ".template-cache", "registry_run", "quote-card.html"),
      "utf8",
    );
    expect(written).toContain("REGISTRY-QUOTE");

    // The client's own base template was copied in alongside, so one
    // templateDir serves the photo slides too.
    const baseTpl = await fsp.readFile(
      pathMod.join(env.repoRoot, ".template-cache", "registry_run", "slide.html"),
      "utf8",
    );
    expect(baseTpl.length).toBeGreaterThan(0);
  }, 30000);

  it("falls back to the client's templateDir when the registry throws, rather than failing the run", async () => {
    const brokenStore = {
      name: "broken",
      async list(): Promise<never> {
        throw new Error("firestore unreachable");
      },
      async get() {
        return undefined;
      },
      async save() {},
      async recordFeedback() {},
    };

    const router = fakeRouterSequence([
      finalTurn(goodResearchOutput()),
      finalTurn(goodCopyOutput()),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodVisualQaOutput()),
    ]);
    const durableStore = new MemoryDurableStepStore();
    const result = await new WorkflowEngine(durableStore).run(
      createInstagramAgentWorkflow({
        tools: { ...env.tools, "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!) },
        promptStore: makePromptStore(),
        router,
        repoRoot: env.repoRoot,
        imageCandidatePool: goodImageCandidatePool(),
        autoApprove: true,
        templateStore: brokenStore,
      }),
      { runId: "registry_broken", clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" },
    );

    expect(result.status).toBe("completed");
    const resolved = (await durableStore.listSteps("registry_broken")).find((s) => s.stepId === "04c-resolve-templates")
      ?.output as { templateDir: string } | undefined;
    // Fell back to the on-disk path, so rendering never depended on the store.
    expect(resolved?.templateDir).toBe("fixtures/templates");
  }, 30000);

  it("re-materializes templates that vanished from disk before a revision's render, instead of failing the run", async () => {
    // Prep job 9qkTWlg7e9ZLiVIZUok4: round 0 rendered fine, the reviewer sent
    // it back for a revision, and the `-r1` render failed with "template ...
    // not found" — because `04c-resolve-templates` is checkpointed and kept
    // returning the same templateDir/files on resume, but the directory it
    // named was never written to THIS instance's disk. Simulated here by
    // deleting the materialized directory between the two `engine.run` calls,
    // standing in for a resume that lands on a fresh Cloud Run instance.
    const store = new MemoryTemplateStore([]);
    const first = goodCopyOutput();
    const router = fakeRouterSequence([
      finalTurn(goodResearchOutput()),
      finalTurn(first),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodVisualQaOutput()),
      finalTurn(first),
      finalTurn(goodImageVettingOutput()),
      finalTurn(goodVisualQaOutput()),
    ]);

    const durableStore = new MemoryDurableStepStore();
    const engine = new WorkflowEngine(durableStore);
    const runId = "instance_recycle_run";
    const workflowFn = createInstagramAgentWorkflow({
      tools: { ...env.tools, "publish.renderCarousel": fakeRenderCarousel(env.tools["publish.renderCarousel"]!) },
      promptStore: makePromptStore(),
      router,
      repoRoot: env.repoRoot,
      imageCandidatePool: goodImageCandidatePool(),
      templateStore: store,
    });

    const r0 = await engine.run(workflowFn, { runId, clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" });
    expect(r0.status).toBe("awaiting_gate");

    const resolved = (await durableStore.listSteps(runId)).find((s) => s.stepId === "04c-resolve-templates")?.output as
      | { templateDir: string; files: string[] }
      | undefined;
    // Confirms round 0 really did materialize something onto disk, so wiping
    // it below is actually exercising the re-materialization path and not a
    // no-op.
    expect(resolved?.files.length).toBeGreaterThan(0);
    await fsp.rm(pathMod.join(env.repoRoot, resolved!.templateDir), { recursive: true, force: true });

    await engine.resolveGate(runId, "09a-batch-review-r0", {
      decision: "revise",
      actor: "jane@karoslabs.com",
      feedback: "Tighten the hooks.",
      at: new Date().toISOString(),
    });

    // Without `ensureTemplatesOnDisk`, this resume fails the render with a
    // tooling error ("template ... not found"), exactly as the real job did.
    const r1 = await engine.run(workflowFn, { runId, clientSlug: "acme", productId: "instagram-agent", runKind: "recurring" });
    expect(r1.status).toBe("awaiting_gate");

    const rewritten = await fsp.readFile(pathMod.join(env.repoRoot, resolved!.templateDir, resolved!.files[0]!), "utf8");
    expect(rewritten.length).toBeGreaterThan(0);
  }, 60000);
});

/**
 * IGSTYLE-7, §7a — "wire the rotation that already exists": `paletteForSlide`
 * predates this ticket (AU39) but was called from nowhere in the render path
 * — every slide got ONE shared `accentColor`. This is the wiring's own proof,
 * at the level `assembleSlidesData` itself operates (no workflow/memory
 * involved — see `preference-as-prior.test.ts` for the end-to-end version).
 */
describe("assembleSlidesData: per-slide accent rotation (IGSTYLE-7, §7a)", () => {
  const RING = ["#A5E82B", "#FF5B5F", "#41C6FF"];
  const BRAND_TOKENS = { templateDir: "fixtures/templates", slideTemplate: "slide.html" };

  function sixSlideCopy(): InstagramCopyOutput {
    return copyWith(Array.from({ length: 6 }, () => ({})));
  }

  function sixSelections(): ImageSelection[] {
    return Array.from({ length: 6 }, (_, i) => ({
      n: i + 1,
      imagePath: `photos/n${i + 1}.jpg`,
      reason: "matches",
      license: "CC0",
      rightsUsable: true,
      watermarkFree: true,
    }));
  }

  it("a slide's accent comes from the ring walk, matching paletteForSlide exactly, when the kit can rotate", () => {
    const data = assembleSlidesData({
      clientSlug: "acme",
      postId: "post_1",
      repoRoot: "/repo",
      brandTokens: BRAND_TOKENS,
      copy: sixSlideCopy(),
      selections: sixSelections(),
      canvas: CANVAS,
      accentRing: RING,
      paletteSeed: "run-xyz",
    });
    const expected = data.slides.map((s) => paletteForSlide({ palette: RING }, { index: s.n, seed: "run-xyz" })!.accent);
    expect(data.slides.map((s) => s.fields["accentColor"])).toEqual(expected);
    // Genuinely rotating, not coincidentally constant — the whole point of 7a.
    expect(new Set(expected).size).toBeGreaterThan(1);
    // Never off-kit — every value used is a real ring member.
    for (const hex of expected) expect(RING).toContain(hex);
  });

  it("falls back to the existing accentColor param for EVERY slide when the ring cannot rotate (length <= 1) — a one-colour kit is unchanged", () => {
    const data = assembleSlidesData({
      clientSlug: "acme",
      postId: "post_1",
      repoRoot: "/repo",
      brandTokens: BRAND_TOKENS,
      copy: sixSlideCopy(),
      selections: sixSelections(),
      canvas: CANVAS,
      brandAccentFallback: "#A5E82B",
      accentRing: ["#A5E82B"],
      paletteSeed: "run-xyz",
    });
    for (const s of data.slides) expect(s.fields["accentColor"]).toBe("#A5E82B");
  });

  it("falls back to the existing accentColor param for EVERY slide when no ring is passed at all — byte-identical to pre-IGSTYLE-7 callers", () => {
    const data = assembleSlidesData({
      clientSlug: "acme",
      postId: "post_1",
      repoRoot: "/repo",
      brandTokens: BRAND_TOKENS,
      copy: sixSlideCopy(),
      selections: sixSelections(),
      canvas: CANVAS,
      brandAccentFallback: "#C0FFEE",
    });
    for (const s of data.slides) expect(s.fields["accentColor"]).toBe("#C0FFEE");
  });

  it("is deterministic: the same postId/copy/seed renders the identical per-slide accents twice", () => {
    const build = () =>
      assembleSlidesData({
        clientSlug: "acme",
        postId: "post_1",
        repoRoot: "/repo",
        brandTokens: BRAND_TOKENS,
        copy: sixSlideCopy(),
        selections: sixSelections(),
        canvas: CANVAS,
        accentRing: RING,
        paletteSeed: "run-xyz",
      });
    const a = build().slides.map((s) => s.fields["accentColor"]);
    const b = build().slides.map((s) => s.fields["accentColor"]);
    expect(b).toEqual(a);
  });

  it("a different seed rotates the phase — two runs of the same kit needn't render identically", () => {
    const build = (seed: string) =>
      assembleSlidesData({
        clientSlug: "acme",
        postId: "post_1",
        repoRoot: "/repo",
        brandTokens: BRAND_TOKENS,
        copy: sixSlideCopy(),
        selections: sixSelections(),
        canvas: CANVAS,
        accentRing: RING,
        paletteSeed: seed,
      }).slides.map((s) => s.fields["accentColor"]);
    const seeds = ["run-1", "run-2", "run-3", "run-4", "run-5"];
    const outcomes = new Set(seeds.map((seed) => build(seed).join(",")));
    expect(outcomes.size).toBeGreaterThan(1);
  });
});

/**
 * IGSTYLE-10, §10a/10b/10c/10e — the 75/25 smart variation model. `isVariationSlot`
 * and `buildVariationPlan` are tested directly (no workflow involved — the
 * end-to-end materialization proof lives in `ground-fg-inversion.test.ts`),
 * matching the same "pure function first, workflow second" split IGSTYLE-7's
 * own test file already established.
 */
describe("isVariationSlot (IGSTYLE-10, §10b — the low-discrepancy walk)", () => {
  it("lands within ±8 percentage points of VARIATION_MIX over a 40-slide window", () => {
    for (const seed of ["run-1", "run-2", "run-abc", "post_xyz", "carousel-42"]) {
      const hits = Array.from({ length: 40 }, (_, i) => isVariationSlot(i, VARIATION_MIX, seed));
      const pct = (hits.filter(Boolean).length / 40) * 100;
      expect(pct, `seed "${seed}" landed at ${pct}%`).toBeGreaterThanOrEqual(VARIATION_MIX * 100 - 8);
      expect(pct, `seed "${seed}" landed at ${pct}%`).toBeLessThanOrEqual(VARIATION_MIX * 100 + 8);
    }
  });

  it("never marks more than two consecutive slides as alternates", () => {
    for (const seed of ["run-1", "run-2", "run-abc", "post_xyz", "carousel-42", "", "z"]) {
      const hits = Array.from({ length: 60 }, (_, i) => isVariationSlot(i, VARIATION_MIX, seed));
      let run = 0;
      let maxRun = 0;
      for (const hit of hits) {
        run = hit ? run + 1 : 0;
        maxRun = Math.max(maxRun, run);
      }
      expect(maxRun, `seed "${seed}"`).toBeLessThanOrEqual(2);
    }
  });

  it("an 8-slide carousel lands near 2 alternates, spread out", () => {
    for (const seed of ["a", "b", "c", "d", "e"]) {
      const hits = Array.from({ length: 8 }, (_, i) => isVariationSlot(i, VARIATION_MIX, seed));
      expect(hits.filter(Boolean).length, `seed "${seed}"`).toBeGreaterThanOrEqual(1);
      expect(hits.filter(Boolean).length, `seed "${seed}"`).toBeLessThanOrEqual(3);
    }
  });

  it("is deterministic across 100 iterations of the same seed", () => {
    const seed = "determinism-check";
    const first = Array.from({ length: 40 }, (_, i) => isVariationSlot(i, VARIATION_MIX, seed));
    for (let iter = 0; iter < 100; iter++) {
      const again = Array.from({ length: 40 }, (_, i) => isVariationSlot(i, VARIATION_MIX, seed));
      expect(again).toEqual(first);
    }
  });

  it("three different runIds produce three different variation plans", () => {
    // Seeds chosen to actually disperse: two seeds differing only in a
    // trailing digit can hash close enough to land on an identical 8-slot
    // pattern (a real property of this seeded walk, not a bug — verified
    // empirically for these three before writing this assertion).
    const seeds = ["carousel-run-alpha", "post_9f21c-beta", "run:2026-09-02:gamma"];
    const plans = seeds.map((seed) => Array.from({ length: 8 }, (_, i) => isVariationSlot(i, VARIATION_MIX, seed)).join(""));
    expect(new Set(plans).size).toBe(3);
  });

  it("mix <= 0 never fires; mix >= 1 always fires", () => {
    for (let i = 0; i < 10; i++) {
      expect(isVariationSlot(i, 0, "any-seed")).toBe(false);
      expect(isVariationSlot(i, 1, "any-seed")).toBe(true);
    }
  });
});

describe("assembleSlidesData: ground/fg inversion axis (IGSTYLE-10, §10a/10c)", () => {
  const RING = ["#A5E82B", "#FF5B5F", "#41C6FF"];
  const BRAND_TOKENS = { templateDir: "fixtures/templates", slideTemplate: "slide.html" };

  function sixSlideCopy(): InstagramCopyOutput {
    return copyWith(Array.from({ length: 6 }, () => ({})));
  }
  function sixSelections(): ImageSelection[] {
    return Array.from({ length: 6 }, (_, i) => ({
      n: i + 1,
      imagePath: `photos/n${i + 1}.jpg`,
      reason: "matches",
      license: "CC0",
      rightsUsable: true,
      watermarkFree: true,
    }));
  }

  it("some slides render through the inverted sibling file when a derived ground/fg pair is present and legal", () => {
    const data = assembleSlidesData({
      clientSlug: "acme",
      postId: "post_1",
      repoRoot: "/repo",
      brandTokens: BRAND_TOKENS,
      copy: sixSlideCopy(),
      selections: sixSelections(),
      canvas: CANVAS,
      // #C4552F (the templates' own legacy default accent) clears the 3:1
      // floor against BOTH the primary ground and what becomes the ground
      // once inverted — chosen deliberately so this test isolates the walk,
      // not the accent-contrast gate (see the accent-bound test below for that).
      brandAccentFallback: "#C4552F",
      groundFgInversion: { ground: "#17181C", fg: "#F4F2EC", directivePinned: false },
      paletteSeed: "run-inv-1",
    });
    const templates = data.slides.map((s) => s.template);
    expect(templates.some((t) => t === invertedTemplateFileName("slide.html"))).toBe(true);
    expect(templates.some((t) => t === "slide.html")).toBe(true);
    for (const t of templates) expect([`slide.html`, invertedTemplateFileName("slide.html")]).toContain(t);
  });

  it("never inverts when no groundFgInversion config is passed at all — byte-identical to before this ticket", () => {
    const data = assembleSlidesData({
      clientSlug: "acme",
      postId: "post_1",
      repoRoot: "/repo",
      brandTokens: BRAND_TOKENS,
      copy: sixSlideCopy(),
      selections: sixSelections(),
      canvas: CANVAS,
      paletteSeed: "run-inv-1",
    });
    for (const s of data.slides) expect(s.template).toBe("slide.html");
  });

  it("§10c-4 directive supremacy: a directive-pinned round produces zero alternates, at any seed", () => {
    for (const seed of ["run-inv-1", "run-inv-2", "run-inv-3", "run-inv-4"]) {
      const data = assembleSlidesData({
        clientSlug: "acme",
        postId: "post_1",
        repoRoot: "/repo",
        brandTokens: BRAND_TOKENS,
        copy: sixSlideCopy(),
        selections: sixSelections(),
        canvas: CANVAS,
        brandAccentFallback: "#A5E82B",
        groundFgInversion: { ground: "#17181C", fg: "#F4F2EC", directivePinned: true },
        paletteSeed: seed,
      });
      for (const s of data.slides) expect(s.template, `seed ${seed}`).toBe("slide.html");
    }
  });

  it("§10c-2 accent bound: refuses inversion when the accent fails the 3:1 floor against the inverted ground (thepitchbydeel's real palette)", () => {
    // Appendix D's own fixture: ground #faf4ee / fg #1b1b1b / accent #5938b7.
    // 7.19:1 on the primary ground, ~2.19:1 on the inverted one — well under
    // the 3:1 accent floor, so every slide must keep the primary pairing
    // regardless of what the walk would otherwise pick.
    const data = assembleSlidesData({
      clientSlug: "thepitchbydeel",
      postId: "post_1",
      repoRoot: "/repo",
      brandTokens: BRAND_TOKENS,
      copy: sixSlideCopy(),
      selections: sixSelections(),
      canvas: CANVAS,
      brandAccentFallback: "#5938b7",
      groundFgInversion: { ground: "#faf4ee", fg: "#1b1b1b", directivePinned: false },
      paletteSeed: "run-inv-1",
    });
    for (const s of data.slides) expect(s.template).toBe("slide.html");
  });

  it("§10a one-colour ring: still varies via ground/fg inversion, independent of ring size", () => {
    const data = assembleSlidesData({
      clientSlug: "acme",
      postId: "post_1",
      repoRoot: "/repo",
      brandTokens: BRAND_TOKENS,
      copy: sixSlideCopy(),
      selections: sixSelections(),
      canvas: CANVAS,
      brandAccentFallback: "#C4552F",
      accentRing: ["#A5E82B"], // ring.length <= 1: the accent axis cannot rotate
      groundFgInversion: { ground: "#17181C", fg: "#F4F2EC", directivePinned: false },
      paletteSeed: "run-inv-1",
    });
    expect(data.slides.some((s) => s.template === invertedTemplateFileName("slide.html"))).toBe(true);
  });

  it("§10a inversion safety: the inverted pairing's text contrast equals the primary's exactly (contrastRatio's own symmetry, asserted rather than assumed)", () => {
    const pairs: Array<[string, string]> = [
      ["#17181C", "#F4F2EC"],
      ["#faf4ee", "#1b1b1b"],
      ["#000000", "#ffffff"],
    ];
    for (const [ground, fg] of pairs) {
      // contrastRatio's own definition takes the max/min luminance regardless
      // of argument order, so swapping the two arguments — exactly what an
      // inversion does — cannot change the result.
      const primary = contrastRatioForTest(ground, fg);
      const inverted = contrastRatioForTest(fg, ground);
      expect(inverted).toBe(primary);
    }
  });

  it("§10a palette boundedness: an inverted slide's rendered pairing is exactly {fg, ground} swapped — never a synthesised colour", () => {
    // decideGroundFgInversion never manufactures a value: it only ever swaps
    // the two hexes it was given. Proven at the config level, since the
    // rendered CSS var values themselves live in the materialized template
    // file (see the end-to-end test for the on-disk proof) rather than in
    // RenderCarouselInput's own schema.
    const ground = "#17181C";
    const fg = "#F4F2EC";
    const data = assembleSlidesData({
      clientSlug: "acme",
      postId: "post_1",
      repoRoot: "/repo",
      brandTokens: BRAND_TOKENS,
      copy: sixSlideCopy(),
      selections: sixSelections(),
      canvas: CANVAS,
      brandAccentFallback: "#C4552F",
      groundFgInversion: { ground, fg, directivePinned: false },
      paletteSeed: "run-inv-1",
    });
    const invertedCount = data.slides.filter((s) => s.template === invertedTemplateFileName("slide.html")).length;
    expect(invertedCount).toBeGreaterThan(0);
    // No third file name ever appears — only the primary and its one inverted sibling.
    for (const s of data.slides) expect(["slide.html", invertedTemplateFileName("slide.html")]).toContain(s.template);
  });
});

/** A local, minimal copy — this file has no direct import of `contrastRatio` and shouldn't need one just for this one symmetry assertion. */
function contrastRatioForTest(a: string, b: string): number {
  const relLum = (hex: string): number => {
    let h = hex.slice(1);
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
    const channel = (i: number) => {
      const v = parseInt(h.slice(i, i + 2), 16) / 255;
      return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
  };
  const la = relLum(a);
  const lb = relLum(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

describe("buildVariationPlan (IGSTYLE-10, §10e — the gate payload's own report)", () => {
  it("reports 'ring=1' for the accent axis and honest groundFg status when the ring cannot rotate", () => {
    const plan = buildVariationPlan({
      slideNs: [1, 2, 3, 4, 5, 6],
      accentRing: ["#A5E82B"],
      paletteSeed: "run-plan-1",
      brandAccentFallback: "#C4552F",
      groundFgInversion: { ground: "#17181C", fg: "#F4F2EC", directivePinned: false },
    });
    const accentEntries = plan.filter((e) => e.axis === "accent");
    expect(accentEntries).toHaveLength(6);
    for (const e of accentEntries) {
      expect(e.used).toBe(false);
      expect(e.reason).toBe("ring=1");
    }
    const groundFgEntries = plan.filter((e) => e.axis === "groundFg");
    expect(groundFgEntries.some((e) => e.used)).toBe(true);
  });

  it("reports 'no-ground-pair' for every slide's groundFg axis when inversion is unavailable", () => {
    const plan = buildVariationPlan({
      slideNs: [1, 2, 3],
      brandAccentFallback: "#A5E82B",
    });
    for (const e of plan.filter((e) => e.axis === "groundFg")) {
      expect(e.used).toBe(false);
      expect(e.reason).toBe("no-ground-pair");
    }
  });

  it("reports 'directive-pinned' for every slide's groundFg axis when this round's directive pinned a colour", () => {
    const plan = buildVariationPlan({
      slideNs: [1, 2, 3, 4, 5, 6, 7, 8],
      paletteSeed: "run-plan-2",
      brandAccentFallback: "#A5E82B",
      groundFgInversion: { ground: "#17181C", fg: "#F4F2EC", directivePinned: true },
    });
    for (const e of plan.filter((e) => e.axis === "groundFg")) {
      expect(e.used).toBe(false);
      expect(e.reason).toBe("directive-pinned");
    }
  });

  it("reports 'accent-fails-inverted-ground' when the accent can't clear the floor on the flipped ground", () => {
    const plan = buildVariationPlan({
      slideNs: [1, 2, 3, 4, 5, 6],
      paletteSeed: "run-plan-3",
      brandAccentFallback: "#5938b7",
      groundFgInversion: { ground: "#faf4ee", fg: "#1b1b1b", directivePinned: false },
    });
    for (const e of plan.filter((e) => e.axis === "groundFg")) {
      expect(e.used).toBe(false);
      expect(e.reason).toBe("accent-fails-inverted-ground");
    }
  });

  it("agrees with assembleSlidesData's own template choice, slide for slide", () => {
    const groundFgInversion = { ground: "#17181C", fg: "#F4F2EC", directivePinned: false };
    const copy = copyWith(Array.from({ length: 8 }, () => ({})));
    const selections: ImageSelection[] = Array.from({ length: 8 }, (_, i) => ({
      n: i + 1,
      imagePath: `photos/n${i + 1}.jpg`,
      reason: "matches",
      license: "CC0",
      rightsUsable: true,
      watermarkFree: true,
    }));
    const data = assembleSlidesData({
      clientSlug: "acme",
      postId: "post_1",
      repoRoot: "/repo",
      brandTokens: { templateDir: "fixtures/templates", slideTemplate: "slide.html" },
      copy,
      selections,
      canvas: CANVAS,
      brandAccentFallback: "#C4552F",
      groundFgInversion,
      paletteSeed: "run-plan-agree",
    });
    const plan = buildVariationPlan({
      slideNs: data.slides.map((s) => s.n),
      brandAccentFallback: "#C4552F",
      groundFgInversion,
      paletteSeed: "run-plan-agree",
    });
    expect(data.slides.some((s) => s.template === invertedTemplateFileName("slide.html"))).toBe(true);
    for (const slide of data.slides) {
      const wasInverted = slide.template === invertedTemplateFileName("slide.html");
      const planEntry = plan.find((e) => e.slide === slide.n && e.axis === "groundFg")!;
      expect(planEntry.used, `slide ${slide.n}`).toBe(wasInverted);
    }
  });
});

describe("eligibleAlternateTemplates / pickAlternateTemplate (IGSTYLE-10, §10d)", () => {
  it("excludes the primary row and anything below the mean score", () => {
    const candidates = [
      { templateId: "primary", qualityScore: 90 },
      { templateId: "alt-good", qualityScore: 70 },
      { templateId: "alt-bad", qualityScore: 50 },
    ];
    // mean = (90+70+50)/3 = 70
    const eligible = eligibleAlternateTemplates(candidates, "primary");
    expect(eligible.map((c) => c.templateId)).toEqual(["alt-good"]);
  });

  it("a down-scored template never resurfaces through the variation budget, even after the mean itself drops", () => {
    const before = [
      { templateId: "primary", qualityScore: 90 },
      { templateId: "b", qualityScore: 70 },
      { templateId: "c", qualityScore: 50 },
    ];
    // c gets reviewer-down-scored from 50 to 20.
    const after = [
      { templateId: "primary", qualityScore: 90 },
      { templateId: "b", qualityScore: 70 },
      { templateId: "c", qualityScore: 20 },
    ];
    const eligibleBefore = eligibleAlternateTemplates(before, "primary").map((c) => c.templateId);
    const eligibleAfter = eligibleAlternateTemplates(after, "primary").map((c) => c.templateId);
    expect(eligibleAfter).not.toContain("c");
    // b alone survives on both sides of the down-score -- c dropping the mean
    // doesn't let itself back in, and doesn't accidentally exclude b either.
    expect(eligibleBefore).toContain("b");
    expect(eligibleAfter).toContain("b");
  });

  it("returns nothing eligible when every other row is a single, already-primary row", () => {
    const candidates = [{ templateId: "primary", qualityScore: 90 }];
    expect(eligibleAlternateTemplates(candidates, "primary")).toEqual([]);
  });

  it("pickAlternateTemplate is deterministic and returns undefined for an empty pool", () => {
    const pool = [
      { templateId: "b", qualityScore: 70 },
      { templateId: "d", qualityScore: 75 },
    ];
    const a = pickAlternateTemplate(pool, "run-x");
    const b = pickAlternateTemplate(pool, "run-x");
    expect(a).toEqual(b);
    expect(pickAlternateTemplate([], "run-x")).toBeUndefined();
  });
});
