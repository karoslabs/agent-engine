/**
 * Live, narrated demo of the two migrated Phase 2 agents — X (`agents/x-agent`)
 * and LinkedIn (`agents/linkedin-agent`) — each running its real,
 * shipped `createXAgentWorkflow()` / `createLinkedInAgentWorkflow()` end to
 * end for the same client. Every tool call below is real — real
 * `karos-gates` verdicts, real file-backed persistence, real `PromptStore`
 * resolution — only the *model* is faked (a scripted `ModelRouter`), so this
 * runs with no API key and no network call.
 *
 * Run with:
 *   npx tsx scripts/demo-agents-run.ts
 */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  FilePromptStore,
  type AgentContext,
  type AgentExecutionResult,
  type CompletionResult,
  type GateVerdict,
  type ModelRouter,
} from "@agent-engine/core";
import { createAllKarosTools, WorkspaceStore } from "@agent-engine/tools";
import {
  MemoryDurableStepStore,
  WorkflowEngine,
  serializeToDynamicAgentRunReport,
  type DynamicAgentStepDescriptor,
  type StepRecord,
  type WorkflowContext,
} from "@agent-engine/workflow";
import { createXAgentWorkflow, type XPostOutput } from "@agent-engine/agent-x";
import { createLinkedInAgentWorkflow, type LinkedInPostOutput } from "@agent-engine/agent-linkedin";

// ── tiny console-narration helpers (no dependency added just for a demo script) ──

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";

function section(title: string): void {
  console.log();
  console.log(`${BOLD}${CYAN}${"=".repeat(78)}${RESET}`);
  console.log(`${BOLD}${CYAN}  ${title}${RESET}`);
  console.log(`${BOLD}${CYAN}${"=".repeat(78)}${RESET}`);
}

function sub(title: string): void {
  console.log();
  console.log(`${BOLD}${title}${RESET}`);
  console.log(`${DIM}${"-".repeat(70)}${RESET}`);
}

function info(label: string, value: unknown): void {
  const rendered = typeof value === "string" ? value : JSON.stringify(value);
  console.log(`  ${DIM}${label}:${RESET} ${rendered}`);
}

function ok(msg: string): void {
  console.log(`  ${GREEN}✓${RESET} ${msg}`);
}

function fail(msg: string): void {
  console.log(`  ${RED}✗${RESET} ${msg}`);
}

function narrate(msg: string): void {
  console.log(`  ${msg}`);
}

// ── scripted "model" — no network, no API key; every tool call is real ──

function fakeRouterSequence(turns: Array<() => CompletionResult<unknown>>): ModelRouter {
  const queue = [...turns];
  return {
    async complete() {
      const next = queue.shift();
      if (!next) throw new Error("fakeRouterSequence: exhausted configured turns");
      return next();
    },
    async completeAlias() {
      throw new Error("completeAlias not used in this demo");
    },
  } as unknown as ModelRouter;
}

function finalTurn(output: unknown, opts: { model?: string; inputTokens?: number; outputTokens?: number } = {}): () => CompletionResult<unknown> {
  return () => ({
    output: { type: "final", output },
    modelUsed: opts.model ?? "claude-sonnet-4-6",
    inputTokens: { cached: 0, uncached: opts.inputTokens ?? 100 },
    outputTokens: opts.outputTokens ?? 30,
  });
}

// scripts/*.ts compiles as CommonJS under the root tsconfig (root package.json
// has no "type": "module"), so __dirname is available directly — no import.meta needed.
const X_PROMPTS_ROOT = path.join(__dirname, "..", "agents", "x-agent", "prompts");
const LINKEDIN_PROMPTS_ROOT = path.join(__dirname, "..", "agents", "linkedin-agent", "prompts");

const CLIENT_SLUG = "acme-corp";

// Both agents' *current* step protocols (RFC-02 §3/§5) — kept as two separate
// lists rather than one shared one because they've drifted apart: X gained a
// lane-selection step (08) and an engagement-cap check (09) LinkedIn never
// had, shifting everything after by one, and each agent's own gate/persist
// steps landed on different numbers as a result.
const X_STEP_IDS = [
  "00-intake-check",
  "01-load-client-context",
  "02-load-memory-shelf",
  "03-load-recent-decisions",
  "04-research-pull",
  "05-extract-candidate-summary",
  "06-reserve-topic",
  "07-select-candidate",
  "08-select-lane",
  "09-check-engagement-cap",
  "10-draft-post",
  "11-verify-numbers-sourced",
  "12-verify-brand-compliance",
  "13-verify-link-placement",
  "14-render-preview-check",
  "14c-verify-no-placeholder",
  "14d-verify-no-leak",
  "15-batch-review",
  "18-persist-deliverable",
  "19-persist-manifest",
  "20-commit-and-record",
];

const LINKEDIN_STEP_IDS = [
  "00-intake-check",
  "01-load-client-context",
  "02-load-memory-shelf",
  "03-load-recent-decisions",
  "04-research-pull",
  "05-extract-candidate-summary",
  "06-reserve-topic",
  "07-select-candidate",
  "08-determine-archetype",
  "09-draft-post",
  "10-verify-numbers-sourced",
  "11-verify-brand-compliance",
  "12-render-preview-check",
  "13-verify-no-placeholder",
  "14-verify-no-leak",
  "15-batch-review",
  "16-persist-deliverable",
  "17-persist-manifest",
  "18-commit-and-record",
];

/** The mandatory human batch-review gate every migrated channel shares (RFC-01 §8.3) — same id, same kind, in both workflows. */
const BATCH_REVIEW_GATE_ID = "15-batch-review";

function stepDescriptors(stepIds: readonly string[], draftStepId: string): DynamicAgentStepDescriptor[] {
  return stepIds.map((stepId) => ({ stepId, label: stepId, type: stepId === draftStepId ? "ai" : "code" }));
}

/**
 * `step.gate` pauses a run rather than blocking a process (RFC-01 §8.1/§8.3)
 * — `engine.run()` returns `awaiting_gate` instead of holding anything open.
 * This is the demo's stand-in for a human reviewer: resolve the gate, then
 * call `run()` again. Every earlier `step.code`/`step.agent` short-circuits
 * via checkpoint, so the replay only actually executes what comes after the
 * gate — the same mechanic `gate-pause-and-resume.test.ts` verifies for real.
 */
async function approveGateIfPending<T>(
  engine: WorkflowEngine,
  workflowFn: (wf: WorkflowContext) => Promise<T>,
  params: { runId: string; clientSlug: string; productId: string; runKind: "recurring" },
  result: Awaited<ReturnType<WorkflowEngine["run"]>>,
): Promise<Awaited<ReturnType<WorkflowEngine["run"]>>> {
  if (result.status !== "awaiting_gate") return result;
  ok(`run paused at "${result.pendingGateId}" — the mandatory human batch-review gate (RFC-01 §8.3)`);
  narrate(`Simulating a human reviewer: engine.resolveGate(runId, "${BATCH_REVIEW_GATE_ID}", {decision: "approve", ...})...`);
  await engine.resolveGate(params.runId, BATCH_REVIEW_GATE_ID, {
    decision: "approve",
    actor: "demo-script@karoslabs.com",
    at: new Date().toISOString(),
  });
  narrate("Resuming: engine.run(...) again — every step before the gate short-circuits via checkpoint...");
  return engine.run(workflowFn, params);
}

/** Pulls the bare `GateVerdict` out of a self-critique gate row in an agent step's telemetry (RFC-01 §5.6 — never wrapped like a regular tool_call). */
function findSelfCritiqueVerdict(execResult: AgentExecutionResult<unknown>, gateTool: string): GateVerdict | undefined {
  const row = execResult.steps.find((s) => s.toolCall?.name === gateTool);
  return row?.toolCall?.result as GateVerdict | undefined;
}

/** `evidence` only exists on the `pass`/`content_fail` variants, never on `tooling_error`. */
function gateDetail(verdict: GateVerdict): string {
  return verdict.verdict === "tooling_error" ? verdict.reason : (verdict.evidence[0] ?? "");
}

async function runXAgentDemo(workspaceStore: WorkspaceStore, tools: ReturnType<typeof createAllKarosTools>): Promise<void> {
  section("PART 1 — X AGENT (e13) — createXAgentWorkflow()");

  sub("[1/6] PROMPT RESOLUTION — skillRef \"x-craft@1\"");
  const promptStore = new FilePromptStore(X_PROMPTS_ROOT);
  const resolvedPrompt = await promptStore.getPrompt("x-craft", "1");
  narrate('Resolving skillRef "x-craft@1" via FilePromptStore...');
  ok(`resolved ${resolvedPrompt.length} chars from prompts/x-craft/1.md`);
  console.log(`${DIM}${resolvedPrompt.split("\n").slice(0, 6).join("\n")}\n  ...${RESET}`);

  const draft: XPostOutput = {
    text: "More teams are testing 4-day weeks this quarter. Early internal data [1] shows steady output with fewer sick days.",
    mainPostText: "More teams are testing 4-day weeks this quarter. Early internal data [1] shows steady output with fewer sick days.",
    hook: "More teams are testing 4-day weeks this quarter.",
    angle: "data-point",
    lane: "knowledge",
    targetHandle: "@acmecorp",
    mediaRefs: [],
    thread: [],
  };
  const router = fakeRouterSequence([finalTurn(draft, { inputTokens: 140, outputTokens: 45 })]);
  const workflowFn = createXAgentWorkflow({ tools, promptStore, router });

  const durableStore = new MemoryDurableStepStore();
  const engine = new WorkflowEngine(durableStore);
  const params = { runId: "demo_x_run", clientSlug: CLIENT_SLUG, productId: "x-agent", runKind: "recurring" as const };

  sub("[2/6] EXECUTING THE 21-STEP WORKFLOW");
  narrate('engine.run(createXAgentWorkflow({tools, promptStore, router}), params)...');
  const result = await approveGateIfPending(engine, workflowFn, params, await engine.run(workflowFn, params));
  if (result.status === "completed") {
    ok(`run completed — total cost: $${result.totalCostUsd.toFixed(6)}`);
  } else {
    fail(`unexpected status: "${result.status}"`);
  }

  sub("[3/6] SIMULATED RESEARCH INPUT (step 04-research-pull)");
  const researchStep = (await durableStore.getStep(params.runId, "04-research-pull")) as StepRecord;
  const research = researchStep.output as { runId: string; query: string; fromCache: boolean };
  info("job", "x-news-scan");
  info("query", research.query);
  info("window", "24h");

  sub("[4/6] THE DRAFT — text, hook, angle (step 10-draft-post)");
  const draftStep = (await durableStore.getStep(params.runId, "10-draft-post")) as StepRecord;
  const draftExec = draftStep.output as AgentExecutionResult<XPostOutput>;
  const finalDraft = draftExec.finalOutput!;
  info("text", finalDraft.text);
  info("hook", finalDraft.hook);
  info("angle", finalDraft.angle);
  info("targetHandle", finalDraft.targetHandle);

  sub("[5/6] GATE VERDICTS");
  const lintVerdict = findSelfCritiqueVerdict(draftExec, "gate.lintPost");
  ok(`self-critique gate.lintPost (280-char check, platform: "x") → ${lintVerdict?.verdict ?? "unknown"} — ${lintVerdict ? gateDetail(lintVerdict) : ""}`);
  const brandStep = (await durableStore.getStep(params.runId, "12-verify-brand-compliance")) as StepRecord;
  const brandVerdict = brandStep.output as GateVerdict;
  ok(`workflow gate.brandCompliance (step 12) → ${brandVerdict.verdict} — ${gateDetail(brandVerdict)}`);
  const numbersStep = (await durableStore.getStep(params.runId, "11-verify-numbers-sourced")) as StepRecord;
  const numbersVerdict = numbersStep.output as GateVerdict;
  ok(`workflow gate.numbersSourced (step 11) → ${numbersVerdict.verdict} — ${gateDetail(numbersVerdict)}`);

  sub("[6/6] FINAL DELIVERABLE + DynamicAgentRunReport");
  info("deliverable", finalDraft);
  const stepRecords = await durableStore.listSteps(params.runId);
  const runRecord = await durableStore.getRun(params.runId);
  const report = serializeToDynamicAgentRunReport({
    specId: "spec_x_agent_demo",
    specVersion: 1,
    steps: stepDescriptors(X_STEP_IDS, "10-draft-post"),
    stepRecords,
    slotRecords: [],
    ...(runRecord !== undefined ? { runRecord } : {}),
  });
  ok(`domainOutcome: "${report.domainOutcome}" — ${report.steps.length} steps, all "${report.steps.every((s) => s.status === "done") ? "done" : "mixed"}"`);
  ok(`total cost: $${result.status === "completed" ? result.totalCostUsd.toFixed(6) : "n/a"}`);
}

async function runLinkedInAgentDemo(workspaceStore: WorkspaceStore, tools: ReturnType<typeof createAllKarosTools>): Promise<void> {
  section("PART 2 — LINKEDIN AGENT (e10) — createLinkedInAgentWorkflow()");

  sub("[1/6] PROMPT RESOLUTION — skillRef \"linkedin-craft@1\"");
  const promptStore = new FilePromptStore(LINKEDIN_PROMPTS_ROOT);
  const resolvedPrompt = await promptStore.getPrompt("linkedin-craft", "1");
  narrate('Resolving skillRef "linkedin-craft@1" via FilePromptStore...');
  ok(`resolved ${resolvedPrompt.length} chars from prompts/linkedin-craft/1.md`);
  console.log(`${DIM}${resolvedPrompt.split("\n").slice(0, 6).join("\n")}\n  ...${RESET}`);

  const draft: LinkedInPostOutput = {
    headline: "Anchor days cut scheduling friction",
    hook: "We looked at attendance data across our hybrid client base this quarter, and the pattern surprised us.",
    // No bare numeric claim (e.g. "18%") — gate.numbersSourced (workflow step
    // 10) fails any percentage/currency/multiplier claim whose exact figure
    // doesn't appear in `sources`, and this demo's research.pull stand-in
    // never sets hasNumericInsight, so sources is always empty (same reason
    // the X agent's fake draft below only gestures at "data" without a figure).
    body: "Teams with a fixed two-day in-office schedule reported meaningfully fewer scheduling conflicts [1] than teams with fully flexible policies.",
    takeaway: "Predictability, not enforcement, is what made the schedule stick.",
    hashtags: ["HybridWork", "FutureOfWork"],
    callToAction: "If your team is still negotiating its hybrid policy week to week, a fixed anchor-day structure might be worth testing.",
    targetAudience: "People leaders and operations managers evaluating hybrid work policies",
    archetype: "industry-reaction",
    text:
      "We looked at attendance data across our hybrid client base this quarter, and the pattern surprised us.\n\n" +
      "Teams with a fixed two-day in-office schedule reported meaningfully fewer scheduling conflicts [1] than teams with fully flexible policies.\n\n" +
      "If your team is still negotiating its hybrid policy week to week, a fixed anchor-day structure might be worth testing.\n\n" +
      "#HybridWork #FutureOfWork",
  };
  const router = fakeRouterSequence([finalTurn(draft, { inputTokens: 150, outputTokens: 60 })]);
  const workflowFn = createLinkedInAgentWorkflow({ tools, promptStore, router });

  const durableStore = new MemoryDurableStepStore();
  const engine = new WorkflowEngine(durableStore);
  const params = { runId: "demo_linkedin_run", clientSlug: CLIENT_SLUG, productId: "linkedin-agent", runKind: "recurring" as const };

  sub("[2/6] EXECUTING THE 19-STEP WORKFLOW");
  narrate('engine.run(createLinkedInAgentWorkflow({tools, promptStore, router}), params)...');
  const result = await approveGateIfPending(engine, workflowFn, params, await engine.run(workflowFn, params));
  if (result.status === "completed") {
    ok(`run completed — total cost: $${result.totalCostUsd.toFixed(6)}`);
  } else {
    fail(`unexpected status: "${result.status}"`);
  }

  sub("[3/6] SIMULATED RESEARCH INPUT (step 04-research-pull)");
  const researchStep = (await durableStore.getStep(params.runId, "04-research-pull")) as StepRecord;
  const research = researchStep.output as { runId: string; query: string; fromCache: boolean };
  info("job", "linkedin-trend-scan");
  info("query", research.query);
  info("window", "7d");

  sub("[4/6] THE DRAFT — headline, hook, body, hashtags, callToAction (step 09-draft-post)");
  const draftStep = (await durableStore.getStep(params.runId, "09-draft-post")) as StepRecord;
  const draftExec = draftStep.output as AgentExecutionResult<LinkedInPostOutput>;
  const finalDraft = draftExec.finalOutput!;
  info("headline", finalDraft.headline);
  info("hook", finalDraft.hook);
  info("body", finalDraft.body);
  info("hashtags", finalDraft.hashtags);
  info("callToAction", finalDraft.callToAction);
  info("targetAudience", finalDraft.targetAudience);

  sub("[5/6] GATE VERDICTS");
  const lintVerdict = findSelfCritiqueVerdict(draftExec, "gate.lintPost");
  ok(`self-critique gate.lintPost (3000-char check, platform: "linkedin") → ${lintVerdict?.verdict ?? "unknown"} — ${lintVerdict ? gateDetail(lintVerdict) : ""}`);
  const brandStep = (await durableStore.getStep(params.runId, "11-verify-brand-compliance")) as StepRecord;
  const brandVerdict = brandStep.output as GateVerdict;
  ok(`workflow gate.brandCompliance (step 11) → ${brandVerdict.verdict} — ${gateDetail(brandVerdict)}`);
  const numbersStep = (await durableStore.getStep(params.runId, "10-verify-numbers-sourced")) as StepRecord;
  const numbersVerdict = numbersStep.output as GateVerdict;
  ok(`workflow gate.numbersSourced (step 10) → ${numbersVerdict.verdict} — ${gateDetail(numbersVerdict)}`);

  sub("[6/6] FINAL DELIVERABLE + DynamicAgentRunReport");
  info("deliverable", finalDraft);
  const stepRecords = await durableStore.listSteps(params.runId);
  const runRecord = await durableStore.getRun(params.runId);
  const report = serializeToDynamicAgentRunReport({
    specId: "spec_linkedin_agent_demo",
    specVersion: 1,
    steps: stepDescriptors(LINKEDIN_STEP_IDS, "09-draft-post"),
    stepRecords,
    slotRecords: [],
    ...(runRecord !== undefined ? { runRecord } : {}),
  });
  ok(`domainOutcome: "${report.domainOutcome}" — ${report.steps.length} steps, all "${report.steps.every((s) => s.status === "done") ? "done" : "mixed"}"`);
  ok(`total cost: $${result.status === "completed" ? result.totalCostUsd.toFixed(6) : "n/a"}`);
}

async function main(): Promise<void> {
  section("AGENT-ENGINE — PHASE 2 LIVE DEMO: X AGENT + LINKEDIN AGENT");
  narrate('Both agents run their real, shipped workflow for the same client — only the model is scripted; every tool call is real.');

  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-engine-agents-demo-"));
  const workspaceStore = new WorkspaceStore(rootDir);
  const tools = createAllKarosTools(workspaceStore);

  sub("SETUP — seeding the shared client fixture");
  await workspaceStore.writeJson(CLIENT_SLUG, ["client", "profile"], { name: "Acme Corp", industry: "B2B SaaS" });
  await workspaceStore.writeJson(CLIENT_SLUG, ["client", "brand"], { forbiddenTerms: ["guaranteed", "the best", "#1", "cheapest"] });
  await workspaceStore.writeJson(CLIENT_SLUG, ["client", "voice-rules"], { tone: "confident, no jargon" });
  await workspaceStore.writeJson(CLIENT_SLUG, ["client", "config"], { xHandle: "@acmecorp" });
  const seedCtx: AgentContext = { runId: "seed", clientSlug: CLIENT_SLUG, productId: "demo-seed", runKind: "recurring", metadata: {} };
  await tools["topics.topUp"]!.execute({ topics: ["hybrid work anchor days", "four-day work weeks", "async collaboration"] }, { ctx: seedCtx });
  ok(`seeded client.profile, client.brand, client.voice-rules, client.config, and a 3-topic catalog for "${CLIENT_SLUG}"`);

  await runXAgentDemo(workspaceStore, tools);
  await runLinkedInAgentDemo(workspaceStore, tools);

  section("DEMO COMPLETE");
  ok("both agents ran their real workflow to completion, including the batch-review gate pause/resume (domainOutcome: \"delivered\")");
  ok("PromptStore resolved both skillRefs from their own versioned markdown files — no hardcoded prompt strings");
  ok("every gate verdict came from a real karos-gates tool call, not a simulated result");

  await fs.rm(rootDir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error();
  console.error(`${RED}${BOLD}DEMO FAILED${RESET}`);
  console.error(err);
  process.exitCode = 1;
});
