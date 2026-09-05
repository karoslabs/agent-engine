import type { AgentContext, AgentToolRegistry, GateVerdict } from "@agent-engine/core";
import { WorkflowToolingFailure } from "@agent-engine/workflow";
import type { RenderCarouselInput, Slide } from "@agent-engine/tool-karos-publish";
import { templateFileName } from "@agent-engine/tool-karos-templates";
import { contrastRatio, paletteForSlide } from "./brand-render-tokens.js";
import type {
  BrandTokens,
  ImageSelection,
  InstagramCopyOutput,
  InstagramSlideCopy,
  InstagramSlideLayout,
  ResearchOutput,
  SlidesDataSelfCheck,
  StyleConfig,
} from "./types.js";

/**
 * Which template file each archetype renders through.
 *
 * `photo` and `text_only` both resolve to the client's own configured
 * `slideTemplate` — that file renders correctly with or without a hero image
 * (see its doc comment), and it is the guaranteed-delivery floor, so it stays
 * exactly where it was. The five ported archetypes have their own files in the
 * same `templateDir`, so a client with a bespoke `templateDir` needs the whole
 * set present to use them; `LAYOUT_TEMPLATE_FILES` is the list to copy.
 */
const LAYOUT_TEMPLATE_FILES: Record<Exclude<InstagramSlideLayout, "photo" | "text_only" | "custom">, string> = {
  stat_callout: "stat-callout.html",
  quote_card: "quote-card.html",
  comparison_card: "comparison-card.html",
  list_takeaway: "list-takeaway.html",
  headline_focus: "headline-focus.html",
};

function templateForLayout(layout: InstagramSlideLayout, slide: InstagramSlideCopy, clientTemplate: string): string {
  if (layout === "photo" || layout === "text_only") return clientTemplate;
  if (layout === "custom") return templateFileName(slide.customArchetype!.archetypeId);
  return LAYOUT_TEMPLATE_FILES[layout];
}

/** The five archetype template filenames, for a caller checking which of them a `templateDir` actually holds. */
export const ARCHETYPE_TEMPLATE_FILES: readonly string[] = Object.values(LAYOUT_TEMPLATE_FILES);

// ─────────────────────────────────────────────────────────────────────────
// IGSTYLE-10, §10a/10b/10c/10e — smart template & palette variation.
//
// Two independent axes decide, per slide, whether it renders with the
// client's PRIMARY ground/fg pairing (the common case) or an ALTERNATIVE one:
//
//   groundFg — swap which derived neutral is the ground. Safe for text
//     legibility by construction (`contrastRatio` is symmetric — an inverted
//     pair has EXACTLY the primary pair's text contrast), but can break the
//     accent's OWN legibility against the new ground, so it is checked
//     per slide against that slide's already-resolved accent (see
//     `decideGroundFgInversion` below). Works for any client with a derived
//     ground/fg pair — 7 of 7 real clients, per the ticket's own fleet audit.
//
//   accent — `paletteForSlide` (7a) already walks the ring every slide; nothing
//     new is decided here, this section only REPORTS its `rotates` outcome
//     into the same `variationPlan` shape, so a one-colour-ring client's
//     "nothing to vary here" is as visible as the groundFg axis's own.
//
// Both axes are pure functions of (index, seed) — see `paletteForSlide`'s own
// "SEEDED, NOT RANDOM" contract, which this generalises from a ring position
// to a proportion.
// ─────────────────────────────────────────────────────────────────────────

/**
 * The target share of slides that render with the ALTERNATIVE pairing rather
 * than the client's primary one. 75/25 is the ticket's own stated ratio
 * (§10b) — named so nobody mistakes it for a tunable knob at a call site.
 */
export const VARIATION_MIX = 0.25;

/**
 * (sqrt(5)-1)/2 — the golden ratio's conjugate, the real number classically
 * used to build a low-discrepancy (Weyl/additive-recurrence) sequence: adding
 * it modulo 1 on every step equidistributes over any window (so a long
 * carousel's alternate rate converges on `VARIATION_MIX`) and, by the
 * three-distance theorem, the gaps between any two "alternative" hits take
 * only two nearby sizes — for a mix at or below 0.5 that rules out two
 * alternates landing back to back, which is exactly §10b's "spread out, not a
 * per-slide coin flip" requirement. `paletteForSlide`'s ring walk is a
 * simpler case of the same idea (a seeded position per index); this
 * generalises it to a seeded PROPORTION.
 */
const GOLDEN_RATIO_CONJUGATE = 0.6180339887498949;

/**
 * FNV-1a 32-bit — a byte-identical copy of `brand-render-tokens.ts`'s own
 * private hash, duplicated rather than imported so this ticket's diff stays
 * inside the files IGSTYLE-10 actually needs to touch (its own §2.1 file
 * list does not include `brand-render-tokens.ts`). Pure, no clock, no
 * randomness — the seed is the only input, same contract as the original.
 */
function fnv1a32ForVariation(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Whether slide `index` draws the ALTERNATIVE pairing under the seeded
 * low-discrepancy walk described above. A pure function of `(index, mix,
 * seed)` — same seed and index always agree; a different seed (a different
 * run) starts the walk at a different phase, so WHICH slides land in the
 * mix varies across posts without ever varying within a re-render of the
 * same one (determinism, acceptance criterion 2; cross-run variety,
 * criterion 3).
 */
export function isVariationSlot(index: number, mix: number, seed: string): boolean {
  if (mix <= 0) return false;
  if (mix >= 1) return true;
  const phase = seed.length > 0 ? fnv1a32ForVariation(seed) / 0x100000000 : 0;
  const i = Number.isFinite(index) ? index : 0;
  const position = (phase + i * GOLDEN_RATIO_CONJUGATE) % 1;
  return position < mix;
}

/**
 * The floor an accent must clear against whatever ground it actually renders
 * on. A byte-identical copy of `brand-render-tokens.ts`'s own private
 * `ACCENT_GROUND_CONTRAST_FLOOR` — duplicated for the same "stay inside
 * IGSTYLE-10's own file list" reason as `fnv1a32ForVariation` above. §10c-2:
 * this is the constraint that actually bites on inversion — flipping the
 * ground changes accent contrast even though text contrast (checked by
 * construction, see the module doc comment above) cannot regress.
 */
const INVERTED_ACCENT_GROUND_CONTRAST_FLOOR = 3;

/**
 * The suffix an inverted-variant template file carries, inserted before the
 * extension. Exported so `create-instagram-agent-workflow.ts`'s own
 * materialization step can recognise (and skip re-inverting) a file this
 * naming already produced, without duplicating the literal string.
 */
export const INVERTED_TEMPLATE_SUFFIX = "-inv";

/**
 * The filename an archetype's ground/fg-INVERTED variant materializes as,
 * sibling to the primary file in the same `templateDir` — `Slide.template`
 * is a path resolved against ONE shared `templateDir` for the whole
 * carousel (`publish.renderCarousel`'s own contract), so an inverted variant
 * has to live beside the primary file, not in a different directory.
 */
export function invertedTemplateFileName(primaryFile: string): string {
  const dot = primaryFile.lastIndexOf(".");
  return dot === -1 ? `${primaryFile}${INVERTED_TEMPLATE_SUFFIX}` : `${primaryFile.slice(0, dot)}${INVERTED_TEMPLATE_SUFFIX}${primaryFile.slice(dot)}`;
}

/** §10a — this round's derived ground/fg pair, and whether variation is even on the table this round. */
export interface GroundFgInversionConfig {
  /** The effective kit's `--bg` — what an inverted slide's fg becomes. */
  ground: string;
  /** The effective kit's `--fg` — what an inverted slide's ground becomes. */
  fg: string;
  /**
   * §10c-4 — true when THIS round's active reviewer directive (Layer 2)
   * pinned any colour at all. Suppresses inversion entirely for the round:
   * a person who just said "make it dark" must not get 25% light slides.
   * Never suppresses the accent axis (7a) — that shipped, unconditional,
   * before this ticket and IGSTYLE-10 does not revisit it.
   */
  directivePinned: boolean;
}

/** One axis's status for one slide, for the gate payload's `variationPlan` (§10e). */
export interface VariationPlanEntry {
  slide: number;
  axis: "groundFg" | "accent";
  used: boolean;
  /** Present only when `used` is false AND there's a specific reason to name — never invented for the ordinary "nothing to report" case. */
  reason?: "ring=1" | "accent-fails-inverted-ground" | "directive-pinned" | "no-ground-pair";
}

/** The accent one slide actually renders with, and whether that came from a genuine rotation — shared by `assembleSlidesData` and `buildVariationPlan` so the two can never disagree about what a slide's accent is. */
function resolveSlideAccent(
  index: number,
  accentRing: string[] | undefined,
  paletteSeed: string | undefined,
  fallbackAccent: string,
): { accent: string; rotates: boolean } {
  const slidePalette =
    accentRing !== undefined ? paletteForSlide({ palette: accentRing }, { index, ...(paletteSeed !== undefined ? { seed: paletteSeed } : {}) }) : undefined;
  return slidePalette?.rotates === true ? { accent: slidePalette.accent, rotates: true } : { accent: fallbackAccent, rotates: false };
}

/**
 * §10a/10c — whether slide `index` inverts its ground/fg pairing, and why
 * not when it doesn't. The walk is seeded from `paletteSeed`, namespaced
 * (`:groundFg`) so this axis's phase needn't coincide with the accent axis's
 * own walk over the same seed.
 */
function decideGroundFgInversion(
  index: number,
  paletteSeed: string | undefined,
  slideAccent: string,
  config: GroundFgInversionConfig | undefined,
): { used: boolean; reason?: VariationPlanEntry["reason"] } {
  if (config === undefined) return { used: false, reason: "no-ground-pair" };
  if (config.directivePinned) return { used: false, reason: "directive-pinned" };
  // §10c-2: the constraint that actually bites — the accent must still clear
  // the floor against what BECOMES the ground once inverted (today's fg).
  // Checked BEFORE the walk (not after): the accent itself can vary per
  // slide (7a's own ring walk), so whether inversion is even legal is a
  // per-slide fact, and a slide whose accent genuinely can't clear the
  // floor should say so regardless of whether the walk would have picked it
  // — the walk deciding "not this slide's turn" is the only case honestly
  // reported as no reason at all.
  if (contrastRatio(slideAccent, config.fg) < INVERTED_ACCENT_GROUND_CONTRAST_FLOOR) {
    return { used: false, reason: "accent-fails-inverted-ground" };
  }
  if (!isVariationSlot(index, VARIATION_MIX, `${paletteSeed ?? ""}:groundFg`)) return { used: false };
  return { used: true };
}

/**
 * The gate payload's own §10e report: which axis each slide used, and why
 * not when it didn't. Deliberately standalone rather than folded into
 * `assembleSlidesData`'s return value — `RenderCarouselInput` is
 * `publish.renderCarousel`'s exact input contract (RFC-03 §1), not a place
 * to smuggle reporting metadata — but built from the SAME pure per-slide
 * decisions `assembleSlidesData` itself uses, so the two can never drift
 * apart on what a slide actually rendered with.
 */
export function buildVariationPlan(params: {
  slideNs: readonly number[];
  accentRing?: string[] | undefined;
  paletteSeed?: string | undefined;
  /** The same fallback `assembleSlidesData` resolves to for a non-rotating slide. */
  brandAccentFallback: string;
  groundFgInversion?: GroundFgInversionConfig | undefined;
}): VariationPlanEntry[] {
  const plan: VariationPlanEntry[] = [];
  for (const n of params.slideNs) {
    const { accent, rotates } = resolveSlideAccent(n, params.accentRing, params.paletteSeed, params.brandAccentFallback);
    plan.push({ slide: n, axis: "accent", used: rotates, ...(rotates ? {} : { reason: "ring=1" as const }) });

    const groundFg = decideGroundFgInversion(n, params.paletteSeed, accent, params.groundFgInversion);
    plan.push({ slide: n, axis: "groundFg", used: groundFg.used, ...(groundFg.reason !== undefined ? { reason: groundFg.reason } : {}) });
  }
  return plan;
}

// ─────────────────────────────────────────────────────────────────────────
// IGSTYLE-10, §10d — template/layout variation, drawing on the SAME
// distribution as §10a/10b (`VARIATION_MIX`, the same low-discrepancy walk)
// but applied to WHICH registry row an archetype renders through, reusing
// the template registry's own `qualityScore` rather than inventing a
// separate mechanism.
// ─────────────────────────────────────────────────────────────────────────

/** The one field this axis needs from a `TemplateDefinition` row — kept minimal so this file doesn't need to import the registry's own type. */
export interface TemplateScoreCandidate {
  templateId: string;
  qualityScore: number;
}

/**
 * Which of an archetype's OTHER rows the variation budget may draw from:
 * every candidate at or above the mean score of every row the registry
 * offered for this archetype, excluding whichever row is already the
 * primary (`resolveBest`'s own winner). A reviewer's down-score moves both
 * the row's own score AND the mean it's compared against, but never lets a
 * downgraded row back in just because the whole set fell with it — it must
 * still clear the (possibly-lowered) bar on its own merits.
 */
export function eligibleAlternateTemplates(allCandidates: readonly TemplateScoreCandidate[], primaryTemplateId: string): TemplateScoreCandidate[] {
  if (allCandidates.length === 0) return [];
  const mean = allCandidates.reduce((sum, c) => sum + c.qualityScore, 0) / allCandidates.length;
  return allCandidates.filter((c) => c.templateId !== primaryTemplateId && c.qualityScore >= mean);
}

/**
 * Seeded pick among the eligible pool — deterministic, never random, same
 * contract as every other seeded choice in this module. `undefined` when
 * there is nothing eligible (a single-row archetype, or every other row
 * already below the mean), which the caller reads as "this archetype has no
 * alternative to offer" and keeps the primary row for every slide.
 */
export function pickAlternateTemplate(eligible: readonly TemplateScoreCandidate[], seed: string): TemplateScoreCandidate | undefined {
  if (eligible.length === 0) return undefined;
  const idx = fnv1a32ForVariation(`${seed}:template-alt`) % eligible.length;
  return eligible[idx];
}

/**
 * Hebrew, Arabic, and their presentation-form/extended Unicode blocks — the
 * RTL scripts a client's copy has actually shown up in (prep job
 * `9qkTWlg7e9ZLiVIZUok4`: a Hebrew brand-voice client whose carousel rendered
 * left-to-right). Every template is LTR by default and `{{dir}}` only ever
 * adds `dir="rtl"`, never overrides to `dir="ltr"` explicitly, so detection
 * only has to answer "is this RTL", not classify every script by name.
 */
const RTL_SCRIPT = /[\p{Script=Hebrew}\p{Script=Arabic}]/gu;
const LATIN_LETTER = /[A-Za-z]/g;

/**
 * The carousel's language is whatever the copy model actually wrote, not a
 * client-config field nobody threads through here — the same reasoning
 * `buildClientVoiceContext`'s "write entirely in that language" prompt rule
 * rests on. Counting characters rather than testing "contains any RTL
 * character at all" avoids a false positive from one Hebrew brand name or
 * hashtag sitting inside an otherwise-English post.
 */
function detectDirection(text: string): "rtl" | "ltr" {
  const rtl = text.match(RTL_SCRIPT)?.length ?? 0;
  const latin = text.match(LATIN_LETTER)?.length ?? 0;
  return rtl > latin ? "rtl" : "ltr";
}

/** Every user-visible string a slide can carry, across every archetype — the corpus `detectDirection` reads. */
function collectSlideText(slide: InstagramSlideCopy): string {
  return [
    slide.headline,
    slide.body,
    slide.kicker,
    slide.quote?.text,
    slide.quote?.attribution,
    slide.stat?.figure,
    slide.stat?.subLabel,
    slide.stat?.source,
    slide.comparison?.leftLabel,
    slide.comparison?.leftBody,
    slide.comparison?.rightLabel,
    slide.comparison?.rightBody,
    ...(slide.items?.flatMap((item) => [item.title, item.note]) ?? []),
    ...(slide.customArchetype ? Object.values(slide.customArchetype.fields) : []),
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
}

/**
 * Escapes a value for interpolation into a `{{html:...}}` fragment.
 *
 * Mirrors `escapeHtmlText` in `karos-publish` rather than importing it, so
 * this file's own fragment builders cannot silently lose escaping if that
 * export moves. The `{{html:}}` substitution form is deliberately NOT escaped
 * by the renderer — that is the whole point of it — which makes escaping here
 * the only thing standing between model-authored takeaway text and live markup
 * in a rendered slide.
 */
function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Builds `list_takeaway`'s rows as one markup fragment.
 *
 * `publish.renderCarousel` substitutes flat strings and has no loop
 * construct, so a variable number of rows has to be assembled by the caller.
 * The row shape matches `list-takeaway.html`'s CSS exactly (`.me-row` >
 * `.diamond` + div > `.me-title` + `.me-note`), and the separator rules come
 * from `border-top` with `:first-child` zeroed, so nothing conditional is
 * needed per row.
 */
export function buildListRows(items: readonly { title: string; note?: string | undefined }[]): string {
  return items
    .map(
      (item) =>
        `<div class="me-row"><span class="diamond"></span><div>` +
        `<div class="me-title">${esc(item.title)}</div>` +
        `<div class="me-note">${item.note ? esc(item.note) : ""}</div>` +
        `</div></div>`,
    )
    .join("");
}

/**
 * The archetype this slide can actually be rendered as, which is not always
 * the one it asked for.
 *
 * The copy model picks `layout` and fills the matching content block, and
 * those are two independent chances to be inconsistent — it can name
 * `stat_callout` and then omit `stat`. Rendering that as requested produces a
 * slide with an empty 300px figure, which is worse than any honest
 * alternative, so a request whose content is missing falls back to
 * `text_only`: the one archetype whose inputs (`headline`, `body`) every
 * slide is schema-guaranteed to have.
 *
 * Returning the reason alongside it, rather than logging and discarding it,
 * is what lets the workflow checkpoint WHY a slide it asked to be a quote card
 * came out as plain type — otherwise that difference is invisible in the trace
 * and reads as the model never having chosen an archetype at all.
 */
export function resolveLayout(
  slide: InstagramSlideCopy,
  /**
   * Which template files the run's `templateDir` actually contains. Omit to
   * skip the check entirely (every caller that only cares about content
   * completeness, and every test that is not about a bespoke templateDir).
   *
   * This exists because a client configured before the archetype set shipped
   * has a `templateDir` holding only its own `slide.html`. Routing a slide to
   * `stat-callout.html` there is a `tooling_error` from the renderer ("a
   * missing template is a tooling failure, not a content one") that fails the
   * WHOLE run — so the archetypes would have turned every such client's next
   * carousel into an outage the first time the model picked one. Degrading to
   * the client's own template instead keeps the run shipping, which is the
   * same guaranteed-delivery rule the rest of this pipeline follows.
   */
  availableTemplates?: ReadonlySet<string>,
  /**
   * Which structured archetypes an earlier slide in THIS carousel already
   * used. `stat_callout`/`quote_card`/`comparison_card`/`list_takeaway`/
   * `headline_focus` each has one fixed visual template — a second slide in
   * the same carousel choosing one reads as the same slide shown twice, not
   * two designed slides (a real prep run shipped two `stat_callout`s and two
   * `comparison_card`s in one 8-slide post). `photo`/`text_only` are
   * exempt: several photo slides, or several quiet typographic ones, are
   * the normal, expected case, not a repeated design.
   *
   * A prompt rule alone ("aim for a mix") already asked for this and did not
   * hold, so this degrades the REPEAT rather than holding or re-drafting —
   * the same "downgrade, never hold" rule `06f`/`07a` already apply to a
   * missing image, applied here to a repeated layout instead.
   *
   * Keyed by string rather than `InstagramSlideLayout`, because two DIFFERENT
   * `custom` archetypes in one carousel are two different designs (not a
   * repeat) — the key for a custom slide is its own `archetypeId`, not the
   * literal `"custom"`.
   */
  usedLayouts?: ReadonlySet<string>,
  /**
   * Which `custom` archetypeIds passed `assertSafeMarkup` (and the
   * collision check against the five real archetype ids) THIS attempt.
   * Unlike the five structured archetypes, a custom archetype's
   * availability is never about the client's own `templateDir` — it is
   * whatever the model just authored, re-validated fresh every attempt (see
   * `create-instagram-agent-workflow.ts`'s `ensureTemplatesOnDisk`) — so it
   * gets its own, separate presence check rather than reusing
   * `availableTemplates`.
   */
  validatedCustomArchetypeIds?: ReadonlySet<string>,
): { layout: InstagramSlideLayout; downgradedFrom?: string } {
  const missing = (what: string) => ({ layout: "text_only" as const, downgradedFrom: `${slide.layout} (no ${what} supplied)` });

  if (slide.layout === "custom") {
    const archetype = slide.customArchetype;
    if (!archetype) return missing("customArchetype");
    if (!validatedCustomArchetypeIds?.has(archetype.archetypeId)) {
      return { layout: "text_only", downgradedFrom: `custom (${archetype.archetypeId} failed its markup safety check)` };
    }
    if (usedLayouts?.has(archetype.archetypeId)) {
      return { layout: "text_only", downgradedFrom: `custom (${archetype.archetypeId} already used earlier in this carousel)` };
    }
    return { layout: "custom" };
  }

  // Checked before content, because an absent template makes the content
  // question moot: it cannot render as that archetype either way.
  if (slide.layout !== "photo" && slide.layout !== "text_only" && availableTemplates !== undefined) {
    const file = LAYOUT_TEMPLATE_FILES[slide.layout];
    if (!availableTemplates.has(file)) {
      return { layout: "text_only", downgradedFrom: `${slide.layout} (this client's templateDir has no ${file})` };
    }
  }

  if (slide.layout !== "photo" && slide.layout !== "text_only" && usedLayouts?.has(slide.layout)) {
    return { layout: "text_only", downgradedFrom: `${slide.layout} (already used earlier in this carousel)` };
  }

  switch (slide.layout) {
    case "stat_callout":
      return slide.stat ? { layout: slide.layout } : missing("stat");
    case "quote_card":
      return slide.quote ? { layout: slide.layout } : missing("quote");
    case "comparison_card":
      return slide.comparison ? { layout: slide.layout } : missing("comparison");
    case "list_takeaway":
      return slide.items && slide.items.length >= 2 ? { layout: slide.layout } : missing("items");
    case "photo":
    case "text_only":
    case "headline_focus":
      // These three need nothing beyond `headline`/`body`, which the schema
      // already requires on every slide.
      return { layout: slide.layout };
  }
}

/**
 * The `fields`/`htmlFragments` pair one archetype needs.
 *
 * Every archetype gets `accentColor`, `dir`, and `kicker`; the rest is
 * per-archetype. A template asking for a slot this returns nothing for
 * renders it as empty (`fillTemplate` strips unfilled slots), which is why
 * the optional lines — a stat's source, a headline's kicker — need no
 * conditional here.
 */
/** The reviewer's discrete per-slide typography controls — see `SlideEditSchema` in packages/core. */
export interface SlideStyleOverride {
  fontScale?: "s" | "m" | "l" | undefined;
  textAlign?: "start" | "center" | "end" | undefined;
}

function contentFor(
  layout: InstagramSlideLayout,
  slide: InstagramSlideCopy,
  accentColor: string,
  dir: "rtl" | "ltr",
  /** Standing brand furniture — the SAME on every slide of the carousel, unlike the model-authored per-slide `kicker`. */
  brand?: { handle?: string | undefined; seriesBadge?: string | undefined },
  /** Reviewer typography for THIS slide. Defaults always emitted — a stripped `{{fontScale}}` class token is harmless, but emitting the default keeps every rendered document explicit. */
  style?: SlideStyleOverride,
): { fields: Record<string, string>; htmlFragments: Record<string, string> } {
  const base: Record<string, string> = {
    accentColor,
    dir,
    fontScale: style?.fontScale ?? "m",
    textAlign: style?.textAlign ?? "start",
    ...(slide.kicker ? { kicker: slide.kicker } : {}),
    ...(brand?.handle !== undefined ? { brandHandle: brand.handle } : {}),
    ...(brand?.seriesBadge !== undefined ? { seriesBadge: brand.seriesBadge } : {}),
  };

  switch (layout) {
    case "stat_callout":
      return {
        fields: {
          ...base,
          figure: slide.stat!.figure,
          subLabel: slide.stat!.subLabel,
          body: slide.body,
          sourceLine: slide.stat!.source,
        },
        htmlFragments: {},
      };
    case "quote_card":
      return {
        fields: { ...base, quoteText: slide.quote!.text, attribution: slide.quote!.attribution },
        htmlFragments: {},
      };
    case "comparison_card":
      return {
        fields: {
          ...base,
          headline: slide.headline,
          body: slide.body,
          leftLabel: slide.comparison!.leftLabel,
          leftBody: slide.comparison!.leftBody,
          rightLabel: slide.comparison!.rightLabel,
          rightBody: slide.comparison!.rightBody,
        },
        htmlFragments: {},
      };
    case "list_takeaway":
      return {
        fields: { ...base, headline: slide.headline },
        htmlFragments: { itemRows: buildListRows(slide.items!) },
      };
    case "custom":
      // Model-authored slot values are substituted through the SAME escaped
      // `{{key}}` path as every other archetype's fields — no raw/`html:`
      // form exists for this content (see `SlideCustomArchetypeSchema`'s own
      // doc comment).
      return { fields: { ...base, ...slide.customArchetype!.fields }, htmlFragments: {} };
    case "photo":
    case "text_only":
    case "headline_focus":
      return { fields: { ...base, headline: slide.headline, body: slide.body }, htmlFragments: {} };
  }
}

/**
 * RFC-03 §3 step 07's self-check, run before `slides-data.json` is ever
 * handed to the renderer: "every claim traces to a source, every config
 * rule with `check: 'copy'` passes, slide count matches step 06." A failure
 * here drives the workflow's own capped "RETURN: 05" retry loop
 * (`create-instagram-agent-workflow.ts`) — this function itself never
 * retries anything; it just reports pass/fail plus a human-readable reason.
 *
 * `styleConfig.rules[]` entries with `check: "copy"` are descriptive/audit
 * labels in this Phase-1 schema — the actual checkable conditions they
 * describe live in `banned_words`/`banned_chars`/`compliance` below, which
 * this function evaluates directly rather than interpreting `rules[]` as a
 * mini rule-engine with no real semantics yet. (A prior version of this
 * comment attributed that choice to an invented RFC-03 quote — no such
 * instruction exists in RFC-03; this is this package's own Phase-1 scoping
 * decision.) `check: "render"` rules are out of scope for this function
 * entirely — those are checked post-render, against the rendered attempt's
 * structured slide data, by step 08b's `InstagramVisualQaAgent` instead.
 *
 * SCRUM-301/AU17: `banned_words`/`banned_chars`/`compliance.never_say`/
 * `compliance.required_framing` used to be a hand-rolled case-insensitive
 * substring scan duplicated right here — the exact algorithm the shared
 * `gate.brandCompliance` tool (`packages/tools/karos-gates/src/brand-compliance.ts`)
 * already implements and every other migrated content agent
 * (blog/reddit/x/linkedin/newsletter-agent's own step "verify-brand-
 * compliance") already calls for precisely this "client's own forbidden
 * terms / required disclaimer" check. This function now calls that same
 * tool instead of re-implementing the scan, so a client's `banned_words` and
 * `banned_chars` both flow through `forbiddenTerms` (a single-character
 * "banned char" is just a length-1 forbidden term to a substring scan), a
 * regulated client's `never_say` list flows through the same `forbiddenTerms`
 * parameter, and each `required_framing` phrase is checked via
 * `requiredDisclaimer` (one call per phrase, since that field is
 * single-phrase and required_framing is an array). This picks up
 * `gate.brandCompliance`'s always-on `DEFAULT_BANNED_PROMISE_PHRASES` floor
 * ("guaranteed returns", "risk-free", ...) as a side effect — the same floor
 * every other migrated agent already gets for free — which is new coverage,
 * not a behavior this function had before.
 */
export async function checkSlidesData(
  tools: AgentToolRegistry,
  ctx: AgentContext,
  copy: InstagramCopyOutput,
  selections: ImageSelection[],
  research: ResearchOutput,
  styleConfig: StyleConfig,
): Promise<SlidesDataSelfCheck> {
  const { canvas, banned_words: bannedWords, banned_chars: bannedChars, compliance } = styleConfig;

  // The slide count is held to the FORMAT (2026-09): a single-image post is
  // exactly one slide, a carousel stays inside the client's configured range.
  if (copy.format === "single") {
    if (copy.slides.length !== 1) {
      return { ok: false, reason: `a single-image post carries exactly one slide, this draft carries ${copy.slides.length}` };
    }
  } else if (copy.slides.length < canvas.slides_min || copy.slides.length > canvas.slides_max) {
    return {
      ok: false,
      reason: `slide count ${copy.slides.length} is outside the configured range [${canvas.slides_min}, ${canvas.slides_max}]`,
    };
  }

  // "slide count matches step 06" (RFC-03 §3 step 07) — every copy slide must
  // have exactly one corresponding vetted image selection, no more, no fewer.
  if (selections.length !== copy.slides.length) {
    return {
      ok: false,
      reason: `image selection count (${selections.length}) does not match slide count (${copy.slides.length})`,
    };
  }
  const selectionNs = new Set(selections.map((s) => s.n));
  for (const slide of copy.slides) {
    if (!selectionNs.has(slide.n)) {
      return { ok: false, reason: `slide ${slide.n} has no corresponding image selection` };
    }
  }

  // "every claim traces to a source" (RFC-03 §3 step 07) — sourceRef must
  // name a step-04 fact's claim verbatim, not a paraphrase.
  const factClaims = new Set(research.facts.map((f) => f.claim));
  for (const slide of copy.slides) {
    if (!factClaims.has(slide.sourceRef)) {
      return {
        ok: false,
        reason: `slide ${slide.n}'s sourceRef does not match any research fact's claim verbatim: "${slide.sourceRef}"`,
      };
    }
  }

  const brandComplianceTool = tools["gate.brandCompliance"];
  if (!brandComplianceTool) {
    throw new WorkflowToolingFailure(`"gate.brandCompliance" is not registered — step 07's banned-word/char and compliance checks cannot run without it`);
  }
  const runBrandCompliance = async (text: string, forbiddenTerms: string[], requiredDisclaimer?: string): Promise<GateVerdict> => {
    const outcome = await brandComplianceTool.execute({ text, forbiddenTerms, ...(requiredDisclaimer !== undefined ? { requiredDisclaimer } : {}) }, { ctx });
    if (outcome.status !== "success") {
      throw new WorkflowToolingFailure(`gate.brandCompliance failed: ${outcome.status}`);
    }
    return outcome.result as GateVerdict;
  };

  for (const slide of copy.slides) {
    const slideText = `${slide.headline} ${slide.body}`;
    const verdict = await runBrandCompliance(slideText, [...bannedWords, ...bannedChars]);
    if (verdict.verdict === "content_fail") {
      return { ok: false, reason: `slide ${slide.n} failed the banned word/character check (gate.brandCompliance): ${verdict.reason}` };
    }
  }

  if (compliance.regulated) {
    const combinedText = copy.slides.map((s) => `${s.headline}\n${s.body}`).join("\n");

    for (const phrase of compliance.required_framing) {
      const verdict = await runBrandCompliance(combinedText, [], phrase);
      if (verdict.verdict === "content_fail") {
        return { ok: false, reason: `regulated client's required framing phrase is missing from the post: "${phrase}"` };
      }
    }

    if (compliance.never_say.length > 0) {
      const verdict = await runBrandCompliance(combinedText, compliance.never_say);
      if (verdict.verdict === "content_fail") {
        return { ok: false, reason: `regulated client's post contains a "never say" phrase (gate.brandCompliance): ${verdict.reason}` };
      }
    }
  }

  return { ok: true };
}

/**
 * Assembles the exact `publish.renderCarousel` input contract (RFC-03 §1
 * required-reading item 1's schema, imported straight from
 * `@agent-engine/tool-karos-publish` rather than redeclared here — one
 * schema, not two that could drift). Only ever called after
 * `checkSlidesData` has already passed. `outDir` is deterministic per
 * `(clientSlug, postId)` so re-running this on resume lands on the same
 * output directory rather than a fresh one each attempt.
 */
export function assembleSlidesData(params: {
  clientSlug: string;
  postId: string;
  repoRoot: string;
  brandTokens: BrandTokens;
  copy: InstagramCopyOutput;
  selections: ImageSelection[];
  canvas: StyleConfig["canvas"];
  /** Template filenames present in the effective template directory. See `resolveLayout`'s own note. */
  availableTemplates?: ReadonlySet<string>;
  /**
   * Overrides `brandTokens.templateDir` for this run.
   *
   * Set when the template registry materialized its winning templates into a
   * per-run directory (Approach (a)) — the renderer takes ONE `templateDir`,
   * so the materialized directory has to be the one it reads, with the
   * client's own base template copied in alongside.
   */
  templateDirOverride?: string | undefined;
  /** Which `custom` archetypeIds passed their safety check THIS attempt. See `resolveLayout`'s own note. */
  validatedCustomArchetypeIds?: ReadonlySet<string>;
  /**
   * The brand.json accent, used only when `brandTokens.accentColor` is
   * unset. The accent has exactly ONE channel — this per-slide field — and
   * the brand token sheet deliberately never emits `--accent` (see
   * `buildBrandHeadHtml`), so precedence stays legible:
   * config accentColor > brand.json accent > the legacy default.
   */
  brandAccentFallback?: string | undefined;
  /** The client's normalized `@handle` watermark, from the frozen brand kit. Rendered by the templates' `.brand-handle` component; absent means the slot strips clean. */
  brandHandle?: string | undefined;
  /** Reviewer typography per slide number (Phase 2 in-place edits). Absent slides keep the defaults. */
  slideStyleOverrides?: ReadonlyMap<number, SlideStyleOverride>;
  /**
   * IGSTYLE-7, §7a — the effective kit's accent ring (`BrandRenderTokens.palette`),
   * wiring `paletteForSlide`'s already-seeded rotation into the render path for
   * the first time. Absent, or a ring of length ≤ 1, falls back to
   * `brandAccentFallback`/`brandTokens.accentColor` for EVERY slide exactly as
   * before this ticket — a one-colour kit is unchanged.
   */
  accentRing?: string[] | undefined;
  /**
   * Seeds the ring walk (`paletteForSlide`'s own "SEEDED, NOT RANDOM" contract)
   * — the run id, per §7a. Absent is treated as phase 0 (same as an empty
   * seed), which only matters when `accentRing` actually has more than one
   * member.
   */
  paletteSeed?: string | undefined;
  /**
   * IGSTYLE-10, §10a — this round's ground/fg inversion axis. Absent means
   * unavailable this round (no derived pair, or nothing to gate against) —
   * every slide keeps the client's primary pairing, exactly as before this
   * ticket. See `GroundFgInversionConfig`'s own doc comment for what
   * suppresses it even when present.
   */
  groundFgInversion?: GroundFgInversionConfig | undefined;
}): RenderCarouselInput {
  const selectionByN = new Map(params.selections.map((s) => [s.n, s]));

  // The default template (agents/instagram-agent/assets/templates/default/slide.html,
  // agent-engine#4) reads this as a CSS custom property — falls back to that template's
  // own legacy-palette accent (see its doc comment) when a client hasn't set one yet.
  // `logoPath` isn't threaded through here: the default template has no wordmark
  // slot (no client-name field exists anywhere in this agent's per-slide contract to
  // put next to one), so wiring it through would have nothing real to attach to.
  const accentColor = params.brandTokens.accentColor ?? params.brandAccentFallback ?? "#C4552F";

  // One direction for the whole carousel, not per slide — a post is written
  // in one language, and a stat figure or kicker (short, often just digits or
  // a brand name) is too thin a sample on its own to call reliably. See
  // `detectDirection`'s own doc comment for why this reads the copy itself
  // rather than a client-config field (prep job hcf9ymPGJC7mDS5pcEQ4: a
  // Hebrew-brand-voice client's carousel that rendered left-to-right).
  const direction = detectDirection([params.copy.caption, ...params.copy.slides.map(collectSlideText)].join(" "));

  // Tracks which structured archetypes an earlier slide already claimed, in
  // carousel order, so a repeat degrades to `text_only` instead of shipping
  // two slides in the same fixed layout — see `resolveLayout`'s own doc
  // comment on `usedLayouts`.
  const usedLayouts = new Set<string>();
  const slides: Slide[] = params.copy.slides.map((slide) => {
    const selection = selectionByN.get(slide.n);
    const { layout } = resolveLayout(slide, params.availableTemplates, usedLayouts, params.validatedCustomArchetypeIds);
    if (layout === "custom") usedLayouts.add(slide.customArchetype!.archetypeId);
    else if (layout !== "photo" && layout !== "text_only") usedLayouts.add(layout);
    // IGSTYLE-7, §7a — a slide's accent comes from the ring walk rather than
    // one shared `accentColor` whenever the kit can actually rotate.
    // `rotates: false` (an empty or one-member ring) keeps every slide on the
    // SAME existing `accentColor` fallback — a one-colour kit renders exactly
    // as it did before this ticket, never a manufactured "variation."
    const { accent: slideAccentColor } = resolveSlideAccent(slide.n, params.accentRing, params.paletteSeed, accentColor);
    const { fields, htmlFragments } = contentFor(
      layout,
      slide,
      slideAccentColor,
      direction,
      {
        handle: params.brandHandle,
        seriesBadge: params.brandTokens.seriesBadge,
      },
      params.slideStyleOverrides?.get(slide.n),
    );
    // Only `photo` consumes a hero image. Every other archetype is typographic
    // by design, so attaching one would either be ignored by its template or —
    // worse, for a template that did grow a background slot later — quietly
    // reintroduce the "every slide needs a picture" coupling this set exists
    // to break.
    const imagePath = layout === "photo" ? (selection?.imagePath ?? undefined) : undefined;
    const primaryTemplate = templateForLayout(layout, slide, params.brandTokens.slideTemplate);
    // IGSTYLE-10, §10a/10c — this slide's ground/fg pairing: the inverted
    // sibling file when the seeded walk lands here AND the accent still
    // clears the floor against the ground that inversion would produce;
    // the primary file (unchanged from before this ticket) otherwise.
    const { used: inverted } = decideGroundFgInversion(slide.n, params.paletteSeed, slideAccentColor, params.groundFgInversion);
    return {
      n: slide.n,
      template: inverted ? invertedTemplateFileName(primaryTemplate) : primaryTemplate,
      fields,
      images: imagePath ? { hero: imagePath } : {},
      htmlFragments,
    };
  });

  return {
    client: params.clientSlug,
    postId: params.postId,
    templateDir: params.templateDirOverride ?? params.brandTokens.templateDir,
    outDir: `instagram-output/${params.clientSlug}/${params.postId}`,
    repoRoot: params.repoRoot,
    slides,
    canvas: params.canvas,
    readyFlag: "__CAROUSEL_READY__",
  };
}
