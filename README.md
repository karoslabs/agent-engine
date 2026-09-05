# agent-engine

Karos Labs' autonomous agent runtime. Replaces the prompt-chaining pattern in
`agent-service` with a real three-layer architecture:

1. **Orchestration (code)** — a durable workflow per run: identity, checkpoints,
   retries, budget, human gates.
2. **Agent steps (`BaseAgent`)** — a bounded ReAct loop with narrow tools and a
   typed output schema. Every concrete agent (`XAgent`, `LinkedInAgent`, ...)
   inherits from this.
3. **Tools (MCP)** — every external read/write is a typed, tested, versioned
   tool server.

**Start here:** [`docs/RFC-01-agent-engine-core.md`](docs/RFC-01-agent-engine-core.md)
defines the engine itself (this is the spec to build against first).
[`docs/RFC-02-agent-migration.md`](docs/RFC-02-agent-migration.md) is the
playbook for migrating each existing skill onto this engine — read it only
once RFC-01's tool layer and `BaseAgent` exist.
[`docs/RFC-12-social-agents-elite-tier.md`](docs/RFC-12-social-agents-elite-tier.md)
is the 2026-09 review and upgrade of the X, LinkedIn and Instagram agents
(vision-read media, trend-jacking with brand fit, platform craft, per-step
model routing) and the place to look for each social step's recommended model.

## Relationship to other repos

- **`karosCMO`** (sibling folder) — the portal and the legacy `agent-service`
  runner. `agent-engine` is developed alongside it, not inside it. During
  early development, keep this repo's parent directory open in your editor/
  Claude Code session so you can read `karosCMO`'s real contracts
  (`src/lib/types.ts`, `src/lib/data.ts`, the `dynamic-agent-*` files) as
  ground truth while building the tool layer — see RFC-01 §9 and §7.
- **`karos-agents`** (separate repo, not yet connected here) — the skill
  library. Skills stay Markdown; they become the craft-policy layer loaded by
  `BaseAgent` steps, per RFC-01 §1.3.

## Repo layout

```
packages/core/          BaseAgent, AgentContext, ModelRouter, telemetry types      (RFC-01 §5)
packages/workflow/       Layer 1 primitives: step.code / step.agent / step.gate /
                         fanout / gate() — Firestore adapter first, Postgres and
                         Temporal adapters later                                    (RFC-01 §8)
packages/telemetry/      OpenTelemetry setup, cost calculators                       (RFC-01 §11)
packages/tools/*         One folder per MCP server (karos-client, karos-research,
                         karos-topics, karos-gates, karos-ledger, karos-memory,
                         karos-publish)                                              (RFC-01 §9)
agents/                  One folder per concrete agent (XAgent, LinkedInAgent, ...)  (RFC-02)
evals/                   Golden runs, judges, CI regression gate                     (RFC-01 §12)
infra/                   Docker, CI
```

## Running it

Requires Node >= 22 (`.nvmrc` pins 22; the `engines` field enforces the floor).

```bash
npm install
npm run build     # every workspace, in dependency order — see the note below
npm run verify    # workspace-wide typecheck + every package's own test suite
```

`npm run build` is an explicit, ordered chain rather than
`npm run build --workspaces`, which does **not** guarantee topological order.
Each package compiles to `dist/` and its dependents resolve that `dist/`
through the workspace symlink, so a package built before its dependencies
fails with `TS2307: Cannot find module`. **`apps/agent-server/Dockerfile`
hardcodes the same order in its own `RUN` step — a new package has to be added
to both.**

### Checking it without any credentials

The fastest real verification. Every tool call, gate verdict, and checkpoint
is genuine; only the model is scripted, so these need no GCP project, no API
key, and no network:

```bash
npm run demo:e2e      # all three layers in one run, incl. a human gate + resume from checkpoint
npm run smoke         # the full agent-server HTTP surface, in-process
```

`npm run demo:agents` (`scripts/demo-agents-run.ts`) currently **fails** — it
has drifted from the workflows it demos: it hardcodes a 16-step list and reads
`09-draft-post`, but the X agent is now 21 steps with the draft at
`10-draft-post`, and both agents gained a `15-batch-review` human gate the
script never resolves (pass `autoApprove: true` to the workflow factory, or
resolve the gate, to get a `completed` run).

### Running the HTTP server locally

```bash
cp .env.example .env       # then set ANTHROPIC_VERTEX_PROJECT_ID in it
gcloud auth application-default login
npm run setup:local        # builds .local/prompts + seeds a demo tenant
npm run dev:server         # tsx watch, or `npm run start:server` for the built output
```

Both server scripts read `.env` through Node's own `--env-file` flag. Nothing
else in the repo loads `.env` implicitly — there is no `dotenv` dependency —
so any other command needs its variables exported the usual way.

`npm run setup:local` exists because two things have no working default:

- **Prompts.** `FilePromptStore` resolves `<root>/<promptId>/<version>.md` from
  one root, but prompts ship per agent (`agents/x-agent/prompts/x-craft/1.md`).
  The script merges them all into `.local/prompts`. Without it,
  `PROMPT_STORE_DRIVER=file` has nothing valid to point at, and the `memory`
  default starts empty — every `skillRef` resolution then fails.
- **Client state.** Each workflow reads its entire input from persisted client
  state, so a run against an empty workspace stops at `00-intake-check` with
  status `blocked_intake`. The script seeds one tenant (`acme`) matching the
  fixture in `apps/agent-server/__tests__/test-helpers.ts`.

Then:

```bash
curl localhost:8080/healthz

# ENQUEUES a run and returns 202 {"runId":"pubsub-...","status":"queued"}.
# It does NOT execute the run — a worker consuming the topic does.
curl -X POST localhost:8080/api/v1/runs/start -H "Content-Type: application/json" \
  -d '{"clientSlug":"acme","productId":"linkedin-agent","runKind":"recurring"}'

# The run's real state lives here, and 404s until a worker claims the message.
curl localhost:8080/api/v1/runs/<runId>/status
```

`/runs/start` used to run the whole workflow inside the request. On Cloud Run
that is a 300s ceiling with CPU throttling after it, which killed a Chromium
render nine minutes after the request had already been severed — twice,
reproducibly (AU66 / SCRUM-364). It now hands off to the same topic karosCMO
publishes to, so exactly one path executes a run.

Locally this needs `PUBSUB_PROJECT_ID` (or `GOOGLE_CLOUD_PROJECT`) plus a
running consumer — see "Running jobs from a queue" below. With no queue
configured the route says so, rather than quietly running the job itself.

Every run makes real, billable model calls. Valid `productId`s
are the six in `KNOWN_PRODUCT_IDS` (`apps/agent-server/src/wiring/workflows.ts`)
— note that `instagram-agent`, `seo-geo-agent`, and `intel-report-agent` are
built and tested but not yet dispatchable through the server.

## How model calls reach Claude

This section covers Claude's own *route* — which network path a Claude call
takes. `ModelPolicy.vendor` (next section) is a separate axis: which
*company's* model answers the call at all. Every agent in this system uses
the `anthropic` vendor by default, so this section is still what governs
every step until something opts into a different vendor.

The `pinned` tier — the tier every agent in this system declares — routes
through **Google Cloud's Agent Platform** (formerly Vertex AI) by default.
`MODEL_PROVIDER=anthropic` switches to the direct Anthropic API instead.

Both routes reach the *same* models. Nothing about an agent changes with the
route: not its `modelPolicy`, not a prompt, not the alias table
(`packages/core/src/router/aliases.ts`), not a pricing row, not the
`DynamicAgentRunStep.model` the portal renders. That holds because **model ids
stay in canonical Claude API form everywhere except inside the Agent Platform
adapter**, which translates them at the boundary in both directions —
`claude-haiku-4-5-20251001` on the way out becomes `claude-haiku-4-5@20251001`
on the wire, and `response.model` is normalized back before it reaches
telemetry (`router/adapters/agent-platform-model-ids.ts`).

That inbound direction is not cosmetic. `computeStepCostUsd` looks the returned
model name up in `MODEL_PRICING`, and a miss falls back to Sonnet's `$3/$15`
*silently* — so an un-normalized Agent Platform run would bill Haiku and Opus
work at Sonnet rates in every per-step cost report (RFC-01 §11).

**Why this is the default, and not just the redundancy option RFC-01 §11
described:** authentication moves from a long-lived API key to Application
Default Credentials — the attached service account on Cloud Run, `gcloud`
locally. No model credential is ever passed to a container as an environment
variable value, which is exactly the rule RFC-01 §16.3 added after
`ANTHROPIC_API_KEY` was found in plaintext in `karoscmo-prep`'s Cloud Run audit
logs. The route change removes that class of exposure rather than mitigating
it, and consolidates model billing onto the GCP project the rest of the stack
already runs on.

### Setup

One-time, per GCP project:

```bash
gcloud config set project YOUR-PROJECT-ID
gcloud services enable aiplatform.googleapis.com
# then request access to the Claude models in Model Garden (can take 24-48h)
gcloud auth application-default login          # local dev only
```

The runtime service account needs `roles/aiplatform.user`. `cloudbuild.yaml`
already grants it and deploys with **no** `--set-secrets` for the model route.

### Verifying it

```bash
npm run smoke:agent-platform                   # one real, ~$0.000x call
npm run smoke:agent-platform claude-opus-4-8   # or check one specific model
```

This is the one script here that deliberately makes a billable call — it is the
only way to distinguish "credentials resolve", "this model is enabled in this
project", and "this model is served at this endpoint", which are three separate
failure modes that all surface as one opaque error otherwise. It prints the
project, region, wire model id, token split, and computed cost, and on failure
prints `err.cause` (RFC-01 §16.4) plus the four likely causes in order.

### Regions

`CLOUD_ML_REGION` defaults to `global` — best availability, fewest 429s. The
global endpoint does not serve every Claude model, which is the usual cause of
a `404 model not found`; pin just that model rather than moving the whole
deployment:

```bash
VERTEX_REGION_CLAUDE_HAIKU_4_5=us-east5
```

Region lives in the client's base URL rather than in the request, so a
per-model pin constructs a second client — the adapter memoizes one per region.

### Prompt caching

The adapter places one cache breakpoint on the stable `tools` + `system` prefix
of every step (the craft-policy skill body), which is where the 90% cache-read
discount comes from. It applies on both routes. `DISABLE_PROMPT_CACHING=1`
turns it off for debugging. Cache-*write* tokens are folded into
`inputTokens.uncached` rather than tracked separately, which under-reports them
by the cache-write premium; widening `TokenUsage` to a third field reaches
every persisted `AgentStepTelemetry` record, so that is a deliberate deferral,
not an oversight.

## Choosing a model vendor for any step

Every `ModelPolicy` (`packages/core/src/types/model-policy.ts`) carries two
independent axes: `policy` (the `pinned`/`portable`/`commodity` tier, which
governs fallback/retry semantics) and `vendor` (which company's model
actually answers the call). They don't interact — switching vendor never
changes a step's fallback behavior, and switching tier never changes which
company runs the call. A `ModelPolicy` with no `vendor` set means `anthropic`,
so every agent written before vendor selection existed keeps working
unchanged.

Four vendors exist today, each behind its own `ModelAdapter`
(`packages/core/src/router/adapters/`):

- **`anthropic`** — Claude, via the route described above. The router's only
  required vendor.
- **`gemini`** — Google's own models, via `@google/genai`. Agent Platform
  (Vertex AI backend, ADC) by default, or the direct Gemini Developer API with
  `GEMINI_API_KEY`.
- **`model-garden`** — third-party/open Model Garden partner models (Llama,
  Mistral, and similar) through Agent Platform's Model-as-a-Service
  OpenAI-compatible endpoint, ADC-authenticated.
- **`openai-compatible`** — the real OpenAI API, or a self-hosted gateway
  (LiteLLM) fronting whatever it fronts.

`gemini`, `model-garden`, and `openai-compatible` are each optional: the
router builds one only when its own env vars (`.env.example`) are present. A
step whose `modelPolicy.vendor` names an unconfigured vendor fails loudly and
specifically at the point of use — `DefaultModelRouter` names the exact env
vars that vendor needs — rather than at server startup, so a deployment that
never touches non-Anthropic models needs none of this configured.

**Switching a step's vendor without touching its code:** every step now
resolves its `modelPolicy` through `resolveModelPolicy(stepId, defaultPolicy)`
(`packages/core/src/router/step-model-policy.ts`), which checks
`MODEL_STEP_<STEP_ID>_VENDOR` / `MODEL_STEP_<STEP_ID>_MODEL` before falling
back to the code default. `<STEP_ID>` is the step's own `id`
(`AgentStepConfig.id`), upper-cased with non-alphanumeric runs collapsed to
one underscore — `blog-draft` → `BLOG_DRAFT`. Setting the vendor without also
setting the model throws at startup, since a step's default model id is
shaped for its default vendor and won't resolve against a different one:

```bash
MODEL_STEP_BLOG_DRAFT_VENDOR=gemini
MODEL_STEP_BLOG_DRAFT_MODEL=gemini-2.5-pro
```

**Switching a step's vendor in code:** set `vendor` directly on its
`modelPolicy` literal, e.g.
`resolveModelPolicy("blog-draft", { policy: "pinned", model: "gemini-2.5-pro", vendor: "gemini" })`.

A fallback model (`portable`/`commodity` tiers) always resolves against the
*same* vendor as the primary model — swapping vendor and model together on a
transient failure would silently change the structured-output mechanism,
pricing, and failure mode all at once, which is the one thing a fallback path
should never do.

See `.env.example` for every vendor's exact env vars, including per-model
region pins for `gemini` and `model-garden`.

## Running jobs from a queue (Pub/Sub)

`packages/queue` is a vendor-agnostic job-queue transport behind one
`QueueAdapter` interface (`publish(topic, payload)` / `subscribe(subscription,
handler)`), the same design this repo already uses for model vendors
(`ModelAdapter`). Google Cloud Pub/Sub is the only implemented provider today
(`QUEUE_PROVIDER=pubsub`, the default) — swapping providers later means
writing one new adapter class and adding one branch to
`createQueueFromEnv` (`packages/queue/src/create-queue-from-env.ts`); no
publisher or consumer anywhere in this repo would need to change.

The concept: a message published to a topic, shaped
`{clientSlug, productId, runKind}`, triggers a run — the exact same
"start a run" logic `POST /api/v1/runs/start` uses
(`apps/agent-server/src/run-job.ts`'s `startRunJob`), not a second, parallel
code path. Only *starting* a run is wired through the queue today; resuming a
run paused at a human gate is not — that stays an explicit HTTP call
(`POST /api/v1/runs/:runId/resume`), since a gate resolution is a deliberate
human action, not something a queue naturally models.

### Local testing

No public URL needed — this uses Pub/Sub's *pull* delivery instead of push:

```bash
npm run dev:queue-consumer                          # starts the pull consumer
npm run demo:queue-publish linkedin-agent acme       # publishes one run-job message
```

The consumer prints the run's outcome as soon as the message arrives. Both
commands need only `PUBSUB_PROJECT_ID` (or `GOOGLE_CLOUD_PROJECT`) and ADC —
`gcloud auth application-default login`, same as every other GCP-backed piece
of this repo.

### Production: the pull consumer on a dedicated worker

**What is actually deployed** — read from the running subscriptions, not from
this file: one PULL subscription, `karos-agent-runs-<env>-pull`, consumed by
`agent-engine-<env>-worker`, a separate Cloud Run service running
`queue-consumer.js` with `--min-instances=1` and `--no-cpu-throttling`. There
is **no push subscription in any environment.**

This section used to recommend push and describe it as the production model.
That was a design intent and it never shipped. The push route
(`POST /api/v1/queue/pubsub-push`) is still wired and still verified — AU2
proved it REFUSES a plain invoker token once the audience became the full
endpoint path — but nothing pushes to it today, so that proof is about a door
nobody knocks on.

Why the worker suits this workload, whatever the original argument said: a run
takes minutes and does CPU-bound work (Chromium renders, video). Cloud Run
throttles CPU outside request processing, so the properties the worker sets
deliberately — `--no-cpu-throttling`, `min-instances=1`, a 600s ack deadline —
are not overhead to be avoided. They are the requirement. AU66 measured what
happens without them: a render that dies nine minutes after its request ended.

The original argument for push, kept because it is still true of push and
explains the trade: A persistent pull consumer,
by contrast, needs a process kept alive between messages — on Cloud Run that
means `--no-cpu-throttling` or `--min-instances=1`, plus reconnect handling
for a streaming-pull connection that can drop — a whole class of operational
concerns push sidesteps entirely. (The pull consumer script is still there
for local testing, and as an option if a dedicated worker is ever preferred
over push for some other reason.)

One-time setup, per GCP project:

```bash
gcloud pubsub topics create agent-engine-run-jobs
gcloud pubsub topics create agent-engine-run-jobs-dlq

gcloud pubsub subscriptions create agent-engine-run-jobs-push \
  --topic=agent-engine-run-jobs \
  --push-endpoint=https://YOUR-SERVICE-URL/api/v1/queue/pubsub-push \
  --push-auth-service-account=YOUR-PUSH-SA@YOUR-PROJECT.iam.gserviceaccount.com \
  --dead-letter-topic=agent-engine-run-jobs-dlq \
  --max-delivery-attempts=5
```

Grant the push service account permission to actually invoke this (private)
Cloud Run service:

```bash
gcloud run services add-iam-policy-binding agent-engine-server \
  --member="serviceAccount:YOUR-PUSH-SA@YOUR-PROJECT.iam.gserviceaccount.com" \
  --role="roles/run.invoker"
```

Then close the one real chicken-and-egg: `PUBSUB_PUSH_AUDIENCE_URL` has to be
the service's own URL, which Cloud Run only assigns at deploy time. Deploy
once, note the URL, then set it:

```bash
gcloud run services update agent-engine-server \
  --update-env-vars=PUBSUB_PUSH_AUDIENCE_URL=https://YOUR-SERVICE-URL/api/v1/queue/pubsub-push
```

Whoever publishes (karosCMO/Portal, or anything else) needs
`roles/pubsub.publisher` on `agent-engine-run-jobs` — nothing on this
service's own side changes for that.

### Redelivery can't double-run a job

Pub/Sub is at-least-once delivery: the same message can legitimately arrive
twice. The push route (and the pull consumer) both derive the run's `runId`
deterministically from Pub/Sub's own message id (`` `pubsub-${messageId}` ``)
rather than generating a fresh one — a redelivery of the same unacked message
reuses that same message id, so it always lands on the same `runId`. And
`WorkflowEngine.run()` already treats re-invoking an existing `runId` as safe
by construction (every step it already ran is checkpointed and short-circuits
rather than re-executing) — so a redelivered message can reach this endpoint
a second time without ever spending a second model call. No extra
idempotency tracking was built for this; it falls entirely out of a
deterministic id plus the durable-step-store guarantee RFC-01 §8.4a already
relies on.

## Status of the source specs

Both RFCs were produced from a direct read of the live `karosCMO` repository
(types, the Dynamic Agent Studio contracts, `agent-service`'s state layer) as
of August 2026. Re-verify anything version-specific (model names, package
versions, exact field names) against the current `karosCMO` state before
relying on it — the codebase moves faster than this document.
