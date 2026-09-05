import { z } from "zod";
import { DynamicAgent, resolveModelPolicy, type AgentContext, type AgentToolRegistry, type ModelRouter, type PromptStore } from "@agent-engine/core";
import type { WorkflowContext } from "./context.js";
import { WorkflowToolingFailure } from "./signals.js";
import { researchDigestForDrafting, type ResearchCandidateDocument, type ResearchDigestEntry, type ResearchPullResult } from "./research-candidate.js";

/**
 * Trend scouting and the content-mode mix, shared by the social channel agents.
 *
 * ## What was wrong
 *
 * Every social agent's research step ran ONE query — `${industry} trends this
 * week` — and the candidate step picked the first headline with a number in
 * it. No judgment was applied to whether the story had anything to do with the
 * client, no distinction was drawn between a launch that happened this morning
 * and an evergreen explainer, and nothing rotated between the kinds of post an
 * account needs to publish to read as a person rather than a feed. A Hebrew
 * tech outlet got "B2B SaaS thought leadership trends this week" and a post
 * about whatever ranked first.
 *
 * ## What this does
 *
 * 1. `buildTrendQueries` widens the research to the questions a strategist
 *    would actually ask: what happened in the client's field this week, which
 *    launches/deals/reports landed, what the client itself is in the news for,
 *    plus any standing `trendQueries` the client configured (a tech outlet can
 *    name "OpenAI new model" and "Israeli startup exit" once).
 * 2. `pullTrendResearch` runs them through `research.pull` (cached, egress-
 *    bound, one step) and merges the documents by URL.
 * 3. `runTrendScout` asks a model to turn those documents into a SHORT LIST of
 *    grounded candidates, each scored for brand fit (1-5, with the bridge to
 *    the client stated) and tagged with the content mode it suits.
 * 4. `selectContentMode` rotates the account across hot news, deep value and
 *    open discussion, never the same mode twice in a row, and
 *    `selectTrendCandidate` picks the strongest on-brand candidate for it.
 *
 * The scout is a `DynamicAgent` with an inline system prompt, on the same
 * footing as the topic guardrail: it is shared by three agents and owned by
 * none, so it has no home in any one agent's prompt directory. Its model is
 * Gemini 2.5 Flash on Vertex by default — this step READS a pile of documents
 * and ranks them, which wants breadth and a large window more than voice; the
 * client-facing copy step keeps its pinned Claude model. Retargetable per
 * deployment through `MODEL_STEP_SOCIAL_TREND_SCOUT_VENDOR/_MODEL`, and per run
 * through Studio's `stageModels["social-trend-scout"]`.
 *
 * Everything degrades: no documents means no scout call, a scout that fails
 * or returns nothing means the caller falls back to `extractResearchCandidate`,
 * exactly as before this file existed. A trend is an upgrade, never a blocker.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Content modes — the mix an account rotates through
// ─────────────────────────────────────────────────────────────────────────────

export const CONTENT_MODES = ["hot-news", "deep-value", "open-discussion"] as const;
export const ContentModeSchema = z.enum(CONTENT_MODES);
export type ContentMode = z.infer<typeof ContentModeSchema>;

/**
 * The default mix, as a tie-breaker when usage counts are level. Deep value
 * leads because it is the kind of post that earns follows from strangers;
 * hot news is the freshness anchor; open discussion is the rarest because a
 * question with nothing behind it is bait.
 */
export const CONTENT_MODE_WEIGHT: Record<ContentMode, number> = {
  "deep-value": 40,
  "hot-news": 35,
  "open-discussion": 25,
};

export function isContentMode(value: unknown): value is ContentMode {
  return typeof value === "string" && (CONTENT_MODES as readonly string[]).includes(value);
}

/** Pulls `(mode: hot-news)` back out of a recorded decision summary — the only place the mode survives across runs, like the X lane. */
export function parseContentModeFromSummary(summary: string): ContentMode | undefined {
  // `mode:` sits after the lane and angle inside the same parenthesis, so it is
  // matched wherever it appears rather than as the first key of the group.
  const match = /mode: ([a-z-]+)/.exec(summary);
  const candidate = match?.[1];
  return isContentMode(candidate) ? candidate : undefined;
}

/**
 * Picks this run's content mode.
 *
 * An explicit request wins. Otherwise: never the immediately-prior mode, then
 * the least-used mode across the recent window, tie-broken by
 * `CONTENT_MODE_WEIGHT`. `recentModes` is oldest-first; the caller derives it
 * from its own decision log so this stays a pure function.
 */
export function selectContentMode(recentModes: readonly ContentMode[], requested?: string): ContentMode {
  if (isContentMode(requested)) return requested;
  const prior = recentModes.at(-1);
  const usage: Record<ContentMode, number> = { "hot-news": 0, "deep-value": 0, "open-discussion": 0 };
  for (const mode of recentModes) usage[mode]++;
  const ranked = CONTENT_MODES.filter((mode) => mode !== prior)
    .slice()
    .sort((a, b) => {
      const byUsage = usage[a] - usage[b];
      if (byUsage !== 0) return byUsage;
      return CONTENT_MODE_WEIGHT[b] - CONTENT_MODE_WEIGHT[a];
    });
  return ranked[0] ?? "deep-value";
}

// ─────────────────────────────────────────────────────────────────────────────
// Research queries
// ─────────────────────────────────────────────────────────────────────────────

export interface TrendQueryInput {
  industry?: string | undefined;
  companyName?: string | undefined;
  /** The client's own standing queries (`client/config.json` → `trendQueries`), e.g. "OpenAI new model", "Israeli startup exit". */
  configuredQueries?: readonly string[] | undefined;
  /** A subject someone requested for this run; researched alongside the field so the draft has sources for it. */
  requestedTopic?: string | undefined;
}

/** How many queries one run may spend on. Each is a cached scrape; four keeps a run under one research call per mode. */
export const MAX_TREND_QUERIES = 4;

/**
 * The research questions for one run, most specific first, de-duplicated,
 * capped at `MAX_TREND_QUERIES`. Returns `[]` only when there is nothing to
 * ask about at all (no industry, no company, no request, no configured
 * queries) — the caller's existing "no subject" handling applies then.
 */
export function buildTrendQueries(input: TrendQueryInput): string[] {
  const queries: string[] = [];
  const push = (q: string | undefined) => {
    const trimmed = q?.trim();
    if (trimmed && !queries.some((existing) => existing.toLowerCase() === trimmed.toLowerCase())) queries.push(trimmed);
  };
  push(input.requestedTopic);
  for (const q of input.configuredQueries ?? []) push(q);
  if (input.industry) {
    push(`${input.industry} news this week`);
    push(`${input.industry} launch announcement funding acquisition report`);
  }
  if (input.companyName) push(`"${input.companyName}" news`);
  return queries.slice(0, MAX_TREND_QUERIES);
}

export interface TrendResearch {
  /** Every query actually run, in order, with whether it answered. */
  queries: Array<{ query: string; status: string; documents: number; fromCache: boolean }>;
  /** Every `research.pull` result that succeeded, verbatim. */
  pulls: ResearchPullResult[];
  /** One pull-shaped payload with every document merged and de-duplicated by URL — what the scout and the drafting digest read. */
  merged: ResearchPullResult;
}

/**
 * Runs every query through `research.pull` and merges the answers.
 *
 * ONE code step, so the trace shows one research step as before, and a
 * resumed run reuses every query's result. A single failing query is
 * recorded and skipped; the pull only fails as a whole when EVERY query
 * failed with a tooling problem, which is the outage case the old single
 * query also failed on.
 */
export async function pullTrendResearch(
  wf: WorkflowContext,
  tools: AgentToolRegistry,
  ctx: AgentContext,
  options: {
    stepId: string;
    job: string;
    queries: readonly string[];
    window: string;
    historyAgentId: string;
    maxResultsPerQuery?: number;
  },
): Promise<TrendResearch> {
  return wf.step.code(options.stepId, async (): Promise<TrendResearch> => {
    const pull = tools["research.pull"];
    if (!pull) throw new Error(`${options.stepId}: research.pull is not registered`);
    const queries: TrendResearch["queries"] = [];
    const pulls: ResearchPullResult[] = [];
    let lastFailure: string | undefined;
    for (const query of options.queries) {
      const outcome = await pull.execute(
        {
          job: options.job,
          query,
          window: options.window,
          historyAgentId: options.historyAgentId,
          ...(options.maxResultsPerQuery !== undefined ? { maxResults: options.maxResultsPerQuery } : {}),
        },
        { ctx },
      );
      if (outcome.status !== "success") {
        lastFailure = `${outcome.status}${"reason" in outcome ? `: ${outcome.reason}` : ""}`;
        queries.push({ query, status: outcome.status, documents: 0, fromCache: false });
        continue;
      }
      const result = outcome.result as ResearchPullResult;
      pulls.push(result);
      queries.push({ query, status: "success", documents: result.result?.documents?.length ?? 0, fromCache: result.fromCache });
    }
    if (pulls.length === 0) {
      // The same signal the old single-query step threw from inside its own
      // step: an outage is tooling, never "the topic had nothing to say".
      throw new WorkflowToolingFailure(`research.pull failed for every query (${lastFailure ?? "no queries"})`);
    }
    return { queries, pulls, merged: mergeResearchPulls(pulls) };
  });
}

/** Merges several pulls into one payload, de-duplicating documents by URL (then by title) and keeping the first occurrence. */
export function mergeResearchPulls(pulls: readonly ResearchPullResult[]): ResearchPullResult {
  const seen = new Set<string>();
  const documents: ResearchCandidateDocument[] = [];
  const priorTopics: string[] = [];
  for (const pull of pulls) {
    for (const d of pull.result?.documents ?? []) {
      const key = (d.url ?? "").trim().toLowerCase() || (d.title ?? "").trim().toLowerCase();
      if (key.length === 0 || seen.has(key)) continue;
      seen.add(key);
      documents.push(d);
    }
    for (const t of pull.result?.history?.priorTopics ?? []) if (!priorTopics.includes(t)) priorTopics.push(t);
  }
  const first = pulls[0];
  return {
    runId: pulls.map((p) => p.runId).join("+"),
    // The FIRST query, which `buildTrendQueries` orders most-specific-first:
    // `extractResearchCandidate` falls back to `query` as the topic when the
    // search returned nothing, and a topic reading "a | b | c" is not a topic.
    query: first?.query ?? "",
    fromCache: pulls.every((p) => p.fromCache),
    result: {
      ...(first?.result?.provider !== undefined ? { provider: first.result.provider } : {}),
      documents,
      history: { priorTopics },
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The scout
// ─────────────────────────────────────────────────────────────────────────────

export const TREND_SCOUT_STEP_ID = "social-trend-scout";

export const MEDIA_HINTS = ["screenshot", "photo", "data", "none"] as const;

export const TrendCandidateSchema = z.object({
  /** A short subject line, the thing the post is about. */
  topic: z.string().min(1),
  /** The source headline or event, as the source phrased it. */
  headline: z.string().min(1),
  mode: ContentModeSchema,
  /** 1 (no honest connection to the client) to 5 (the client's core domain, and its audience would expect it to speak). */
  brandFit: z.number().int().min(1).max(5),
  /** The bridge: why this client, specifically, has standing to post about this. */
  brandFitReason: z.string().min(1),
  /** The client's take, distinct from the headline. */
  angle: z.string().min(1),
  /** A first line that could open the post. */
  hook: z.string().min(1),
  /** Why this week and not any week. */
  whyNow: z.string().min(1),
  sourceUrls: z.array(z.string()).default([]),
  publishedAt: z.string().optional(),
  /** Whether the sources carry a figure a draft could cite. */
  hasNumbers: z.boolean().default(false),
  /** What picture, if any, would carry this: a screenshot of the source, a real photo, a data visual, or nothing. */
  mediaHint: z.enum(MEDIA_HINTS).default("none"),
});
export type TrendCandidate = z.infer<typeof TrendCandidateSchema>;

export const TrendScoutOutputSchema = z.object({
  candidates: z.array(TrendCandidateSchema).max(10),
  /** Stories considered and dropped, with the reason — so a reviewer can see what was NOT posted about and why. */
  skipped: z.array(z.object({ headline: z.string().min(1), reason: z.string().min(1) })).default([]),
  notes: z.string().optional(),
});
export type TrendScoutOutput = z.infer<typeof TrendScoutOutputSchema>;

export interface TrendScoutInput {
  /** `researchDigestForDrafting(merged)` — the documents, shaped for a prompt. */
  research: readonly ResearchDigestEntry[];
  channel: "x" | "linkedin" | "instagram";
  clientProfile: Record<string, unknown>;
  clientIntelContext?: string | undefined;
  clientVoiceContext?: string | undefined;
  /** What the client recently published — the scout must not propose it again. */
  recentPosts?: string | undefined;
  forbiddenTopics: readonly string[];
  requestedTopic?: string | undefined;
  /** ISO date the scout should treat as "now", for freshness judgments. */
  today: string;
}

export interface TrendScoutDeps {
  tools: AgentToolRegistry;
  promptStore: PromptStore;
  router: ModelRouter;
}

const CHANNEL_NOTE: Record<TrendScoutInput["channel"], string> = {
  x: "The channel is X: fast, sharp, reactive. Hot news lands best within 24-48 hours; a screenshot or a data point beats an illustration.",
  linkedin: "The channel is LinkedIn: professional readers, a slower clock (a story stays fresh for about a week), and a post needs a clear takeaway for the reader's own work.",
  instagram: "The channel is Instagram: visual first. A candidate needs a subject that can be pictured or set as bold type, and a story with a human stake.",
};

/** The scout's system prompt. Inline for the same reason the topic guardrail's is — shared by three agents, owned by none. */
export function buildTrendScoutSystemPrompt(channel: TrendScoutInput["channel"]): string {
  return [
    "You are a content strategist scouting this week's stories for ONE client's social account.",
    "You are given research documents the engine actually fetched (title, url, date, excerpt), the client's own profile and knowledge, what they recently published, and the topics they never touch.",
    "",
    CHANNEL_NOTE[channel],
    "",
    "Produce 3 to 8 candidates. Every candidate must be grounded in the documents you were given: never invent a trend, a launch, a number or a date, and list the source URLs the candidate rests on. Never invent — an unsupported claim here becomes a false statement in the client's feed.",
    "",
    "BRAND FIT is the judgment that matters most. Score 1-5 and state the bridge in one sentence:",
    "  5 — the client's core domain; their audience would expect them to have a view.",
    "  4 — adjacent to the core, with a specific, honest angle only this client can take.",
    "  3 — a real connection, but the bridge takes a sentence to explain. Acceptable only when nothing scores higher.",
    "  2 or 1 — no genuine connection. Put these under `skipped` with the reason; do not manufacture a bridge.",
    "A story about a famous company is not on-brand just because it is famous. A story IS on-brand when it touches what the client sells, who they sell to, or the field they publish about.",
    "",
    "MODE. Tag each candidate with the kind of post it suits:",
    "  hot-news — a dated event from the last days: a launch, a funding round, an acquisition, a report, a regulation. Fresh or not at all; read the dates.",
    "  deep-value — a durable, useful insight the documents support: how something works, what a number means, what practitioners get wrong.",
    "  open-discussion — a genuine, specific question the client's audience would argue about, with the client's own position stated.",
    "Offer at least one candidate per mode when the material honestly allows it. Never force a mode the documents do not support.",
    "",
    "For each candidate also write: `angle` (the client's take, not the headline restated), `hook` (a first line a stranger would stop for, in the client's language — read `clientVoiceContext` for a stated or implied language and write hooks in it), `whyNow`, `hasNumbers` (true only when the excerpt carries a citable figure), and `mediaHint`: screenshot (the source page itself is the visual), photo (a real, photographable subject), data (a chart or figure), or none.",
    "",
    "Never propose anything under `forbiddenTopics`, and never propose a subject, angle or hook that overlaps `recentPosts` — saying the same thing in different words is a repeat.",
    "Answer with the structured output only.",
  ].join("\n");
}

/**
 * One scout call, checkpointed under `stepId`. Returns `undefined` when there
 * was nothing to scout (no documents) or the model step did not complete —
 * the caller falls back to `extractResearchCandidate`, exactly as before.
 */
export async function runTrendScout(
  wf: WorkflowContext,
  deps: TrendScoutDeps,
  stepId: string,
  input: TrendScoutInput,
): Promise<TrendScoutOutput | undefined> {
  if (input.research.length === 0) return undefined;
  const scout = new DynamicAgent<TrendScoutOutput>(
    { tools: deps.tools, router: deps.router, promptStore: deps.promptStore },
    {
      id: TREND_SCOUT_STEP_ID,
      description: "Propose 3-8 grounded, brand-fit-scored story candidates for this client's channel from the fetched research, tagged by content mode.",
      // No tools: the research call happened in code, cached and bounded, and a
      // scout that could fetch more would wander off the evidence it was given.
      allowedTools: [],
      outputSchema: TrendScoutOutputSchema,
      // Pinned, never a silent substitute — but on Gemini 2.5 Flash via Vertex:
      // this step reads documents and ranks them, a breadth-and-window job, and
      // it costs a fraction of the copy step it feeds. A deployment moves it with
      // MODEL_STEP_SOCIAL_TREND_SCOUT_VENDOR/_MODEL; Studio per run via stageModels.
      modelPolicy: resolveScoutPolicy(),
      maxSteps: 1,
    },
    buildTrendScoutSystemPrompt(input.channel),
  );
  const exec = await wf.step.agent(stepId, scout, {
    channel: input.channel,
    today: input.today,
    clientProfile: input.clientProfile,
    ...(input.clientIntelContext !== undefined ? { clientIntelContext: input.clientIntelContext } : {}),
    ...(input.clientVoiceContext !== undefined ? { clientVoiceContext: input.clientVoiceContext } : {}),
    ...(input.recentPosts !== undefined ? { recentPosts: input.recentPosts } : {}),
    ...(input.requestedTopic !== undefined ? { requestedTopic: input.requestedTopic } : {}),
    forbiddenTopics: [...input.forbiddenTopics],
    research: input.research,
  });
  if (exec.status !== "completed" || !exec.finalOutput) return undefined;
  return exec.finalOutput;
}

/** The scout's model policy, resolved through the same env override every hand-written agent uses. */
function resolveScoutPolicy() {
  return resolveModelPolicy(TREND_SCOUT_STEP_ID, { policy: "pinned", model: "gemini-2.5-flash", vendor: "gemini" });
}

// ─────────────────────────────────────────────────────────────────────────────
// Selection
// ─────────────────────────────────────────────────────────────────────────────

/** Below this, a candidate is not on-brand enough to post about at all. */
export const MIN_BRAND_FIT = 3;

export interface SelectTrendOptions {
  minBrandFit?: number;
  /** Subjects already covered; a candidate whose topic or headline overlaps is skipped. */
  avoidTopics?: readonly string[];
}

function overlaps(text: string, avoid: readonly string[]): boolean {
  const t = text.trim().toLowerCase();
  if (t.length === 0) return false;
  return avoid.some((a) => {
    const v = a.trim().toLowerCase();
    return v.length > 0 && (t.includes(v) || v.includes(t));
  });
}

/**
 * The strongest on-brand candidate for a mode.
 *
 * Preference: candidates in the requested mode, then any mode (the rotation is
 * a steer, not a wall — a week with one story worth posting about should post
 * about it). Within a group: brand fit, then a citable number, then the more
 * recent date. Returns `undefined` when nothing clears `minBrandFit`, which
 * the caller treats as "the scout found nothing on-brand this week".
 */
export function selectTrendCandidate(candidates: readonly TrendCandidate[], mode: ContentMode, options: SelectTrendOptions = {}): TrendCandidate | undefined {
  const minFit = options.minBrandFit ?? MIN_BRAND_FIT;
  const avoid = options.avoidTopics ?? [];
  const eligible = candidates.filter((c) => c.brandFit >= minFit && !overlaps(c.topic, avoid) && !overlaps(c.headline, avoid));
  const rank = (a: TrendCandidate, b: TrendCandidate) => {
    if (b.brandFit !== a.brandFit) return b.brandFit - a.brandFit;
    if (a.hasNumbers !== b.hasNumbers) return a.hasNumbers ? -1 : 1;
    return (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "");
  };
  const inMode = eligible.filter((c) => c.mode === mode).sort(rank);
  if (inMode.length > 0) return inMode[0];
  return eligible.slice().sort(rank)[0];
}

/** The candidate as the drafting prompt receives it — everything the writer needs, nothing about the scoring internals. */
export function trendCandidateForDrafting(candidate: TrendCandidate): Record<string, unknown> {
  return {
    topic: candidate.topic,
    headline: candidate.headline,
    mode: candidate.mode,
    angle: candidate.angle,
    hook: candidate.hook,
    whyNow: candidate.whyNow,
    brandFitReason: candidate.brandFitReason,
    sourceUrls: candidate.sourceUrls,
    ...(candidate.publishedAt !== undefined ? { publishedAt: candidate.publishedAt } : {}),
    mediaHint: candidate.mediaHint,
  };
}

/** The digest the scout reads: the merged documents, more of them and shorter than the drafting digest. */
export function researchDigestForScout(merged: ResearchPullResult): ResearchDigestEntry[] {
  return researchDigestForDrafting(merged, { maxDocuments: 16, maxExcerptChars: 1_200 }) ?? [];
}
