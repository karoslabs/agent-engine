import { BaseAgent, resolveModelPolicy, type AgentStepConfig } from "@agent-engine/core";
import { VisualQaOutputSchema, type VisualQaOutput } from "../workflow/types.js";

/**
 * P0 parity-audit Fix 2: carousel-agent-v2 SKILL.md step 08 — "look at the
 * PNGs. The renderer proves pixels exist; it does not prove they are good.
 * Check the `check: 'render'` rules from the frozen config: nothing
 * overlapping, no near-empty slide, the closer carries a device. A fail here
 * is `RETURN: 05`." This agent is a deliberate TEXT-PROXY stand-in for real
 * pixel inspection: it is handed the rendered attempt's own structured
 * `fields`/`images` data (never actual pixels) plus the frozen style config's
 * `check: "render"` rules, and judges plausibility from what's actually
 * available. This is honestly weaker than real pixel inspection and is
 * documented as such rather than overclaiming. (Since 2026-09 the workflow's 08a4 step
 * hands it `renderedInspections` — a vision model's reading of the actual
 * PNGs — when a vision backend is configured.)
 *
 * A `pass: false` verdict is routed by the workflow into the SAME step-07
 * self-check retry loop already in place — visual QA failing is
 * conceptually identical to "the assembled contract didn't pass its own
 * check," not a new retry mechanism.
 *
 * `allowedTools: []` — the workflow hand-assembles everything this step
 * needs (the rendered slides' fields/images, the frozen render-type rules,
 * and since 2026-09 the post `format`, so a single-image post is not judged
 * against a rule written for an eight-slide closer).
 *
 * SCRUM-324 (AU40), `@2`: the workflow also passes four ELEVATED criteria as
 * ordinary `renderRules` entries — composition richness, font hierarchy,
 * brand-asset integration, colour harmony (`visual-qa-pre-checks.ts`) — and,
 * when relevant, `brandAssetContext`/`brandPalette` facts the model must
 * treat as already-verified, never re-judge. Every factual half of those four
 * criteria is answered in code BEFORE this agent ever runs; this agent grades
 * only the aesthetic residue.
 *
 * ## Model (2026-09)
 *
 * Gemini 2.5 Flash on Vertex, `pinned`. A structured pass/fail with per-rule
 * findings over structured data — a QA step, not client-facing copy — where
 * Flash's structured output is reliable and its cost is a rounding error
 * next to the render it judges. Retargetable per deployment
 * (`MODEL_STEP_INSTAGRAM_VISUAL_QA_VENDOR/_MODEL`) and per run in Studio.
 */
export class InstagramVisualQaAgent extends BaseAgent<VisualQaOutput> {
  protected readonly config: AgentStepConfig<VisualQaOutput> = {
    id: "instagram-visual-qa",
    description:
      "Judge a rendered carousel attempt's structured slide data (fields/images, never actual pixels) against the frozen style config's check:'render' rules plus the elevated composition/font-hierarchy/brand-asset-integration/colour-harmony criteria, and report pass/fail with per-rule findings.",
    allowedTools: [],
    outputSchema: VisualQaOutputSchema,
    modelPolicy: resolveModelPolicy("instagram-visual-qa", { policy: "pinned", model: "gemini-2.5-flash", vendor: "gemini" }),
    // Pinned to "3" (2026-09): v3 adds §5, `renderedInspections` — what a
    // vision model saw in the actual rendered PNGs, when the run had a vision
    // backend — as evidence for the config's own render rules. v2 stays frozen.
    skillRef: "instagram-visual-qa@3",
  };
}
