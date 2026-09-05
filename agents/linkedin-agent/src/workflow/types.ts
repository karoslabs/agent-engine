import type { ContentMode, SocialMediaStatus, TrendCandidate } from "@agent-engine/workflow";

export interface LinkedInIntakeConfig {
  /** Subjects this client does not engage with, carried from the intake read so the terminal guardrail needs no second one. */
  forbiddenTopics: string[];
  profile: Record<string, unknown>;
  voiceRules: Record<string, unknown>;
  /** An explicit content-mode request for this run (`hot-news` / `deep-value` / `open-discussion`). Anything else is ignored and the rotation decides. */
  requestedMode?: string;
  /** The client's standing research questions for trend scouting (`client/config.json` -> `trendQueries`). Optional; the industry defaults always run. */
  trendQueries?: string[];
  /** `"always"` lets a fresh, high-brand-fit trend take the slot over a planned catalog row; default `"fallback"` runs the scout only when the catalog is empty. */
  trendJacking: "fallback" | "always";
}

/** The two posting identities the legacy system supported (RFC-01 §9's "two-paths" design) — which voice a run drafts in. */
export type LinkedInIdentityScope = "company" | "executive";

/**
 * The restored archetype/lane menu (Phase 2.5 Batch 2.2), sourced from
 * `products/live/linkedin-agent/references/linkedin-voice-by-industry.md`'s
 * "11 founder archetypes" (SKILL.md's own index names that file as the
 * canonical source for exactly this list) — the founder-led rotation that
 * replaces the pre-restoration boolean `hasNumericInsight ? "data-point" :
 * "thought-leadership"` angle. Naming follows that file's eleven numbered
 * entries directly: build-in-public/progress update, lesson learned
 * (failure → insight), contrarian/POV, origin story, milestone/launch,
 * the "here's how we did X" teardown, hiring/culture, customer/win story,
 * industry react, personal vulnerability, and community question.
 */
export const LINKEDIN_ARCHETYPES = [
  "build-in-public",
  "lesson-learned",
  "contrarian-take",
  "origin-story",
  "milestone-launch",
  "teardown-framework",
  "hiring-culture",
  "customer-story",
  "industry-reaction",
  "vulnerability-admission",
  "community-question",
] as const;
export type LinkedInArchetype = (typeof LINKEDIN_ARCHETYPES)[number];

/**
 * Which archetypes carry each content mode (2026-09). The mode is the KIND
 * of post the rotation wants this week — hot news, deep value, open
 * discussion — and the archetype is the founder-led shape it takes. Every one
 * of the eleven archetypes belongs to a mode, so the rotation still reaches
 * all of them over time; the mode only decides which family this run draws
 * from. A preference, not a wall: an explicit `requestedArchetype` still wins,
 * and the never-repeat rule still applies inside the family.
 */
export const ARCHETYPES_FOR_MODE: Record<ContentMode, readonly LinkedInArchetype[]> = {
  "hot-news": ["industry-reaction", "contrarian-take"],
  "deep-value": ["teardown-framework", "lesson-learned", "customer-story", "build-in-public", "milestone-launch", "origin-story"],
  "open-discussion": ["community-question", "contrarian-take", "vulnerability-admission", "hiring-culture"],
};

export interface LinkedInCompanyIdentity {
  scope: "company";
}

export interface LinkedInExecutiveIdentity {
  scope: "executive";
  executiveName: string;
  executiveTitle?: string;
  /**
   * The mined-CV "lens" narrative (`founder-persona-spec.md` §2) — what
   * prior companies actually did, this executive's role there, and the
   * earned point of view it gives them. Free text, not structured, since the
   * whole point is the throughline prose a model can draw credibility from.
   */
  careerHistory?: string;
  /** The 3-5 earned pillars (`founder-persona-spec.md` §3) this executive can post on with authority because of `careerHistory`. */
  corePillars?: string[];
  /** Topics that would read as borrowed credibility for this executive — the earned-claim gate's hard "do not post" list (`founder-persona-spec.md` §3). A draft that strays here is not earned, not just off-brand. */
  offLimitsTopics?: string[];
  /** This executive's own personal voice/tone (`founder-persona-spec.md` §4) — deliberately distinct from the company's own `voiceRules.tone`; a founder post is not a press release wearing a first-person disguise. */
  voiceTone?: string;
}

export type LinkedInIdentity = LinkedInCompanyIdentity | LinkedInExecutiveIdentity;

export interface LinkedInClientContext {
  profile: Record<string, unknown>;
  brand: Record<string, unknown>;
  voiceRules: { tone?: string; forbiddenTerms?: string[]; [key: string]: unknown };
  requestedTopic?: string;
  /** A run note / standing direction request naming the archetype directly (`lanes.md` §2's style-choice rule #1: "the customer's request wins"). Takes precedence over the rotation below, even over a repeat of the last post's archetype. */
  requestedArchetype?: LinkedInArchetype;
  identity: LinkedInIdentity;
  /**
   * The setup document for whoever this run posts as — the company page's
   * standing direction, or that seat's own intake.
   *
   * Per identity, not per client, because that is what the document
   * describes: the company page and each executive seat have their own
   * charter, and merging them would let a seat post the company's material in
   * the company's framing under a personal name.
   *
   * `null` when no document exists, which is an ordinary state.
   */
  strategy: string | null;
}

export interface LinkedInCandidateSummary {
  candidateTopic?: string;
  hasNumericInsight: boolean;
  sourceLabel: string;
}

export interface LinkedInTopicReservation {
  reservationKey?: string;
  topics: string[];
}

/** `trend`: the scout's on-brand candidate took the slot (2026-09). */
export type LinkedInCandidateSource = "requested" | "reserved" | "trend" | "research";

export interface LinkedInSelectedCandidate {
  topic: string;
  source: LinkedInCandidateSource;
  /** Present when `source === "trend"`: the scouted candidate, with its angle, hook, why-now and brand-fit bridge. */
  trend?: TrendCandidate;
}

/** Step 07b's output: the content mode this run writes in, and the prior run's, for the trace. */
export interface LinkedInContentModeSelection {
  mode: ContentMode;
  source: "requested" | "rotation";
  priorMode?: ContentMode;
}

/** What step 03 hands forward: the raw decision summaries (unchanged, still used to exclude recently-covered topics) plus the most recent run's archetype, if one can be parsed back out of its summary. */
export interface LinkedInDecisionsShelf {
  summaries: string[];
  lastArchetype?: LinkedInArchetype;
}

export type LinkedInArchetypeSource = "requested" | "rotation";

/** Step 08's output: the archetype this run will draft in, how it was picked, and (for testability) what the immediately-prior run's archetype was, if any. */
export interface LinkedInArchetypeSelection {
  archetype: LinkedInArchetype;
  source: LinkedInArchetypeSource;
  priorArchetype?: LinkedInArchetype;
  /** The content mode whose archetype family the rotation drew from. */
  mode: ContentMode;
}

export interface LinkedInAgentWorkflowResult {
  topic: string;
  archetype: LinkedInArchetype;
  /** hot-news / deep-value / open-discussion — the kind of post this run produced. */
  contentMode: ContentMode;
  targetAudience: string;
  /** The one line the reader should remember. */
  takeaway: string;
  deliverableId: string;
  /** attached / screenshot / harvested / stock / generated / none — where the post's visual came from, if anywhere. */
  mediaStatus: SocialMediaStatus;
  /** Formatting findings the reflow could not fix, for the reviewer. Empty when the shape is clean. */
  formattingNotes: string[];
  /**
   * What the inline channel-setup pre-flight decided (step `00a`).
   *
   * On the result rather than only in the step trace because it changes how the
   * post should be read: `not-supplied` means this client has no LinkedIn
   * charter and the draft is in the house voice rather than a chartered one,
   * which a reviewer approving it deserves to know without opening the run.
   */
  channelSetup: "already-configured" | "recorded" | "not-supplied";
  /**
   * The same post text this run's own `15-batch-review` gate showed a human
   * (or would have, had `autoApprove` not skipped it) — i.e. `draft.text`.
   *
   * Added for SCRUM-302/AU18: campaign-orchestrator runs every channel with
   * `autoApprove: true` and needs something to put in front of its own single
   * campaign-review gate in place of the five per-channel gates it bypassed.
   * A standalone caller that already got a real per-channel gate can ignore
   * this field.
   */
  preview: string;
}
