import { z } from "zod";
import { BaseAgent, resolveModelPolicy, type AgentStepConfig } from "@agent-engine/core";
import { MediaBriefSchema } from "@agent-engine/workflow";

/**
 * The six content lanes (`references/lanes.md` in x-agent-v2): what this
 * account talks about and how, restored here as a real enum after the
 * migration shipped a two-value `hasNumericInsight ? "data-point" :
 * "trend-observation"` stub with no lane concept at all. `pov` stands in for
 * lanes.md's "POV / hot takes" and `engagement` for its "engagement (reply /
 * quote)" — both renamed to single tokens to fit a zod enum.
 */
export const LANE_VALUES = [
  "build-in-public",
  "knowledge",
  "pov",
  "news-reaction",
  "quote-comment",
  "engagement",
] as const;
export const LaneSchema = z.enum(LANE_VALUES);
export type Lane = z.infer<typeof LaneSchema>;

/** The most parts a thread may run to. Past seven, X readers stop; past seven, a writer is padding. */
export const MAX_THREAD_PARTS = 7;

/**
 * A single X post (RFC-02 §3). `text` and `mainPostText` are required to
 * carry identical content (enforced by prompt instruction, not a schema
 * `.transform`/`.refine` — `BaseAgent`'s self-critique spreads the model's
 * raw, unparsed turn output straight into `gate.lintPost`, which only knows
 * the field name `text`; a schema-level refinement wouldn't be visible to
 * that call, and wrapping this schema in `ZodEffects` risks breaking
 * `AnthropicAdapter`'s `z.toJSONSchema(req.schema)` tool-input conversion).
 * `text` stays for every pre-existing call site (self-critique's own
 * `gate.lintPost` call, `render.preview`, `gate.numbersSourced`,
 * `gate.brandCompliance`) that already depends on a field literally named
 * `text`; `mainPostText` is the spec-named field matching x-agent-v2
 * SKILL.md step 09's draft artifact (`{text, parts?, first_reply?}`) and is
 * what the workflow's link-placement check (x-craft.md §5: "post the idea
 * clean and put the link in the first reply") actually inspects.
 *
 * 2026-09 (x-craft@5): `thread` restores SKILL.md's `parts?` — the
 * continuation posts of a thread, each its own ≤280-character post, empty for
 * a single post. `mediaBrief` is the draft's own statement of what visual (if
 * any) the post wants, answered afterwards by the shared media resolver; a
 * client-attached image arrives BEFORE drafting as `attachedMedia` in the
 * input, and the brief is then moot.
 */
export const XPostOutputSchema = z.object({
  text: z.string().min(1),
  mainPostText: z.string().min(1),
  /** Set only when a link is relevant to this post (x-craft.md §5) — the link itself must never appear in `text`/`mainPostText`. */
  firstReplyUrl: z.string().url().optional(),
  hook: z.string().min(1),
  angle: z.string().min(1),
  lane: LaneSchema,
  targetHandle: z.string().min(1),
  /** Only meaningful when `lane === "engagement"`: the roster account this reply/quote is aimed at (x-craft.md §4, lanes.md lane 6). Not roster-validated here — see the workflow's own caps-only gap note. */
  targetPostHandle: z.string().min(1).optional(),
  /** Only meaningful when `lane === "engagement"`: the specific post URL being replied to or quoted. */
  targetPostUrl: z.string().url().optional(),
  mediaRefs: z.array(z.string()).default([]),
  /** Continuation parts 2..N of a thread, in order. Empty for a single post. Part 1 is `text`. */
  thread: z.array(z.string().min(1)).max(MAX_THREAD_PARTS - 1).default([]),
  /** What visual this post wants, if any. Omitted when the run attached media (the copy was written to it). */
  mediaBrief: MediaBriefSchema.optional(),
});
export type XPostOutput = z.infer<typeof XPostOutputSchema>;

/**
 * X-specific hook/engagement-bait phrases from x-craft.md §1 and §4 that
 * aren't already in `gate.lintPost`'s shared `DEFAULT_BANNED_PHRASES` bank
 * (checked directly against `packages/tools/karos-gates/src/lint-post.ts`:
 * "unpopular opinion:", "hot take:", and "nobody talks about" are already
 * there, so they're deliberately not repeated here). Passed locally via
 * `selfCritique.gateArgs` rather than edited into the shared file, since
 * cross-cutting gate content is another engineer's concern this batch.
 */
const X_SPECIFIC_BANNED_PHRASES = ["i'm going to say it:", "great post", "this 👇", "so true", "🧵"];

/**
 * The RFC-02 §3 pilot agent: drafts exactly one X post per run (RFC-01
 * §16.2's "one post, one run" ruling). `skillRef` resolves the full craft
 * policy (voice, hook construction, formatting, the six lanes, link
 * placement) dynamically through `runtime.promptStore` (RFC-01 §16.1) —
 * nothing here is a hardcoded prompt literal. Pinned to version "2": "1" is
 * kept frozen as the pre-lane-restoration baseline (mirroring x-agent-v2's
 * own "v1 stays in place, untouched" convention for its predecessor).
 * `allowedTools` covers the mechanical render check and the three content
 * gates; `gate.lintPost` also runs as this agent's own self-critique, bounded
 * to one revision. `gateArgs: {platform: "x", bannedPhrases: [...]}` pins the
 * 280-character limit explicitly (the draft object handed to self-critique is
 * the model's raw turn output, before `outputSchema` defaults ever apply, so
 * leaving `platform` for the model to supply would silently fall back to
 * `gate.lintPost`'s generic 5000-character limit) and layers in the
 * X-specific banned-phrase additions on top of the shared bank.
 */
export class XDraftAgent extends BaseAgent<XPostOutput> {
  protected readonly config: AgentStepConfig<XPostOutput> = {
    id: "x-draft",
    description: "Draft a single X post (optionally with thread parts) for the selected candidate topic, lane, content mode and angle, and state what visual it wants.",
    allowedTools: ["render.preview", "gate.lintPost", "gate.numbersSourced", "gate.brandCompliance"],
    outputSchema: XPostOutputSchema,
    // Pinned — RFC-02 §3: claude-sonnet-4-6 today, claude-sonnet-5 is an
    // equally acceptable pin once available; never a fallback for a pinned step.
    // This is the client-facing copy step: it keeps Claude for voice while the
    // trend scout and vision steps around it run on Gemini Flash. Studio can
    // move it per run (stageModels["x-draft"]); `contentLanguageSensitive`
    // lets a non-English client's brand kit re-point it per client (AU34).
    modelPolicy: resolveModelPolicy("x-draft", { policy: "pinned", model: "claude-sonnet-4-6", contentLanguageSensitive: true }),
    // Pinned to "3": v3 adds a language check to §3 (Voice) against
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
    // Pinned to "5" (2026-09): v5 is the elite-tier rewrite. The draft now
    // receives the RESEARCH itself (`research`: every fetched source's title,
    // url, date, excerpt — until now it got a headline), a scouted trend
    // candidate with its brand-fit bridge, a content mode (hot news / deep
    // value / open discussion) to write in, and any client-attached media
    // described by a vision model. It may write a thread when the material
    // earns one, must state a `mediaBrief` (screenshots and data over
    // illustration, "none" is a valid answer), and carries the machine-
    // writing tells to avoid. v4 stays frozen.
    skillRef: "x-craft@5",
    selfCritique: {
      gateTool: "gate.lintPost",
      maxRevisions: 1,
      gateArgs: { platform: "x", bannedPhrases: X_SPECIFIC_BANNED_PHRASES },
    },
  };
}
