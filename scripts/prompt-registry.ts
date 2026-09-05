/**
 * SCRUM-325 (AU44) — the TYPED PROMPT REGISTRY.
 *
 * Before this file, every script that needed to know "what prompts exist"
 * walked `agents/<agent>/prompts/<promptId>/` and believed whatever it found.
 * `setup-local.ts` walked it, `publish-prompts.ts` walked it, and because a
 * walk cannot disagree with the disk it is reading, neither could ever notice
 * that something on disk was wrong. That is what let `blog-craft` and
 * `newsletter-craft` carry a `latest.md` that matched none of their numbered
 * versions for three commits: the walk simply reported what was there, and
 * `publish-prompts.ts` then SYNTHESIZED a phantom `v4` out of the drifted
 * `latest.md` and repointed `latestVersion` at it.
 *
 * A registry fixes that by being a SECOND, independent statement of the same
 * fact. `PROMPT_REGISTRY` below is hand-maintained and code-reviewed; the
 * disk is discovered separately; `diffRegistryAgainstDisk()` compares them.
 * A prompt added, removed, renumbered, re-owned or re-pointed without the
 * registry entry changing is a CI failure, and vice versa. Neither side is
 * trusted over the other — they are required to agree.
 *
 * Per-prompt hygiene lives here too (`requires`), for the same reason: a
 * guardrail sentence that a prompt is SUPPOSED to carry is only enforceable
 * if something outside the prompt says it is supposed to carry it. See
 * `HYGIENE_MARKERS` for what each flag actually looks for.
 *
 * Consumed by `scripts/check-prompts.ts` (CI) and `scripts/publish-prompts.ts`
 * (which now enumerates from here instead of from a walk).
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";

// scripts/*.ts compiles as CommonJS under the root tsconfig — see setup-local.ts's own note.
export const REPO_ROOT = path.resolve(__dirname, "..");

/**
 * Per-prompt hygiene requirements, asserted against the prompt's own text.
 *
 * Every flag defaults to FALSE. A prompt only has to carry a guardrail when
 * this registry says it does — an unconditional "every prompt must say X"
 * rule would be satisfied by all 28 prompts today and could therefore never
 * fail, which is the exact shape of defect this repo keeps finding.
 */
export interface PromptHygiene {
  /**
   * AU31's language directive: the prompt must tell the model to read
   * `clientVoiceContext` for a stated-or-implied language and draft the whole
   * deliverable in it. Required of every client-facing DRAFTING prompt.
   * `blog-craft`/`newsletter-craft`'s drifted `latest.md` had silently lost
   * exactly this sentence — a run resolving "latest" drafted in English for a
   * Hebrew-language outlet, with nothing to catch it.
   */
  readonly languageDirective?: boolean;
  /**
   * Anti-hallucination: the prompt must contain an explicit "do not invent"
   * instruction AND name `gate.numbersSourced`, the deterministic validator
   * that actually rejects an unsourced number. Prose without the gate name is
   * an unenforced request; the gate without prose makes the model guess and
   * then fail. Required of every prompt whose output carries statistics.
   */
  readonly numbersSourced?: boolean;
  /**
   * Structured output: the prompt must name the output fields the agent's zod
   * schema actually requires (see `structuredOutputFields` below) — a prompt
   * that never mentions a required field produces a schema violation at run
   * time, not a graceful degradation.
   */
  readonly structuredOutput?: boolean;
}

export interface PromptRegistryEntry {
  /** `promptId` — the directory name, and the left half of every `skillRef`. */
  readonly promptId: string;
  /** The agent package under `agents/` that owns and ships this prompt. */
  readonly agent: string;
  /** Every numbered `N.md` that must exist on disk, ascending. Published versions are immutable; a change means a NEW number. */
  readonly versions: readonly string[];
  /** The version `latest.md` must be byte-identical to, and what `prompts/{promptId}.latestVersion` is published as. */
  readonly latestVersion: string;
  /** Guardrails this prompt is required to carry. */
  readonly requires?: PromptHygiene;
  /** Output-schema field names the prompt text must mention. Only read when `requires.structuredOutput` is set. */
  readonly structuredOutputFields?: readonly string[];
}

/**
 * What each `PromptHygiene` flag looks for in the prompt text. Case-insensitive
 * substring alternatives — a marker is satisfied when ANY alternative appears.
 *
 * Deliberately NOT regex-clever: the point is to detect a guardrail that was
 * dropped wholesale (which is what actually happened), not to grade phrasing.
 */
export const HYGIENE_MARKERS = {
  languageDirective: ["clientvoicecontext"],
  numbersSourcedProse: ["never invent", "do not invent", "don't invent"],
  numbersSourcedGate: ["gate.numberssourced"],
} as const;

/**
 * Every `gate.*` name a prompt is allowed to name, taken from the tool
 * registry `createKarosGatesTools()` actually returns
 * (`packages/tools/karos-gates/src/index.ts`). A prompt instructing the model
 * to satisfy a gate that does not exist is an unenforced instruction dressed
 * as an enforced one.
 *
 * Kept as a literal rather than imported so this script has no compile-time
 * dependency on a workspace package's built `dist/` — `check-prompts.ts` runs
 * on a fresh checkout, before `npm run build`. `check-prompts.ts` re-derives
 * the same list FROM that source file at run time and fails if the two
 * disagree, so this copy cannot silently rot.
 */
export const KNOWN_GATES = [
  "gate.lintPost",
  "gate.noPlaceholder",
  "gate.brandCompliance",
  "gate.leakCheck",
  "gate.numbersSourced",
  "gate.subredditRules",
] as const;

/**
 * THE REGISTRY. Ordered by promptId. Edit this deliberately when you add,
 * renumber or re-own a prompt — CI fails if it disagrees with `agents/`.
 */
export const PROMPT_REGISTRY: readonly PromptRegistryEntry[] = [
  {
    promptId: "blog-craft",
    agent: "blog-agent",
    versions: ["1", "2", "3", "4"],
    latestVersion: "4",
    requires: { languageDirective: true, numbersSourced: true, structuredOutput: true },
    structuredOutputFields: ["bodyMarkdown", "slug", "excerpt", "estimatedReadMinutes", "faqItems"],
  },
  { promptId: "branded-shorts-graphics", agent: "branded-shorts-agent", versions: ["1", "2"], latestVersion: "2" },
  { promptId: "branded-shorts-highlights", agent: "branded-shorts-agent", versions: ["1"], latestVersion: "1" },
  { promptId: "branded-shorts-style-exploration", agent: "branded-shorts-agent", versions: ["1"], latestVersion: "1" },
  { promptId: "campaign-craft", agent: "campaign-orchestrator", versions: ["1"], latestVersion: "1" },
  {
    promptId: "instagram-copy",
    agent: "instagram-agent",
    versions: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"],
    latestVersion: "11",
    requires: { languageDirective: true },
  },
  { promptId: "instagram-image-vet", agent: "instagram-agent", versions: ["1", "2"], latestVersion: "2" },
  { promptId: "instagram-research", agent: "instagram-agent", versions: ["1"], latestVersion: "1" },
  { promptId: "instagram-visual-qa", agent: "instagram-agent", versions: ["1", "2", "3"], latestVersion: "3" },
  {
    promptId: "intel-report-grounding",
    agent: "intel-report-agent",
    versions: ["1"],
    latestVersion: "1",
    // The pre-gate correction pass names the gate it exists to satisfy, so the
    // hygiene check holds it to the same "never invent numbers" declaration the
    // drafting prompt carries.
    requires: { numbersSourced: true },
  },
  {
    promptId: "intel-report-craft",
    agent: "intel-report-agent",
    versions: ["1", "2", "3", "4", "5"],
    latestVersion: "5",
    requires: { numbersSourced: true },
  },
  { promptId: "landing-compose", agent: "landing-builder-agent", versions: ["1"], latestVersion: "1" },
  { promptId: "landing-copy", agent: "landing-builder-agent", versions: ["1", "2", "3"], latestVersion: "3" },
  { promptId: "landing-craft-verdict", agent: "landing-builder-agent", versions: ["1"], latestVersion: "1" },
  { promptId: "landing-make", agent: "landing-builder-agent", versions: ["1"], latestVersion: "1" },
  {
    promptId: "linkedin-craft",
    agent: "linkedin-agent",
    versions: ["1", "2", "3", "4", "5"],
    latestVersion: "5",
    requires: { languageDirective: true, numbersSourced: true },
  },
  {
    promptId: "newsletter-craft",
    agent: "newsletter-agent",
    versions: ["1", "2", "3", "4", "5"],
    latestVersion: "5",
    requires: { languageDirective: true, numbersSourced: true, structuredOutput: true },
    structuredOutputFields: ["subject", "previewText", "intro", "callToAction", "signoff", "text"],
  },
  {
    promptId: "reddit-channel-plan",
    agent: "reddit-agent",
    versions: ["1"],
    latestVersion: "1",
    // A planning step, not client-facing prose: it decides communities and
    // keywords, so neither the language directive nor the numbers pair applies.
    requires: { structuredOutput: true },
    structuredOutputFields: ["targetSubreddits", "searchKeywords", "offLimitsTopics", "voiceNotes", "disclosureLine"],
  },
  {
    promptId: "reddit-craft",
    agent: "reddit-agent",
    versions: ["1", "2", "3", "4", "5"],
    latestVersion: "5",
    requires: { languageDirective: true, numbersSourced: true, structuredOutput: true },
    structuredOutputFields: ["replyBody", "text", "targetThreadUrl", "targetThreadTitle", "targetSubreddit", "disclosureIncluded", "sourcesUsed"],
  },
  {
    promptId: "reddit-scout",
    agent: "reddit-agent",
    versions: ["1"],
    latestVersion: "1",
    // Chooses a thread; produces no client-facing prose and no figures.
    requires: { structuredOutput: true },
    structuredOutputFields: ["selected", "passReason", "runnersUp", "angle", "whatToAdd", "requiresDisclosure"],
  },
  { promptId: "reputation-doctrine-gate", agent: "reputation-agent", versions: ["1"], latestVersion: "1" },
  { promptId: "reputation-draft", agent: "reputation-agent", versions: ["1"], latestVersion: "1" },
  { promptId: "reputation-extraction", agent: "reputation-agent", versions: ["1"], latestVersion: "1" },
  { promptId: "reputation-tag", agent: "reputation-agent", versions: ["1"], latestVersion: "1" },
  { promptId: "reputation-voice", agent: "reputation-agent", versions: ["1"], latestVersion: "1" },
  { promptId: "seo-geo-fix-draft", agent: "seo-geo-agent", versions: ["1", "2"], latestVersion: "2" },
  { promptId: "seo-geo-narrative", agent: "seo-geo-agent", versions: ["1", "2"], latestVersion: "2" },
  { promptId: "tiktok-commentary", agent: "tiktok-agent", versions: ["1", "2"], latestVersion: "2" },
  { promptId: "tiktok-moment", agent: "tiktok-agent", versions: ["1"], latestVersion: "1" },
  {
    promptId: "x-craft",
    agent: "x-agent",
    versions: ["1", "2", "3", "4", "5"],
    latestVersion: "5",
    requires: { languageDirective: true, numbersSourced: true },
  },
];

/** One promptId as it actually exists on disk. */
export interface DiskPrompt {
  readonly promptId: string;
  readonly agent: string;
  /** version -> file content, ascending by numeric version. */
  readonly versions: ReadonlyMap<string, string>;
  /** `latest.md`'s content, or `undefined` when the file is missing entirely. */
  readonly latestContent: string | undefined;
}

/**
 * Reads `agents/<agent>/prompts/<promptId>/` from disk. Unlike the walk this
 * replaced, NOTHING downstream trusts this on its own — it exists to be
 * compared against `PROMPT_REGISTRY`.
 *
 * `root` is injectable so the checker's own tests can point it at a fixture
 * tree; production callers pass nothing and get `REPO_ROOT`.
 */
export async function discoverPromptsOnDisk(root: string = REPO_ROOT): Promise<DiskPrompt[]> {
  const agentsDir = path.join(root, "agents");
  const prompts: DiskPrompt[] = [];

  let agentEntries: import("fs").Dirent[];
  try {
    agentEntries = (await fs.readdir(agentsDir, { withFileTypes: true })).filter((e) => e.isDirectory());
  } catch {
    return prompts;
  }

  for (const agent of agentEntries.sort((a, b) => a.name.localeCompare(b.name))) {
    const promptsDir = path.join(agentsDir, agent.name, "prompts");
    let promptIds: string[];
    try {
      promptIds = (await fs.readdir(promptsDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      continue; // an agent folder without a prompts/ dir is fine
    }

    for (const promptId of promptIds.sort()) {
      const dir = path.join(promptsDir, promptId);
      const files = await fs.readdir(dir);
      const numbered: Array<[string, string]> = [];
      for (const file of files) {
        const m = /^(\d+)\.md$/.exec(file);
        if (m) numbered.push([m[1]!, await fs.readFile(path.join(dir, file), "utf8")]);
      }
      numbered.sort((a, b) => Number(a[0]) - Number(b[0]));
      let latestContent: string | undefined;
      try {
        latestContent = await fs.readFile(path.join(dir, "latest.md"), "utf8");
      } catch {
        latestContent = undefined;
      }
      prompts.push({ promptId, agent: agent.name, versions: new Map(numbered), latestContent });
    }
  }
  return prompts;
}

/** A single disagreement between the registry and the disk, or a violated invariant. */
export interface PromptProblem {
  readonly kind:
    | "latest-drift"
    | "latest-missing"
    | "registry-missing-prompt"
    | "registry-orphan-prompt"
    | "registry-wrong-agent"
    | "registry-version-mismatch"
    | "registry-latest-mismatch"
    | "duplicate-prompt-id"
    | "hygiene-missing-marker"
    | "unknown-gate"
    | "unresolvable-pin";
  readonly promptId: string;
  readonly detail: string;
}

/**
 * The drift check itself: registry vs disk, plus the `latest.md` invariant.
 *
 * The `latest.md` invariant is "byte-identical to the registry's declared
 * `latestVersion`", not the weaker "matches SOME numbered version". The weaker
 * form would have passed a `latest.md` frozen at `1.md` while `2.md` and
 * `3.md` shipped past it — which is a drift you very much want to hear about.
 */
export function diffRegistryAgainstDisk(registry: readonly PromptRegistryEntry[], disk: readonly DiskPrompt[]): PromptProblem[] {
  const problems: PromptProblem[] = [];

  const seenIds = new Set<string>();
  for (const entry of registry) {
    if (seenIds.has(entry.promptId)) {
      problems.push({ kind: "duplicate-prompt-id", promptId: entry.promptId, detail: `declared more than once in PROMPT_REGISTRY` });
    }
    seenIds.add(entry.promptId);
  }

  const diskById = new Map<string, DiskPrompt[]>();
  for (const d of disk) {
    const bucket = diskById.get(d.promptId);
    if (bucket) bucket.push(d);
    else diskById.set(d.promptId, [d]);
  }
  for (const [promptId, owners] of diskById) {
    if (owners.length > 1) {
      problems.push({
        kind: "duplicate-prompt-id",
        promptId,
        detail: `shipped by ${owners.map((o) => `"${o.agent}"`).join(" and ")} — one shared PromptStore can't serve both`,
      });
    }
  }

  for (const d of disk) {
    if (!seenIds.has(d.promptId)) {
      problems.push({
        kind: "registry-missing-prompt",
        promptId: d.promptId,
        detail: `exists at agents/${d.agent}/prompts/${d.promptId}/ but is not declared in PROMPT_REGISTRY`,
      });
    }
  }

  for (const entry of registry) {
    const d = diskById.get(entry.promptId)?.[0];
    if (!d) {
      problems.push({
        kind: "registry-orphan-prompt",
        promptId: entry.promptId,
        detail: `declared in PROMPT_REGISTRY (owner "${entry.agent}") but no such directory exists under agents/*/prompts/`,
      });
      continue;
    }

    if (d.agent !== entry.agent) {
      problems.push({
        kind: "registry-wrong-agent",
        promptId: entry.promptId,
        detail: `registry says owner "${entry.agent}", disk says "${d.agent}"`,
      });
    }

    const onDisk = [...d.versions.keys()];
    const declared = [...entry.versions];
    const missingOnDisk = declared.filter((v) => !d.versions.has(v));
    const undeclared = onDisk.filter((v) => !declared.includes(v));
    if (missingOnDisk.length > 0 || undeclared.length > 0) {
      problems.push({
        kind: "registry-version-mismatch",
        promptId: entry.promptId,
        detail:
          `registry declares [${declared.join(", ")}], disk has [${onDisk.join(", ")}]` +
          (missingOnDisk.length > 0 ? ` — declared but absent: ${missingOnDisk.join(", ")}` : "") +
          (undeclared.length > 0 ? ` — present but undeclared: ${undeclared.join(", ")}` : ""),
      });
    }

    if (!entry.versions.includes(entry.latestVersion)) {
      problems.push({
        kind: "registry-latest-mismatch",
        promptId: entry.promptId,
        detail: `registry latestVersion "${entry.latestVersion}" is not one of its declared versions [${declared.join(", ")}]`,
      });
      continue;
    }

    if (d.latestContent === undefined) {
      problems.push({ kind: "latest-missing", promptId: entry.promptId, detail: `agents/${d.agent}/prompts/${entry.promptId}/latest.md does not exist` });
      continue;
    }

    const declaredLatest = d.versions.get(entry.latestVersion);
    if (declaredLatest !== undefined && declaredLatest !== d.latestContent) {
      const matches = [...d.versions.entries()].filter(([, content]) => content === d.latestContent).map(([v]) => v);
      problems.push({
        kind: "latest-drift",
        promptId: entry.promptId,
        detail:
          `latest.md is not byte-identical to its declared latestVersion ${entry.latestVersion}.md — ` +
          (matches.length > 0
            ? `it matches ${matches.map((v) => `${v}.md`).join(", ")} instead. Either bump latestVersion or re-sync latest.md.`
            : `it matches NO numbered version at all. Snapshot it as a new numbered version and point latestVersion at that ` +
              `— do not leave it for the publisher to invent one.`),
      });
    }
  }

  return problems;
}

/** Absolute path to one numbered prompt file, derived from a registry entry. */
export function promptVersionPath(entry: PromptRegistryEntry, version: string, root: string = REPO_ROOT): string {
  return path.join(root, "agents", entry.agent, "prompts", entry.promptId, `${version}.md`);
}
