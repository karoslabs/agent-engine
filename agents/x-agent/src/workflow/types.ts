import type { ContentMode, SocialMediaStatus, TrendCandidate } from "@agent-engine/workflow";

/** The subset of `client.getConfig()`'s free-form config this workflow actually depends on. */
export interface XIntakeConfig {
  xHandle: string;
  /**
   * Subjects this account does not engage with, carried from the same config
   * read that produced `xHandle` so the terminal guardrail does not have to
   * read it a second time and add a step to every run's trace.
   */
  forbiddenTopics: string[];
  /**
   * Which setup document under `strategy/x-agent/` this account posts from.
   *
   * Config rather than convention because nothing derives one from the other:
   * karoslabs runs `@getkaros` off `karos-labs.md` and `@alberree` off
   * `albert-kattan.md`. Slugifying a handle would silently pick up the wrong
   * charter, or none, and "none" is the dangerous one — the run would proceed
   * without the never-post list.
   *
   * Omitted falls back to the account-level `strategy/x-agent` document.
   */
  xStrategyKey?: string;
  requestedTopic?: string;
  /** An explicit lane request for this run (lanes.md: "the customer's run request wins"). Any of `LANE_VALUES`; anything else is ignored and the rotation fallback decides instead. */
  requestedLane?: string;
  /** An explicit content-mode request for this run (`hot-news` / `deep-value` / `open-discussion`). Anything else is ignored and the rotation decides. */
  requestedMode?: string;
  /**
   * The client's standing research questions for trend scouting — what THEY
   * want to be first to react to ("OpenAI new model", "Israeli startup exit").
   * Configured once in `client/config.json`, run every time alongside the
   * industry defaults. Optional; a client without them gets the defaults.
   */
  trendQueries?: string[];
  /**
   * Whether this account may publish threads. Default true. A client whose
   * charter is "one sharp line, never a thread" sets `xAllowThreads: false`
   * and a draft carrying thread parts is held before review.
   */
  allowThreads: boolean;
  /**
   * When `"always"`, a fresh, high-brand-fit trend may take the slot even when
   * the topics catalog has a planned row. Default `"fallback"`: the catalog's
   * planned topic wins and the scout only runs when the catalog is empty.
   */
  trendJacking: "fallback" | "always";
  [key: string]: unknown;
}

export interface XClientContext {
  profile: Record<string, unknown>;
  brand: Record<string, unknown>;
  voiceRules: { tone?: string; forbiddenTerms?: string[]; [key: string]: unknown };
  /**
   * The client's filled-in account intake for this handle — what the account
   * is chartered to be known for, and what it must never post.
   *
   * Distinct from `voiceRules`, which says how the client SOUNDS. This says
   * what this particular account is FOR, and the two are not
   * interchangeable: a brand page and a founder's seat share one voice and
   * have opposite charters, which is exactly why the lab repo keeps a
   * separate intake per account.
   *
   * `null` when the client has no setup document — a real state, not an error.
   */
  strategy: string | null;
}

/**
 * `XResearchPull`/`XResearchDocument` lived here briefly and were replaced by
 * `ResearchPullResult` in @agent-engine/workflow, which every publishing agent
 * now shares. Two definitions of the same payload is how the five copies of
 * the old extraction step drifted in the first place.
 */

export interface XCandidateSummary {
  /** A real source's headline when the search returned one; the query itself only when it returned nothing. */
  candidateTopic?: string;
  hasNumericInsight: boolean;
  /** The source URL a downstream claim can be traced to, or a labelled run id when there was no source. */
  sourceLabel: string;
}

export interface XTopicReservation {
  reservationKey?: string;
  topics: string[];
}

/**
 * A single `memory.read({scope:"decisions"})` row, widened past
 * `DecisionRecord`'s own shape to explicitly surface `at` — the append
 * timestamp `memory.appendDecision` always writes but `AppendDecisionInputSchema`
 * doesn't name as a field — since the lane rotation and the engagement daily
 * cap both need real recency, not just insertion order (`listJson` sorts by
 * filename, which is a decision id, not a timestamp).
 */
export interface XRecentDecision {
  decisionId: string;
  summary: string;
  at?: number;
  [key: string]: unknown;
}

/** `trend`: the scout's on-brand candidate took the slot (2026-09). */
export type XCandidateSource = "requested" | "reserved" | "trend" | "research";

export interface XSelectedCandidate {
  topic: string;
  source: XCandidateSource;
  /** Present when `source === "trend"`: the scouted candidate, with its angle, hook, why-now and brand-fit bridge. */
  trend?: TrendCandidate;
}

/** Step 07b's output: the content mode this run writes in, and the prior run's, for the trace. */
export interface XContentModeSelection {
  mode: ContentMode;
  source: "requested" | "rotation";
  priorMode?: ContentMode;
}

export interface XAgentWorkflowResult {
  topic: string;
  angle: string;
  lane: string;
  /** hot-news / deep-value / open-discussion — the kind of post this run produced. */
  contentMode: ContentMode;
  targetHandle: string;
  deliverableId: string;
  /** How many posts the deliverable is: 1 for a single post, 2..7 for a thread. */
  parts: number;
  /** attached / screenshot / harvested / stock / generated / none — where the post's visual came from, if anywhere. */
  mediaStatus: SocialMediaStatus;
  /**
   * The same post text this run's own `15-batch-review` gate showed a human
   * (or would have, had `autoApprove` not skipped it) — i.e. `draft.text`.
   *
   * Added for SCRUM-302/AU18: campaign-orchestrator runs every channel with
   * `autoApprove: true` and needs something to put in front of its own single
   * campaign-review gate in place of the five per-channel gates it bypassed.
   * A standalone caller that already got a real per-channel gate can ignore
   * this field; it is not new information to a human who already approved
   * the post.
   */
  preview: string;
}
