import { z } from "zod";
import { BaseAgent, resolveModelPolicy, type AgentStepConfig } from "@agent-engine/core";
import { MediaBriefSchema } from "@agent-engine/workflow";
import { LINKEDIN_ARCHETYPES } from "../workflow/types.js";

/**
 * A single LinkedIn post (RFC-02 §5). `headline`, `hook`, `body`,
 * `hashtags`, `callToAction`, and `targetAudience` are the structured
 * breakdown; `text` is the fully composed post exactly as it will be
 * published (`hook` + `body` + takeaway + `callToAction` + hashtags) — the
 * single field every gate and the render check actually operate on, same
 * role `text` plays on the X agent's output. `headline` is never published;
 * it's an internal working title for the client's content calendar.
 * `archetype` is the restored lane/mix concept (Phase 2.5 Batch 2.2, source
 * of truth `linkedin-voice-by-industry.md`'s 11 founder archetypes) — the
 * model echoes back which archetype it actually wrote the post in (it is
 * handed a chosen archetype as input; this field is the ground truth of what
 * shipped, which is what the workflow records for the next run's
 * never-repeat-the-last-lane check).
 *
 * 2026-09 (linkedin-craft@5): `takeaway` is the one line a reader should
 * carry away, required and expected to appear in `text` (the formatting
 * check reports when it does not). `mediaBrief` is the draft's statement of
 * what visual, if any, the post wants — answered by the shared media
 * resolver; a client-attached image arrives BEFORE drafting as
 * `attachedMedia` and the brief is then moot.
 */
export const LinkedInPostOutputSchema = z.object({
  headline: z.string().min(1),
  hook: z.string().min(1),
  body: z.string().min(1),
  /** The single sentence a reader should remember. Appears in `text`, on its own line, before the call to action. */
  takeaway: z.string().min(1),
  hashtags: z.array(z.string()).default([]),
  callToAction: z.string().min(1),
  targetAudience: z.string().min(1),
  text: z.string().min(1),
  archetype: z.enum(LINKEDIN_ARCHETYPES),
  /** What visual this post wants, if any. Omitted when the run attached media (the copy was written to it). */
  mediaBrief: MediaBriefSchema.optional(),
});
export type LinkedInPostOutput = z.infer<typeof LinkedInPostOutputSchema>;

/**
 * The RFC-02 §5 migration: drafts exactly one LinkedIn post per run (RFC-01
 * §16.2's "one post, one run" ruling, the same recipe used for the X pilot).
 * `skillRef` resolves the full craft policy (voice, hook construction,
 * thought-leadership structure, hashtag policy) dynamically through
 * `runtime.promptStore` (RFC-01 §16.1) — nothing here is a hardcoded prompt
 * literal. `allowedTools` covers the mechanical render check and the three
 * content gates; `gate.lintPost` also runs as this agent's own
 * self-critique, bounded to one revision. `gateArgs: {platform: "linkedin"}`
 * pins that check to LinkedIn's real 3000-character limit explicitly — the
 * draft object handed to self-critique is the model's raw turn output,
 * before `outputSchema` defaults ever apply, so leaving `platform` for the
 * model to supply would risk falling back to `gate.lintPost`'s generic
 * 5000-character limit.
 */
export class LinkedInDraftAgent extends BaseAgent<LinkedInPostOutput> {
  protected readonly config: AgentStepConfig<LinkedInPostOutput> = {
    id: "linkedin-draft",
    description: "Draft a single LinkedIn post for the selected candidate topic, archetype and content mode, with a clear takeaway, and state what visual it wants.",
    allowedTools: ["render.preview", "gate.lintPost", "gate.numbersSourced", "gate.brandCompliance"],
    outputSchema: LinkedInPostOutputSchema,
    // Pinned — RFC-02 §5: claude-sonnet-4-6 today, claude-sonnet-5 is an
    // equally acceptable pin once available; never a fallback for a pinned step.
    // The client-facing copy step keeps Claude for voice; the scout and vision
    // steps around it run on Gemini Flash. `contentLanguageSensitive` lets a
    // non-English client's brand kit re-point it per client (AU34), and Studio
    // can move it per run (stageModels["linkedin-draft"]) — an executive seat
    // whose posts are the product is a candidate for claude-opus-4-8.
    modelPolicy: resolveModelPolicy("linkedin-draft", { policy: "pinned", model: "claude-sonnet-4-6", contentLanguageSensitive: true }),
    // Pinned to "3": v3 adds a language check to §2 (Voice) against
    // `clientVoiceContext` (the client's own profile description +
    // voice-rules guidelines) — nothing before it ever forwarded `profile`
    // to this prompt at all, so an outlet that states its own language in
    // plain prose (Geektime: "Israel's largest Hebrew-language technology...
    // site") got a fluent English post regardless of channel (prep job
    // hcf9ymPGJC7mDS5pcEQ4, traced on instagram-agent but structural across
    // every channel). v2 stays frozen.
    // Pinned to "4": v4 adds the client-knowledge-and-recent-posts section
    // — clientIntelContext (the client's own intel report, distilled) is read
    // as authoritative before external facts, and recentPosts (the shipped-
    // output dedup window this agent now writes back into on delivery) is a
    // hard do-not-repeat constraint. v3 stays frozen.
    // Pinned to "5" (2026-09): the elite-tier rewrite. The draft now receives
    // the RESEARCH itself (`research`: every source's title, url, date,
    // excerpt — until now it got a headline), a scouted trend candidate with
    // its brand-fit bridge, a content mode (hot news / deep value / open
    // discussion), and any client-attached media described by a vision model.
    // The shape is specified (one or two sentences per line, a blank line
    // between every line, a stated `takeaway`), the machine-writing tells are
    // named, and a `mediaBrief` is required (a real photo or a document
    // screenshot over illustration; "none" is a valid answer). v4 stays frozen.
    skillRef: "linkedin-craft@5",
    selfCritique: { gateTool: "gate.lintPost", maxRevisions: 1, gateArgs: { platform: "linkedin" } },
  };
}
