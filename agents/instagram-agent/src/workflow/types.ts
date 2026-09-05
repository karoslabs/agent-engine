import { z } from "zod";
import type { DegradedContextGroundingMarker, TrendCandidate } from "@agent-engine/workflow";

// ─────────────────────────────────────────────────────────────────────────
// Style config + brand tokens (RFC-03 step 02 — "freeze the small files")
// ─────────────────────────────────────────────────────────────────────────

/**
 * A single content rule from the client's style config. `check` names which
 * half of the pipeline the rule is checkable against — `"copy"` (a text
 * rule, checked deterministically against slide text inside step 07's
 * self-check: banned words/chars, `compliance` framing) or `"render"` (only
 * checkable on the rendered pixels/structured slide output — step 08b's
 * visual QA, see `InstagramVisualQaAgent`).
 *
 * P0 parity-audit fix: this used to be `z.literal("copy")` only, which
 * rejected every real legacy-shaped `02-style-config.json` at intake, since
 * `assets/style-config-template.json`'s own 5 worked examples are 100%
 * `check: "render"` rules (nothing-overlaps, no-empty-closer, figures-are-
 * designed, mono-face-sparingly, real-photo-person-chips — none of them are
 * text rules). A prior version of this comment attributed the original
 * `"copy"`-only narrowing to an invented RFC-03 quote ("you don't need every
 * legacy field, just enough to genuinely validate") that does not appear
 * anywhere in RFC-03 — there was never an RFC instruction to drop `"render"`
 * support. Widening this to `z.enum(["copy", "render"])` is a deliberate
 * fidelity fix to match the real template's rule-type contract, not a
 * response to anything RFC-03 said.
 */
export const StyleRuleSchema = z.object({
  id: z.string().min(1),
  check: z.enum(["copy", "render"]),
  description: z.string().min(1),
});
export type StyleRule = z.infer<typeof StyleRuleSchema>;

/**
 * The canvas block, shaped identically to `publish.renderCarousel`'s own
 * `CanvasSchema` (`@agent-engine/tool-karos-publish`) so step 02's frozen
 * config can be passed straight into the render tool's input at step 08
 * with zero translation — one canvas definition, not two that could drift.
 * `scale` has no default here (unlike the render tool's own schema): a
 * client's style config must say `2` explicitly, on purpose — RFC-03's step
 * 02 is a parse-*and*-validate gate, and silently defaulting a client's own
 * frozen config file to the right value would hide a real client-config bug
 * instead of catching it at intake.
 */
export const StyleConfigCanvasSchema = z.object({
  w: z.number().int().positive(),
  h: z.number().int().positive(),
  scale: z.number(),
  slides_min: z.number().int().positive(),
  slides_max: z.number().int().positive(),
});
export type StyleConfigCanvas = z.infer<typeof StyleConfigCanvasSchema>;

/**
 * The compliance block (regulated clients only, but present with defaults
 * either way — RFC-03's `compliance: {regulated, required_framing[],
 * never_say[]}`). When `regulated` is true, step 07's self-check requires
 * every `required_framing` phrase to appear somewhere in the post's copy and
 * refuses any `never_say` phrase anywhere in it.
 */
export const StyleComplianceSchema = z.object({
  regulated: z.boolean(),
  required_framing: z.array(z.string()).default([]),
  never_say: z.array(z.string()).default([]),
});
export type StyleCompliance = z.infer<typeof StyleComplianceSchema>;

/**
 * The frozen `02-style-config.json` shape (RFC-03 §1 required-reading list,
 * item 1) — step 02 parses the client's config against this schema and
 * throws `WorkflowBlockedIntake` on any failure (missing file, wrong
 * version, malformed canvas, `scale !== 2`, etc.) rather than ever falling
 * back to defaults silently. This is the "parse-check-or-HALT" gate.
 */
export const StyleConfigSchema = z.object({
  style_config_version: z.number().int().positive(),
  canvas: StyleConfigCanvasSchema,
  rules: z.array(StyleRuleSchema).default([]),
  banned_words: z.array(z.string()).default([]),
  banned_chars: z.array(z.string()).default([]),
  compliance: StyleComplianceSchema,
});
export type StyleConfig = z.infer<typeof StyleConfigSchema>;

/**
 * The brand-tokens half of step 02's "freeze the small files" (RFC-03 §3
 * step 02) — just enough to feed the render step's `templateDir` and to
 * give slide copy a couple of on-brand fields (`accentColor`) without
 * pulling in the full legacy brand-kit file. `templateDir` is repo-relative
 * on purpose: it flows straight into `publish.renderCarousel`'s own
 * `templateDir` input, which `assertInside` (RFC-03 §1 required-reading
 * item 2) refuses to accept as an absolute path.
 *
 * RESOLVED (karoslabs/agent-engine#4): a real, non-`__tests__` default now
 * ships at `agents/instagram-agent/assets/templates/default/slide.html`
 * (`slideTemplate` still defaults to `"slide.html"`, matching it) — a new
 * client's `templateDir` should point there unless/until it has its own.
 * Adapted from karos-agents' legacy `marketing-services` CSS design tokens
 * for visual parity — see that file's own doc comment for exactly what was
 * and wasn't ported.
 */
export const BrandTokensSchema = z.object({
  templateDir: z.string().min(1),
  /** The single shared slide template file (repo-relative to `templateDir`) every slide renders through — RFC-03 §1's "one static renderer/template serves every client" fix #2, never a per-agent-invented template. */
  slideTemplate: z.string().min(1).default("slide.html"),
  accentColor: z.string().min(1).optional(),
  logoPath: z.string().min(1).optional(),
  /**
   * Optional photographic direction, used only by the generative tier
   * (`image.generate`) when retrieval could not fill a slide.
   *
   * All optional, so no existing client config breaks by their absence, and a
   * client without them gets the same neutral brief as before. They exist
   * because a flat "photographic image of X" returns a generic stock-looking
   * frame — the same weakness that made retrieval insufficient — and lighting,
   * aesthetic and palette are what make a generated slide look like it belongs
   * to this client rather than to nobody.
   */
  aesthetic: z.string().min(1).optional(),
  lighting: z.string().min(1).optional(),
  palette: z.array(z.string().min(1)).max(6).optional(),
  visualMood: z.string().min(1).optional(),
  /**
   * Explicit render-token overrides — the hand-authored escape hatch that
   * beats every derivation in `brand-render-tokens.ts`. Role names mirror
   * karos-landing's `BrandColorRolesSchema` (the in-repo precedent for
   * "colors are roles, not a palette list"). Everything optional: most
   * clients get their tokens DERIVED from `client/brand.json` (which the
   * portal already edits), and a required field here would hard-block every
   * existing client at step 02's refuse-to-guess parse.
   */
  renderTokens: z
    .object({
      ground: z.string().min(1).optional(),
      surface: z.string().min(1).optional(),
      fg: z.string().min(1).optional(),
      fg2: z.string().min(1).optional(),
      line: z.string().min(1).optional(),
      accentInk: z.string().min(1).optional(),
      /**
       * IGSTYLE-1. An override for the brand ACCENT itself — distinct from
       * every other key here, which `deriveBrandRenderTokens` has always
       * read from this object. `brandAccent` is derived only from
       * `client/brand.json` today (`b["accent"]` /
       * `b["colors"]["primaryAccent"]`); this is the field that gives a
       * reviewer's or a learned preference's accent pick somewhere to live
       * without touching that derivation. Added here (not wired into
       * derivation yet) so `StyleOverrides` below can be typed as exactly
       * the seven roles `StyleEditSchema` (`@agent-engine/core`) accepts —
       * IGSTYLE-3 is what makes `deriveBrandRenderTokens` actually honor
       * it; this ticket only defines and threads the shape ("no behaviour
       * change").
       */
      accent: z.string().min(1).optional(),
      fontDisplay: z.string().min(1).optional(),
      fontBody: z.string().min(1).optional(),
      fontMono: z.string().min(1).optional(),
      /** Badge/eyebrow treatment; unset means derived from brand data. See `BadgeStyle`. */
      badgeStyle: z.enum(["pill", "brackets", "underline", "plain"]).optional(),
    })
    .optional(),
  /** A standing series badge ("PITCH SCHOOL | LESSON 15") rendered on every slide when set. */
  seriesBadge: z.string().min(1).max(48).optional(),
});
export type BrandTokens = z.infer<typeof BrandTokensSchema>;

/**
 * IGSTYLE-1. The wire shape Layers 1 (learned) and 2 (this run's directive)
 * of style resolution both speak — deliberately typed as exactly what
 * `client/brand.json`'s hand-authored escape hatch already accepts, so a
 * layer's patch and a human's standing config override are
 * indistinguishable to every downstream consumer
 * (`deriveBrandRenderTokens`, `buildBrandHeadHtml`, `paletteForSlide`,
 * `assembleSlidesData`). `NonNullable` because a "patch" with no keys set is
 * `{}`, never `undefined` — see `mergeStyleOverrides`.
 */
export type StyleOverrides = NonNullable<BrandTokens["renderTokens"]>;

/**
 * Last-wins merge over DEFINED keys only — `undefined` in a later patch
 * never erases a value an earlier patch set, so a caller can pass a
 * partially-filled `StyleEditSchema` object (only the roles a reviewer
 * actually picked) without it clobbering the rest of the merge.
 *
 * Order matters and is the caller's to get right — §2.2's architecture
 * calls this as `mergeStyleOverrides(baseline.renderTokens, learned,
 * directive)`, so Layer 2 (this run's active directive) is always passed
 * LAST and therefore wins any key it sets, exactly as the architecture
 * diagram's "L2 wins" requires.
 */
export function mergeStyleOverrides(...patches: ReadonlyArray<StyleOverrides | undefined>): StyleOverrides {
  const merged: Record<string, string> = {};
  for (const patch of patches) {
    if (patch === undefined) continue;
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) merged[key] = value;
    }
  }
  return merged as StyleOverrides;
}

/** What step 02 hands forward to every later step. */
export interface InstagramFrozenConfig {
  /** Subjects this client does not engage with, frozen from the same read as the style config so the terminal guardrail needs no second one. */
  forbiddenTopics: string[];
  styleConfig: StyleConfig;
  brandTokens: BrandTokens;
}

// ─────────────────────────────────────────────────────────────────────────
// Step 01 — open run / claim post number
// ─────────────────────────────────────────────────────────────────────────

/** What step 01 hands forward. `postId` is the run's own idempotency key (RFC-01 §9.1 rule 2) — stable across resumes of the same `runId`. */
export interface InstagramRunClaim {
  postId: string;
  postNumber: number;
  /** An optional client-supplied steer (lane/subject) for this run — may pick a lane, never relax the topics-catalog lock (RFC-03 §3 step 01's note). */
  requestedLane?: string;
  requestedSubject?: string;
  /**
   * The post format for this run (2026-09): `carousel`, `single`, or `auto`
   * (rotate). From the run input's `requestedFormat` first, then the client's
   * standing `instagramFormat` config; absent means `carousel`, exactly as
   * every run before formats existed.
   */
  requestedFormat?: "carousel" | "single" | "auto";
}

// ─────────────────────────────────────────────────────────────────────────
// Step 03 — claim topic
// ─────────────────────────────────────────────────────────────────────────

/** Where step 03's subject came from — decides whether there is a dedup reservation to commit at step 09. `trend` (2026-09): the scout's on-brand candidate took the slot. */
export type InstagramTopicSource = "reserved" | "requested" | "trend" | "research";

export interface InstagramTopicClaim {
  /**
   * OPTIONAL, because only a `"reserved"` claim has one.
   *
   * It used to be required, which encoded the assumption that the topics
   * catalog is the sole possible origin of a subject — and that assumption is
   * exactly what made a client with no seeded catalog unable to run this agent
   * at all: `topics.reserve` reported a floor breach, step 03 threw
   * `WorkflowHeld`, and the run ended having produced nothing. `topics.commit`
   * at step 09 is now conditional on this field, matching what `x-agent` has
   * always done with its own `XTopicReservation.reservationKey`.
   */
  reservationKey?: string;
  topic: string;
  source: InstagramTopicSource;
  /** Present when `source === "trend"`: the scouted candidate, with its angle, hook, why-now and brand-fit bridge. */
  trend?: TrendCandidate;
}

// ─────────────────────────────────────────────────────────────────────────
// Step 04 — research (InstagramResearchAgent's output)
// ─────────────────────────────────────────────────────────────────────────

/** One sourced fact — "every fact that will reach a slide needs a source + date" (RFC-03 §3 step 04). */
export const ResearchFactSchema = z.object({
  claim: z.string().min(1),
  source: z.string().min(1),
  date: z.string().min(1),
});
export type ResearchFact = z.infer<typeof ResearchFactSchema>;

/**
 * `InstagramResearchAgent`'s output. `rawPayloadRef` is the `research.pull`
 * run id whose raw payload was captured verbatim (by `research.pull` itself,
 * before this agent ever sees it) — RFC-03 §1's "verbatim raw payload
 * capture" requirement is satisfied by `research.pull`'s own design, not
 * reimplemented here; this field just carries the pointer forward so step
 * 07's self-check and step 09's ledger record can trace every fact back to it.
 */
export const ResearchOutputSchema = z.object({
  topic: z.string().min(1),
  facts: z.array(ResearchFactSchema).min(1),
  rawPayloadRef: z.string().min(1),
});
export type ResearchOutput = z.infer<typeof ResearchOutputSchema>;

// ─────────────────────────────────────────────────────────────────────────
// Step 05 — write copy (InstagramCopyAgent's output)
// ─────────────────────────────────────────────────────────────────────────

/**
 * One slide's copy — "one idea each" (RFC-03 §3 step 05). `visualNeed` is
 * what step 06 vets a picture against; `sourceRef` must name one of step
 * 04's `facts[].claim` values verbatim, which is exactly what step 07's
 * self-check verifies ("every claim traces to a source").
 */
/**
 * Which archetype `assembleSlidesData` renders this slide as.
 *
 * Ported from the legacy `karos-agents` archetype set (2026-08) — see
 * `assets/templates/default/` for one HTML template per value, and
 * `references/legacy-archetype-port.md` for what was and wasn't carried over
 * from the legacy design system.
 *
 * Not every slide wants a photograph, which is the whole point: a bare
 * percentage reads better as 300px type on a solid ground than as a caption
 * over a stock desk, and a direct quote wants quotation styling rather than a
 * scrim. Before this set existed every slide demanded a photo, so a carousel
 * had one visual rhythm and every slide competed for the same stock imagery.
 *
 * Two values are special:
 *
 * - `"photo"` is the default, so any caller predating this field is unchanged.
 * - `"text_only"` is the guaranteed-delivery floor: the workflow reassigns a
 *   slide here when every image tier and the rights gate leave it with no
 *   usable picture (see `ImageSelectionSchema`). It is also what any other
 *   archetype degrades to if its own required content fields are missing —
 *   a deliberate archetype, never a placeholder.
 */
export const InstagramSlideLayoutSchema = z.enum([
  "photo",
  "text_only",
  "stat_callout",
  "quote_card",
  "comparison_card",
  "list_takeaway",
  "headline_focus",
  "custom",
]);
export type InstagramSlideLayout = z.infer<typeof InstagramSlideLayoutSchema>;

/**
 * `stat_callout`'s content. `figure` carries its own unit or symbol ("73%",
 * "4.2x", "$1.8B") exactly as the legacy contract did — a separate unit field
 * invites "4.2" + "x" being typeset apart, and the figure's own string length
 * is what picks its type size.
 *
 * `source` is required, not optional: the legacy system's rule was "every
 * figure names its source on the slide", and a big unattributed number is
 * precisely the shape of a claim a reader should distrust.
 */
export const SlideStatSchema = z.object({
  figure: z.string().min(1).max(12),
  subLabel: z.string().min(1),
  source: z.string().min(1),
});

/** `quote_card`'s content — the pull-quote and who said it. */
export const SlideQuoteSchema = z.object({
  text: z.string().min(1),
  attribution: z.string().min(1),
});

/** `comparison_card`'s content — two sides, each a short label plus a line of detail. */
export const SlideComparisonSchema = z.object({
  leftLabel: z.string().min(1),
  leftBody: z.string().min(1),
  rightLabel: z.string().min(1),
  rightBody: z.string().min(1),
});

/**
 * `list_takeaway`'s content. Two to four rows: the legacy `meaning` layout
 * pins its rows at a fixed offset in a 1440px column with 46px padding each,
 * so five would overflow the canvas rather than shrink to fit.
 */
export const SlideListSchema = z
  .array(z.object({ title: z.string().min(1), note: z.string().min(1).optional() }))
  .min(2)
  .max(4);

/**
 * `custom`'s content — a model-authored typographic archetype for the rare
 * case none of the six standard ones fit. Not a full HTML document:
 * `bodyHtml` is a markup FRAGMENT (goes inside the shared shell's `<body>`,
 * built by `buildCustomArchetypeDocument`) and `css` is rules only (spliced
 * in separately, by `composeDocument`, the same way any registry template's
 * `cssStyles` already is) — never a `<script>`/`<style>` tag of its own.
 *
 * `archetypeId` must start with `custom_`: its file lands in the same
 * per-run directory the five real structured archetypes' files do, and this
 * prefix is what keeps it from ever colliding with one of them (checked
 * again, at runtime, in `create-instagram-agent-workflow.ts` — a schema
 * regex is one edit away from being loosened later).
 *
 * `slots`/`fields` follow the renderer's own escaped-substitution
 * convention: every `{{key}}` `bodyHtml` uses must be a declared slot (or
 * the always-available `kicker`/`dir`), and every value in `fields` is
 * substituted as escaped text — there is no raw/`{{html:...}}` form for
 * model-authored content, deliberately, since that split is what keeps a
 * copy field from being an injection point (see `assertSafeMarkup`).
 */
export const SlideCustomArchetypeSchema = z.object({
  archetypeId: z
    .string()
    .regex(/^custom_[a-z0-9_]{3,40}$/, "must start with 'custom_' and contain only lowercase letters, digits, and underscores"),
  name: z.string().min(1).max(60),
  /** One sentence: why none of the six standard archetypes fit this slide. */
  rationale: z.string().min(1).max(300),
  bodyHtml: z.string().min(1).max(4000),
  css: z.string().max(4000).default(""),
  slots: z.array(z.string().regex(/^[A-Za-z0-9_]+$/)).min(1).max(8),
  fields: z.record(z.string(), z.string().max(2000)),
});
export type SlideCustomArchetype = z.infer<typeof SlideCustomArchetypeSchema>;

export const InstagramSlideCopySchema = z.object({
  n: z.number().int().positive(),
  headline: z.string().min(1),
  body: z.string().min(1),
  visualNeed: z.string().min(1),
  sourceRef: z.string().min(1),
  layout: InstagramSlideLayoutSchema.default("photo"),
  /**
   * The archetype-specific content, all optional.
   *
   * Optional rather than a discriminated union on `layout`, deliberately: the
   * model picks the layout AND fills the matching block, and those are two
   * chances to be inconsistent. A union turns any mismatch into a whole-output
   * schema rejection, which costs the entire draft (and, at the retry cap, the
   * run). Keeping them optional means a `stat_callout` that arrives without a
   * `stat` degrades to `text_only` on its own headline and body — which every
   * slide always has — and the carousel still ships.
   *
   * `assembleSlidesData` is where that degradation is decided; nothing here
   * assumes the model got it right.
   */
  stat: SlideStatSchema.optional(),
  quote: SlideQuoteSchema.optional(),
  comparison: SlideComparisonSchema.optional(),
  items: SlideListSchema.optional(),
  customArchetype: SlideCustomArchetypeSchema.optional(),
  /** A short mono eyebrow above a `headline_focus` statement. Optional on every archetype. */
  kicker: z.string().min(1).max(48).optional(),
});
export type InstagramSlideCopy = z.infer<typeof InstagramSlideCopySchema>;

/**
 * The two shapes an Instagram post takes (2026-09).
 *
 * `carousel` is the 6-8 slide format every run produced until now. `single`
 * is one designed image and a DEEP caption: the caption carries the argument
 * the slides used to, in short lines, and the one slide is the hook. The
 * workflow decides the format (a run request, the client's `instagramFormat`
 * setting, or an `auto` rotation) and hands it to the copy step, which echoes
 * it back; `checkSlidesData` holds the slide count to it.
 */
export const INSTAGRAM_FORMATS = ["carousel", "single"] as const;
export const InstagramFormatSchema = z.enum(INSTAGRAM_FORMATS);
export type InstagramFormat = z.infer<typeof InstagramFormatSchema>;

/** `InstagramCopyAgent`'s output — six to eight slides for a carousel (RFC-03 §3 step 05), exactly one for a single-image post; `checkSlidesData` enforces the count per format. */
export const InstagramCopyOutputSchema = z.object({
  /** The format this copy was written for. Defaults to `carousel` so every existing caller and fixture keeps its shape. */
  format: InstagramFormatSchema.default("carousel"),
  slides: z.array(InstagramSlideCopySchema).min(1).max(8),
  /**
   * The post's own caption — the text Instagram shows below the carousel,
   * separate from anything baked into the slide images themselves.
   *
   * Every slide always had `headline`/`body`, and until 2026-08 that was
   * mistaken for "the post has text": a reviewer approving in the portal saw
   * either nothing (the gate payload carried no caption at all) or a raw dump
   * of every slide's field values including `accentColor`'s hex code — never
   * a real caption a human wrote to accompany the images. Required, because
   * an Instagram carousel with no caption is exactly the defect this field
   * exists to close.
   */
  caption: z.string().min(1),
});
export type InstagramCopyOutput = z.infer<typeof InstagramCopyOutputSchema>;

// ─────────────────────────────────────────────────────────────────────────
// Step 06 — source + vet images (InstagramImageVettingAgent's output)
// ─────────────────────────────────────────────────────────────────────────

/**
 * One slide's image candidate pool entry — a repo-relative path plus a
 * short human-readable description the vetting agent judges against the
 * slide's `visualNeed`. Phase 1 has no real internet image-search tool
 * (RFC-03 §1) so this pool is caller-provided (a workflow input), standing
 * in for the "fetch + open + look at it" step of the real tool.
 */
export const ImageCandidateSchema = z.object({
  path: z.string().min(1),
  description: z.string().min(1),
});
export type ImageCandidate = z.infer<typeof ImageCandidateSchema>;

/**
 * One slide's vetting verdict. `imagePath: null` means "no candidate in the
 * pool honestly satisfies this slide's need".
 *
 * Until 2026-08 a `null` here always held the *whole* post (RFC-03 §1's
 * legacy-defect fix, preserved exactly: never ship a placeholder, a
 * rights-encumbered image, or a reused one). That guarantee is unchanged —
 * this schema still refuses every one of those. What changed is what happens
 * *instead* of holding: after every image-sourcing tier (retrieval, scrape,
 * generation) has genuinely been tried and a slide still has no usable
 * picture, the workflow now reassigns that slide's `layout` to `"text_only"`
 * (`InstagramSlideLayoutSchema`) and ships it without a photo — a real,
 * designed archetype the render template already supports, not a
 * placeholder standing in for a missing one. A run only holds now if the
 * copy/rights/compliance self-checks themselves fail, never solely because a
 * picture could not be found.
 *

 * `license`/`rightsUsable`/`watermarkFree` (P0 parity-audit Fix 4) restore
 * carousel-agent-v2 SKILL.md step 06's real vetting requirement — "Is it
 * rights-usable, watermark-free, and of the right era? Record per image: the
 * source URL, the licence, and the check verdict" — which this schema used
 * to drop entirely (only `imagePath`/`reason` existed; a code *comment*
 * described the legacy requirement but it never reached the schema or the
 * prompt the model actually sees). Every selected image needs its own
 * verdict on all three, whether or not `imagePath` is null (a `null`
 * selection still records why nothing qualified, including rights/watermark
 * concerns if that's what disqualified a candidate). The workflow treats
 * `rightsUsable: false` or `watermarkFree: false` exactly like `imagePath:
 * null` — holding the whole post, never shipping a rights-encumbered or
 * watermarked image.
 */
export const ImageSelectionSchema = z.object({
  n: z.number().int().positive(),
  imagePath: z.string().min(1).nullable(),
  reason: z.string().min(1),
  /** The licence/source basis for this verdict (e.g. "CC0, Unsplash", "client-owned asset", "n/a — no candidate qualified"). */
  license: z.string().min(1),
  /** False when the candidate is not clear to use commercially (unclear/incompatible licence, unverifiable source, etc.) — never shipped regardless of visual fit. */
  rightsUsable: z.boolean(),
  /** False when the candidate carries a visible watermark, stock-site overlay, or other embedded marking — never shipped regardless of visual fit. */
  watermarkFree: z.boolean(),
});
export type ImageSelection = z.infer<typeof ImageSelectionSchema>;

export const ImageVettingOutputSchema = z.object({
  selections: z.array(ImageSelectionSchema).min(1),
});
export type ImageVettingOutput = z.infer<typeof ImageVettingOutputSchema>;

// ─────────────────────────────────────────────────────────────────────────
// Step 08b — post-render visual QA (InstagramVisualQaAgent's output)
// ─────────────────────────────────────────────────────────────────────────

/**
 * One `check: "render"` rule's verdict against a single rendered attempt.
 * `slide` is omitted for a whole-post-level rule (e.g. "never repeat a
 * picture across slides") that isn't about one specific slide.
 */
export const VisualQaFindingSchema = z.object({
  ruleId: z.string().min(1),
  slide: z.number().int().positive().optional(),
  passed: z.boolean(),
  note: z.string().min(1),
});
export type VisualQaFinding = z.infer<typeof VisualQaFindingSchema>;

/**
 * `InstagramVisualQaAgent`'s output (P0 parity-audit Fix 2) — carousel-agent-v2
 * SKILL.md step 08: "look at the PNGs... check the `check: 'render'` rules
 * from the frozen config: nothing overlapping, no near-empty slide, the
 * closer carries a device. A fail here is `RETURN: 05`." This repo has no
 * real vision-capable image-inspection tool wired in yet (the same
 * documented class of gap as `InstagramImageVettingAgent`'s own text-only
 * candidate judging), so this agent is a deliberate text-proxy stand-in: it
 * judges plausibility from the same structured `fields`/`images` data
 * `slides-data.json` carries, never actual pixels. `pass: false` routes the
 * workflow back through the SAME step-07 self-check retry loop (RETURN: 05
 * equivalent), not a separate mechanism.
 */
export const VisualQaOutputSchema = z.object({
  pass: z.boolean(),
  findings: z.array(VisualQaFindingSchema).default([]),
});
export type VisualQaOutput = z.infer<typeof VisualQaOutputSchema>;

// ─────────────────────────────────────────────────────────────────────────
// Step 07 — emit slides-data.json (the publish.renderCarousel input contract)
// ─────────────────────────────────────────────────────────────────────────

/** The result of step 07's self-check — mirrors `GateVerdictKind`'s pass/content_fail shape without pulling in the full `GateVerdict` union (this is workflow-internal, never a tool outcome). */
export type SlidesDataSelfCheck = { ok: true } | { ok: false; reason: string };

// ─────────────────────────────────────────────────────────────────────────
// Final workflow result
// ─────────────────────────────────────────────────────────────────────────

export interface InstagramAgentWorkflowResult {
  postId: string;
  topic: string;
  slideCount: number;
  renderedCount: number;
  deliverableId: string;
  /** SCRUM-242 (T-A10) — present only when this run's branding-guidelines context doc was absent; a human reviewer must see this, not merely a system that fetched it. */
  contextGrounding?: DegradedContextGroundingMarker;
}
