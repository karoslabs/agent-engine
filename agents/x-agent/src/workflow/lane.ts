import type { ContentMode } from "@agent-engine/workflow";
import { LANE_VALUES, type Lane } from "../agent/x-draft-agent.js";
import type { XRecentDecision } from "./types.js";

export const LANE_LIST: readonly Lane[] = LANE_VALUES;

/**
 * Simplified, blended default weights approximating lanes.md's "The default
 * mix, per run" table. lanes.md weights are per-*identity* (company page:
 * knowledge 60% / build-in-public 20% / news-reaction 20%; a seat: POV 60% /
 * quote-comment 20% / news-reaction 20%) because a real batch run belongs to
 * one identity drawing from its own subset of lanes. This pilot agent has no
 * identity/seat concept at all — one `xHandle` per run, one post per run — so
 * there is no per-identity batch to split weights across. These numbers
 * blend both identities' tables into a single ranking (knowledge and POV
 * both stay the two "weighted by default" lanes per lanes.md §2/§3; engagement
 * is weighted lowest since lanes.md itself says it "sits OUTSIDE the drafting
 * batch" with "no executor in v2 by design" — folding it into this rotation
 * at all is already a simplification past what legacy does). Not lanes.md's
 * exact percentages — a documented approximation only, used as a fallback
 * tie-breaker, never as a real probability draw.
 */
export const LANE_WEIGHT: Record<Lane, number> = {
  knowledge: 30,
  pov: 30,
  "build-in-public": 15,
  "news-reaction": 15,
  "quote-comment": 7,
  engagement: 3,
};

/** The daily cap on engagement-lane posts (x-craft.md §4: "defaults... 5 actions/day"). Per-account caps (1 reply/account/day) aren't enforced here — see the workflow's own gap note, since there is no roster/account model to check against yet. */
export const ENGAGEMENT_DAILY_CAP = 5;
export const ENGAGEMENT_CAP_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Which lanes carry each content mode (2026-09 upgrade). The mode is the
 * KIND of post the rotation wants this week; the lane is x-craft's own
 * voice-and-content shape. A hot-news week wants a reaction or a quote of the
 * source; a deep-value week wants the knowledge lane (or the client's own
 * build); an open-discussion week wants a take the audience can argue with.
 *
 * A preference, not a wall: `selectLane` still honours an explicit request
 * and still never repeats the prior lane, and falls back to the whole menu
 * when every preferred lane is the one just used.
 */
export const LANES_FOR_MODE: Record<ContentMode, readonly Lane[]> = {
  "hot-news": ["news-reaction", "quote-comment"],
  "deep-value": ["knowledge", "build-in-public"],
  "open-discussion": ["pov", "quote-comment"],
};

function isLane(value: string): value is Lane {
  return (LANE_LIST as readonly string[]).includes(value);
}

/**
 * `memory.appendDecision`'s `summary` is the only place lane information
 * survives across runs — `AppendDecisionInputSchema` has no `lane` field of
 * its own (RFC-01 §9.1 rule 1's tenant-only-via-ctx pattern extends to zod
 * stripping any other unrecognized key), so step 20 embeds it as
 * `(lane: <value>)` inside the free-text summary and this is the matching
 * parser. A documented approximation, not a real structured field.
 */
export function parseLaneFromSummary(summary: string): Lane | undefined {
  const match = /\(lane: ([a-z-]+)/.exec(summary);
  const candidate = match?.[1];
  return candidate !== undefined && isLane(candidate) ? candidate : undefined;
}

/**
 * The lane selector (lanes.md's "Choose the batch" step, folded down to a
 * single slot since this agent drafts one post per run):
 *
 * 1. **An explicit `requestedLane` wins** (lanes.md: "the customer's run
 *    request wins").
 * 2. Otherwise, **never repeat the immediately-prior recorded decision's
 *    lane** ("never same lane twice in a row"), and among the rest pick the
 *    least-recently-used lane (by total appearances in `recentDecisions`),
 *    tie-broken by `LANE_WEIGHT` descending. This is a deterministic stand-in
 *    for lanes.md's weighted-random default mix — real weighted variety
 *    across a whole batch isn't meaningful for a one-post-per-run agent, so
 *    "spread usage out over time, weighted toward the default-favored lanes"
 *    is the closest honest analogue.
 * 3. **`preferred`** (the content mode's lanes, 2026-09) narrows step 2 to
 *    those lanes when at least one of them is not the prior lane; otherwise
 *    the whole menu applies as before.
 */
export function selectLane(requestedLane: string | undefined, recentDecisions: readonly XRecentDecision[], preferred?: readonly Lane[]): Lane {
  if (requestedLane !== undefined && isLane(requestedLane)) {
    return requestedLane;
  }

  const dated = recentDecisions
    .map((d) => ({ at: typeof d.at === "number" ? d.at : 0, lane: parseLaneFromSummary(d.summary) }))
    .filter((d): d is { at: number; lane: Lane } => d.lane !== undefined);

  const priorLane = dated.slice().sort((a, b) => a.at - b.at).at(-1)?.lane;

  const usageCount: Record<Lane, number> = {
    "build-in-public": 0,
    knowledge: 0,
    pov: 0,
    "news-reaction": 0,
    "quote-comment": 0,
    engagement: 0,
  };
  for (const d of dated) usageCount[d.lane]++;

  const everything = LANE_LIST.filter((lane) => lane !== priorLane);
  const narrowed = preferred !== undefined ? everything.filter((lane) => preferred.includes(lane)) : [];
  const candidates = narrowed.length > 0 ? narrowed : everything;
  const ranked = candidates.slice().sort((a, b) => {
    const byUsage = usageCount[a] - usageCount[b];
    if (byUsage !== 0) return byUsage;
    return LANE_WEIGHT[b] - LANE_WEIGHT[a];
  });

  return ranked[0] ?? LANE_LIST[0]!;
}

/** Counts engagement-lane decisions recorded within `windowMs` of `now` — the mechanical half of the engagement lane's daily cap (x-craft.md §4). */
export function countRecentEngagementPosts(
  recentDecisions: readonly XRecentDecision[],
  now: number,
  windowMs: number = ENGAGEMENT_CAP_WINDOW_MS,
): number {
  return recentDecisions.filter((d) => {
    if (typeof d.at !== "number") return false;
    if (now - d.at > windowMs) return false;
    return parseLaneFromSummary(d.summary) === "engagement";
  }).length;
}
