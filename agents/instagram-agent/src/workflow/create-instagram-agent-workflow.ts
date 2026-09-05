import fs from "node:fs/promises";
import path from "node:path";
import { readForbiddenTopics } from "@agent-engine/core";
import type { AgentContext, AgentTool, AgentToolRegistry, GateResponse, ModelRouter, PromptStore, StyleEdit, TemplateFeedback } from "@agent-engine/core";
import { type WorkflowContext, type RevisionNote, WorkflowBlockedIntake, WorkflowHeld, WorkflowToolingFailure, runAutoSetup, runReviewCycle, runTopicGuardrail, readRunDirection, revisionDirective, runDirectionField, buildClientVoiceContext, readOutputHistoryForDedup, dedupeDirective, checkOutputDedupe, dedupeRetryDirective, readClientIntelContext, readContextDoc, enforceContextDocPolicy, toAgentContext, distillStylePreferences, varyLearnedStyle, buildTrendQueries, pullTrendResearch, runTrendScout, researchDigestForScout, selectTrendCandidate, trendCandidateForDrafting, CONTENT_MODES, type DistilledStyle, type FeedbackEntryLike, type StyleVariationEntry } from "@agent-engine/workflow";
import type { InstagramFormat, InstagramTopicClaim as InstagramTopicClaimShape } from "./types.js";
import type { RenderCarouselInput, RenderCarouselResult } from "@agent-engine/tool-karos-publish";
import { InstagramCopyAgent } from "../agent/instagram-copy-agent.js";
import { InstagramImageVettingAgent } from "../agent/instagram-image-vetting-agent.js";
import { InstagramResearchAgent } from "../agent/instagram-research-agent.js";
import { InstagramVisualQaAgent } from "../agent/instagram-visual-qa-agent.js";
import {
  assertSafeMarkup,
  buildCustomArchetypeDocument,
  composeDocument,
  composeRawDocument,
  LEGACY_ARCHETYPE_IDS,
  materializeTemplates,
  promoteTemplate,
  reviewTemplate,
  TemplateDefinitionSchema,
  templateFileName,
  type TemplateStore,
} from "@agent-engine/tool-karos-templates";
import { brandLogoDataUri, downloadBrandLogo, parseBrandLogoDataUri, type BrandLogoPlacement } from "@agent-engine/tool-karos-media";
import { buildBrandHeadHtml, buildBrandLogoBodyHtml, deriveBrandRenderTokens, planBrandLogo, type BrandRenderTokens } from "./brand-render-tokens.js";
import {
  ARCHETYPE_TEMPLATE_FILES,
  assembleSlidesData,
  buildVariationPlan,
  checkSlidesData,
  INVERTED_TEMPLATE_SUFFIX,
  invertedTemplateFileName,
  resolveLayout,
  type GroundFgInversionConfig,
  type VariationPlanEntry,
} from "./slides-data.js";
import { checkCraftHygiene } from "./craft-hygiene.js";
import { checkExpectedScript, languageGateText, runLanguageFluency, LANGUAGE_FLUENCY_STEP_ID, LANGUAGE_SCRIPT_STEP_ID } from "./language-gate.js";
import {
  assessBrandAssetPresence,
  assessContrastFacts,
  buildElevatedVisualQaCriteria,
  checkPaletteWithinKit,
  type ContrastFact,
} from "./visual-qa-pre-checks.js";
import { parseStyleDirective, applyIntents, type StyleDirectiveResult, type StyleIntent, type StyleRefusal } from "./style-directive.js";
import {
  BrandTokensSchema,
  type BrandTokens,
  mergeStyleOverrides,
  ResearchOutputSchema,
  StyleConfigSchema,
  type ImageCandidate,
  type ImageSelection,
  type InstagramAgentWorkflowResult,
  type InstagramCopyOutput,
  type InstagramFrozenConfig,
  type InstagramRunClaim,
  type InstagramSlideLayout,
  type InstagramTopicClaim,
  type ResearchOutput,
  type SlideCustomArchetype,
  type StyleOverrides,
} from "./types.js";

/**
 * The self-check retry cap (RFC-03 §3 step 07): "capped at two returns to
 * step 05" means the very first attempt plus at most two revisions — three
 * total tries at steps 05-07 before the post is `WorkflowHeld`. P0
 * parity-audit Fixes 2 and 3 extend what this SAME budget covers — a step
 * 07b craft-hygiene failure or a step 08b visual-QA failure both `continue`
 * this same loop exactly like a step 07 self-check failure, rather than
 * getting their own separate retry mechanism.
 */
const MAX_SELF_CHECK_ATTEMPTS = 3;

/**
 * Revision rounds a reviewer may request before the run holds instead.
 *
 * Two, plus the original draft, so a person gets a real back-and-forth
 * without the loop becoming unbounded. It has to be bounded: every round
 * re-runs the paid drafting steps (copy, vetting, generation, render), and a
 * reviewer who keeps clicking "revise" would otherwise keep spending with
 * nothing in the system noticing.
 */
const MAX_REVISION_ROUNDS = 2;

/**
 * Writes one review decision to durable client memory, and routes any
 * per-slide template notes to the template registry.
 *
 * Two destinations because they are two different lessons. The reviewer's
 * words about the POST go to `memory.appendFeedback`, which the next run reads
 * back as standing guidance. Their words about a TEMPLATE go to the registry,
 * where they move that template's `qualityScore` and therefore which layout
 * later runs across every client actually get.
 *
 * Idempotent by construction: `feedbackId` is `${runId}-r${revision}`, so a
 * replayed run appends one row rather than one per replay.
 *
 * Failures are swallowed and logged, deliberately and narrowly: losing a note
 * is bad, but failing an already-APPROVED run because a memory write timed out
 * would throw away a finished carousel the client is waiting for. The gate
 * record itself still holds the decision verbatim, so nothing is
 * unrecoverable.
 */
/**
 * The stable id a `custom` archetype uses everywhere it's referenced before
 * it is ever promoted: the gate payload's synthetic `chosen` entry, the
 * reviewer's own `templateFeedback.templateId`, and (if promoted)
 * `promoteTemplate`'s own `id`. One id, minted at drafting time, so nothing
 * downstream needs a separate lookup to connect the three.
 */
export function customArchetypeTemplateId(clientSlug: string, archetypeId: string): string {
  return `${clientSlug}:${archetypeId}`;
}

/**
 * IGSTYLE-3, §2.3 — the effective kit for ONE attempt: `baseline` (Layer 0,
 * frozen at `02c-load-brand-kit`) with `learned` (Layer 1, the durable prior)
 * and `directive` (Layer 2, this run's own binding instruction) merged on
 * top, L2 winning (`mergeStyleOverrides`'s own last-wins contract).
 *
 * Pure and uncheckpointed on purpose: every input is already checkpointed
 * (`rawBrand` at 02g, `baseline` at 02c, `learned` at 02h, `directive` inside
 * `04g-style-directive`), so re-deriving this on every call is deterministic
 * and free — no separate checkpoint boundary needed, and none of the
 * "resuming an in-flight run replays an old-shape checkpoint" risk that
 * justifies the actual checkpointed steps' own existence.
 *
 * Two refuse-to-guess exits, both taken before spending a re-derivation:
 *
 * 1. Nothing to apply (`rawBrand` absent AND both patches empty) — returns
 *    `baseline` verbatim. The overwhelmingly common case (every revision-0
 *    call, and any later round nobody asked to re-colour), and the one that
 *    keeps revision 0 byte-identical to today.
 * 2. Re-deriving would DROP the `--bg`/`--fg` pair `baseline` had — a
 *    `StyleRefusal`, and the baseline kit ships instead. `deriveBrandRenderTokens`
 *    already drops a ground/fg pair that fails the 4.5:1 floor rather than
 *    shipping it broken; the bug this closes is what happens next — silently
 *    losing color from a working slide because ONE directive/learned patch
 *    turned out to be illegible is strictly worse than the run's original,
 *    frozen colors. "Never silently discard" (§2.3) is enforced here, not
 *    only inside `parseStyleDirective`.
 */
export function effectiveBrandKit(
  rawBrand: unknown,
  brandTokens: BrandTokens,
  learned: StyleOverrides,
  directive: StyleOverrides,
  baseline: BrandRenderTokens | undefined,
): { kit: BrandRenderTokens | undefined; refusals: StyleRefusal[] } {
  const learnedEmpty = Object.keys(learned).length === 0;
  const directiveEmpty = Object.keys(directive).length === 0;
  if (rawBrand === undefined && learnedEmpty && directiveEmpty) {
    return { kit: baseline, refusals: [] };
  }

  const merged = mergeStyleOverrides(brandTokens.renderTokens, learned, directive);
  // `deriveBrandRenderTokens`'s own explicit-override ladder only treats
  // ground/fg as an override AT ALL when BOTH are set (protecting its
  // contrast-floor check, which needs a pair to measure) — otherwise it
  // falls through to full re-derivation from `rawBrand`, silently discarding
  // a directive that touched only one of the two. That is the overwhelmingly
  // common real case ("make the text orange" says nothing about the
  // background), so a single-role pick must not be lost: fill the untouched
  // half from the CURRENT baseline's own resolved value before handing the
  // pair to `deriveBrandRenderTokens`. `finalize` (in `style-directive.ts`)
  // already checked the resulting pair against the contrast floor using
  // this exact baseline as context, so this fill-in cannot smuggle in a pair
  // that check would have refused.
  const groundFgFilled: StyleOverrides = { ...merged };
  if (merged.ground !== undefined && merged.fg === undefined && baseline?.cssVars["--fg"] !== undefined) {
    groundFgFilled.fg = baseline.cssVars["--fg"];
  }
  if (merged.fg !== undefined && merged.ground === undefined && baseline?.cssVars["--bg"] !== undefined) {
    groundFgFilled.ground = baseline.cssVars["--bg"];
  }
  const rederived = deriveBrandRenderTokens(rawBrand, { ...brandTokens, renderTokens: groundFgFilled });

  const baselineHadPair = baseline?.cssVars["--bg"] !== undefined && baseline?.cssVars["--fg"] !== undefined;
  const rederivedHasPair = rederived?.cssVars["--bg"] !== undefined && rederived?.cssVars["--fg"] !== undefined;
  if (baselineHadPair && !rederivedHasPair) {
    const refusal: StyleRefusal = {
      role: "pair",
      requested: `ground=${merged.ground ?? "(baseline)"} / fg=${merged.fg ?? "(baseline)"}`,
      reason:
        "re-deriving the brand kit with this round's merged style overrides dropped the ground/fg pair the baseline " +
        "kit had (most likely the pair failed deriveBrandRenderTokens's own contrast floor) — falling back to the " +
        "baseline kit rather than shipping this attempt with no ground/fg at all",
    };
    return { kit: baseline, refusals: [refusal] };
  }

  return { kit: rederived, refusals: [] };
}

/**
 * Validates every `layout: "custom"` slide's markup for THIS attempt and
 * returns the ones that passed — `resolveLayout` downgrades anything
 * missing, unvalidated, or a repeat within the carousel to `text_only`, so a
 * rejected or hallucinated custom archetype degrades exactly like a
 * `stat_callout` missing its `stat` does, never holding the run.
 *
 * Deliberately pure and re-derived every attempt from the checkpointed
 * `copy` — never itself checkpointed, for the same reason
 * `ensureTemplatesOnDisk` isn't: a validation result is only as good as the
 * file it describes actually being on THIS instance's disk, and re-deriving
 * both from the same checkpointed source on every attempt is what keeps
 * them from drifting apart across a resume on a different Cloud Run
 * instance.
 */
export function validateCustomArchetypes(copy: InstagramCopyOutput): SlideCustomArchetype[] {
  const validated: SlideCustomArchetype[] = [];
  for (const slide of copy.slides) {
    if (slide.layout !== "custom" || !slide.customArchetype) continue;
    const archetype = slide.customArchetype;
    // Belt-and-suspenders beyond the schema's own `custom_` regex: this
    // archetype's file lands in the SAME per-run directory the five real
    // structured archetypes' files do, and a collision would silently
    // overwrite one of them mid-run.
    if (LEGACY_ARCHETYPE_IDS.has(archetype.archetypeId)) {
      console.error(
        `validateCustomArchetypes: archetypeId "${archetype.archetypeId}" collides with a real archetype id — refusing rather than risking an overwrite`,
      );
      continue;
    }
    const safety = assertSafeMarkup(archetype.bodyHtml, archetype.css, archetype.slots);
    if (!safety.ok) {
      console.error(`validateCustomArchetypes: "${archetype.archetypeId}" failed its markup safety check: ${safety.reason}`);
      continue;
    }
    validated.push(archetype);
  }
  return validated;
}

/** Builds the full, self-contained document `composeDocument`/the renderer expect, from a validated custom archetype — branded like every other template when the run has brand fragments. */
export function composeCustomArchetypeDocument(archetype: SlideCustomArchetype, brandHeadHtml?: string, brandBodyHtml?: string): string {
  const definition = TemplateDefinitionSchema.parse({
    id: customArchetypeTemplateId("preview", archetype.archetypeId),
    archetypeId: archetype.archetypeId,
    name: archetype.name,
    layoutType: "typographic" as const,
    htmlTemplate: buildCustomArchetypeDocument(archetype.bodyHtml),
    cssStyles: archetype.css,
    source: "ai_generated" as const,
  });
  return composeDocument(definition, brandHeadHtml, brandBodyHtml);
}

async function persistReviewFeedback(
  wf: WorkflowContext,
  tools: AgentToolRegistry,
  ctx: AgentContext,
  input: {
    revision: number;
    response: GateResponse;
    templateFeedback: readonly TemplateFeedback[];
    templateStore?: TemplateStore | undefined;
    /**
     * Every `custom` archetype THIS run drafted (across every revision so
     * far), keyed by the same `customArchetypeTemplateId` scheme the gate
     * payload used. `persistReviewFeedback` is a module-level function with
     * no closure access to a draft's `copy` — this is how it learns a
     * `templateFeedback.templateId` names a run-generated design rather than
     * an already-registered row.
     */
    customArchetypesByTemplateId?: ReadonlyMap<string, SlideCustomArchetype> | undefined;
    /**
     * SCRUM-306 (AU23): this round's full draft, verbatim — attached to the
     * feedback row only on `reject` (see `persistReviewFeedbackToMemory`'s
     * doc for why: an approval already has a durable copy via
     * `ledger.writeDeliverable`, and a revise round's draft is superseded by
     * the next attempt). Serialized here rather than in the shared helper,
     * same reason that helper takes `content` as a plain string rather than
     * a generic `output: T` — Layer 1 makes no content judgments, so nothing
     * shared knows how to turn a `DraftResult` into text.
     */
    content?: string | undefined;
    /**
     * IGSTYLE-5, §2.4 writer 1 — this round's resolved style directive
     * (`DraftResult["styleDirectiveOutcome"]`, minus `refusals`, which
     * `StylePreferenceSchema` deliberately has no room for — see that
     * schema's own doc comment), so a future run's `distillStylePreferences`
     * has real evidence to vote over. `undefined` on the overwhelming
     * majority of rounds (nothing style-related was even attempted), exactly
     * like `styleDirectiveOutcome` itself.
     */
    style?: { overrides: Record<string, string>; source: "structured" | "parsed" | "model"; intents: StyleIntent[]; applied: string[] } | undefined;
  },
): Promise<void> {
  const note = input.response.feedback ?? input.response.reason;
  const append = tools["memory.appendFeedback"];
  // IGSTYLE-5 widens this gate from `note !== undefined` alone: a plain
  // approve carries no `feedback`/`reason` text at all (there is nothing a
  // person typed), but can still be the round that resolved a style
  // directive — the SAME directive a `revise` round before it produced,
  // carried forward because a revision's directive is resolved fresh every
  // attempt from the accumulated notes (§2.2), not only on the round that
  // first typed them. Without this widening, the overwhelmingly common
  // "revise once, then approve" review shape would only ever persist ONE
  // structured row (the revise round's), which rule 4's own threshold
  // ("one parsed sentence does not suffice") deliberately treats as not
  // enough evidence to learn from — the approve round's row is what a real
  // review naturally supplies to clear it, exactly like "written for every
  // decision including approvals" already promises for prose feedback.
  if ((note !== undefined || input.style !== undefined) && append !== undefined) {
    try {
      await wf.step.code(`09a-record-feedback-r${input.revision}`, async () =>
        append.execute(
          {
            feedbackId: `${wf.runId}-r${input.revision}`,
            productId: wf.productId,
            decision: input.response.decision,
            actor: input.response.actor,
            // `AppendFeedbackInputSchema.note` requires non-empty text
            // (`min(1)`) — a decision with structured style evidence and no
            // typed note still needs SOME note to satisfy that.
            note: note ?? `${input.response.decision} — no reviewer note this round (style directive carried over)`,
            revision: input.revision,
            runId: wf.runId,
            ...(input.content !== undefined ? { content: input.content } : {}),
            ...(input.style !== undefined ? { style: input.style } : {}),
          },
          { ctx },
        ),
      );
    } catch (error) {
      console.error(`persistReviewFeedback: could not record review feedback for run ${wf.runId}`, error);
    }
  }

  if (input.templateFeedback.length === 0 || input.templateStore === undefined) return;
  for (const entry of input.templateFeedback) {
    try {
      await wf.step.code(`09a-template-feedback-r${input.revision}-s${entry.slide}`, async () => {
        const store = input.templateStore!;
        // A `promote: true` on a run-generated custom archetype's FIRST
        // approval enrolls it into the registry — `promoteTemplate`'s own
        // seeded feedback entry already records this approval, so it is
        // called INSTEAD of `reviewTemplate`, never alongside it (stacking
        // `QUALITY_DELTA.approved` on top in the same turn would double-count
        // one human action as two). `store.get` first, rather than assuming
        // "not yet promoted": a reviewer who promotes the SAME archetypeId
        // again in a later revision round of this same run must land on the
        // ordinary review path instead — `promoteTemplate` has no
        // existence check of its own and would otherwise blind-overwrite the
        // row, resetting its quality score back to 40.
        const customArchetype = input.customArchetypesByTemplateId?.get(entry.templateId);
        if (entry.promote && customArchetype !== undefined && (await store.get(entry.templateId)) === undefined) {
          await promoteTemplate({
            store,
            archetypeId: customArchetype.archetypeId,
            name: customArchetype.name,
            htmlTemplate: buildCustomArchetypeDocument(customArchetype.bodyHtml),
            cssStyles: customArchetype.css,
            layoutType: "typographic",
            source: "ai_generated",
            clientSlug: wf.clientSlug,
            actor: input.response.actor,
            note: entry.note,
            now: Date.now(),
            id: entry.templateId,
          });
          return { templateId: entry.templateId, verdict: entry.verdict, promoted: true };
        }

        await reviewTemplate({
          store,
          templateId: entry.templateId,
          actor: input.response.actor,
          verdict: entry.verdict,
          note: entry.note,
          now: Date.now(),
        });
        return { templateId: entry.templateId, verdict: entry.verdict, promoted: entry.promote };
      });
    } catch (error) {
      console.error(`persistReviewFeedback: could not record template feedback for "${entry.templateId}"`, error);
    }

    // IGSTYLE-5, §2.4 writer 2 — the registry write above teaches the
    // template-quality system (a DIFFERENT store: `templateStore`, keyed by
    // `archetypeId`, moving a single row's score). It has nothing to do with
    // `distillStylePreferences`, which only ever reads `memory.feedback` rows
    // keyed by `clientSlug`. Without this second, ADDITIONAL write, a
    // reviewer's per-slide template note would never reach that store at
    // all — "in addition to the registry write, which must not be replaced"
    // is the acceptance line this satisfies. `scope: "template"` is what lets
    // a later `memory.readFeedback` consumer (or a human) tell this row apart
    // from an ordinary post-level decision.
    if (append !== undefined) {
      try {
        await wf.step.code(`09a-template-feedback-r${input.revision}-s${entry.slide}-tpl`, async () =>
          append.execute(
            {
              feedbackId: `${wf.runId}-r${input.revision}-s${entry.slide}-tpl`,
              productId: wf.productId,
              decision: entry.verdict === "approved" ? "approve" : "revise",
              actor: input.response.actor,
              note: entry.note,
              revision: input.revision,
              runId: wf.runId,
              scope: "template",
              slide: entry.slide,
            },
            { ctx },
          ),
        );
      } catch (error) {
        console.error(`persistReviewFeedback: could not record durable template feedback for "${entry.templateId}"`, error);
      }
    }
  }
}

/**
 * P0 parity-audit Fix 1: carousel-agent-v2 SKILL.md step 01's "absent or
 * empty, the default applies: the highest-evidence unused row across the
 * lanes that are furthest behind cadence" describes a real multi-lane
 * cadence-selection algorithm this Phase-1 build does not implement (it
 * would need per-lane cadence/schedule tracking that doesn't exist anywhere
 * in this repo yet). Rather than silently skip lane-scoped floor protection
 * whenever a client hasn't set an explicit `requestedLane` — which would
 * quietly defeat the whole point of Fix 1 — every run that doesn't specify a
 * lane falls back to this one named lane, so the floor guard in
 * `topics.reserve` is ALWAYS exercised, never silently bypassed. This is a
 * documented Phase-1 stand-in for the real "furthest behind cadence"
 * selection, not a claim that every client's topics naturally belong to one
 * lane called "general."
 */
export const DEFAULT_CAROUSEL_LANE = "general";

export interface CreateInstagramAgentWorkflowOptions {
  /** The base Layer 3 registry (client/research/topics/gates/ledger/publish) — see `packages/tools/src/index.ts`'s `createAllKarosTools()`. */
  tools: AgentToolRegistry;
  promptStore: PromptStore;
  router: ModelRouter;
  /**
   * Skips step 09's human `batch_review` gate and records a synthetic
   * `actor: "system"` approval instead — off by default, matching
   * `linkedin-agent`'s exact same opt-out pattern (RFC-01 §8.3). Intended
   * for tests/demos/evals that need a synchronous happy path, never for
   * production wiring.
   */
  autoApprove?: boolean;
  /**
   * The real filesystem directory every `templateDir`/`outDir`/image path in
   * this run's `slides-data.json` is resolved and bounds-checked against
   * (`publish.renderCarousel`'s own `repoRoot` input — RFC-03 §1 required-
   * reading item 2's `assertInside` guard). Required: there is no safe
   * default for "where do this deployment's templates/images actually live
   * on disk."
   */
  repoRoot: string;
  /**
   * A fixed candidate pool for step 06 to vet against.
   *
   * Optional, and normally omitted: step 05b now calls `media.findImages` to
   * source candidates from each slide's own `visualNeed`. Supplying a pool
   * here overrides that entirely, which is what tests and evals want (a fixed
   * pool is the only way to make step 06 deterministic) and what a caller
   * with curated client-owned assets wants.
   *
   * Defaults to empty, which no longer means "every run holds": empty is the
   * signal to go and search.
   */
  imageCandidatePool?: ImageCandidate[];
  /**
   * The slide-template registry (`@agent-engine/tool-karos-templates`).
   *
   * Omit and the run reads archetype templates straight off disk from the
   * client's own `templateDir`, exactly as it did before the registry
   * existed. Supply one and step 04c MATERIALIZES the registry's winning
   * template per archetype into this run's own directory and renders from
   * there (Approach (a)) — which is what lets a template live in Firestore,
   * and what the promotion path writes into.
   *
   * Optional rather than required on purpose: the registry must never be
   * able to take slide rendering down, and a caller that has not wired one
   * should get the previous behaviour rather than a broken run.
   */
  templateStore?: TemplateStore | undefined;
  /**
   * The fetch used for the brand-logo download. Defaults to the global
   * fetch; tests inject a fake so a logo "download" is deterministic and
   * offline, the same reason the render tool takes a fake in tests.
   */
  fetchImpl?: typeof fetch;
}


/**
 * `createInstagramAgentWorkflow()` (RFC-03): the 9-step run protocol,
 * steps 01-09, native to `agent-engine` from day one (RFC-03 §1 — no legacy
 * execution path exists to preserve compatibility with). Every legacy v1->v2
 * defect fix (RFC-03 §2) is structural here, not a comment:
 *
 * 1. **Context bloat** — every `BaseAgent` step (`allowedTools: []`) only
 *    ever sees the one already-assembled input the workflow hands it for
 *    that run; nothing here reads a growing ledger/master-file in full.
 * 2. **A rogue rendering path** — step 08 calls the one shared, already-
 *    tested `publish.renderCarousel` tool; this package writes no rendering
 *    code of its own, and never touches an absolute path (`assembleSlidesData`
 *    only ever produces repo-relative paths, which `assertInside` inside the
 *    tool itself refuses to relax).
 * 3. **The ledger illusion** — `topics.reserve` (step 03) is the only claim
 *    made before any paid work runs, and it is the only thing step 09
 *    re-confirms (`topics.commit`) before logging; no second, shadow dedup
 *    mechanism exists anywhere in this workflow.
 *
 * P0 parity-audit fixes layered on top of the above (see each fix's own doc
 * comment at its call site below for the full rationale):
 *
 * - **Fix 1** — step 03 passes the run's actual lane to `topics.reserve`,
 *   restoring the lane/floor-of-5 dedup model instead of a single
 *   undifferentiated catalog.
 * - **Fix 2** — steps 05-08 now share ONE retry loop that also covers a new
 *   step 08b post-render visual QA, not just step 07's self-check.
 * - **Fix 3** — step 07b is a new, unconditional mechanical craft-hygiene
 *   gate (em dash/exclamation/sentence-case), plus cross-post image-reuse
 *   prevention wired into step 06 and step 09b.
 * - **Fix 4** — step 06's image selections now carry a real rights/licence/
 *   watermark verdict, and a failing one is never shipped.
 *
 * ## The zero-held guarantee (2026-08)
 *
 * A carousel never fails to ship BECAUSE OF A PICTURE. Every tier can be down
 * at once (every stock/CC provider, the social scrape, the generative rescue)
 * and the run still delivers, degrading the affected slides to typographic
 * archetypes. Four mechanisms carry it:
 *
 * 1. An empty candidate pool skips the vetting model call and falls straight
 *    to the rescue tiers, rather than holding on a verdict about nothing.
 * 2. A sourcing `tooling_error` (a provider outage) is RECORDED, not thrown.
 *    It used to fail the whole run, so one library returning 503 discarded
 *    copy that was already written.
 * 3. Step 06f re-verifies every selected image is still on disk, so a media
 *    cache lost to an instance recycle degrades the slide instead of failing
 *    the render.
 * 4. A render `content_fail` strips every image and re-renders once, fully
 *    typographic, before reporting anything.
 *
 * Four holds remain, and none is a picture problem: no subject available at
 * all, research producing no schema-valid facts, the copy/compliance
 * self-checks never passing inside the retry budget, and a human rejecting
 * the batch review. Each is asserted in `__tests__/zero-held-guarantee.test.ts`
 * so the boundary is pinned rather than assumed.
 */
export function createInstagramAgentWorkflow(options: CreateInstagramAgentWorkflowOptions) {
  const tools = options.tools;
  const imageCandidatePool = options.imageCandidatePool ?? [];

  return async function instagramAgentWorkflow(wf: WorkflowContext): Promise<InstagramAgentWorkflowResult> {
    const ctx = toAgentContext(wf);

    // The run-scoped instruction and any media the person attached. Read once:
    // the direction steers copy, and the attachments become Tier 0 below.
    const runDirection = readRunDirection(wf.input);

    // ── 00-auto-setup: onboard this client inline, rather than requiring
    // somebody to have dispatched a separate setup agent first ──
    //
    // Step 03 below survives an unseeded catalog by falling back, which fixed
    // the outage where "every run died at step 03" — but a client whose catalog
    // is never seeded then runs in fallback FOREVER, and so runs forever
    // without the dedup lock the catalog exists to provide. This seeds it from
    // the titles of documents `research.pull` actually retrieved, so step 03
    // can reserve properly from the next run onward.
    //
    // Genuinely first, and it reads its own `client.getConfig`/`getProfile`
    // rather than borrowing step 01's `runClaim`. That costs one extra store
    // read and buys a step whose name does not lie: a step called `00-` that
    // executed third would misdescribe every run record it appears in.
    //
    // Never fails the run. Every problem (no scraper, an outage, no usable
    // titles, no declared industry) degrades to a recorded note, and step 03's
    // fallback carries the run exactly as it did before this step existed.
    // Not bound to a local: nothing downstream branches on the outcome (step
    // 03 re-reads the catalog either way), and `wf.step.code` already persists
    // the returned notes into the run record, which is where someone
    // debugging "why is this client still in fallback" will look.
    await wf.step.code("00-auto-setup", async () => {
      const [configOutcome, profileOutcome] = await Promise.all([
        tools["client.getConfig"]!.execute({}, { ctx }),
        tools["client.getProfile"]!.execute({}, { ctx }),
      ]);

      // Seeded topics must land in the lane step 03 will reserve from, or the
      // reserve breaches on a lane mismatch and the seeding was wasted.
      const runConfig = configOutcome.status === "success" ? (configOutcome.result as Record<string, unknown>) : {};
      const lane = typeof runConfig["requestedLane"] === "string" ? (runConfig["requestedLane"] as string) : DEFAULT_CAROUSEL_LANE;

      // Gated on a declared industry, and that gate is load-bearing rather
      // than defensive. Seeding needs a query; without an industry the only
      // available query is generic, and generic research would seed topics
      // with no relationship to this client. Step 03 would then reserve one
      // and draft from it in good faith, so an off-brand catalog is worse than
      // an empty one. A client with no profile is left to hold, honestly.
      const industry = industryForSetup(profileOutcome);
      if (industry === undefined) {
        return {
          ran: false,
          catalogSizeBefore: 0,
          catalogSizeAfter: 0,
          topicsAdded: 0,
          notes: ["client has no declared industry, so there is no honest query to seed topics from"],
        };
      }

      return runAutoSetup({
        tools,
        ctx,
        lane,
        researchJob: "instagram-topic-seed",
        researchQuery: `${industry} content topics and trends`,
      });
    });

    // ── 01: open the run / claim the post number ──
    const runClaim = await wf.step.code("01-open-run", async (): Promise<InstagramRunClaim> => {
      const configOutcome = await tools["client.getConfig"]!.execute({}, { ctx });
      const runConfig = configOutcome.status === "success" ? (configOutcome.result as Record<string, unknown>) : {};
      const requestedLane = typeof runConfig["requestedLane"] === "string" ? (runConfig["requestedLane"] as string) : undefined;
      const requestedSubject = typeof runConfig["requestedSubject"] === "string" ? (runConfig["requestedSubject"] as string) : undefined;
      const requestedPostNumber = typeof runConfig["postNumber"] === "number" ? (runConfig["postNumber"] as number) : undefined;
      // The post format (2026-09): this run's own request first, then the
      // client's standing setting. Anything but the three known values is
      // ignored so a typo cannot switch a client's whole feed to single images.
      const isFormatChoice = (v: unknown): v is "carousel" | "single" | "auto" => v === "carousel" || v === "single" || v === "auto";
      const runFormat = (wf.input ?? {})["requestedFormat"];
      const requestedFormat = isFormatChoice(runFormat) ? runFormat : isFormatChoice(runConfig["instagramFormat"]) ? runConfig["instagramFormat"] : undefined;
      // `wf.runId` is already a caller-supplied, globally-unique idempotency
      // key (RFC-01 §9.1 rule 2), so it doubles as `postId` directly — a
      // dedicated sequential-counter tool (RFC-03 §3's suggested
      // `carousel.claimRunNumber`) is real shared infrastructure this
      // package's brief explicitly does not include building; `postNumber`
      // below is therefore best-effort/cosmetic (client-suppliable), never
      // load-bearing for any later step's correctness.
      return {
        postId: wf.runId,
        postNumber: requestedPostNumber ?? 1,
        ...(requestedLane !== undefined ? { requestedLane } : {}),
        ...(requestedSubject !== undefined ? { requestedSubject } : {}),
        ...(requestedFormat !== undefined ? { requestedFormat } : {}),
      };
    });

    // ── 02: freeze the small files — style config + brand tokens, parse-check-or-HALT ──
    const frozen = await wf.step.code("02-freeze-style-config", async (): Promise<InstagramFrozenConfig> => {
      const configOutcome = await tools["client.getConfig"]!.execute({}, { ctx });
      if (configOutcome.status !== "success") {
        throw new WorkflowBlockedIntake("client config has not been set up for this client yet — cannot freeze a style config or brand tokens");
      }
      const config = configOutcome.result as Record<string, unknown>;

      const styleConfigParse = StyleConfigSchema.safeParse(config["instagramStyleConfig"]);
      if (!styleConfigParse.success) {
        // Never guess defaults silently (RFC-03 §1 required-reading item 1's
        // "parse-check-or-HALT" rule) — a bad/missing style config blocks
        // intake outright.
        throw new WorkflowBlockedIntake(
          `client's instagramStyleConfig failed to parse/validate — refusing to guess defaults: ${styleConfigParse.error.message}`,
        );
      }
      const brandTokensParse = BrandTokensSchema.safeParse(config["instagramBrandTokens"]);
      if (!brandTokensParse.success) {
        throw new WorkflowBlockedIntake(
          `client's instagramBrandTokens failed to parse/validate — refusing to guess defaults: ${brandTokensParse.error.message}`,
        );
      }
      if (styleConfigParse.data.canvas.scale !== 2) {
        throw new WorkflowBlockedIntake(
          `client's frozen canvas.scale must be exactly 2, got ${styleConfigParse.data.canvas.scale} — publish.renderCarousel's QA PNG floor depends on it`,
        );
      }

      return {
        forbiddenTopics: readForbiddenTopics(configOutcome.result),
        styleConfig: styleConfigParse.data,
        brandTokens: brandTokensParse.data,
      };
    });

    // ── 02b: the client's own voice/profile context — best-effort, never blocking ──
    //
    // Everything else this workflow reads (`instagramStyleConfig`,
    // `instagramBrandTokens`) is colors, canvas and compliance words. None of
    // it carries what a client's brand voice actually SAYS — including, for a
    // client like Geektime (Israel's largest HEBREW-language tech site), the
    // language the post has to be written in. That sentence lives in
    // `client.getProfile`'s `description` and `client.getVoiceRules`'s
    // `guidelines`, neither of which this workflow ever called before, so a
    // carousel drafted in fluent English for a Hebrew-only outlet passed every
    // check that existed and shipped anyway (prep job hcf9ymPGJC7mDS5pcEQ4).
    //
    // SCRUM-309 (AU31): prose is a real signal but not a reliable one — the
    // fix above still depends on someone's profile blurb happening to
    // mention a language. `client.getBrand`'s structured `language` field
    // (read here, independently of step 02c's frozen render-token copy of
    // the same brand kit — see that step's own comment for why they are
    // deliberately two separate calls) is threaded in as a third,
    // unconditional argument so a language requirement no longer depends on
    // which sentence a human happened to write it into.
    //
    // Best-effort and non-blocking on purpose: a client with no profile/voice
    // rules set up yet should still get a carousel, in English, same as
    // before this step existed — this step only ever ADDS context, it never
    // gates on finding any.
    const clientVoiceContext = await wf.step.code("02b-load-client-voice-context", async () => {
      const profileOutcome = await tools["client.getProfile"]?.execute({}, { ctx });
      const voiceOutcome = await tools["client.getVoiceRules"]?.execute({}, { ctx });
      const brandOutcome = await tools["client.getBrand"]?.execute({}, { ctx });
      return buildClientVoiceContext(
        profileOutcome?.status === "success" ? (profileOutcome.result as Record<string, unknown>) : undefined,
        voiceOutcome?.status === "success" ? (voiceOutcome.result as Record<string, unknown>) : undefined,
        brandOutcome?.status === "success" ? (brandOutcome.result as Record<string, unknown>) : undefined,
      );
    });

    // ── 02c: the client's Brand Kit — best-effort, never blocking ──
    //
    // `client/brand.json` has carried each client's real palette, fonts,
    // visualStyle and logo since the portal started projecting them, and
    // NOTHING in the render path ever read it — the only brand value that
    // reached a slide was `instagramBrandTokens.accentColor`, which is how
    // every client shipped the same generic dark design (RFC-03's own step-02
    // row lists `client.getBrand` as one of the two tools this step should
    // read; only `getConfig` ever was).
    //
    // A NEW step rather than an extension of 02b, deliberately: 02b's
    // checkpoint shape is already in production, and an in-flight run
    // resuming across this deploy would replay an old-shape checkpoint into
    // new-shape code. And a CHECKPOINTED step, deliberately: every later
    // consumer (the head-fragment build, re-materialization after an
    // instance recycle) reads this frozen value only, so a portal edit
    // mid-run cannot change the brand between attempt 1 and a revision.
    // `?? undefined` on BOTH sides of the checkpoint: a step's return value
    // round-trips through JSON, which has no `undefined` — a first run's
    // `undefined` comes back as `null` on a resumed run, and `null !==
    // undefined` would send a brandless client down the branded path with a
    // null kit (the exact crash a resumed gate-approval hit in tests).
    const brandKit =
      (await wf.step.code("02c-load-brand-kit", async () => {
        const brandOutcome = await tools["client.getBrand"]?.execute({}, { ctx });
        return (
          deriveBrandRenderTokens(brandOutcome?.status === "success" ? brandOutcome.result : undefined, frozen.brandTokens) ?? null
        );
      })) ?? undefined;

    // ── 02d: the client's declared target language — the language gate's subject ──
    //
    // SCRUM-310 (AU32). 02b folds `client.getBrand().language` into a PROMPT
    // (a requirement the drafting model is asked to follow); steps 07e/07f
    // need the bare value back out to CHECK that it was followed. Reading the
    // structured field rather than re-deriving a language out of 02b's prose
    // blob is the whole point of AU31 having introduced the field.
    //
    // A separate checkpointed step rather than a widening of 02b or 02c, for
    // exactly the reason 02c's own comment gives: both of those checkpoint
    // shapes are already in production, and an in-flight run resuming across
    // this deploy would replay an old-shape checkpoint into new-shape code.
    // Checkpointed, so a portal edit mid-run cannot change the language
    // between attempt 1 and a revision — the gate must judge against the
    // language the copy was actually drafted for.
    //
    // `?? undefined` across the checkpoint boundary for the same JSON
    // round-trip reason as 02c: a step's `undefined` comes back as `null` on
    // a resumed run.
    const targetLanguage =
      (await wf.step.code("02d-load-target-language", async () => {
        const brandOutcome = await tools["client.getBrand"]?.execute({}, { ctx });
        if (brandOutcome?.status !== "success") return null;
        const language = (brandOutcome.result as { language?: unknown }).language;
        return typeof language === "string" && language.trim().length > 0 ? language.trim() : null;
      })) ?? undefined;

    // ── 02e: the client's projected branding-guidelines context doc (C1/SCRUM-209, T-A9) ──
    //
    // instagram-agent is one of two agents this ticket calls "the agents that
    // read nothing" — before this step, nothing here ever called
    // `client.getContextDoc`, so a client's own visual-identity guidance
    // (logo/lockup rules, imagery do's and don'ts, palette usage beyond the
    // bare `accentColor` hex `instagramBrandTokens` already carries) never
    // reached the copy-writing prompt, even though this is a VISUAL post
    // whose `visualNeed`s and archetype choices are exactly what such
    // guidance is meant to steer. `branding-guidelines` (not `brand-voice`)
    // is the deliberate choice here: voice/tone already reaches this prompt
    // through `clientVoiceContext` (02b) and `client.getBrand`'s structured
    // fields (02c/02d); what was missing is the client's stated visual
    // identity rules, which is what `branding-guidelines` actually is.
    //
    // Best-effort and non-blocking, same as every other optional context
    // read here (02b/04f): a client with no projected branding-guidelines
    // doc yet drafts exactly as this workflow did before this step existed —
    // T-A10, not this ticket, decides whether a MISSING doc should ever
    // change that.
    const brandingGuidelines = await readContextDoc(wf, tools, ctx, "branding-guidelines", "02e-load-branding-guidelines");

    // ── 02f: SCRUM-242 (T-A10) — stop failing open. instagram-agent's row in the
    // one shared policy table (CONTEXT_DOC_POLICY) is DEGRADED, not BLOCK: this is
    // channel copy a human reviews before it ships, so the run still completes —
    // but the marker `enforceContextDocPolicy` returns is what makes "this ran
    // with zero real grounding" visible instead of indistinguishable from a
    // genuinely grounded post (the ticket's own "worst of the three options").
    // Threaded into the deliverable AND the workflow's own return value below —
    // see those sites' own comments for why a step checkpoint alone isn't enough.
    const contextGrounding = await wf.step.code("02f-enforce-context-doc-policy", () =>
      enforceContextDocPolicy({ agentId: "instagram-agent", docs: { "branding-guidelines": brandingGuidelines } }),
    );

    // ── 02g: the RAW brand kit (IGSTYLE-3, §2.3) ──
    //
    // `02c` above only ever kept `deriveBrandRenderTokens`'s OUTPUT. Applying a
    // learned/directive style patch means re-deriving with a merged
    // `renderTokens`, and re-deriving needs the raw `client.getBrand()` object
    // 02c itself derived from — never checkpointed anywhere until now.
    //
    // A NEW step rather than a widened 02c, for the exact reason 02c/02d's own
    // comments give: an in-flight run resuming across this deploy would replay
    // an old-shape checkpoint into new-shape code. Named `02g` (not the spec
    // draft's `02e`) because `02e`/`02f` were already taken by SCRUM-209/242's
    // branding-guidelines/context-doc-policy steps by the time this ticket
    // landed — same `?? undefined` JSON round-trip treatment as 02c/02d.
    const rawBrand =
      (await wf.step.code("02g-load-brand-kit-raw", async () => {
        const brandOutcome = await tools["client.getBrand"]?.execute({}, { ctx });
        return brandOutcome?.status === "success" ? brandOutcome.result : null;
      })) ?? undefined;

    // ── 02h: the learned style prior (IGSTYLE-5) ──
    //
    // Layer 1 of §2.2's three-layer resolution — a PRIOR distilled from this
    // client's accumulated feedback, read once and frozen for the run so
    // another run's write mid-flight can't change it under this one (hence a
    // single `wf.step.code` call outside `draftOnce` — every attempt inside
    // the revision loop below sees the SAME frozen prior, never a re-read
    // that could drift between round 0 and round 1 of the same run).
    //
    // Best-effort and never blocking, same convention as `readPastFeedback`
    // right below in the same source file this reads from
    // (`packages/workflow/src/primitives/review-cycle.ts`): a memory read
    // failing, or `memory.readFeedback` simply not being wired for this
    // client, must not stop a run that can draft without a prior — it drafts
    // exactly as it did before this ticket existed (an empty `learned` patch
    // is invisible to `mergeStyleOverrides`).
    const distilledStyle: DistilledStyle = await wf.step.code("02h-learned-style-preferences", async () => {
      const read = tools["memory.readFeedback"];
      if (read === undefined) return { overrides: {}, strength: {}, intents: [], evidence: [] };
      try {
        const outcome = await read.execute({ productId: wf.productId, limit: 50 }, { ctx });
        if (outcome.status !== "success") return { overrides: {}, strength: {}, intents: [], evidence: [] };
        const entries = (outcome.result as { entries: FeedbackEntryLike[] }).entries;
        return distillStylePreferences(entries, { productId: wf.productId });
      } catch (error) {
        console.error(`02h-learned-style-preferences: could not read client style history for run ${wf.runId}, drafting without a prior`, error);
        return { overrides: {}, strength: {}, intents: [], evidence: [] };
      }
    });
    // `DistilledStyle["overrides"]` is a plain `Record<string, string>` keyed
    // by role (never any key `StyleOverrides` doesn't also accept — see
    // `distillStylePreferences`'s own role loop, which only ever considers
    // "ground"/"fg"/"accent") — structurally exactly a `StyleOverrides`
    // patch, just not spelled as one in that lower package (§ this file's
    // import comment on why `packages/workflow` cannot import this agent's
    // own types).
    const learnedStyle: StyleOverrides = distilledStyle.overrides;

    /**
     * The brand kit THIS attempt actually renders with — `brandKit` (Layer 0,
     * frozen at 02c) until `draftOnce` resolves a revision's own effective
     * kit (§2.3's `effectiveBrandKit`) and reassigns it, at which point every
     * consumer below (`brandLogoAssessment`, `brandFragments`, the palette/
     * accent/handle reads inside `draftOnce`) sees the NEW kit on its very
     * next call — the same "re-derive fresh every call, never cache across a
     * revision" rule `ensureTemplatesOnDisk`'s own doc comment already
     * requires for the on-disk template files.
     *
     * A plain mutable binding rather than a parameter threaded through every
     * one of those closures: this whole workflow function replays
     * deterministically from its checkpoints on every resume (`brandKit`
     * itself is exactly this same pattern — a `const` derived from a
     * checkpointed step), and the review cycle is a strict, single-threaded
     * loop (`runReviewCycle`'s own doc comment: "attempt -> buildGate -> gate
     * -> onDecision, one round fully resolves before the next begins") — so
     * there is never a moment two revisions' effective kits are live at once.
     * Reassigned once per revision inside `draftOnce`, never per attempt: the
     * style directive is revision-scoped (`04g-style-directive`), not
     * attempt-scoped, so every attempt within one revision correctly shares
     * one effective kit.
     */
    let effectiveKit: BrandRenderTokens | undefined = brandKit;

    /**
     * IGSTYLE-3 — which kit `ensureTemplatesOnDisk` last actually wrote to
     * disk, so a revision whose `effectiveKit` differs from round 0's forces
     * a re-materialization even when the files are still physically PRESENT
     * (the common case: the same Cloud Run instance handles every round of
     * one run, so the 9qkTWlg7e9ZLiVIZUok4 "instance recycled" trigger never
     * fires, but the CONTENT still has to change). Without this, a directive
     * would resolve correctly at `04g-style-directive` and then silently
     * never reach a single rendered pixel, because the presence check alone
     * has no way to know the file on disk is stale rather than merely
     * present — exactly the kind of silent loss this whole ticket exists to
     * close.
     *
     * The sentinel (rather than starting at `undefined`) matters: `undefined`
     * is itself a legal `effectiveKit` value (a brandless client), and this
     * must force a materialization on the very first call regardless of
     * whether that first kit happens to be `undefined`.
     */
    const NEVER_MATERIALIZED = Symbol("templates-never-materialized");
    let templatesMaterializedForKit: BrandRenderTokens | undefined | typeof NEVER_MATERIALIZED = NEVER_MATERIALIZED;

    const brandFetch = options.fetchImpl ?? fetch;
    let cachedLogoDataUri: string | undefined;
    /**
     * The brand logo, as a data URI. Embedded rather than referenced —
     * a `slide.images` path whose file vanished on a recycled instance is a
     * run-holding `content_fail`, and brand furniture must never be able to
     * hold a run. Memoized in-process, cached on the run's own disk for a
     * same-instance restart, re-fetched fresh after a recycle; a fetch
     * FAILURE is never memoized, so the next attempt tries again and a
     * transient outage costs one attempt's logo, not the run's.
     */
    const ensureBrandLogoDataUri = async (): Promise<string | undefined> => {
      if (effectiveKit?.logoUrl === undefined) return undefined;
      if (cachedLogoDataUri !== undefined) return cachedLogoDataUri;
      const cacheDir = path.resolve(options.repoRoot, ".media-cache", wf.runId, "brand");
      const cacheFile = path.join(cacheDir, "logo.datauri");
      const rootResolved = path.resolve(options.repoRoot);
      if (!cacheDir.startsWith(rootResolved + path.sep)) return undefined;
      try {
        cachedLogoDataUri = await fs.readFile(cacheFile, "utf8");
        return cachedLogoDataUri;
      } catch {
        // Not cached on this instance yet — fetch below.
      }
      const download = await downloadBrandLogo(brandFetch, effectiveKit.logoUrl);
      if (download === undefined) return undefined;
      cachedLogoDataUri = brandLogoDataUri(download);
      try {
        await fs.mkdir(cacheDir, { recursive: true });
        await fs.writeFile(cacheFile, cachedLogoDataUri, "utf8");
      } catch {
        // A cache write failure costs a refetch, nothing else.
      }
      return cachedLogoDataUri;
    };

    /**
     * The one place this run decides whether a brand logo will render at all
     * this attempt, and (AU38, SCRUM-322) where it goes and whether it
     * survives this client's ground — from the mark's own decoded pixels
     * against the ground token the slide will actually render on, never from
     * a sentence in a prompt asking for a legible placement.
     *
     * Factored out of `brandFragments` (SCRUM-324/AU40) so the deterministic
     * visual-QA pre-check (step 08a2 below) can read the SAME placement
     * `brandFragments` itself renders from, rather than re-deriving it — the
     * two must never be able to disagree about whether a logo shipped this
     * attempt.
     */
    const brandLogoAssessment = async (): Promise<{ logoDataUri?: string; placement?: BrandLogoPlacement }> => {
      if (effectiveKit === undefined) return {};
      const logoDataUri = await ensureBrandLogoDataUri();
      const download = logoDataUri !== undefined ? parseBrandLogoDataUri(logoDataUri) : undefined;
      // IGSTYLE-3: planned against `effectiveKit`, not the frozen 02c kit —
      // change the ground and keep the old plan and you ship a black logo on
      // a black slide. An illegible mark against the NEW ground is omitted
      // exactly as it always was against the old one (`planBrandLogoPlacement`
      // itself decides that); this just makes sure it is asked about the
      // ground that will actually be under it.
      const placement =
        download !== undefined
          ? planBrandLogo(effectiveKit, download, { hasSeriesBadge: frozen.brandTokens.seriesBadge !== undefined })
          : undefined;
      return { ...(logoDataUri !== undefined ? { logoDataUri } : {}), ...(placement !== undefined ? { placement } : {}) };
    };

    /**
     * The fragments (head: font links + token sheet + badge variant; body:
     * the logo `<img>`) spliced into every rendered document. Re-derived from
     * `effectiveKit` on every call (IGSTYLE-3 — was the frozen `brandKit`) —
     * the string work is pure, and the one piece of I/O (the logo fetch)
     * degrades to "no logo this attempt" rather than ever failing a compose.
     */
    const brandFragments = async (): Promise<{ head?: string; body?: string }> => {
      if (effectiveKit === undefined) return {};
      const { logoDataUri, placement } = await brandLogoAssessment();
      // A plan whose decision is `omit` emits neither the rules nor the
      // `<img>`: an illegible mark ships as nothing, never as a smudge, and
      // never as a held run.
      const showLogo = logoDataUri !== undefined && placement !== undefined && placement.decision !== "omit";
      return {
        head: buildBrandHeadHtml(effectiveKit, showLogo ? { logo: placement } : {}),
        ...(showLogo ? { body: buildBrandLogoBodyHtml(logoDataUri) } : {}),
      };
    };

    // Render-type rules from the frozen config (Fix 2) — evaluated post-render
    // by step 08b, never by step 07's checkSlidesData (which only ever
    // evaluates `check: "copy"` rules).
    const renderRules = frozen.styleConfig.rules.filter((r) => r.check === "render");

    // ── 03: claim the subject — the catalog first, then the same fallbacks every other channel already has ──
    const claimedTopic = await wf.step.code("03-claim-topic", async (): Promise<InstagramTopicClaim> => {
      const reservationKey = `${wf.runId}__topic`;
      const lane = runClaim.requestedLane ?? DEFAULT_CAROUSEL_LANE;

      /*
       * A SUBJECT SOMEONE TYPED FOR THIS RUN OUTRANKS THE CATALOG.
       *
       * This is the one thing that goes above the reservation, and a live prep
       * run is what showed why it has to. The direction reached the copy step
       * (`runDirectionField` at step 05) but not this one, so the catalog picked
       * the subject, step 04 researched THAT subject, and the writer was handed
       * a direction it could not honour alongside facts about something else.
       * It wrote about the facts, correctly, and the person got a carousel on a
       * topic they had not asked for — with no error anywhere.
       *
       * The rule below is the same one blog-agent and x-agent already apply, and
       * the reasoning the surrounding comment gives for keeping the RESERVATION
       * first does not reach it. That reasoning is about `requestedSubject`, a
       * STANDING config field: making it outrank the catalog would silently drop
       * the dedup lock on every run of every client who ever set it. A typed
       * direction is per-run and per-person — it cannot silently affect a run
       * nobody typed at.
       *
       * Dedup honesty is preserved exactly as the fallback path preserves it: no
       * `reservationKey`, so step 09 skips `topics.commit` and the catalog is
       * never told it issued a topic it did not.
       */
      if (runDirection.topicOverride) {
        return { topic: runDirection.topicOverride, source: "requested" };
      }

      const outcome = await tools["topics.reserve"]!.execute({ reservationKey, count: 1, excludeTopics: [], lane }, { ctx });
      if (outcome.status === "success") {
        const result = outcome.result as { reservationKey: string; topics: string[] };
        return { reservationKey: result.reservationKey, topic: result.topics[0]!, source: "reserved" };
      }
      if (outcome.status !== "content_fail") {
        throw new WorkflowToolingFailure(`topics.reserve failed: ${outcome.status}`);
      }

      /*
       * A FLOOR BREACH IS NO LONGER THE END OF THE RUN.
       *
       * The old code threw `WorkflowHeld` here, and its reasoning was sound in
       * isolation: the catalog is "the only dedup gate" (RFC-03 §2.3), so
       * proceeding without a claim means proceeding without the dedup lock, and
       * inventing a topic in a deterministic code step would be fabrication.
       * What that reasoning missed is that THIS AGENT WAS THE ONLY ONE THAT DID
       * IT. Every other caller of `topics.reserve` in this repo — x-agent,
       * linkedin-agent, blog-agent, newsletter-agent, reddit-agent,
       * campaign-orchestrator — treats a `content_fail` as "the catalog can't
       * help this run" and falls through to a research-derived candidate
       * (x-agent's step 06/07 is the closest analogue and the model followed
       * here). And it is also the only caller that passes `lane`, so it is the
       * only one whose reserve can breach on a lane mismatch rather than on an
       * empty catalog.
       *
       * The consequence in production was total, not marginal: nothing in this
       * repo ever seeds a topics catalog with real rows (`topics.topUp` is
       * called by exactly one caller — `topics.reserve`'s own proactive top-up,
       * with an empty array, a documented no-op), so a client whose catalog was
       * never seeded out of band could not run this agent AT ALL. Every run
       * died at step 03. That is not a guardrail declining a post; that is an
       * agent that cannot start.
       *
       * The dedup honesty is preserved rather than dropped: a fallback claim
       * carries no `reservationKey`, `source` records where the subject really
       * came from, and step 09's `topics.commit` is skipped for it — so the
       * catalog is never told a topic was consumed that it never issued. What a
       * fallback run gives up is dedup PROTECTION, which is the correct trade
       * against not running: a possibly-repeated post is reviewable by the human
       * gate at step 09; a run that never happened is not.
       *
       * WHY THE RESERVATION IS STILL TRIED FIRST, unlike x-agent (whose
       * explicit `requestedTopic` outranks a reserved one): the happy path must
       * not change. A client with a healthy catalog keeps getting a real dedup
       * lock on every run, exactly as before — `requestedSubject` only decides
       * things when the catalog could not. Making it outrank the catalog would
       * silently drop the dedup lock for every run of every client who has ever
       * set that field, which is a different change with different consequences.
       */

      // 1. What the client actually asked for. Read into `InstagramRunClaim` at
      //    step 01 since that step was written and, until now, never once read —
      //    a client could set `requestedSubject` and have it silently ignored.
      if (runClaim.requestedSubject) {
        return { topic: runClaim.requestedSubject, source: "requested" };
      }

      // 2. A research-derived subject, built the same way x-agent's step 04/05
      //    builds its own fallback candidate: from the client's own declared
      //    industry, labelled for what it is. Phase 1's `research.pull` has no
      //    real search backend (see karos-research/src/pull.ts), so the honest
      //    candidate is the QUERY, never a fabricated finding — the research
      //    agent at step 04b still does the real sourcing work on top of it.
      const profileOutcome = await tools["client.getProfile"]!.execute({}, { ctx });
      const industry =
        profileOutcome.status === "success" && typeof (profileOutcome.result as Record<string, unknown>)["industry"] === "string"
          ? ((profileOutcome.result as Record<string, unknown>)["industry"] as string)
          : undefined;
      if (industry) {
        return { topic: `${industry} trends this week`, source: "research" };
      }

      // 3. Genuinely nothing to post about: no catalog row, no requested
      //    subject, and no declared industry to derive one from. NOW a hold is
      //    the honest answer, and its message says which three things were
      //    missing rather than blaming the catalog alone.
      throw new WorkflowHeld(
        `no subject available for this run — the topics catalog could not serve lane "${lane}" (${outcome.reason}), ` +
          `no requestedSubject was set, and the client profile declares no industry to derive one from`,
      );
    });

    // ── 04e: what this agent already SHIPPED for this client ──
    //
    // The anti-repetition read: the rolling excerpt window this run's own
    // deliver step (09b) writes back into. Read once, used three times — as a
    // hard do-not-repeat directive in the copy prompt, as the corpus the
    // post-draft similarity check (07d) scores against, and (2026-09) as the
    // list the trend scout must steer clear of. Read HERE, before the topic is
    // final, for that third use.
    const outputHistory = await readOutputHistoryForDedup(wf, tools, ctx, "instagram-agent", "04e-read-output-history");
    const recentPostsDirective = dedupeDirective(outputHistory);

    // ── 04f: the client's own intel report and knowledge base, as authoritative drafting context ──
    //
    // `intel.getReport` has been registered in every agent's registry since
    // the intel agent shipped, with zero channel-agent callers — a client
    // could pay for a full intel report (voice rows, positioning, whitespace
    // opportunities) and have their caption writer never see a word of it.
    const clientIntelContext = await readClientIntelContext(wf, tools, ctx, "04f-read-intel-context");

    // ── 03a-03c: the trend scout, only on the fallback path (2026-09) ──
    //
    // Step 03 falls back to `${industry} trends this week` when nobody planned
    // this run's subject — a query, not a subject, and the research step then
    // researched the query. Now that path pulls the field's news (several
    // questions, cached), asks the scout for brand-fit-scored candidates, and
    // takes the strongest on-brand one. A planned catalog row or a typed
    // request is untouched: the scout never outranks a person's choice.
    let topicClaim: InstagramTopicClaimShape = claimedTopic;
    if (claimedTopic.source === "research") {
      const trendProfile = await wf.step.code("03a-load-trend-profile", async () => {
        const profileOutcome = await tools["client.getProfile"]!.execute({}, { ctx });
        const profile = profileOutcome.status === "success" ? (profileOutcome.result as Record<string, unknown>) : {};
        const configOutcome = await tools["client.getConfig"]!.execute({}, { ctx });
        const config = configOutcome.status === "success" ? (configOutcome.result as Record<string, unknown>) : {};
        const configured = Array.isArray(config["trendQueries"]) ? (config["trendQueries"] as unknown[]).filter((q): q is string => typeof q === "string" && q.trim().length > 0) : [];
        return {
          profile,
          industry: typeof profile["industry"] === "string" ? (profile["industry"] as string) : undefined,
          companyName: typeof profile["companyName"] === "string" ? (profile["companyName"] as string) : typeof profile["name"] === "string" ? (profile["name"] as string) : undefined,
          trendQueries: configured,
          forbiddenTopics: readForbiddenTopics(config),
        };
      });
      const queries = buildTrendQueries({ industry: trendProfile.industry, companyName: trendProfile.companyName, configuredQueries: trendProfile.trendQueries });
      const trendResearch = await pullTrendResearch(wf, tools, ctx, {
        stepId: "03b-trend-research-pull",
        job: "instagram-trend-scan",
        queries: queries.length > 0 ? queries : [claimedTopic.topic],
        window: "7d",
        historyAgentId: "instagram-agent",
      });
      const scout = await runTrendScout(wf, { tools, promptStore: options.promptStore, router: options.router }, "03c-trend-scout", {
        research: researchDigestForScout(trendResearch.merged),
        channel: "instagram",
        clientProfile: trendProfile.profile,
        ...(clientIntelContext !== undefined ? { clientIntelContext } : {}),
        ...(clientVoiceContext !== undefined ? { clientVoiceContext } : {}),
        ...(recentPostsDirective !== undefined ? { recentPosts: recentPostsDirective } : {}),
        forbiddenTopics: trendProfile.forbiddenTopics,
        today: new Date().toISOString().slice(0, 10),
      });
      if (scout !== undefined) {
        // This agent keeps no decision log, so the content mode rotates on the
        // count of shipped posts: hot news, deep value, open discussion, in turn.
        const mode = CONTENT_MODES[outputHistory.length % CONTENT_MODES.length]!;
        const avoidTopics = outputHistory.map((h) => h.excerpt.split("\n").find((l) => l.trim().length > 0) ?? "").filter((l) => l.length > 0);
        const trend = selectTrendCandidate(scout.candidates, mode, { avoidTopics });
        if (trend !== undefined) topicClaim = { topic: trend.topic, source: "trend", trend };
      }
    }

    // ── 04h: the post format — a request, the client's setting, or the rotation ──
    //
    // `carousel` unless someone asked otherwise. `auto` makes every third post
    // a single image with a deep caption, counted on the shipped-output window
    // so the rotation survives restarts without a decision log of its own.
    const format = await wf.step.code("04h-select-format", (): { format: InstagramFormat; source: string } => {
      const requested = runClaim.requestedFormat;
      if (requested === "single" || requested === "carousel") return { format: requested, source: "requested" };
      if (requested === "auto") return { format: outputHistory.length % 3 === 2 ? "single" : "carousel", source: "rotation" };
      return { format: "carousel", source: "default" };
    });

    // ── 04: research the subject — verbatim raw payload capture, then judgment ──
    const researchPull = await wf.step.code("04a-research-pull", async () => {
      const outcome = await tools["research.pull"]!.execute(
        // `historyAgentId` joins this agent to the same anti-repetition
        // history feed every OTHER channel already requested — instagram was
        // the one caller that omitted it entirely.
        { job: "instagram-carousel-research", query: topicClaim.topic, window: "24h", historyAgentId: "instagram-agent" },
        { ctx },
      );
      if (outcome.status !== "success") {
        throw new WorkflowToolingFailure(`research.pull failed: ${outcome.status}`);
      }
      return outcome.result as { runId: string; query: string; result: unknown };
    });

    const researchAgent = new InstagramResearchAgent({ router: options.router, tools, promptStore: options.promptStore });
    const researchExec = await wf.step.agent("04b-research-extract-facts", researchAgent, {
      topic: topicClaim.topic,
      rawPayload: researchPull.result,
      rawPayloadRef: researchPull.runId,
    });
    if (researchExec.status === "content_fail") {
      throw new WorkflowHeld("research extraction did not produce output that cleared its own schema — nothing honestly cleared this run's research step");
    }
    if (researchExec.status !== "completed") {
      throw new WorkflowToolingFailure(`research extraction step resolved to "${researchExec.status}"`);
    }
    // Re-validate defensively — `finalOutput` is already schema-checked inside
    // BaseAgent, but this keeps step 07's self-check callers honestly typed
    // without a non-null assertion on a value this workflow never produced itself.
    const research: ResearchOutput = ResearchOutputSchema.parse(researchExec.finalOutput);

    // Cross-post image-reuse prevention (Fix 3): fetched once, before any
    // vetting attempt — every prior post's shipped images for this client,
    // so step 06 can refuse to reselect one regardless of what the model does.
    const usedImagesOutcome = await wf.step.code("05a-list-used-images", async () => tools["ledger.listUsedImages"]!.execute({}, { ctx }));
    if (usedImagesOutcome.status !== "success") {
      throw new WorkflowToolingFailure(`ledger.listUsedImages failed: ${usedImagesOutcome.status}`);
    }
    const usedImages = (usedImagesOutcome.result as { imagePaths: string[] }).imagePaths;
    const usedImagesSet = new Set(usedImages);

    // ── Tier 0: media the client attached to this run ──
    //
    // Above every sourcing tier, and the reasoning is not subtle: a client who
    // uploaded a photograph has told us exactly what they want on the slide.
    // No harvester, scrape or generation outranks that, and asking a vetting
    // model to "choose" between a client's own asset and a stock photo would
    // be inviting it to overrule them.
    //
    // The attachment is INGESTED, not passed through. `assertInside` in
    // karos-publish refuses URL-shaped strings outright, so a `gs://` path in
    // the candidate pool would clear the rights gate, reach step 08 and die
    // there — after the run had already paid for copy, vetting and every other
    // tier. `media.ingestAssets` downloads it into the same
    // `.media-cache/<runId>/` every other tier writes to, through the same
    // downloader, so one set of content-type and size guarantees covers all of
    // them.
    //
    // Slides are assigned by upload order: the first attachment to slide 1, the
    // second to slide 2. A rule someone can predict from the order they
    // uploaded in, rather than a model deciding which of their photos "fits".
    const tier0Pool = await wf.step.code("05z-attach-user-media", async () => {
      const usable = runDirection.mediaAssets.filter((a) => a.role === "source" || a.role === "reference");
      const ingest = tools["media.ingestAssets"];
      if (usable.length === 0 || ingest === undefined) {
        return { candidates: [] as ImageCandidate[], slots: [] as number[], attached: usable.length, note: usable.length === 0 ? "no attachments on this run" : "media.ingestAssets is not registered" };
      }

      const outcome = await ingest.execute(
        {
          repoRoot: options.repoRoot,
          runId: wf.runId,
          assets: usable.map((asset, index) => ({
            uri: asset.uri,
            ...(asset.label ? { label: asset.label } : {}),
            slot: index + 1,
          })),
        },
        { ctx },
      );

      if (outcome.status !== "success") {
        // A failed ingest must not fail the run: the tiers below can still
        // fill every slide, and a client whose upload could not be read is
        // better served by a complete post plus a recorded reason than by no
        // post at all.
        return {
          candidates: [] as ImageCandidate[],
          slots: [] as number[],
          attached: usable.length,
          note: `attachments could not be ingested (${outcome.status}${"reason" in outcome ? `: ${outcome.reason}` : ""})`,
        };
      }

      const result = outcome.result as { candidates: ImageCandidate[]; unmet: Array<{ slot: number; reason: string }> };

      // ── A vision model READS the client's pictures (2026-09) ──
      //
      // Until now the copy step wrote slide 1 with no idea what the client's
      // photo on slide 1 showed, and the vetting step judged that photo from
      // the licence line this pipeline itself wrote. `media.inspectImages`
      // describes each upload; the description reaches the copy prompt as
      // `attachedMedia` (so the words are written TO the picture) and is
      // appended to the candidate's own description (so the vetting judgment
      // is about what is actually in frame). Best-effort: no vision backend,
      // or a failed call, leaves the upload exactly as it was.
      const inspect = tools["media.inspectImages"];
      let analyses: Array<{ slot: number; description: string; subjects: string[]; textInImage: string[]; mood: string; suggestedAngle?: string }> = [];
      let candidates = result.candidates;
      let visionNote: string | undefined;
      if (inspect !== undefined && result.candidates.length > 0) {
        const inspected = await inspect.execute(
          { repoRoot: options.repoRoot, images: result.candidates.slice(0, 12).map((c, i) => ({ ref: `attached-${i + 1}`, path: c.path })), purpose: "attached-media" },
          { ctx },
        );
        if (inspected.status === "success") {
          const byRef = new Map(((inspected.result as { inspections: Array<Record<string, unknown>> }).inspections).map((i) => [i["ref"] as string, i]));
          analyses = result.candidates.flatMap((_, i) => {
            const found = byRef.get(`attached-${i + 1}`);
            if (!found) return [];
            return [
              {
                slot: i + 1,
                description: String(found["description"] ?? ""),
                subjects: (found["subjects"] as string[] | undefined) ?? [],
                textInImage: (found["textInImage"] as string[] | undefined) ?? [],
                mood: String(found["mood"] ?? ""),
                ...(typeof found["suggestedAngle"] === "string" ? { suggestedAngle: found["suggestedAngle"] as string } : {}),
              },
            ];
          });
          candidates = result.candidates.map((c, i) => {
            const found = byRef.get(`attached-${i + 1}`);
            return found ? { ...c, description: `${c.description} [vision: ${String(found["description"] ?? "")}${Array.isArray(found["textInImage"]) && (found["textInImage"] as string[]).length > 0 ? `; text in image: ${(found["textInImage"] as string[]).join(" / ")}` : ""}]` } : c;
          });
        } else {
          visionNote = `vision inspection of the attachments did not complete (${inspected.status}${"reason" in inspected ? `: ${inspected.reason}` : ""})`;
        }
      }

      const notes = [
        ...(result.unmet.length > 0 ? [result.unmet.map((u) => `slide ${u.slot}: ${u.reason}`).join("; ")] : []),
        ...(visionNote !== undefined ? [visionNote] : []),
      ];
      return {
        candidates,
        // Only the slides an asset actually landed on. An attachment that
        // failed to ingest must not reserve a slide the harvesters would then
        // skip, which would leave it empty for the rest of the run.
        slots: result.candidates.map((_, index) => index + 1),
        attached: usable.length,
        analyses,
        ...(notes.length > 0 ? { note: notes.join("; ") } : {}),
      };
    });

    /** Slides already carrying a client upload, so no tier below wastes a call on them. */
    const tier0Slots = new Set(tier0Pool.slots);

    // ── 04c: resolve which archetype templates this run can actually render ──
    //
    // Two paths, one output. With a registry configured, its winning template
    // per archetype is MATERIALIZED into this run's own directory and the
    // renderer points there (Approach (a)); without one, the client's own
    // `templateDir` is probed for the bundled archetype files. Either way the
    // result is a `templateDir` plus the set of filenames present in it, and
    // everything downstream reads only those two facts.
    //
    // Why materialize rather than let the renderer take template bodies:
    // `publish.renderCarousel` resolves `templateDir` through `assertInside`,
    // which refuses absolute paths, URL-shaped strings, and anything escaping
    // the repo root. That guard is why a bad path there is a tooling failure
    // rather than a silent render of the wrong thing, and it works precisely
    // because the renderer only ever deals in repo-relative files. Writing
    // files keeps one code path with one set of guarantees.
    //
    // Failure yields an EMPTY set rather than a throw, on either path: the
    // conservative reading is "assume no archetype template is available",
    // which costs layout variety and nothing else, because every archetype
    // degrades to the client's own base template.
    /**
     * The no-store branded path: copies every template file out of the
     * client's `templateDir` (which ships READ-ONLY in the container image —
     * in-place injection is impossible, not merely undesirable) into this
     * run's own `.template-cache/<runId>/`, splicing the brand head fragment
     * into each on the way. Same bounds check `materializeTemplates` itself
     * applies, for the same "a runId carrying ../ is the case that matters"
     * reason. Returns the archetype files present, preserving `files`'
     * existing meaning for `availableTemplates`/`resolveLayout`.
     */
    const materializeBrandedClientDir = async (): Promise<{ templateDir: string; files: string[] }> => {
      const relDir = `.template-cache/${wf.runId}`;
      const absDir = path.resolve(options.repoRoot, relDir);
      const rootResolved = path.resolve(options.repoRoot);
      if (absDir !== rootResolved && !absDir.startsWith(rootResolved + path.sep)) {
        throw new Error(`materializeBrandedClientDir: resolved dir escaped repoRoot (runId="${wf.runId}")`);
      }
      await fs.mkdir(absDir, { recursive: true });
      const fragments = await brandFragments();
      const srcDir = path.resolve(options.repoRoot, frozen.brandTokens.templateDir);
      const htmlFiles = (await fs.readdir(srcDir)).filter((f) => f.endsWith(".html"));
      for (const file of htmlFiles) {
        const html = await fs.readFile(path.join(srcDir, file), "utf8");
        await fs.writeFile(path.join(absDir, file), composeRawDocument(html, fragments.head, fragments.body), "utf8");
      }
      return { templateDir: relDir, files: htmlFiles.filter((f) => ARCHETYPE_TEMPLATE_FILES.includes(f)) };
    };

    /**
     * The token-drift note (modeled on karos-landing's own token-drift
     * gate): which brand hexes actually appear in the written template
     * files. Non-fatal by design — this exists so a trace can answer "did
     * the client's colors reach the pixels" without anyone re-deriving the
     * whole pipeline, not to hold a run over a hex.
     */
    const brandTokenDrift = async (templateDir: string): Promise<{ present: string[]; missing: string[] } | undefined> => {
      if (brandKit === undefined || Object.keys(brandKit.cssVars).length === 0) return undefined;
      const absDir = path.resolve(options.repoRoot, templateDir);
      // The whole directory, not just the archetype files — the base
      // slide.html carries the brand too, and a client whose dir holds ONLY
      // a base template would otherwise read as "every token missing".
      const htmlFiles = (await fs.readdir(absDir).catch(() => [] as string[])).filter((f) => f.endsWith(".html"));
      let combined = "";
      for (const file of htmlFiles) {
        combined += await fs.readFile(path.join(absDir, file), "utf8").catch(() => "");
      }
      const lower = combined.toLowerCase();
      const present: string[] = [];
      const missing: string[] = [];
      for (const [name, value] of Object.entries(brandKit.cssVars)) {
        (lower.includes(value.toLowerCase()) ? present : missing).push(`${name}=${value}`);
      }
      return { present, missing };
    };

    const templateResolution = await wf.step.code("04c-resolve-templates", async () => {
      if (options.templateStore !== undefined) {
        try {
          const fragments = await brandFragments();
          const materialized = await materializeTemplates({
            store: options.templateStore,
            repoRoot: options.repoRoot,
            runId: wf.runId,
            clientSlug: wf.clientSlug,
            clientTemplateDir: frozen.brandTokens.templateDir,
            clientTemplateFile: frozen.brandTokens.slideTemplate,
            ...(fragments.head !== undefined ? { brandHeadHtml: fragments.head } : {}),
            ...(fragments.body !== undefined ? { brandBodyHtml: fragments.body } : {}),
          });
          const files = Object.values(materialized.files);
          return {
            templateDir: materialized.templateDir,
            files,
            chosen: materialized.chosen,
            ...(brandKit !== undefined ? { brandTokenDrift: await brandTokenDrift(materialized.templateDir) } : {}),
          };
        } catch (error) {
          // A registry outage falls back to the on-disk path below rather
          // than failing the run — the whole point of the bundled floor.
          console.error("04c-resolve-templates: registry materialization failed, falling back to the client's templateDir", error);
        }
      }
      // No registry, but a brand kit: the client's read-only templateDir is
      // copied into the run's own directory with the brand spliced in, so a
      // brandless deployment still gets branded slides.
      if (brandKit !== undefined) {
        try {
          const branded = await materializeBrandedClientDir();
          return {
            ...branded,
            chosen: [],
            brandTokenDrift: await brandTokenDrift(branded.templateDir),
          };
        } catch (error) {
          console.error("04c-resolve-templates: branded copy of the client templateDir failed, falling back to the unbranded original", error);
        }
      }
      const dir = path.resolve(options.repoRoot, frozen.brandTokens.templateDir);
      try {
        const present = (await fs.readdir(dir)).filter((f) => ARCHETYPE_TEMPLATE_FILES.includes(f));
        return { templateDir: frozen.brandTokens.templateDir, files: present, chosen: [] };
      } catch {
        return { templateDir: frozen.brandTokens.templateDir, files: [], chosen: [] };
      }
    });
    const availableTemplates = new Set(templateResolution.files);
    /** Where the renderer reads templates from: the materialized run dir, or the client's own. */
    const effectiveTemplateDir = templateResolution.templateDir;

    /**
     * Rewrites the materialized template files if they're not actually on
     * THIS instance's disk — deliberately NOT a `wf.step.code`, so it runs
     * fresh every single render attempt rather than once per run.
     *
     * `04c-resolve-templates` above IS checkpointed, and that is exactly the
     * bug this closes: Approach (a) materializes template rows into
     * `.template-cache/<runId>/`, a directory on local, per-instance disk —
     * but a run that pauses at the human review gate and comes back as a
     * `revise` can resume on a DIFFERENT Cloud Run instance, one whose disk
     * never had that directory written to it at all. The checkpointed step
     * still returns the same `templateDir`/`files` (that part is genuinely
     * safe to cache — it's a deterministic registry read), so nothing
     * notices anything is wrong until the renderer looks for a real file
     * that was never actually written HERE and reports it as a tooling
     * failure (prep job 9qkTWlg7e9ZLiVIZUok4, on exactly this path, on a
     * `-r1` revision attempt after round 0's own render had already
     * succeeded). Re-materializing is a few KB of writes plus one registry
     * read — cheap next to a failed run — and a no-op when the files are
     * already there, which is the common case on an instance that never
     * recycled.
     */
    const ensureTemplatesOnDisk = async (validatedCustomArchetypes: readonly SlideCustomArchetype[] = []): Promise<void> => {
      /**
       * True when 04c pointed the renderer at the per-run cache dir — which
       * now happens on TWO paths: a registry materialization, or the
       * brand-kit copy of the client's read-only templateDir. Both are
       * per-instance disk state that a resume on a recycled instance loses,
       * so both get the same presence-check-and-rewrite treatment. Skipping
       * the branded no-store path here would recreate the exact
       * 9qkTWlg7e9ZLiVIZUok4 bug this function exists to close, on a new
       * path.
       */
      const usesRunCacheDir = effectiveTemplateDir !== frozen.brandTokens.templateDir;
      if (usesRunCacheDir && templateResolution.files.length > 0) {
        const absDir = path.resolve(options.repoRoot, effectiveTemplateDir);
        const allPresent = await Promise.all(
          templateResolution.files.map((file) =>
            fs
              .access(path.join(absDir, file))
              .then(() => true)
              .catch(() => false),
          ),
        );
        // IGSTYLE-3: re-materialize on a KIT change too, not only when a file
        // is physically missing — see `templatesMaterializedForKit`'s own
        // doc comment above.
        if (!allPresent.every(Boolean) || templatesMaterializedForKit !== effectiveKit) {
          try {
            if (options.templateStore !== undefined) {
              const fragments = await brandFragments();
              await materializeTemplates({
                store: options.templateStore,
                repoRoot: options.repoRoot,
                runId: wf.runId,
                clientSlug: wf.clientSlug,
                clientTemplateDir: frozen.brandTokens.templateDir,
                clientTemplateFile: frozen.brandTokens.slideTemplate,
                ...(fragments.head !== undefined ? { brandHeadHtml: fragments.head } : {}),
                ...(fragments.body !== undefined ? { brandBodyHtml: fragments.body } : {}),
              });
            } else {
              // The branded no-store copy: pure local disk work, no registry
              // dependency, so this branch cannot even fail on an outage.
              await materializeBrandedClientDir();
            }
            templatesMaterializedForKit = effectiveKit;
          } catch (error) {
            // Same fallback rule as 04c-resolve-templates itself: a registry
            // outage here degrades layout variety, it does not fail the run.
            // `templatesMaterializedForKit` is deliberately NOT updated on
            // failure, so the next call retries rather than believing a
            // write that never happened.
            console.error("ensureTemplatesOnDisk: re-materialization failed, render will fall back to the client's own template", error);
          }
        }
      }

      // A validated `custom` archetype is never part of the registry fetch
      // above — it is THIS run's own, not-yet-promoted proposal, re-derived
      // straight from the checkpointed `copy` rather than fetched from
      // anywhere, and written unconditionally (never just "if missing"):
      // it's a pure, local, no-I/O-dependency rebuild, so re-writing it is
      // cheaper than checking first and there's no correctness reason to
      // skip it.
      if (validatedCustomArchetypes.length > 0) {
        const absDir = path.resolve(options.repoRoot, effectiveTemplateDir);
        const fragments = await brandFragments();
        for (const archetype of validatedCustomArchetypes) {
          try {
            await fs.writeFile(
              path.join(absDir, templateFileName(archetype.archetypeId)),
              composeCustomArchetypeDocument(archetype, fragments.head, fragments.body),
              "utf8",
            );
          } catch (error) {
            // Same "degrade, never fail the run" rule as everywhere else in
            // this function — a write failure here just means the slide
            // renders with a "template not found" tooling error further
            // downstream is impossible to avoid, but SHOULD not happen: disk
            // writes to a bounds-checked, already-existing directory fail
            // only on a genuine I/O problem, not a content one.
            console.error(`ensureTemplatesOnDisk: could not write custom archetype "${archetype.archetypeId}" to disk`, error);
          }
        }
      }

      // ── IGSTYLE-10, §10a — materialize every archetype file's ground/fg-
      // INVERTED sibling, so a slide `assembleSlidesData` points at the
      // "-inv" filename finds it on disk. Written unconditionally, same
      // as the custom-archetype block above: a few more KB of writes is
      // cheap next to a failed run, and it keeps this in lockstep with
      // whatever the primary materialization (registry, branded-copy, or
      // custom-archetype) just wrote — including a custom archetype's own
      // file, which is why this runs LAST, after both blocks above.
      //
      // Only possible when the effective kit actually derived a ground/fg
      // pair — nothing to swap otherwise, §10a's own "a derivable neutral
      // pair" requirement — and only when the renderer is pointed at a
      // writable per-run directory rather than the client's own read-only
      // `templateDir` (the no-registry, no-brand-kit floor, which also never
      // derives a pair in the first place, so this is mostly
      // belt-and-suspenders).
      const invertGround = effectiveKit?.cssVars["--bg"];
      const invertFg = effectiveKit?.cssVars["--fg"];
      if (invertGround !== undefined && invertFg !== undefined && effectiveTemplateDir !== frozen.brandTokens.templateDir) {
        const absDir = path.resolve(options.repoRoot, effectiveTemplateDir);
        // Appended AFTER whatever `:root{}` the primary file's own materialization
        // already spliced in — equal CSS specificity, later wins, the same rule
        // `buildBrandHeadHtml`'s own doc comment already relies on.
        const invertedHeadHtml = `<style>\n:root {\n  --bg: ${invertFg};\n  --fg: ${invertGround};\n}\n</style>`;
        const isAlreadyInverted = (file: string): boolean => {
          const dot = file.lastIndexOf(".");
          const stem = dot === -1 ? file : file.slice(0, dot);
          return stem.endsWith(INVERTED_TEMPLATE_SUFFIX);
        };
        try {
          const htmlFiles = (await fs.readdir(absDir)).filter((f) => f.endsWith(".html") && !isAlreadyInverted(f));
          for (const file of htmlFiles) {
            const primary = await fs.readFile(path.join(absDir, file), "utf8");
            const inverted = primary.includes("</head>") ? primary.replace("</head>", `${invertedHeadHtml}\n</head>`) : `${invertedHeadHtml}\n${primary}`;
            await fs.writeFile(path.join(absDir, invertedTemplateFileName(file)), inverted, "utf8");
          }
        } catch (error) {
          // Same "degrade, never fail the run" posture as every other write
          // in this function: a slide that wanted the inverted variant and
          // didn't get one falls through to `publish.renderCarousel`'s own
          // missing-template tooling error, which is loud (a real trace
          // entry), never a silently-wrong render.
          console.error("ensureTemplatesOnDisk: writing ground/fg-inverted template variants failed", error);
        }
      }
    };

    // ── 05-08b: write copy -> vet images -> emit + self-check + craft-hygiene
    //           -> render -> post-render visual QA, all sharing ONE retry
    //           budget capped at two returns to step 05 (RFC-03 §3 step 07,
    //           extended by Fixes 2/3 to cover the two new checks) ──
    const copyAgent = new InstagramCopyAgent({ router: options.router, tools, promptStore: options.promptStore });
    const imageAgent = new InstagramImageVettingAgent({ router: options.router, tools, promptStore: options.promptStore });
    const qaAgent = new InstagramVisualQaAgent({ router: options.router, tools, promptStore: options.promptStore });

    // ── 04d: what this client has asked for on PREVIOUS runs ──
    //
    // The read side of the feedback flywheel. Without it every run starts from
    // zero and the same correction gets made every week — a reviewer who said
    // "stop opening with a statistic" three runs ago has to say it again.
    //
    // Bounded to ten entries and best-effort: this lands in a drafting prompt,
    // so an unbounded history would push the actual brief out of the context
    // window, and a memory read failing must not stop a run that can draft
    // perfectly well without it.
    const pastFeedback = await wf.step.code("04d-read-past-feedback", async () => {
      const read = tools["memory.readFeedback"];
      if (!read) return [] as string[];
      try {
        const outcome = await read.execute({ productId: wf.productId, limit: 10 }, { ctx });
        if (outcome.status !== "success") return [] as string[];
        const entries = (outcome.result as { entries: Array<{ decision: string; note: string; at: number }> }).entries;
        return entries.map((e) => `(${e.decision}) ${e.note}`);
      } catch (error) {
        console.error("04d-read-past-feedback: could not read client feedback history, drafting without it", error);
        return [] as string[];
      }
    });

    // (04e-read-output-history and 04f-read-intel-context moved above step 04a
    // in 2026-09 so the trend scout can read them; same step ids, same reads.)

    /**
     * The reviewer's structured colour pick from the PREVIOUS round's gate
     * response (IGSTYLE-3, §2.2 Layer 2) — `RevisionNote` (the shared,
     * cross-agent primitive in `packages/workflow`) carries only
     * `{revision, actor, at, feedback}`, deliberately never `edits`, so this
     * is captured separately, in `onDecision` below, rather than by widening
     * that shared shape for one agent's use. Read by `draftOnce` at the START
     * of the NEXT round; always `undefined` for revision 0, since there is no
     * previous round's response yet — which is exactly what keeps revision 0
     * unaffected.
     */
    let latestStyleEdit: StyleEdit | undefined;

    /** What one drafting pass produces, once its own self-checks have passed. */
    interface DraftResult {
      copy: InstagramCopyOutput;
      selections: ImageSelection[];
      slidesData: RenderCarouselInput;
      rendered: RenderCarouselResult;
      /**
       * IGSTYLE-3, §2.3's "loud refusals" requirement — what THIS round's
       * style-directive resolution did (`04g-style-directive`) plus any
       * `effectiveBrandKit` pair-drop refusal, surfaced verbatim in the gate
       * payload as `styleDirectiveOutcome`. `undefined` only when nothing was
       * even attempted — no structured pick, no free-text feedback, no
       * learned prior (the overwhelming majority of revision-0 rounds).
       */
      styleDirectiveOutcome?: {
        source: StyleDirectiveResult["source"];
        applied: string[];
        intents: StyleIntent[];
        refusals: StyleRefusal[];
        /**
         * IGSTYLE-5, §2.4 writer 1 — "carry the round's resolved `style`
         * patch + `source`": this round's own `styleDirectiveResult.overrides`
         * verbatim (never `effectiveBrandKit`'s re-derived/merged kit), so
         * `persistReviewFeedback` below can hand it straight to
         * `memory.appendFeedback`'s `style` field as future evidence for
         * `distillStylePreferences` to vote over. Additive to the gate
         * payload too — a reviewer seeing exactly which hex a refused pick
         * resolved to, alongside the refusal, is strictly more informative
         * than before.
         */
        overrides: StyleOverrides;
      };
      /**
       * IGSTYLE-7, §7b/7c — every departure this round's variation budget (or
       * an intent-only satisfaction) made from the raw learned prior
       * (`distilledStyle.overrides`/`.intents`), for the gate payload's own
       * `styleVariation`. Absent (never an empty array) when nothing
       * departed — the overwhelming majority of rounds: every learned role at
       * or above `VARIATION_THRESHOLD`, or no learned prior at all.
       */
      styleVariation?: StyleVariationEntry[];
      /**
       * IGSTYLE-10, §10e — which axis each slide used this attempt, and why
       * not when it didn't (`variationPlan`'s own doc comment in
       * `slides-data.ts` names every reason string). Absent only when
       * neither axis was even attempted — no accent ring AND no derived
       * ground/fg pair, i.e. a client with no brand kit at all — matching
       * every other optional gate-payload field's "absent, never empty"
       * convention here.
       */
      variationPlan?: VariationPlanEntry[];
      /** SCRUM-393 (IGSTYLE-8) — text and accent-on-ground contrast, reported as facts. Never gates. */
      contrastFacts: ContrastFact[];
    }

    /** Never prose — excluded from anything a human or the topic guardrail reads as text. */
    const NON_PROSE_FIELD_KEYS = new Set(["accentColor", "dir", "brandHandle", "seriesBadge", "fontScale", "textAlign"]);

    /**
     * Every slide's prose field values, joined — everything ON the carousel
     * images, for the topic guardrail's coverage (it must see the whole post,
     * not only the caption below). `accentColor` is a hex string, never prose;
     * excluding it is what stopped it leaking into a reviewer's "preview" back
     * when this was the only text a reviewer saw at all.
     */
    const slidesTextFor = (draft: DraftResult): string =>
      draft.slidesData.slides
        .map((slide) =>
          Object.entries(slide.fields ?? {})
            .filter(([key]) => !NON_PROSE_FIELD_KEYS.has(key))
            .map(([, value]) => value)
            .join(" "),
        )
        .join("\n\n");

    /**
     * One full drafting pass: copy, images, self-checks, render, visual QA.
     *
     * Called once per REVISION round by `runReviewCycle`. `revision` is folded
     * into every checkpointed step id inside it (via `rev` below) so a second
     * round genuinely re-executes rather than short-circuiting on the first
     * round's checkpoints — while everything OUTSIDE this function (auto-setup,
     * the topic claim, research, the template resolution) keeps its id and is
     * therefore reused for free. That reuse is the whole reason the revision is
     * in-run rather than a fresh run.
     */
    const draftOnce = async (revision: number, notes: readonly RevisionNote[]): Promise<DraftResult> => {
      /**
       * Revision-scoped step id. Revision 0 keeps the ORIGINAL ids verbatim, so
       * a first-time run's trace is byte-identical to what it was before
       * revisions existed and every existing step-id assertion still holds.
       */
      const rev = (id: string) => (revision === 0 ? id : `${id}-r${revision}`);
      /** The reviewer's accumulated change requests, as a directive for the copy agent. */
      const directive = revisionDirective(notes);

      // ── 04g: this round's style directive (IGSTYLE-3, §2.2 Layer 2 — ACTIVE, binding within this run) ──
      //
      // Revision-scoped, not attempt-scoped: resolved once here, reused by
      // every attempt in the loop below, exactly like `directive` above.
      // Revision 0 always sees `latestStyleEdit === undefined` and
      // `notes.length === 0`, so `parseStyleDirective` returns
      // `{overrides:{}, source:"none"}` unconditionally with no special
      // casing needed — byte-identical to a run before this ticket existed.
      //
      // The context this round's directive resolves AGAINST is Layer 0's own
      // ground/fg/ring (`brandKit`, not `effectiveKit`) — a directive is
      // always relative to the client's actual baseline kit, never to a
      // PREVIOUS round's already-adjusted colours, so "darker" means "darker
      // than the brand's real ground" in every round, not a runaway drift.
      const latestFeedback = notes.length > 0 ? notes[notes.length - 1]!.feedback : undefined;
      const styleDirectiveResult: StyleDirectiveResult = await wf.step.code(rev("04g-style-directive"), () =>
        parseStyleDirective(
          {
            ...(latestStyleEdit !== undefined ? { style: latestStyleEdit } : {}),
            ...(latestFeedback !== undefined ? { feedback: latestFeedback } : {}),
          },
          {
            ...(brandKit?.cssVars["--bg"] !== undefined ? { ground: brandKit.cssVars["--bg"] } : {}),
            ...(brandKit?.cssVars["--fg"] !== undefined ? { fg: brandKit.cssVars["--fg"] } : {}),
            ring: brandKit?.palette ?? [],
          },
          { router: options.router },
        ),
      );

      // ── IGSTYLE-7, §2.6 tier 2b: spend the variation budget on the LEARNED
      // prior — never on THIS round's own active directive, which stays
      // binding (`styleDirectiveResult.overrides` is untouched below and is
      // still merged LAST inside `effectiveBrandKit`, so "in-run supremacy"
      // holds structurally: an explicit directive always outranks whatever
      // 7b/7c produce here, exactly as IGSTYLE-3 already guarantees). ──
      const { varied: variedLearnedStyle, variations: budgetVariations } = varyLearnedStyle(learnedStyle, distilledStyle.strength, wf.runId, {
        ...(brandKit?.cssVars["--bg"] !== undefined ? { baselineGround: brandKit.cssVars["--bg"] } : {}),
        ...(brandKit?.cssVars["--fg"] !== undefined ? { baselineFg: brandKit.cssVars["--fg"] } : {}),
        ring: brandKit?.palette ?? [],
      });

      // ── 7c: an intent survives even when its hex lost the distillation
      // vote (`distillStylePreferences`'s own rule 10) — satisfy the
      // DIRECTION against Layer 0's own baseline via the exact same
      // `applyIntents` Tier 1/2 already use, never pinning the specific hex
      // that lost. Only for roles 7b left untouched (a role already varied,
      // or already promoted at full strength, has nothing left to satisfy). ──
      const unsatisfiedIntents = distilledStyle.intents.filter((intent) => variedLearnedStyle[intent.role] === undefined);
      const intentSatisfaction =
        unsatisfiedIntents.length > 0
          ? applyIntents(unsatisfiedIntents, {
              ...(brandKit?.cssVars["--bg"] !== undefined ? { ground: brandKit.cssVars["--bg"] } : {}),
              ...(brandKit?.cssVars["--fg"] !== undefined ? { fg: brandKit.cssVars["--fg"] } : {}),
              ring: brandKit?.palette ?? [],
            })
          : { overrides: {}, applied: [], refusals: [] };
      for (const [role, hex] of Object.entries(intentSatisfaction.overrides)) {
        variedLearnedStyle[role] = hex;
      }
      const styleVariation: StyleVariationEntry[] = [
        ...budgetVariations,
        ...unsatisfiedIntents
          .filter((intent) => intentSatisfaction.overrides[intent.role] !== undefined)
          .map((intent) => ({
            role: intent.role,
            prior: `(no hex reached the evidence threshold for ${intent.role})`,
            used: intentSatisfaction.overrides[intent.role]!,
            reason: `distillation rule 10: the "${intent.direction}" intent survived even though no specific hex won the vote for ${intent.role} — satisfied the direction against baseline rather than pinning the losing hex`,
          })),
      ];

      const { kit: revisionEffectiveKit, refusals: kitRefusals } = effectiveBrandKit(
        rawBrand,
        frozen.brandTokens,
        variedLearnedStyle as StyleOverrides,
        styleDirectiveResult.overrides,
        brandKit,
      );
      // Every consumer below this line — `brandFragments`, `brandLogoAssessment`,
      // `ensureTemplatesOnDisk`, and every `effectiveKit?.X` read further down
      // in this attempt loop — now sees THIS round's kit.
      effectiveKit = revisionEffectiveKit;

      // ── IGSTYLE-10, §10a/10c-4 — this round's ground/fg inversion axis. ──
      //
      // Undefined (never attempted) when the effective kit derives no
      // ground/fg pair at all — §10a's own "a derivable neutral pair"
      // requirement. `directivePinned` reads THIS round's own resolved
      // Layer-2 patch (`styleDirectiveResult.overrides`, never the merged/
      // varied kit) — a reviewer who pinned so much as one colour this round
      // must see every slide obey it, never 25% inverted against it.
      const groundFgInversion: GroundFgInversionConfig | undefined =
        effectiveKit?.cssVars["--bg"] !== undefined && effectiveKit.cssVars["--fg"] !== undefined
          ? {
              ground: effectiveKit.cssVars["--bg"],
              fg: effectiveKit.cssVars["--fg"],
              directivePinned: Object.keys(styleDirectiveResult.overrides).length > 0,
            }
          : undefined;

      const allStyleRefusals: StyleRefusal[] = [...styleDirectiveResult.refusals, ...kitRefusals];
      // Loud refusals (§2.3, mandatory): a silently-dropped directive is
      // indistinguishable from the original bug this whole ticket exists to
      // fix. One ledger event per revision (not per refusal) — `eventId` has
      // no per-role suffix, so a re-run that hits the identical refusal(s)
      // again collapses to the SAME row via karos-ledger's own
      // `(runId, eventId)` idempotency, exactly like SCRUM-393's
      // contrast-below-floor warn.
      if (allStyleRefusals.length > 0) {
        await wf.step.code(rev("04g-style-directive-record-refusal"), async () => {
          const summary = allStyleRefusals
            .map(
              (r) =>
                `${r.role} "${r.requested}": ${r.reason}${r.contrastRatio !== undefined ? ` (measured ${r.contrastRatio.toFixed(2)}:1)` : ""}`,
            )
            .join("; ");
          await tools["ledger.appendEvent"]?.execute(
            {
              runId: wf.runId,
              eventId: `${wf.runId}__style-directive-refused-r${revision}`,
              level: "warn",
              message: `round ${revision}'s style directive was partially or fully refused: ${summary}`,
            },
            { ctx },
          );
          return null;
        });
      }

      const styleDirectiveOutcome: DraftResult["styleDirectiveOutcome"] =
        styleDirectiveResult.source !== "none" || allStyleRefusals.length > 0
          ? {
              source: styleDirectiveResult.source,
              applied: [...styleDirectiveResult.applied],
              intents: [...styleDirectiveResult.intents],
              refusals: allStyleRefusals,
              overrides: { ...styleDirectiveResult.overrides },
            }
          : undefined;

      let finalCopy: InstagramCopyOutput | undefined;
      let finalSelections: ImageSelection[] | undefined;
      let finalSlidesData: RenderCarouselInput | undefined;
      let finalRendered: RenderCarouselResult | undefined;
      /** SCRUM-393 (IGSTYLE-8) — the winning attempt's contrast facts, carried into the gate payload. */
      let finalContrastFacts: ContrastFact[] = [];
      let finalOutcomeOk = false;
      let lastSelfCheckReason = "no attempt completed";
      /** Set by a failed 07d similarity check, so the NEXT attempt's prompt names exactly which published post to move away from. */
      let dedupeRetrySteer: string | undefined;

    for (let attempt = 1; attempt <= MAX_SELF_CHECK_ATTEMPTS; attempt++) {
      const copyExec = await wf.step.agent(rev(`05-write-copy-attempt-${attempt}`), copyAgent, {
        ...runDirectionField(runDirection),
        topic: topicClaim.topic,
        // The post format (2026-09): `carousel` (6-8 slides) or `single` (one
        // designed slide and a deep caption). The copy step echoes it back and
        // `checkSlidesData` holds the slide count to it.
        format: format.format,
        // The scouted story, when one took the slot: angle, hook, why-now, the
        // brand-fit bridge, and the source URLs it rests on.
        ...(topicClaim.trend !== undefined ? { trendCandidate: trendCandidateForDrafting(topicClaim.trend) } : {}),
        // What the client attached, as a vision model described it — slide N
        // is written TO the client's picture N.
        ...("analyses" in tier0Pool && tier0Pool.analyses.length > 0 ? { attachedMedia: tier0Pool.analyses } : {}),
        facts: research.facts,
        styleConfig: {
          rules: frozen.styleConfig.rules,
          banned_words: frozen.styleConfig.banned_words,
          banned_chars: frozen.styleConfig.banned_chars,
          compliance: frozen.styleConfig.compliance,
        },
        brandTokens: frozen.brandTokens,
        // The client's own profile description + voice-rules guidelines,
        // verbatim — this is where a language requirement like Geektime's
        // "Hebrew-language technology site" actually lives. See step 02b.
        ...(clientVoiceContext !== undefined ? { clientVoiceContext } : {}),
        // The client's projected branding-guidelines context doc (C1,
        // T-A9) — visual-identity rules distinct from the voice/tone
        // `clientVoiceContext` already carries. See step 02e.
        ...(brandingGuidelines !== undefined ? { brandingGuidelines } : {}),
        // The client's intel report, distilled to what steers copy (voice
        // rows, positioning, whitespace opportunities) — authoritative
        // client knowledge, read BEFORE external facts. See step 04f.
        ...(clientIntelContext !== undefined ? { clientIntelContext } : {}),
        // What this agent already shipped for this client — hard
        // do-not-repeat constraints, distinct from `pastFeedback` (what a
        // person SAID) the same way decisions are distinct from feedback.
        ...(recentPostsDirective !== undefined ? { recentPosts: recentPostsDirective } : {}),
        ...(dedupeRetrySteer !== undefined ? { dedupeAvoid: dedupeRetrySteer } : {}),
        // Two distinct kinds of steer, kept apart on purpose: `pastFeedback` is
        // what this client has said across previous RUNS (durable memory), and
        // `revisionRequest` is what a reviewer asked for about THIS run's draft
        // minutes ago. Collapsing them would let a months-old preference argue
        // with an instruction someone just gave.
        ...(pastFeedback.length > 0 ? { pastFeedback } : {}),
        ...(directive !== undefined ? { revisionRequest: directive } : {}),
      });
      if (copyExec.status === "tooling_error" || copyExec.status === "budget_exceeded") {
        throw new WorkflowToolingFailure(`copy step resolved to "${copyExec.status}" on attempt ${attempt}/${MAX_SELF_CHECK_ATTEMPTS}`);
      }
      if (copyExec.status !== "completed") {
        // A malformed draft (failed its own output schema) gets the same
        // "return to 05" remedy as a step-07 self-check failure below.
        lastSelfCheckReason = `copy draft failed its own output validation on attempt ${attempt}`;
        continue;
      }
      // `let`, not `const`: reassigned once below if a slide survives every
      // image-sourcing tier with nothing usable, to record its downgrade to
      // the "text_only" archetype (never mutated for any other reason).
      let copy = copyExec.finalOutput!;

      // ── 05b: source real candidate images for THIS attempt's copy ──
      //
      // The pool used to be a static workflow option that
      // `apps/agent-server` never supplied, so it was always `[]` and step 06
      // held every production run. `media.findImages` searches on each
      // slide's own `visualNeed`, which is why it belongs inside the retry
      // loop rather than before it: a second attempt rewrites the copy, so
      // the needs — and therefore the right candidates — change with it.
      //
      // An explicitly-supplied `options.imageCandidatePool` still wins. Tests
      // and evals depend on a fixed pool for determinism, and a caller that
      // has curated client-owned assets should not have them ignored in
      // favour of stock.
      //
      // The tool being absent entirely is a supported state, not a bug:
      // `createAllKarosTools()` deliberately excludes `media.*` (it is an
      // egress capability on a credential), so a caller assembling its own
      // registry legitimately has no such tool. That case leaves the pool
      // empty and reaches step 06's hold — exactly the behaviour before this
      // step existed. Asserting the tool here would instead crash those
      // callers.
      const findImages = tools["media.findImages"];
      // Tier 0 first: an explicitly-supplied `imageCandidatePool` still wins
      // (evals depend on a fixed pool), then the client's own uploads, then
      // whatever the harvesters find.
      let attemptPool =
        imageCandidatePool.length > 0
          ? imageCandidatePool
          : tier0Pool.candidates;
      // Why the pool is empty, in the sourcing layer's own words. Without it
      // the hold below could only say "no candidate qualified", which reads as
      // an editorial verdict on the topic and sent whoever debugged prep run
      // pubsub-21528976110173438 looking for a licensing problem when the real
      // cause was an unset UNSPLASH_ACCESS_KEY.
      let sourcingReason: string | undefined;
      // Gated on there being SLIDES LEFT TO FILL, not on the pool being empty.
      // The pool-empty form predated Tier 0 and broke the moment it landed: two
      // client uploads on an eight-slide carousel made the pool non-empty, which
      // skipped Tier 1 entirely and left the other six slides with no
      // harvester candidates at all. Tier 0 partially filling a carousel must
      // narrow the harvesters' work, never cancel it.
      //
      // An explicitly-supplied `imageCandidatePool` still suppresses sourcing,
      // which is what evals depend on.
      // ── Only PHOTO slides want a picture ──
      //
      // The archetype set (`InstagramSlideLayoutSchema`) means a slide can be
      // deliberately typographic: a `stat_callout` sets one number large, a
      // `quote_card` sets a pull-quote. Those render no image at all
      // (`assembleSlidesData` attaches `images.hero` only for `photo`), so
      // sourcing and vetting one for them is paid work whose output is
      // discarded — a real cost, since Tier 1 downloads bytes per candidate
      // and the vetting agent reads every candidate's description in one
      // prompt.
      //
      // `resolveLayout` rather than `s.layout`, because a slide whose chosen
      // archetype is missing its content block degrades to `text_only`, which
      // also needs no photo. Asking the resolved layout keeps this decision
      // consistent with what `assembleSlidesData` will actually render.
      const photoSlideNs = new Set(copy.slides.filter((s) => resolveLayout(s, availableTemplates).layout === "photo").map((s) => s.n));
      const slidesNeedingSource = copy.slides.filter((s) => photoSlideNs.has(s.n) && !tier0Slots.has(s.n));
      if (imageCandidatePool.length === 0 && slidesNeedingSource.length > 0 && findImages !== undefined) {
        const sourced = await wf.step.code(rev(`05b-source-images-attempt-${attempt}`), async () =>
          findImages.execute(
            {
              repoRoot: options.repoRoot,
              runId: wf.runId,
              // Only the slides Tier 0 did not already fill. Searching for a
            // slide that already has the client's own photo on it would be
            // paying a harvester to produce a candidate that must lose.
            needs: slidesNeedingSource.map((s) => ({ n: s.n, query: s.visualNeed })),
            },
            { ctx },
          ),
        );

        if (sourced.status === "success") {
          // Appended, not assigned: replacing the pool here would silently
          // discard the client's own uploads the moment a harvester returned
          // anything, which is the one outcome Tier 0 exists to prevent.
          attemptPool = [...attemptPool, ...(sourced.result as { candidates: ImageCandidate[] }).candidates];
        } else {
          // EVERY non-success is recorded and survived, including
          // `tooling_error`.
          //
          // A provider outage used to throw `WorkflowToolingFailure` here, on
          // the reasoning that an outage is an operator problem and must not
          // be misreported as "the topic had no good picture". That reasoning
          // is still right, and it is still honoured — the outage's own words
          // ride along in `sourcingReason` into the downgrade record, so
          // whoever reads the trace sees a 503 and not an editorial verdict.
          //
          // What was wrong was the CONSEQUENCE: throwing meant one stock
          // library returning 503 failed the entire run, discarding copy that
          // was already written and slides that could have shipped as type.
          // Reporting the cause and shipping is strictly better than
          // reporting the cause and shipping nothing.
          sourcingReason = `${sourced.status}: ${sourced.reason}`;
        }
        // Every outcome now leaves the pool as-is and falls through. An empty
        // pool means the slides degrade to typographic layouts and the post
        // still ships, carrying `sourcingReason` so the reason names the real
        // cause rather than only the gate's own verdict.
      }

      /** One slide still missing a picture, with the brief the next tier should answer. */
      type ImageGap = { n: number; prompt: string };

      /**
       * A selection for a slide that never wanted a photograph.
       *
       * `checkSlidesData` requires exactly one selection per slide, and the
       * rescue/downgrade logic below reads `rightsUsable`/`watermarkFree` —
       * so a typographic archetype needs a real entry rather than a gap.
       * `rightsUsable: true` is correct and not a fudge: there is no
       * third-party image here to have rights over.
       */
      const typographicSelection = (s: { n: number; layout: InstagramSlideLayout }): ImageSelection => ({
        n: s.n,
        imagePath: null,
        reason: `layout "${s.layout}" is typographic and renders no photograph, so no image was sourced or vetted for it`,
        license: "n/a — typographic layout, no image used",
        rightsUsable: true,
        watermarkFree: true,
      });

      /**
       * Whether a slide that WANTED a photo did not honestly get a usable one.
       *
       * Scoped to photo slides by the callers below: a `null` `imagePath` on a
       * `quote_card` is the correct, intended state, and treating it as
       * unfillable would downgrade every typographic archetype straight back
       * to `text_only` — silently undoing the whole archetype set.
       */
      const isUnfillable = (s: ImageSelection): boolean => {
        if (!photoSlideNs.has(s.n)) return false;
        if (s.imagePath === null) return true;
        if (!s.rightsUsable || !s.watermarkFree) return true;
        if (usedImagesSet.has(s.imagePath)) return true;
        return false;
      };

      let selections: ImageSelection[];
      let unfillable: ImageSelection[];

      if (attemptPool.length === 0) {
        // An empty pool has exactly one possible vetting verdict, so asking a
        // model for it buys nothing — the run that prompted this comment
        // spent $0.02 and 16s having Sonnet write six paragraphs each
        // concluding "the candidate pool is entirely empty". Skipping step
        // 06 entirely (rather than holding straight from here, the original
        // fix) still gives the rescue tiers below their real chance: `image.
        // generate` answers a slide's `visualNeed` directly and never
        // consulted this pool anyway, so a dead retrieval tier must not cost
        // it its turn.
        selections = copy.slides.map((s) =>
          photoSlideNs.has(s.n)
            ? {
                n: s.n,
                imagePath: null,
                reason: sourcingReason ?? "no candidate images were sourced at all, so nothing could be vetted",
                license: "n/a — no candidate qualified",
                rightsUsable: false,
                watermarkFree: false,
              }
            : typographicSelection({ n: s.n, layout: resolveLayout(s, availableTemplates).layout }),
        );
        unfillable = selections.filter(isUnfillable);
      } else {
        // ── 05c: a vision model looks at the candidates BEFORE the vetting judgment (2026-09) ──
        //
        // The vetting agent judges from text. Until now that text was a
        // provider's alt string, so a watermark, a cookie banner or a picture
        // of the wrong thing entirely sailed through when the alt text was
        // agreeable. Now each candidate carries what a vision model actually
        // saw, and the ones it grades unusable or watermarked never reach the
        // gate at all. Best-effort: no vision backend, or a failed call, leaves
        // the pool exactly as it was.
        const inspectTool = tools["media.inspectImages"];
        if (inspectTool !== undefined) {
          attemptPool = await wf.step.code(rev(`05c-inspect-candidates-attempt-${attempt}`), async (): Promise<ImageCandidate[]> => {
            const enriched: ImageCandidate[] = [];
            let dropped = 0;
            for (let start = 0; start < attemptPool.length; start += 12) {
              const batch = attemptPool.slice(start, start + 12);
              const inspected = await inspectTool.execute(
                { repoRoot: options.repoRoot, images: batch.map((c, i) => ({ ref: `c-${start + i}`, path: c.path })), purpose: "candidate-vetting" },
                { ctx },
              );
              if (inspected.status !== "success") {
                enriched.push(...batch);
                continue;
              }
              const byRef = new Map(((inspected.result as { inspections: Array<Record<string, unknown>> }).inspections).map((i) => [i["ref"] as string, i]));
              batch.forEach((c, i) => {
                const found = byRef.get(`c-${start + i}`);
                if (!found) {
                  enriched.push(c);
                  return;
                }
                if (found["quality"] === "unusable" || found["hasWatermark"] === true) {
                  dropped += 1;
                  return;
                }
                const text = Array.isArray(found["textInImage"]) && (found["textInImage"] as string[]).length > 0 ? `; text in image: ${(found["textInImage"] as string[]).join(" / ")}` : "";
                const flags = [found["looksLikeScreenshot"] === true ? "screenshot/document" : "", found["looksAiGenerated"] === true ? "looks AI-generated" : ""].filter(Boolean).join(", ");
                enriched.push({ ...c, description: `${c.description} [vision: ${String(found["description"] ?? "")}${text}${flags ? `; ${flags}` : ""}]` });
              });
            }
            if (dropped > 0) sourcingReason = `${sourcingReason ? `${sourcingReason}; ` : ""}${dropped} candidate(s) dropped by vision inspection (watermarked or unusable)`;
            return enriched;
          });
        }
        const imageExec = await wf.step.agent(rev(`06-vet-images-attempt-${attempt}`), imageAgent, {
          // Only the photo slides are put in front of the gate. A typographic
          // archetype has nothing for it to judge, and including it would ask
          // the model to match a picture to a slide that renders none.
          slides: copy.slides.filter((s) => photoSlideNs.has(s.n)).map((s) => ({ n: s.n, visualNeed: s.visualNeed })),
          candidatePool: attemptPool,
          usedImages,
        });
        if (imageExec.status === "tooling_error" || imageExec.status === "budget_exceeded") {
          throw new WorkflowToolingFailure(`image vetting step resolved to "${imageExec.status}" on attempt ${attempt}/${MAX_SELF_CHECK_ATTEMPTS}`);
        }
        if (imageExec.status !== "completed") {
          lastSelfCheckReason = `image vetting failed its own output validation on attempt ${attempt}`;
          continue;
        }
        const vetting = imageExec.finalOutput!;

        // Fix 4 extends "unfillable" to a selection that fails
        // rights/watermark, and Fix 3 extends it to a selection that
        // (despite the prompt's instruction) duplicates a prior post's
        // already-used image — both are deterministically re-checked here,
        // never trusted from the model alone.
        // The gate only saw the photo slides, so its selections cover only
        // those. Every typographic slide gets its own entry appended, in the
        // copy's slide order, so `checkSlidesData`'s one-selection-per-slide
        // requirement still holds.
        const vetted = new Map(vetting.selections.map((sel) => [sel.n, sel]));
        selections = copy.slides.map(
          (s) => vetted.get(s.n) ?? typographicSelection({ n: s.n, layout: resolveLayout(s, availableTemplates).layout }),
        );
        unfillable = selections.filter(isUnfillable);
      }

      // ── 06b/06c: generative rescue for the gaps retrieval could not fill ──
      //
      // Retrieval has a ceiling that more search backends cannot raise. prep
      // run pubsub-21535110633863323 hit it exactly: four providers, 36
      // candidates, and slide 5 still failed because it needed "a timeline or
      // roadmap with a clearly labeled 'research' first phase, shot from
      // above" — a picture no stock or CC library holds. Generation is the
      // only source that answers a specific brief on demand, so the gaps get
      // one bounded attempt at it before the post is held.
      //
      // Deliberately narrow: only the unfilled slides are generated (each
      // image is billed), only the unfilled slides are re-vetted, and only
      // once per copy attempt. The never-a-placeholder rule is untouched — a
      // generated image still has to clear the same gate as a stock photo,
      // and a run whose gaps survive generation still holds.
      // ── The tiered rescue: scrape, then generate ──
      //
      // Tier 1 (05b, `media.findImages`) has already merged every stock and CC
      // harvester. What is left unfilled is a need those libraries do not hold,
      // and the two remaining tiers answer different halves of that:
      //
      //   Tier 2 `media.scrapeImages` — a photograph of the ACTUAL subject,
      //     which exists on the open social web and nowhere else. Every
      //     candidate is `licenseConfidence: "unknown"` (UGC copyright stays
      //     with the poster), so the rights gate will refuse most of them. This
      //     tier widens the choice; it does not guarantee an outcome.
      //   Tier 3 `image.generate` — Vertex draws the brief. Owned outright,
      //     nothing to credit, nothing watermarked, so it is the ONLY tier that
      //     can actually finish a slide unattended.
      //
      // Ordered scrape-then-generate on purpose: a real photograph beats a
      // synthesised one when the gate will accept it, and generation costs a
      // billed call per image, so it runs on what survives tier 2.
      //
      // Each tier re-vets only the slides still missing, against only its own
      // new candidates. Re-judging settled slides would pay for verdicts that
      // are not going to change.
      const rescueTiers: Array<{ id: string; tool: AgentTool | undefined; buildArgs: (gaps: ImageGap[]) => unknown }> = [
        {
          id: "scrape",
          tool: tools["media.scrapeImages"],
          buildArgs: (gaps) => ({
            repoRoot: options.repoRoot,
            runId: wf.runId,
            needs: gaps.map((g) => ({ n: g.n, query: g.prompt })),
          }),
        },
        {
          id: "generate",
          tool: tools["image.generate"],
          buildArgs: (gaps) => ({
            repoRoot: options.repoRoot,
            runId: wf.runId,
            needs: gaps,
            // The real canvas, not a hardcoded default: a generated slide that
            // renders at a different ratio to the template gets cropped, and a
            // crop is exactly how a carefully-composed frame loses its subject.
            aspectRatio: aspectRatioForCanvas(frozen.styleConfig.canvas),
            art: artDirectionFor(frozen.brandTokens),
          }),
        },
      ];

      let tierIndex = 0;
      for (const tier of rescueTiers) {
        tierIndex += 1;
        if (unfillable.length === 0 || tier.tool === undefined) continue;

        const gaps: ImageGap[] = unfillable
          .map((u) => ({ n: u.n, prompt: copy.slides.find((sl) => sl.n === u.n)?.visualNeed }))
          .filter((g): g is ImageGap => g.prompt !== undefined);
        if (gaps.length === 0) continue;

        const sourced = await wf.step.code(rev(`06${"bd"[tierIndex - 1]}-${tier.id}-images-attempt-${attempt}`), async () =>
          tier.tool!.execute(tier.buildArgs(gaps), { ctx }),
        );

        if (sourced.status !== "success") {
          // `not_available` on an unconfigured deployment, `content_fail` when
          // the tier honestly found nothing, `tooling_error` on an outage: all
          // three leave `unfillable` as it was and let the next tier try. Only
          // an exhausted cascade holds the post.
          continue;
        }

        const tierPool = (sourced.result as { candidates: ImageCandidate[] }).candidates;
        if (tierPool.length === 0) continue;

        const revet = await wf.step.agent(rev(`06${"ce"[tierIndex - 1]}-vet-${tier.id}-attempt-${attempt}`), imageAgent, {
          slides: gaps.map((g) => ({ n: g.n, visualNeed: g.prompt })),
          candidatePool: tierPool,
          usedImages,
        });
        if (revet.status !== "completed") continue;

        const rescued = new Map(revet.finalOutput!.selections.map((sel) => [sel.n, sel]));
        selections = selections.map((sel) => {
          const replacement = rescued.get(sel.n);
          // Only an actually-fillable replacement wins. A rescue that failed
          // its own gate must not overwrite the original verdict with a
          // second, equally unusable one.
          return replacement && !isUnfillable(replacement) ? replacement : sel;
        });
        unfillable = selections.filter(isUnfillable);
      }

      // ── Pre-flight: does every selected image still EXIST on disk? ──
      //
      // `publish.renderCarousel` reports a missing image file as
      // `content_fail`, which used to hold the whole post at step 08 — after
      // copy, vetting, every rescue tier and the self-checks had all been
      // paid for. That is the one image-caused hold that survived the
      // guaranteed-delivery work, and it is reachable for real: the media
      // cache lives on an in-memory volume (see karos-media's README), so a
      // Cloud Run instance recycling between vetting and render genuinely
      // loses the bytes.
      //
      // Checked here instead, where a missing file is just another reason the
      // slide has no usable picture, so it flows into the SAME downgrade path
      // as every other sourcing failure rather than needing its own outcome.
      const missingOnDisk = await wf.step.code(rev(`06f-verify-images-on-disk-attempt-${attempt}`), async () => {
        const gone: number[] = [];
        for (const sel of selections) {
          if (sel.imagePath === null) continue;
          try {
            await fs.access(path.resolve(options.repoRoot, sel.imagePath));
          } catch {
            gone.push(sel.n);
          }
        }
        return gone;
      });
      if (missingOnDisk.length > 0) {
        const goneSet = new Set(missingOnDisk);
        selections = selections.map((sel) =>
          goneSet.has(sel.n)
            ? { ...sel, imagePath: null, reason: `${sel.reason} (the file was no longer on disk at render time)` }
            : sel,
        );
        unfillable = selections.filter(isUnfillable);
      }

      // Guaranteed delivery (2026-08): a slide that survives every tier —
      // retrieval, social scrape, generation — with nothing usable no longer
      // holds the whole post. The never-a-placeholder guarantee is
      // unchanged: nothing rights-encumbered, watermarked, or reused ever
      // ships. What changes is the alternative to holding — the slide ships
      // on the "text_only" archetype (`InstagramSlideLayoutSchema`) instead,
      // which `assembleSlidesData`/the render template already support
      // (headline/body/accent-band on the template's own dark background,
      // no photo). A run only holds now for a genuine copy/rights/compliance
      // self-check failure (below), never solely because a picture could not
      // be found — see prep runs pubsub-21533408759483219 and
      // pubsub-21543794087429035, both of which held on exactly this with a
      // real Vertex quota blip as the actual cause, not an editorial "no
      // picture exists" verdict.
      if (unfillable.length > 0) {
        // `s.reason` carries the real diagnostic (an unset key, a provider's
        // own "no results" chain, the vetting model's own explanation) —
        // the category label alone ("no candidate qualified") is exactly
        // the generic-editorial-verdict framing prep run
        // pubsub-21528976110173438 got burned by, with the actual cause
        // (an unset UNSPLASH_ACCESS_KEY) sitting one step upstream of it.
        const detail = unfillable.map((s) => {
          if (s.imagePath === null) return `${s.n}: ${s.reason}`;
          if (!s.rightsUsable) return `${s.n}: not rights-usable (${s.reason})`;
          if (!s.watermarkFree) return `${s.n}: not watermark-free (${s.reason})`;
          return `${s.n}: already used in a prior post`;
        });
        const downgradedNs = new Set(unfillable.map((s) => s.n));
        await wf.step.code(rev(`07a-downgrade-unfillable-slides-attempt-${attempt}`), () => ({
          downgraded: [...downgradedNs],
          reason: `slide(s) ${[...downgradedNs].join(", ")} shipping text-only — no viable image survived retrieval, social-scrape, and generation (${detail.join("; ")})`,
        }));
        // Never a rights-encumbered/watermarked/reused image, regardless of
        // which of those disqualified the candidate — the slide gets NO
        // photo, not a demoted one.
        selections = selections.map((sel) => (downgradedNs.has(sel.n) ? { ...sel, imagePath: null } : sel));
        copy = { ...copy, slides: copy.slides.map((s) => (downgradedNs.has(s.n) ? { ...s, layout: "text_only" } : s)) };
      }

      const attemptChecked = await wf.step.code(rev(`07-self-check-attempt-${attempt}`), () =>
        checkSlidesData(tools, ctx, copy, selections, research, frozen.styleConfig),
      );

      if (!attemptChecked.ok) {
        lastSelfCheckReason = attemptChecked.reason;
        continue;
      }

      // Fix 3: the unconditional, mechanical craft-hygiene gate (em dash/
      // exclamation/sentence-case) — never client-config-driven, runs on
      // every attempt regardless of what the client's own style rules say.
      const craftHygiene = await wf.step.code(rev(`07b-craft-hygiene-attempt-${attempt}`), () => checkCraftHygiene(tools, ctx, copy));
      if (!craftHygiene.ok) {
        lastSelfCheckReason = craftHygiene.reason;
        continue;
      }

      // ── 07e/07f: the language-compliance gate (SCRUM-310/AU32) ──
      //
      // Both stages run BEFORE step 08's render, deliberately: text baked
      // into a 1080x1440 PNG is the one thing a reviewer at gate 09a cannot
      // fix in place. Neither existing quality judge covers this —
      // `instagram-image-vet@2` judges candidate photographs and
      // `instagram-visual-qa@1` judges the rendered attempt's structured
      // slide data against `check: "render"` layout rules; nothing asked
      // whether the words are fluent text in the client's own language,
      // which is how the geektime carousel shipped in English for a
      // Hebrew-only outlet and passed every check that existed.
      //
      // Both stages are skipped entirely when the client has declared no
      // target language (step 02d) — there is nothing to check against, and
      // like `runTopicGuardrail` on a client who forbids no topics, that
      // costs no model call and adds no step to the trace.
      //
      // A failure routes into this SAME shared retry loop as every other
      // self-check, for the same reason: the remedy for wrong-language copy
      // is a redraft (RETURN: 05), and the language requirement is already
      // in the drafting prompt (step 02b) — the model is being told it did
      // not follow it.
      //
      // Placed ahead of 07d rather than after it so the cheapest rejection
      // happens first: a wrong-language draft is dead either way, and
      // scoring it for similarity against the client's back catalogue (or
      // building a dedupe steer out of it) is work thrown away. Step ids in
      // this loop are already not monotonic in execution order — 07d runs
      // before 07c — because they name what a step is, not when it runs.
      if (targetLanguage !== undefined) {
        const gateText = languageGateText(copy);

        // Stage 1 — deterministic, no model call, no tools. Runs first so
        // the catastrophic case (an entirely wrong-script post) never pays
        // for stage 2.
        const scriptCheck = await wf.step.code(rev(`${LANGUAGE_SCRIPT_STEP_ID}-attempt-${attempt}`), () =>
          checkExpectedScript(gateText, targetLanguage),
        );
        if (!scriptCheck.ok) {
          lastSelfCheckReason = `slide copy failed the deterministic language/script check: ${scriptCheck.reason}`;
          continue;
        }

        // Stage 2 — one commodity-tier judge call. Hebrew-shaped nonsense is
        // still Hebrew characters, so stage 1 cannot see it.
        const fluency = await runLanguageFluency(
          wf,
          { tools, promptStore: options.promptStore, router: options.router },
          gateText,
          targetLanguage,
          rev(`${LANGUAGE_FLUENCY_STEP_ID}-attempt-${attempt}`),
        );
        // `error` is never a failure of the draft — same fail-open-loudly
        // posture as `runTopicGuardrail`. The verdict is in the step's own
        // checkpointed output, so a human can see the check did not run
        // rather than a green tick it did not earn.
        if (fluency.status === "not_fluent") {
          lastSelfCheckReason =
            `slide copy is not fluent ${targetLanguage} on attempt ${attempt}: ` +
            `${fluency.issues.length > 0 ? fluency.issues.join("; ") : "no specific issues given"}` +
            `${fluency.evidence ? ` (e.g. "${fluency.evidence}")` : ""}`;
          continue;
        }
      }

      // ── 07d: is this draft a repeat of something this client already published? ──
      //
      // Deterministic trigram-Jaccard scoring against the same excerpt
      // window step 04e read (`evaluateDedupe`'s calibrated 0.4 threshold —
      // the same scorer dynamic agents already run). A `similar` verdict
      // burns one of the SAME shared retry budget every other self-check
      // uses, with the offending post quoted into the redraft prompt; on the
      // final attempt the draft ships FLAGGED (the verdict is in this step's
      // checkpointed output for the trace and the human gate), never held —
      // two posts a fortnight apart about the same launch may be exactly
      // right, and a fixed threshold is not entitled to overrule the person
      // reviewing at 09a.
      const draftText = `${copy.caption}\n\n${copy.slides.map((s) => `${s.headline} ${s.body}`).join("\n")}`;
      const dedupeVerdict = await checkOutputDedupe(wf, rev(`07d-dedupe-check-attempt-${attempt}`), draftText, outputHistory);
      if (dedupeVerdict.status === "similar" && attempt < MAX_SELF_CHECK_ATTEMPTS) {
        dedupeRetrySteer = dedupeRetryDirective(dedupeVerdict, outputHistory);
        lastSelfCheckReason = `draft is ${Math.round(dedupeVerdict.maxSimilarity * 100)}% similar to an already-published post (run ${dedupeVerdict.mostSimilarRunId ?? "unknown"})`;
        continue;
      }

      // A `custom` archetype's markup is validated fresh every attempt, from
      // this attempt's own `copy` — never checkpointed on its own (see
      // `validateCustomArchetypes`'s doc comment). `resolveLayout` (inside
      // `assembleSlidesData`) downgrades anything that didn't pass to
      // `text_only`, and `ensureTemplatesOnDisk` below writes exactly the
      // slides that did.
      const validatedCustomArchetypes = validateCustomArchetypes(copy);
      const validatedCustomArchetypeIds = new Set(validatedCustomArchetypes.map((a) => a.archetypeId));

      const slidesDataAttempt = await wf.step.code(rev(`07c-emit-slides-data-attempt-${attempt}`), () =>
        assembleSlidesData({
          clientSlug: wf.clientSlug,
          postId: runClaim.postId,
          repoRoot: options.repoRoot,
          brandTokens: frozen.brandTokens,
          copy,
          selections,
          canvas: frozen.styleConfig.canvas,
          availableTemplates,
          templateDirOverride: effectiveTemplateDir,
          validatedCustomArchetypeIds,
          ...(effectiveKit?.brandAccent !== undefined ? { brandAccentFallback: effectiveKit.brandAccent } : {}),
          ...(effectiveKit?.handle !== undefined ? { brandHandle: effectiveKit.handle } : {}),
          // IGSTYLE-7, §7a — wires `paletteForSlide`'s already-built, already-
          // seeded rotation into the render path for the first time. Seeded
          // from `wf.runId` per the ticket; a ring of length ≤ 1 (or absent)
          // falls back to `brandAccentFallback` above for every slide.
          accentRing: effectiveKit?.palette ?? [],
          paletteSeed: wf.runId,
          ...(groundFgInversion !== undefined ? { groundFgInversion } : {}),
        }),
      );

      // ── 08: render via the shared, already-tested publish.renderCarousel tool ──
      await ensureTemplatesOnDisk(validatedCustomArchetypes);
      const renderOutcome = await wf.step.code(rev(`08-render-carousel-attempt-${attempt}`), async () => tools["publish.renderCarousel"]!.execute(slidesDataAttempt, { ctx }));

      // ── The last image-caused hold, now a degrade ──
      //
      // `content_fail` from the renderer means an image path did not resolve.
      // The pre-flight check above should have caught every case of that, so
      // reaching here means something raced it (the volume recycled between
      // the check and the screenshot). Holding was the old answer; the
      // guarantee now is that a picture problem never costs the post, so this
      // strips EVERY image and renders the carousel fully typographic instead.
      //
      // Bounded to one extra attempt on purpose: with no images left there is
      // no image left to fail on, so a second `content_fail` is not a picture
      // problem at all and is reported as the tooling break it actually is.
      let renderResolved = renderOutcome;
      let slidesDataResolved = slidesDataAttempt;
      if (renderResolved.status === "content_fail") {
        const strippedCopy: InstagramCopyOutput = {
          ...copy,
          slides: copy.slides.map((s) => (s.layout === "photo" ? { ...s, layout: "text_only" as const } : s)),
        };
        const strippedSelections = selections.map((sel) => ({ ...sel, imagePath: null }));
        slidesDataResolved = await wf.step.code(rev(`08a-render-fallback-typographic-attempt-${attempt}`), () =>
          assembleSlidesData({
            clientSlug: wf.clientSlug,
            postId: runClaim.postId,
            repoRoot: options.repoRoot,
            brandTokens: frozen.brandTokens,
            copy: strippedCopy,
            selections: strippedSelections,
            canvas: frozen.styleConfig.canvas,
            availableTemplates,
            templateDirOverride: effectiveTemplateDir,
            validatedCustomArchetypeIds,
            ...(effectiveKit?.brandAccent !== undefined ? { brandAccentFallback: effectiveKit.brandAccent } : {}),
          ...(effectiveKit?.handle !== undefined ? { brandHandle: effectiveKit.handle } : {}),
            accentRing: effectiveKit?.palette ?? [],
            paletteSeed: wf.runId,
            ...(groundFgInversion !== undefined ? { groundFgInversion } : {}),
          }),
        );
        copy = strippedCopy;
        selections = strippedSelections;
        await ensureTemplatesOnDisk(validatedCustomArchetypes);
        renderResolved = await wf.step.code(rev(`08-render-carousel-typographic-attempt-${attempt}`), async () =>
          tools["publish.renderCarousel"]!.execute(slidesDataResolved, { ctx }),
        );
      }

      if (renderResolved.status !== "success") {
        // Either a genuine tooling break, or a `content_fail` that survived
        // having every image removed — which is no longer a picture problem.
        // Both are `degraded`, never `held`: nothing here is an editorial
        // verdict a human should act on.
        // `status` is read before the `in` check below narrows the union, which
        // would otherwise leave the else branch typed `never`.
        const status: string = renderResolved.status;
        const detail = "reason" in renderResolved ? renderResolved.reason : status;
        throw new WorkflowToolingFailure(
          status === "content_fail"
            ? // Every image was already stripped before this second attempt, so
              // a surviving content failure is not a picture problem.
              `render step still reported a content failure after every image was removed, so it is not an image problem: ${detail}`
            : `render step reported a tooling failure: ${detail}`,
        );
      }
      const renderedAttempt = renderResolved.result as RenderCarouselResult;
      const slidesDataForQa = slidesDataResolved;

      // ── 08a2: deterministic visual-QA pre-checks (SCRUM-324/AU40) —
      //         code answers every question that HAS a factual answer,
      //         before the model is ever asked to grade anything. See
      //         `visual-qa-pre-checks.ts`'s own header for the full
      //         rationale, including why "is the logo present" is a FACT fed
      //         to the judge rather than a gate on the attempt (brand
      //         furniture must never be able to hold a run — same invariant
      //         `brandFragments`/`brand-logo.ts` state repeatedly), while
      //         "are the palette tokens within the kit" genuinely gates and
      //         short-circuits the model call entirely: an off-kit accent is
      //         a real render defect, not an unreachable third-party asset. ──
      const preChecks = await wf.step.code(rev(`08a2-visual-qa-pre-checks-attempt-${attempt}`), async () => {
        const { placement } = await brandLogoAssessment();
        const usedHexes = slidesDataForQa.slides
          .map((s) => s.fields["accentColor"])
          .filter((h): h is string => typeof h === "string");
        return {
          paletteGate: checkPaletteWithinKit(usedHexes, effectiveKit?.palette ?? []),
          brandAsset: assessBrandAssetPresence({
            configuredLogoUrl: effectiveKit?.logoUrl,
            rejectedLogoUrlReason: effectiveKit?.rejectedLogoUrlReason,
            hasDownload: placement !== undefined,
            placement,
          }),
          // SCRUM-393 (IGSTYLE-8): a FACT, never a gate — see
          // `assessContrastFacts`'s own doc comment. Computed from the same
          // `usedHexes` the palette gate above already derived, so "which
          // accents are being judged" can't drift between the two.
          contrastFacts: assessContrastFacts(brandKit, usedHexes),
        };
      });

      if (!preChecks.paletteGate.ok) {
        // The whole cost claim this ticket has to prove: this attempt never
        // reaches `qaAgent` at all — zero model calls for a defect code
        // already knows about with an `includes()` check.
        lastSelfCheckReason = `visual QA deterministic pre-check failed on attempt ${attempt} (no model call spent): ${preChecks.paletteGate.reason}`;
        continue;
      }

      // SCRUM-393 (IGSTYLE-8): surface every sub-floor contrast fact as a
      // ledger warn event — visible to a human without holding, degrading,
      // or retrying this attempt. Real brand colors (a client's own coral
      // accent on its own cream ground) can legitimately sit below the
      // floor; the point is that nobody currently learns this at all.
      const belowFloor = preChecks.contrastFacts.filter((f) => !f.pass);
      if (belowFloor.length > 0) {
        await wf.step.code(rev(`08a3-record-contrast-below-floor-attempt-${attempt}`), async () =>
          tools["ledger.appendEvent"]?.execute(
            {
              runId: wf.runId,
              eventId: `${wf.runId}__contrast-below-floor`,
              level: "warn",
              message: `attempt ${attempt}: ${belowFloor.length} contrast fact(s) below floor — ${belowFloor
                .map((f) => `${f.label}: ${f.ratio.toFixed(2)}:1 (floor ${f.floor}:1)`)
                .join("; ")}`,
            },
            { ctx },
          ),
        );
      }

      // ── 08b: post-render visual QA (Fix 2/AU40) — a text-proxy stand-in
      //         for real pixel inspection (see InstagramVisualQaAgent's own
      //         doc comment). Judges `check: "render"` rules from the frozen
      //         config PLUS the elevated criteria this ticket adds
      //         (composition richness, font hierarchy, brand-asset
      //         integration, colour harmony) — every one of which the
      //         08a2 pre-check has already stripped of its factual half, so
      //         the model grades only the aesthetic residue code cannot
      //         compute. A failure here `continue`s the SAME retry loop as
      //         step 07/07b above, matching carousel-agent-v2 SKILL.md step
      //         08's "a fail here is RETURN: 05, because it is the copy or
      //         the layout, not the code." ──
      // ── 08a4: a vision model LOOKS at the rendered PNGs (2026-09) ──
      //
      // The QA agent has always judged from structured slide data and said so
      // in its own prompt ("you do NOT see the actual rendered pixels"). With
      // `media.inspectImages` in the registry it can: each rendered slide is
      // described — legible text, quality grade, whether it reads as a
      // finished slide — and the descriptions ride into the QA input as
      // `renderedInspections`. Best-effort: no vision backend, or a failed
      // call, leaves the QA exactly as it was.
      const inspectRendered = tools["media.inspectImages"];
      let renderedInspections: Array<Record<string, unknown>> = [];
      if (inspectRendered !== undefined && renderedAttempt.rendered.length > 0) {
        renderedInspections = await wf.step.code(rev(`08a4-inspect-rendered-attempt-${attempt}`), async (): Promise<Array<Record<string, unknown>>> => {
          const images = renderedAttempt.rendered.slice(0, 12).flatMap((r): Array<{ ref: string; url?: string; path?: string }> => {
            if (/^https?:\/\//i.test(r.path)) return [{ ref: `slide-${r.n}`, url: r.path }];
            // The renderer writes a local file when no media store is
            // configured; the vision tool takes it repo-relative and bounds-checks it.
            const relative = path.isAbsolute(r.path) ? path.relative(options.repoRoot, r.path) : r.path;
            if (relative.startsWith("..")) return [];
            return [{ ref: `slide-${r.n}`, path: relative.replace(/\\/g, "/") }];
          });
          if (images.length === 0) return [];
          const outcome = await inspectRendered.execute(
            {
              repoRoot: options.repoRoot,
              images,
              purpose: "candidate-vetting",
              brief: "a finished Instagram slide as it will be published: every word legible, nothing overlapping or cut off, not near-empty, the photo (if any) not fighting the text",
            },
            { ctx },
          );
          if (outcome.status !== "success") return [];
          return (outcome.result as { inspections: Array<Record<string, unknown>> }).inspections.map((i) => ({
            n: Number(String(i["ref"]).split("-")[1]),
            description: i["description"],
            textInImage: i["textInImage"],
            quality: i["quality"],
            qualityReason: i["qualityReason"],
            ...(i["fitScore"] !== undefined ? { fitScore: i["fitScore"], fitReason: i["fitReason"] } : {}),
          }));
        });
      }

      const elevatedCriteria = buildElevatedVisualQaCriteria({ logo: preChecks.brandAsset, kitPalette: effectiveKit?.palette ?? [] });
      const qaExec = await wf.step.agent(rev(`08b-visual-qa-attempt-${attempt}`), qaAgent, {
        // The format (2026-09): a single-image post has no "closer" slide and
        // a rule written for an eight-slide carousel does not apply to it.
        format: copy.format,
        // What a vision model saw in the actual PNGs, when one was available.
        ...(renderedInspections.length > 0 ? { renderedInspections } : {}),
        slides: slidesDataForQa.slides.map((s) => ({ n: s.n, fields: s.fields, images: s.images })),
        renderRules: [...renderRules.map((r) => ({ id: r.id, description: r.description })), ...elevatedCriteria],
        // Facts the judge must not re-derive (per-criterion doc comments in
        // `visual-qa-pre-checks.ts`) — present only when the corresponding
        // elevated criterion above was actually included.
        ...(preChecks.brandAsset.present
          ? { brandAssetContext: { corner: preChecks.brandAsset.corner, scrimmed: preChecks.brandAsset.scrimmed } }
          : {}),
        ...(effectiveKit !== undefined && effectiveKit.palette.length > 0 ? { brandPalette: effectiveKit.palette } : {}),
      });
      if (qaExec.status === "tooling_error" || qaExec.status === "budget_exceeded") {
        throw new WorkflowToolingFailure(`visual QA step resolved to "${qaExec.status}" on attempt ${attempt}/${MAX_SELF_CHECK_ATTEMPTS}`);
      }
      if (qaExec.status !== "completed") {
        lastSelfCheckReason = `visual QA output failed its own output validation on attempt ${attempt}`;
        continue;
      }
      const qa = qaExec.finalOutput!;
      if (!qa.pass) {
        const failing = qa.findings.filter((f) => !f.passed);
        lastSelfCheckReason = `visual QA failed on attempt ${attempt}: ${failing.length > 0 ? failing.map((f) => `${f.ruleId}${f.slide !== undefined ? ` (slide ${f.slide})` : ""}: ${f.note}`).join("; ") : "no specific findings given"}`;
        continue;
      }

      finalCopy = copy;
      finalSelections = selections;
      finalSlidesData = slidesDataForQa;
      finalRendered = renderedAttempt;
      finalContrastFacts = preChecks.contrastFacts;
      finalOutcomeOk = true;
      break;
    }

      if (!finalOutcomeOk || !finalCopy || !finalSelections || !finalSlidesData || !finalRendered) {
        throw new WorkflowHeld(
          `step 07's self-check never passed after ${MAX_SELF_CHECK_ATTEMPTS} attempt(s) (initial + ${MAX_SELF_CHECK_ATTEMPTS - 1} return(s) to step 05) — last reason: ${lastSelfCheckReason}`,
        );
      }
      // IGSTYLE-10, §10e — reconstructed from the SAME pure per-slide
      // decisions `assembleSlidesData` itself used to build `finalSlidesData`
      // (`buildVariationPlan`'s own doc comment), so the report can never
      // drift from what actually rendered. Gated on a brand kit existing at
      // all — a client with neither an accent ring nor a derived ground/fg
      // pair has nothing either axis could have done, so nothing is reported,
      // matching every other optional field's "absent, not noise" convention.
      const variationPlan =
        effectiveKit !== undefined
          ? buildVariationPlan({
              slideNs: finalSlidesData.slides.map((s) => s.n),
              accentRing: effectiveKit.palette,
              paletteSeed: wf.runId,
              brandAccentFallback: frozen.brandTokens.accentColor ?? effectiveKit.brandAccent ?? "#C4552F",
              ...(groundFgInversion !== undefined ? { groundFgInversion } : {}),
            })
          : undefined;
      return {
        copy: finalCopy,
        selections: finalSelections,
        slidesData: finalSlidesData,
        rendered: finalRendered,
        ...(styleDirectiveOutcome !== undefined ? { styleDirectiveOutcome } : {}),
        ...(styleVariation.length > 0 ? { styleVariation } : {}),
        ...(variationPlan !== undefined && variationPlan.length > 0 ? { variationPlan } : {}),
        contrastFacts: finalContrastFacts,
      };
    };

    // ── 09a: the universal approve / revise / reject cycle ──
    //
    // `revise` is what makes this a loop rather than a verdict: the reviewer's
    // feedback is injected into a fresh drafting pass (revision-scoped step
    // ids, everything upstream reused from its checkpoints) instead of the run
    // being held and somebody having to dispatch a new one that knows nothing
    // about what was asked for.
    //
    // Every decision, including approvals, is written to client memory by
    // `onDecision` before the cycle acts on it — an approving reviewer saying
    // "the shorter hooks are working" is teaching the system something, and a
    // store that only remembers complaints learns a distorted version of what
    // a client wants.
    // `runReviewCycle`'s `onDecision` now also receives the round's raw
    // `output` (SCRUM-306/AU23), but `templateFeedback` handling below needs
    // the SLIDES specifically, keyed for `customArchetypesByTemplateId` — so
    // this local capture stays rather than re-deriving that from `output` on
    // every decision. Captured here, in `attempt`, right before each round's
    // draft is returned — safe because the cycle is a strict, single-
    // threaded loop (attempt -> buildGate -> gate -> onDecision, one round
    // fully resolves before the next begins), so `onDecision` always reads
    // the draft the reviewer was actually looking at.
    let latestDraftForReview: DraftResult | undefined;

    const review = await runReviewCycle<DraftResult>(wf, {
      gateId: "09a-batch-review",
      maxRevisions: MAX_REVISION_ROUNDS,
      ...(options.autoApprove ? { autoApprove: true } : {}),
      attempt: async (revision, notes) => {
        const draft = await draftOnce(revision, notes);
        // The terminal topic guardrail runs on the copy that is about to be
        // shown to a human, so a revision's new copy is checked too rather
        // than only the first draft's. Checks the caption AND every slide's
        // own text, since a forbidden subject could surface in either.
        await runTopicGuardrail(
          wf,
          { tools, promptStore: options.promptStore, router: options.router },
          `${draft.copy.caption}\n\n${slidesTextFor(draft)}`,
          frozen.forbiddenTopics,
          revision === 0 ? undefined : `-r${revision}`,
        );
        latestDraftForReview = draft;
        return draft;
      },
      buildGate: (draft, revision) => ({
        kind: "batch_review",
        payload: {
          runId: wf.runId,
          postId: runClaim.postId,
          topic: topicClaim.topic,
          slideCount: draft.slidesData.slides.length,
          renderedCount: draft.rendered.rendered.length,
          revision,
          // IGSTYLE-3, §2.3's "loud refusals" requirement — what THIS round's
          // style-directive resolution did, including any refusal, so a
          // silently-dropped colour instruction is never indistinguishable
          // from one that simply wasn't asked for. Absent on the common case
          // (nothing was attempted this round) rather than an empty object,
          // matching every other optional gate-payload field's convention.
          ...(draft.styleDirectiveOutcome !== undefined ? { styleDirectiveOutcome: draft.styleDirectiveOutcome } : {}),
          // IGSTYLE-7, §7b/7c — every departure THIS round's variation budget
          // (or an intent-only satisfaction) made from the raw learned prior
          // below, so a reviewer can see not just WHAT was learned but
          // whether/why this round's render actually varied from it. Absent
          // on the common case — nothing departed — same convention as every
          // other optional gate-payload field here.
          ...(draft.styleVariation !== undefined ? { styleVariation: draft.styleVariation } : {}),
          // IGSTYLE-10, §10e — which axis each slide used this round, and why
          // not when it didn't (`ring=1`, `accent-fails-inverted-ground`,
          // `directive-pinned`, `no-ground-pair`) — the same "loud, never
          // silent" rule as `styleDirectiveOutcome` above, applied to the
          // 75/25 variation budget. Absent on the common case — no brand kit
          // at all, so neither axis was even attempted.
          ...(draft.variationPlan !== undefined ? { variationPlan: draft.variationPlan } : {}),
          // IGSTYLE-5, §2.4/§2.6 — the Layer-1 PRIOR this run drafted against
          // (frozen at 02h, same object every round of this run), so a
          // reviewer can see WHY revision 0 already leans a certain way with
          // no human input yet given this run. Absent on the common case —
          // no prior client history, or nothing in it cleared the evidence
          // threshold — same convention as `styleDirectiveOutcome` just
          // above.
          ...(distilledStyle.evidence.length > 0
            ? {
                learnedStylePreferences: {
                  overrides: distilledStyle.overrides,
                  strength: distilledStyle.strength,
                  intents: distilledStyle.intents,
                  evidence: distilledStyle.evidence,
                },
              }
            : {}),
          // The actual caption a reviewer approves alongside the images —
          // every other channel's gate payload has carried its drafted text
          // as `preview` since the review panel existed; a carousel's own
          // `preview` used to be a raw join of every slide's field values
          // (including `accentColor`'s hex code) because no real caption
          // existed yet to show instead.
          preview: draft.copy.caption,
          // SCRUM-393 (IGSTYLE-8): text and accent-on-ground contrast, as
          // FACTS — for passes as well as failures, so a reviewer sees the
          // good numbers too, not only a warning when something's wrong.
          contrastFacts: draft.contrastFacts,
          // The editable projection (Phase 2 in-place review editing): the
          // caption plus each slide's PROSE fields — never the layout
          // metadata in NON_PROSE_FIELD_KEYS — so the reviewer can edit the
          // actual text behind the pixels instead of describing a change and
          // paying for a redraft.
          copy: {
            caption: draft.copy.caption,
            slides: draft.slidesData.slides.map((slide) => ({
              n: slide.n,
              template: slide.template,
              fields: Object.fromEntries(Object.entries(slide.fields ?? {}).filter(([key]) => !NON_PROSE_FIELD_KEYS.has(key))),
            })),
          },
          // The rendered PNGs, in slide order — `path` is a signed https URL
          // when the runtime could sign one (`GcsArtifactStore.upload`'s own
          // fallback rule), a bare `gs://` URI otherwise, which the review
          // panel can't load but which the payload should still carry rather
          // than silently omit.
          images: draft.rendered.rendered.map((r) => ({ n: r.n, url: r.path })),
          // Which template rendered each slide, and whether it is one a person
          // has never signed off on. This is what lets the review surface say
          // "new custom template used on slide 4" and attach design feedback to
          // the right registry row rather than to the post as a whole.
          //
          // A `custom` archetype this round drafted has no row in
          // `templateResolution.chosen` at all (that list is fixed at step
          // 04c, before this round's copy even exists) — a synthetic entry
          // is added here so it's found by the exact same lookup below, with
          // no change to the lookup itself. Its `templateId` is the same
          // `customArchetypeTemplateId` scheme `onDecision`/`promoteTemplate`
          // use, so a reviewer's `promote: true` on it connects straight
          // through with no separate lookup needed.
          slideTemplates: (() => {
            const chosenForGate = [
              ...templateResolution.chosen,
              ...draft.copy.slides
                .filter((s) => s.layout === "custom" && s.customArchetype)
                .map((s) => ({
                  archetypeId: s.customArchetype!.archetypeId,
                  templateId: customArchetypeTemplateId(wf.clientSlug, s.customArchetype!.archetypeId),
                  source: "ai_generated" as const,
                  qualityScore: 0,
                })),
            ];
            return draft.slidesData.slides.map((slide) => {
              const chosen = chosenForGate.find((c) => templateFileName(c.archetypeId) === slide.template);
              return {
                n: slide.n,
                template: slide.template,
                ...(chosen ? { templateId: chosen.templateId, templateSource: chosen.source } : {}),
                isExperimental: chosen?.source === "ai_generated",
              };
            });
          })(),
        },
        requiredRole: "account_manager",
        timeout: { duration: "24h", onTimeout: "hold" },
      }),
      onDecision: async ({ revision, response, templateFeedback }) => {
        // IGSTYLE-3, §2.2 Layer 2 — captured here (not via `notes`, which the
        // shared `RevisionNote` shape deliberately never carries `edits` on)
        // so the NEXT round's `draftOnce` reads exactly the structured pick
        // THIS round's reviewer made. Only meaningful on `revise` — an
        // `approve`'s `edits.style` is Phase 2's in-place-edit path (09c/09d
        // below), not a directive for a future drafting round that will
        // never happen. Safe to read/write here with no staleness risk for
        // the same reason `latestDraftForReview` is (`runReviewCycle`'s own
        // doc comment: "attempt -> buildGate -> gate -> onDecision, one round
        // fully resolves before the next begins").
        latestStyleEdit = response.decision === "revise" ? response.edits?.style : undefined;

        const customArchetypesByTemplateId = new Map(
          (latestDraftForReview?.copy.slides ?? [])
            .filter((s) => s.layout === "custom" && s.customArchetype)
            .map((s) => [customArchetypeTemplateId(wf.clientSlug, s.customArchetype!.archetypeId), s.customArchetype!] as const),
        );
        // IGSTYLE-5, §2.4 writer 1 — pulled into a local first (rather than
        // narrowed inline in the object literal below) because
        // `latestDraftForReview` is a `let` captured across an `await`
        // boundary in this closure: TypeScript does not carry a narrowing on
        // `x.y.z` through that boundary, only on a local it can see is never
        // reassigned.
        const styleOutcome = latestDraftForReview?.styleDirectiveOutcome;
        await persistReviewFeedback(wf, tools, ctx, {
          revision,
          response,
          templateFeedback,
          templateStore: options.templateStore,
          customArchetypesByTemplateId,
          // SCRUM-306 (AU23): `latestDraftForReview` is exactly what this
          // round's reviewer looked at (see its own doc comment above, on
          // why reading it here is safe) — only serialized on reject, for
          // the same reason every other review-gated agent restricts this
          // to reject.
          content: response.decision === "reject" && latestDraftForReview !== undefined ? JSON.stringify(latestDraftForReview) : undefined,
          // IGSTYLE-5, §2.4 writer 1 — this round's resolved style directive,
          // verbatim off the draft the reviewer actually judged (never the
          // merged/re-derived effective kit — see `styleDirectiveOutcome`'s
          // own field doc). Undefined on the overwhelming majority of rounds,
          // exactly like `styleDirectiveOutcome` itself: nothing style-related
          // was even attempted.
          style:
            styleOutcome !== undefined && styleOutcome.source !== "none"
              ? {
                  // `StyleOverrides`' keys are all optional (`string |
                  // undefined`) so it isn't structurally a `Record<string,
                  // string>` — this drops any key that ended up unset rather
                  // than writing an illegal `undefined` value into the
                  // durable row.
                  overrides: Object.fromEntries(
                    Object.entries(styleOutcome.overrides).filter((entry): entry is [string, string] => entry[1] !== undefined),
                  ),
                  source: styleOutcome.source,
                  intents: styleOutcome.intents,
                  applied: styleOutcome.applied,
                }
              : undefined,
        });
      },
    });

    // ── 09c/09d: apply the reviewer's in-place edits (Phase 2) ──
    //
    // The reviewer IS the gate: their edits ship verbatim — no model pass, no
    // topic-guardrail re-run on human-authored text. Validation is structural
    // only (an edit may touch a prose field the slide actually has, never the
    // NON_PROSE layout metadata), and the whole path exists only when edits
    // were actually sent — a plain approve's trace is byte-identical to
    // before this feature.
    let slidesData = review.output.slidesData;
    let rendered = review.output.rendered;
    let caption = review.output.copy.caption;

    const reviewEdits = review.response.edits;
    const hasReviewEdits =
      reviewEdits !== undefined && (reviewEdits.caption !== undefined || (reviewEdits.slides?.length ?? 0) > 0);
    if (hasReviewEdits) {
      const applied = await wf.step.code("09c-apply-review-edits", () => {
        const summary: string[] = [];
        const editsBySlide = new Map((reviewEdits.slides ?? []).map((e) => [e.n, e]));
        const slides = review.output.slidesData.slides.map((slide) => {
          const edit = editsBySlide.get(slide.n);
          if (edit === undefined) return slide;
          const fields = { ...slide.fields };
          for (const [key, value] of Object.entries(edit.fields ?? {})) {
            // Only a prose field the slide already HAS is editable — an
            // unknown key or layout metadata is dropped with a note in the
            // step output, never an error: a stray key must not cost an
            // approved post.
            if (!(key in fields) || NON_PROSE_FIELD_KEYS.has(key)) {
              summary.push(`slide ${slide.n} ${key}: ignored (not an editable field)`);
              continue;
            }
            if (fields[key] !== value) {
              summary.push(`slide ${slide.n} ${key}: "${fields[key]}" -> "${value}"`);
              fields[key] = value;
            }
          }
          if (edit.fontScale !== undefined && fields["fontScale"] !== edit.fontScale) {
            summary.push(`slide ${slide.n} font size -> ${edit.fontScale}`);
            fields["fontScale"] = edit.fontScale;
          }
          if (edit.textAlign !== undefined && fields["textAlign"] !== edit.textAlign) {
            summary.push(`slide ${slide.n} alignment -> ${edit.textAlign}`);
            fields["textAlign"] = edit.textAlign;
          }
          return { ...slide, fields };
        });
        let editedCaption = review.output.copy.caption;
        if (reviewEdits.caption !== undefined && reviewEdits.caption !== editedCaption) {
          summary.push(`caption: "${editedCaption}" -> "${reviewEdits.caption}"`);
          editedCaption = reviewEdits.caption;
        }
        return {
          slidesData: { ...review.output.slidesData, slides },
          caption: editedCaption,
          summary,
        };
      });

      // Text edits change pixels, so the carousel re-renders through the
      // exact same path as the original. Image files may have vanished since
      // the pre-gate render (instance recycle): the 06f rule applies — a
      // missing picture strips to a typographic slide, it never holds.
      const editedInput: RenderCarouselInput = {
        ...applied.slidesData,
        slides: await Promise.all(
          applied.slidesData.slides.map(async (slide) => {
            const images: Record<string, string> = {};
            for (const [key, rel] of Object.entries(slide.images ?? {})) {
              const onDisk = await fs
                .access(path.resolve(options.repoRoot, rel))
                .then(() => true)
                .catch(() => false);
              if (onDisk) images[key] = rel;
            }
            return { ...slide, images };
          }),
        ),
      };
      await ensureTemplatesOnDisk(validateCustomArchetypes(review.output.copy));
      const editedRender = await wf.step.code("09d-render-edited-carousel", async () =>
        tools["publish.renderCarousel"]!.execute(editedInput, { ctx }),
      );

      const renderOk = editedRender.status === "success";
      if (renderOk) {
        slidesData = editedInput;
        rendered = (editedRender as { result: RenderCarouselResult }).result;
        caption = applied.caption;
      } else {
        // Pixels and text must never disagree: if the edited render failed,
        // the ORIGINAL approved render ships with its ORIGINAL slide text,
        // and only the caption edit (post text, not pixels) still applies.
        caption = reviewEdits.caption ?? caption;
        await wf.step.code("09d2-record-edits-not-applied", async () =>
          tools["ledger.appendEvent"]?.execute(
            {
              runId: wf.runId,
              eventId: `${wf.runId}__review-edits-not-applied`,
              level: "warn",
              message: `reviewer slide edits could not be applied (re-render: ${editedRender.status}); delivered the originally approved render, caption edit ${reviewEdits.caption !== undefined ? "applied" : "n/a"}`,
            },
            { ctx },
          ),
        );
      }

      // The preference half of the loop: the deltas become durable feedback,
      // so future drafts calibrate toward what the reviewer keeps fixing by
      // hand. A separate feedbackId from the decision's own note — both can
      // exist for one review.
      if (applied.summary.length > 0) {
        await wf.step.code("09e-record-edit-feedback", async () => {
          const note =
            `Reviewer edited before approving${renderOk ? "" : " (edits could not be applied to this post's pixels; treat as preference)"}: ` +
            applied.summary.slice(0, 12).join("; ").slice(0, 1800);
          try {
            await tools["memory.appendFeedback"]?.execute(
              {
                feedbackId: `${wf.runId}-r${review.revision}-edits`,
                productId: wf.productId,
                decision: "approve",
                actor: review.response.actor,
                note,
                revision: review.revision,
                runId: wf.runId,
              },
              { ctx },
            );
          } catch (error) {
            console.error("09e-record-edit-feedback: could not record the reviewer's edit deltas", error);
          }
          return { note };
        });
      }
    }

    // IGSTYLE-5, §2.4 writer 3 — `edits.style` is the reviewer's own color
    // controls (Phase 2, IGSTYLE-1 §"Meaningful on approve AND revise"; the
    // portal UI to submit it on approve is IGSTYLE-6's job, but the field is
    // already a legal `GateResponse.edits.style` today). Deliberately its OWN
    // step and its OWN `if`, independent of `hasReviewEdits` above: a reviewer
    // who only adjusted colors — no caption or slide text touched — still
    // must produce a durable, STRUCTURED row, not just prose, so a later
    // run's `distillStylePreferences` has real hex evidence to vote over.
    if (reviewEdits?.style !== undefined && Object.keys(reviewEdits.style).length > 0) {
      const styleOverrides = Object.fromEntries(
        Object.entries(reviewEdits.style).filter((entry): entry is [string, string] => entry[1] !== undefined),
      );
      await wf.step.code("09e-record-edit-feedback-style", async () => {
        const note = `Reviewer set colors before approving: ${Object.entries(styleOverrides)
          .map(([k, v]) => `${k} -> ${v}`)
          .join("; ")}`;
        try {
          await tools["memory.appendFeedback"]?.execute(
            {
              feedbackId: `${wf.runId}-r${review.revision}-edits-style`,
              productId: wf.productId,
              decision: "approve",
              actor: review.response.actor,
              note,
              revision: review.revision,
              runId: wf.runId,
              style: { overrides: styleOverrides, source: "structured", intents: [], applied: [] },
            },
            { ctx },
          );
        } catch (error) {
          console.error("09e-record-edit-feedback-style: could not record the reviewer's color edits", error);
        }
        return { note };
      });
    }

    // ── 09b: deliver + log — the count invariant is real and checked, not just documented ──
    const deliverableId = await wf.step.code("09b-deliver-and-log", async () => {
      if (rendered.rendered.length !== slidesData.slides.length) {
        // A genuine internal inconsistency (the renderer's own contract is to
        // render every slide or fail outright) — a tooling bug, never a
        // content verdict, so this is never recorded as if the post were
        // simply short a slide.
        throw new WorkflowToolingFailure(
          `rendered PNG count (${rendered.rendered.length}) does not match slide count (${slidesData.slides.length}) — refusing to log a deliverable that doesn't match what was actually rendered`,
        );
      }

      const writeOutcome = await tools["ledger.writeDeliverable"]!.execute(
        {
          runId: wf.runId,
          kind: "instagram-carousel",
          deliverable: {
            postId: runClaim.postId,
            topic: topicClaim.topic,
            // The format (2026-09) and, when a scouted story took the slot, its
            // why-now and brand-fit bridge for the reviewer.
            format: review.output.copy.format,
            ...(topicClaim.trend !== undefined ? { trend: topicClaim.trend } : {}),
            caption,
            slides: slidesData.slides,
            rendered: rendered.rendered,
            // SCRUM-242 (T-A10): the DEGRADED marker, on the actual persisted
            // deliverable a reviewer looks at — see 02f's own comment.
            ...(contextGrounding.decision === "degraded" ? { contextGrounding: contextGrounding.marker } : {}),
          },
        },
        { ctx },
      );
      if (writeOutcome.status !== "success") {
        throw new WorkflowToolingFailure(`ledger.writeDeliverable failed: ${writeOutcome.status}`);
      }
      const id = (writeOutcome.result as { id: string }).id;

      // Fix 3: this post's shipped images are now "used" for every future
      // run's cross-post reuse check (step 06 above) — recorded only now,
      // once delivery is otherwise real, never speculatively before that.
      const shippedImagePaths = review.output.selections.map((s) => s.imagePath).filter((p): p is string => p !== null);
      if (shippedImagePaths.length > 0) {
        const recordOutcome = await tools["ledger.recordUsedImages"]!.execute({ imagePaths: shippedImagePaths }, { ctx });
        if (recordOutcome.status !== "success") {
          throw new WorkflowToolingFailure(`ledger.recordUsedImages failed: ${recordOutcome.status}`);
        }
      }

      // The write half of the anti-repetition loop step 04e reads: the
      // shipped post's text joins this agent's rolling excerpt window, so
      // the NEXT run's research history, do-not-repeat directive, and 07d
      // similarity check all see it. Only on delivery (a post that never
      // shipped was never published — same rule as recordUsedImages above),
      // and best-effort: losing an excerpt costs future dedup signal, but
      // failing an otherwise-delivered post over it would cost the post.
      try {
        await tools["ledger.recordOutputExcerpt"]?.execute(
          // `slidesData` (not review.output) so the dedup window records what
          // ACTUALLY shipped — including any reviewer in-place edits.
          { agentId: "instagram-agent", runId: wf.runId, excerpt: `${caption}\n\n${slidesTextFor({ ...review.output, slidesData })}` },
          { ctx },
        );
      } catch (error) {
        console.error("09b-deliver-and-log: could not record the output excerpt for future dedup", error);
      }

      await tools["ledger.appendEvent"]!.execute(
        {
          runId: wf.runId,
          eventId: `${wf.runId}__delivered`,
          level: "success",
          message: `Instagram carousel delivered: ${rendered.rendered.length} slides rendered for topic "${topicClaim.topic}"`,
        },
        { ctx },
      );

      // Re-confirm the step-03 topic claim survived a concurrent run before
      // finishing (RFC-03 §3 step 09's note) — commits the sole dedup claim
      // for good, only once delivery is otherwise complete.
      //
      // CONDITIONAL, because step 03 can now reach a subject without reserving
      // one (a requested subject, or a research-derived fallback, when the
      // catalog could not serve this lane — see that step's own note). There is
      // no reservation to confirm in those cases, and calling `topics.commit`
      // with no key would either fail or, worse, claim the catalog issued
      // something it never did. Same guard x-agent's step 20 already applies to
      // its own reservation.
      if (topicClaim.source === "reserved" && topicClaim.reservationKey) {
        const commitOutcome = await tools["topics.commit"]!.execute({ reservationKey: topicClaim.reservationKey }, { ctx });
        if (commitOutcome.status !== "success") {
          throw new WorkflowToolingFailure(`topics.commit failed to confirm the step-03 topic claim: ${commitOutcome.status}`);
        }
      }

      return id;
    });

    return {
      postId: runClaim.postId,
      topic: topicClaim.topic,
      slideCount: slidesData.slides.length,
      renderedCount: rendered.rendered.length,
      deliverableId,
      // SCRUM-242 (T-A10): same DEGRADED marker, on the workflow's own typed
      // return value — see 02f's own comment.
      ...(contextGrounding.decision === "degraded" ? { contextGrounding: contextGrounding.marker } : {}),
    };
  };
}

/**
 * The client's declared industry, or undefined when they have none.
 *
 * Reads the same field step 03's fallback reads. Deliberately NOT defaulted to
 * a neutral stand-in: a stand-in would let auto-setup seed the catalog from
 * generic research for a client whose profile is empty, and step 03 would then
 * reserve one of those off-brand topics and draft from it in good faith.
 * Undefined is what makes the caller skip seeding instead.
 */
function industryForSetup(outcome: { status: string; result?: unknown }): string | undefined {
  if (outcome.status !== "success") return undefined;
  const industry = (outcome.result as Record<string, unknown> | undefined)?.["industry"];
  return typeof industry === "string" && industry.trim().length > 0 ? industry.trim() : undefined;
}

/**
 * The closest aspect ratio the image model accepts to the client's actual
 * canvas.
 *
 * The generator only takes a fixed set of ratios, so this picks the nearest by
 * numeric distance rather than guessing a default. Getting it wrong is not
 * cosmetic: the template renders the image into a fixed frame, so a mismatched
 * generation is cropped, and a crop takes the subject out of a frame that was
 * composed around it.
 */
function aspectRatioForCanvas(canvas: { w: number; h: number }): "1:1" | "3:4" | "4:3" | "9:16" | "16:9" {
  const supported: Array<{ id: "1:1" | "3:4" | "4:3" | "9:16" | "16:9"; value: number }> = [
    { id: "1:1", value: 1 },
    { id: "3:4", value: 3 / 4 },
    { id: "4:3", value: 4 / 3 },
    { id: "9:16", value: 9 / 16 },
    { id: "16:9", value: 16 / 9 },
  ];
  const target = canvas.h > 0 ? canvas.w / canvas.h : 1;
  return supported.reduce((best, option) =>
    Math.abs(option.value - target) < Math.abs(best.value - target) ? option : best,
  ).id;
}

/**
 * Art direction assembled from the client's own brand tokens, or undefined
 * when they have declared none.
 *
 * Undefined rather than a set of tasteful defaults, deliberately: invented
 * direction would make every client's generated slides look like whatever this
 * function happened to prefer, which is worse than the neutral brief the
 * generator already falls back to. Only what the client actually declared.
 */
function artDirectionFor(tokens: BrandTokens): Record<string, unknown> | undefined {
  const art = {
    ...(tokens.aesthetic ? { aesthetic: tokens.aesthetic } : {}),
    ...(tokens.lighting ? { lighting: tokens.lighting } : {}),
    ...(tokens.palette && tokens.palette.length > 0 ? { palette: tokens.palette } : {}),
    ...(tokens.accentColor ? { accentColor: tokens.accentColor } : {}),
    ...(tokens.visualMood ? { mood: tokens.visualMood } : {}),
  };
  return Object.keys(art).length > 0 ? art : undefined;
}
