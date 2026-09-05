import { BaseAgent, resolveModelPolicy, type AgentStepConfig } from "@agent-engine/core";
import { ImageVettingOutputSchema, type ImageVettingOutput } from "../workflow/types.js";

/**
 * RFC-03 §3 step 06: "source and vet one picture per slide" — real judgment,
 * not a rubber stamp. This agent is handed a small caller-provided pool of
 * repo-relative candidate image paths, each with a written description, and
 * must judge, per slide, whether any pool candidate actually satisfies that
 * slide's `visualNeed` — does it show what the slide claims, is it the right
 * era, watermark-free, etc.
 *
 * 2026-09: the description is no longer only a provider's alt text. When a
 * vision backend is configured, the workflow's 05c step has a model LOOK at
 * every candidate first and appends what it saw (`[vision: …]`: subjects,
 * legible text, screenshot/AI tells), and drops the ones it graded unusable
 * or watermarked before they ever reach this gate. This agent's judgment is
 * therefore about what is actually in frame, which is what the prompt always
 * asked for and could never have.
 *
 * **The preserved legacy-defect fix (RFC-03 §1/§3, "this exact behavior"):**
 * when no candidate in the pool honestly satisfies a slide, this agent must
 * report that slide's `imagePath` as `null` rather than picking the
 * least-bad option or leaving the slide out of its `selections` array
 * entirely. The workflow checks for exactly this and downgrades the slide to
 * a typographic layout — never a placeholder image, never a silently-dropped
 * slide. This agent's own job is only the honest per-slide verdict; the
 * run-level decision is Layer 1's (RFC-01 §4).
 *
 * **Rights/licence/watermark verification (P0 parity-audit Fix 4) and
 * cross-post reuse (Fix 3):** restored via `ImageSelectionSchema`'s
 * `license`/`rightsUsable`/`watermarkFree` fields, which this agent's output
 * schema requires per selection; the workflow deterministically double-checks
 * both, never trusting the model's verdict alone for a "never ship this"
 * guarantee.
 *
 * ## Model (2026-09)
 *
 * Gemini 2.5 Flash on Vertex, `pinned`. This is a QA/classification step over
 * text the workflow assembled — a per-slide verdict with a reason — not
 * client-facing copy. Flash's structured output is reliable for this shape
 * and it costs a fraction of Sonnet on a step that runs up to three times per
 * attempt across the rescue tiers. Retargetable per deployment
 * (`MODEL_STEP_INSTAGRAM_IMAGE_VET_VENDOR/_MODEL`) and per run in Studio.
 */
export class InstagramImageVettingAgent extends BaseAgent<ImageVettingOutput> {
  protected readonly config: AgentStepConfig<ImageVettingOutput> = {
    id: "instagram-image-vet",
    description: "Judge, per slide, whether any candidate in the supplied image pool actually satisfies that slide's visual need AND is rights-usable, watermark-free, and not already used in a prior post — report null, never a placeholder, when none does.",
    allowedTools: [],
    outputSchema: ImageVettingOutputSchema,
    modelPolicy: resolveModelPolicy("instagram-image-vet", { policy: "pinned", model: "gemini-2.5-flash", vendor: "gemini" }),
    // Pinned to "2": v1 judged every clause of `visualNeed` as an equal hard
    // gate, so a candidate genuinely on-subject was rejected outright over a
    // single decorative mismatch (shot outdoors instead of the requested
    // "warm indoor light"; smiling instead of "concerned") — retrieval had
    // already found reasonable candidates, and v1's literalism threw them
    // away (prep run pubsub-21548537245422013, job 2VFCw79Wu8xfJOKXC7zP:
    // both of that carousel's photo slides rejected every candidate and fell
    // through to generation). v2 adds a CENTRAL-vs-DECORATIVE judgment call:
    // reject on a subject mismatch or a real contradiction of the slide's
    // claim, not on an atmosphere/expression/framing detail that doesn't
    // change what the slide is actually saying. v1 stays frozen.
    skillRef: "instagram-image-vet@2",
  };
}
