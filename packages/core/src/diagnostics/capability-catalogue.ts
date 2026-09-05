/**
 * What every capability in this engine needs, what happens when it is missing,
 * and whether anyone decided that on purpose (AU55 / SCRUM-354).
 *
 * ## Why this exists
 *
 * A missing key here does not fail. It removes a capability quietly, and the
 * system runs with a smaller set of options than anyone believes it has. Four
 * confirmed cases in one week, none of which announced themselves:
 *
 *   - `APIFY_TOKEN` absent in prod: venue photography silently degraded to
 *     generic image search for months.
 *   - Unsplash/Pexels/Pixabay absent in prod: three of six image providers.
 *   - `PUBSUB_PUSH_TOKEN` absent: a SECURITY CHECK that skipped itself. Deleted
 *     outright in SCRUM-333 rather than wired — see below.
 *   - karosCMO's `SEGMIND_API_KEY`: the inverse — a secret shipped to
 *     production for code that exists nowhere in the repo.
 *
 * The failure is not degradation. Degradation is usually fine, and some of
 * these absences are deliberate. The failure is degradation NOBODY CAN SEE.
 *
 * So this is not "fail when a key is missing". It is "always be able to answer,
 * per environment, what is switched off and what it costs".
 *
 * ## The rule for writing a row
 *
 * `title` and `whenAbsent` are read by someone deciding whether to issue a key
 * or delete a feature. They must be answerable WITHOUT opening the codebase.
 *
 *   BAD:  "APIFY_TOKEN is missing"
 *   GOOD: "Venue photography — image routes fall back to generic web search"
 *
 * If a row cannot be decided from the report alone, the row is not finished.
 *
 * `rationale` is what makes a row EXPECTED rather than UNEXPLAINED. It must
 * point at a real recorded decision — a ticket, a comment in a deploy file, a
 * README. "Probably fine" is not a rationale; leaving it undefined is the
 * honest answer and puts the row at the top of the report, which is the point.
 */

/** How a capability is faring right now, in this environment. */
export type CapabilityStatus =
  /** Everything it needs is present. */
  | "ACTIVE"
  /** Running, but with fewer sources/options than its full configuration. */
  | "DEGRADED"
  /** Switched off entirely — the capability cannot run at all. */
  | "DISABLED"
  /**
   * Decided, not yet built (the capability-by-product work — shipped without a Jira ticket).
   *
   * The three statuses above all describe CONFIGURATION: something is present,
   * partly present, or absent, and issuing a key changes the answer. This one
   * does not. The thing the variable would configure DOES NOT EXIST YET —
   * separately scheduled work with a ticket. Issuing the key would change
   * nothing.
   *
   * Without this value such a row had nowhere to live. It landed as DISABLED
   * with no rationale, i.e. UNEXPLAINED, i.e. indistinguishable from an
   * oversight — which quietly devalues the one list that is supposed to mean
   * exactly one thing.
   */
  | "PENDING_BUILD";

/** Whether someone decided this, or whether it is a question nobody has been asked. */
export type CapabilityDecision = "EXPECTED" | "UNEXPLAINED";

export interface CapabilityRequirement {
  /** The variable itself. */
  readonly name: string;
  /**
   * `required` — absent means the capability cannot run.
   * `enhances`  — absent means fewer sources/options, capability still runs.
   * `alternative` — one of a set where any ONE satisfies the requirement.
   */
  readonly kind: "required" | "enhances" | "alternative";
}

export interface CapabilityDefinition {
  readonly id: string;
  /** Capability phrasing, not variable phrasing. What a person loses. */
  readonly title: string;
  /** Where it lives, for whoever follows up. */
  readonly owner: string;
  readonly requires: readonly CapabilityRequirement[];
  /** What the system does INSTEAD when this is not fully configured. The most important field. */
  readonly whenAbsent: string;
  /**
   * The recorded decision that makes an absence expected. Undefined means
   * nobody has decided — the row sorts first.
   */
  readonly rationale?: string;
  /**
   * A capability whose absence removes a CHECK rather than a feature. These are
   * holes, not degradations, and are reported separately and first.
   */
  readonly security?: boolean;
  /**
   * Present when the thing this capability configures is scheduled work that
   * has not been built (the capability-by-product work — shipped without a Jira ticket). Forces `PENDING_BUILD` regardless of
   * the environment, because issuing the key would not help.
   *
   * The ticket is what makes the row EXPECTED rather than UNEXPLAINED. It is
   * required, not optional: "not built yet" without a ticket is exactly the
   * unrecorded decision `rationale` exists to catch, and letting it in through
   * a side door would defeat the point.
   */
  readonly pendingBuild?: {
    /** The ticket that scheduled it. */
    readonly ticket: string;
    /** At most a handful of words, for the product headline: "render engine pending development". */
    readonly summary: string;
  };
  /**
   * A short phrase naming what is MISSING, for the one-line product headline
   * ("no transcription key", "render engine pending development"). Required on
   * any capability some product lists in `requires` — a test enforces that —
   * because `title` describes what the capability IS, and a headline needs what
   * it LACKS.
   */
  readonly shortfall?: string;
}

/**
 * Every capability the engine has that depends on configuration.
 *
 * Grounded in the actual reads: each `name` below is read by code somewhere in
 * this repo (`scripts/config-inventory.ts` cross-checks that claim in CI, so a
 * row naming a variable nothing reads fails the build).
 */
export const CAPABILITY_CATALOGUE: readonly CapabilityDefinition[] = [
  // ── Content production ───────────────────────────────────────────────────
  {
    id: "external-research",
    title: "External research — the live sources every content agent draws facts from",
    owner: "packages/tools/karos-research (research.pull, via the karos-scraper seam)",
    requires: [{ name: "SCRAPPYCOCO_API_KEY", kind: "required" }],
    whenAbsent:
      "research.pull reports not_available and content agents HOLD rather than drafting. This is the one absence that stops work outright, deliberately: a placeholder payload is what let every content agent draft from nothing for months.",
    rationale: "packages/tools/karos-research/README.md — the stand-in was replaced by not_available on purpose.",
    shortfall: "no research source",
  },
  {
    id: "seo-geo-ai-visibility-capture",
    title: "SEO & GEO AI-visibility capture — real per-engine answers for research.captureVisibility's captured engines (T-A3/SCRUM-237)",
    owner: "packages/tools/karos-research (research.captureVisibility, packages/tools/karos-research/src/capture-adapters)",
    requires: [
      { name: "PERPLEXITY_API_KEY", kind: "enhances" },
      { name: "GEMINI_API_KEY", kind: "enhances" },
      { name: "OPENAI_API_KEY", kind: "enhances" },
    ],
    whenAbsent:
      "Each engine's cells report UNAVAILABLE/no_adapter_wired, honestly, exactly like every other unconfigured engine — never a fabricated MEASURED/ESTIMATED answer. Claude's capture independently depends on ANTHROPIC_API_KEY, a row elsewhere in this catalogue for another capability, rather than a new credential. GEMINI_API_KEY is carried on THIS row rather than reused from a model-routing row: AU59/SCRUM-358 removed the direct-Gemini model route and its row, so capture is now this variable's only reader — and absent it, Gemini falls back to the Vertex route on ADC, which needs no credential of its own and so has no entry here. OPENAI_API_KEY backs the ChatGPT column via the Responses API's web_search tool; it replaced a ScrappyCoco route that never worked, so SCRAPPYCOCO_API_KEY is no longer read by capture at all (it still backs research.pull's scraper, its own row). Copilot has no route in this build and is out of the fan-out entirely rather than wired to something that throws.",
    rationale: "packages/tools/karos-research/src/capture-visibility.ts's own header comment — an engine with no adapter configured degrades per-engine, never all-or-nothing.",
  },
  {
    id: "image-search-curated",
    title: "Curated stock photography (Unsplash, Pexels, Pixabay)",
    owner: "packages/tools/karos-media (media.findImages)",
    requires: [
      { name: "UNSPLASH_ACCESS_KEY", kind: "enhances" },
      { name: "PEXELS_API_KEY", kind: "enhances" },
      { name: "PIXABAY_API_KEY", kind: "enhances" },
    ],
    whenAbsent:
      "Those providers do not register. Image sourcing still works from the keyless ones (Openverse, Wikimedia, DuckDuckGo) plus generation, but with a smaller pool and weaker licence tiers — keyless sources are 'attributable' or 'unknown' provenance, never 'blanket'.",
    rationale:
      "cloudbuild.promote.yaml records these as deliberately prep-only: the secrets do not exist in the prod project and --set-secrets naming a missing secret fails the deploy.",
    shortfall: "no curated stock photography",
  },
  {
    id: "venue-photography",
    title: "Venue photography — photos verified to be of a specific real place",
    owner: "packages/tools/karos-media (named_venue route)",
    requires: [{ name: "GOOGLE_PLACES_KEY", kind: "required" }],
    whenAbsent:
      "The named_venue route has no place-verified source and falls through to generic image search (DuckDuckGo, Openverse, Wikimedia). A slide asking for a specific venue gets a photo that merely looks plausible, which the rights gate should and usually will refuse.",
    // DECIDED 2026-08 (AU56 / SCRUM-355): option A — issue the key. This row
    // carried no rationale for exactly one working day, which is what it is
    // for: GOOGLE_PLACES_KEY was documented in .env.example and wired in
    // NEITHER cloudbuild, so the route had been falling through both of its
    // intended tiers to generic image search in every environment since it was
    // written, and nothing said so.
    //
    // prep now has the key via Secret Manager (`google-places-key`). PROD DOES
    // NOT — its key has not been created yet, so a prod report still shows this
    // DISABLED. That is correct and intended, and the rationale here is what
    // keeps it EXPECTED rather than a fresh question.
    rationale:
      "AU56 decided to issue the key. prep is wired (Secret Manager: google-places-key); prod's key is not created yet, so prod remains DISABLED until it is.",
    shortfall: "no venue photography",
  },
  {
    id: "image-generation",
    title: "Image generation — original imagery when no library has the subject",
    owner: "packages/tools/karos-media (image.generate)",
    requires: [
      { name: "GEMINI_VERTEX_PROJECT_ID", kind: "alternative" },
      { name: "GOOGLE_CLOUD_PROJECT", kind: "alternative" },
    ],
    whenAbsent: "The generative tier is unavailable; sourcing must find something in a library or the slide goes unfilled.",
    rationale: "Satisfied by GOOGLE_CLOUD_PROJECT, which every deployed environment sets.",
    shortfall: "no image generation",
  },
  {
    id: "vision-inspection",
    title: "Vision inspection — a model that looks at the pictures a post will carry",
    owner: "packages/tools/karos-media (media.inspectImages)",
    requires: [
      { name: "GEMINI_VERTEX_PROJECT_ID", kind: "alternative" },
      { name: "GOOGLE_CLOUD_PROJECT", kind: "alternative" },
    ],
    whenAbsent:
      "A client-attached image is described to the copy step from its upload label only, so the words are written beside the picture rather than to it; sourced candidates are judged from provider alt text and licence lines alone, so a watermark or a cookie-wall screenshot is caught only if the text happens to say so.",
    rationale: "Same Vertex credential as image generation; satisfied by GOOGLE_CLOUD_PROJECT, which every deployed environment sets.",
    shortfall: "images judged from text, not pixels",
  },

  // ── Video ────────────────────────────────────────────────────────────────
  {
    id: "video-transcription",
    title: "Video transcription — turning a source video into the transcript every clip decision is made from",
    owner: "packages/tools/karos-video (video.transcribe)",
    requires: [{ name: "ELEVENLABS_API_KEY", kind: "required" }],
    whenAbsent:
      "video.transcribe reports not_available, so branded-shorts and tiktok runs cannot plan a cut at all. WIRING THIS ALONE PRODUCES NOTHING: the transcript feeds a renderer that does not exist yet (video-engine, SCRUM-362), so a run with a transcription key and no engine gets further before failing and ships exactly as much video as it does today — none. Fixing this is not fixing video.",
    shortfall: "no transcription key",
    rationale: "Decided: the key is to be placed in Secret Manager, then wired (the per-unit cost work — shipped without a Jira ticket round). Absent today because the secret does not exist in either project yet — verified, not assumed.",
  },
  {
    id: "video-engine",
    title: "Video rendering and its craft gates (cut, brand, graphics, colour)",
    owner: "packages/tools/karos-video",
    requires: [{ name: "BRANDED_SHORTS_ENGINE_DIR", kind: "required" }],
    whenAbsent:
      "Every video.* gate returns tooling_error naming the missing engine checkout, and a branded-shorts or tiktok run fails rather than shipping unchecked footage (AU8 made this a real tooling_error outcome rather than a success carrying an error verdict). Pointing the variable at a directory would not change this: there is no engine to point it at.",
    shortfall: "render engine pending development",
    pendingBuild: {
      ticket: "SCRUM-362",
      summary: "render engine pending development",
    },
  },

  // ── Reputation ───────────────────────────────────────────────────────────
  {
    id: "reputation-capture",
    title: "Review capture from Google Business Profile — the credentialed review source",
    owner: "packages/tools/karos-reputation (reputation.capture)",
    requires: [{ name: "GOOGLE_BUSINESS_TOKEN", kind: "required" }],
    whenAbsent:
      "No credentialed review source at all. The GBP leg writes an UNAVAILABLE tombstone instead of reviews, and the pulse runs on only the uncredentialed legs (App Store RSS, and whatever the client exports by hand) — so a client with no App Store presence gets a pulse with no reviews in it. The tombstone keeps that visible rather than letting it read as 'no reviews this month'.",
    shortfall: "no credentialed review source",
  },

  // ── Google first-party connectors (SEO/GEO Layer 1) ──────────────────────
  {
    id: "google-connectors-oauth",
    title: "Google first-party SEO data — Search Console rankings, GA4 AI-referral outcomes, Business Profile listing",
    owner: "packages/tools/karos-connectors (connectors.googleDataSync)",
    requires: [
      { name: "GOOGLE_OAUTH_CLIENT_ID", kind: "required" },
      { name: "GOOGLE_OAUTH_CLIENT_SECRET", kind: "required" },
      { name: "GSC_SERVICE_ACCOUNT_KEY", kind: "enhances" },
      { name: "GSC_SITE_URL", kind: "enhances" },
    ],
    whenAbsent:
      "Every client stays on the SEO/GEO Layer-2 path, which is the validated default and produces a complete, scored, deliverable 0-100 result on its own. What is lost is accuracy and detail, not the score: real Google positions/impressions/clicks show an honest empty state instead of numbers, GEO-01/41's AI-features opt-out leg drops from its denominator (partial credit over the remaining robots legs), GEO-28 reads a proxy labelled 'estimated (proxy)' instead of real AI-surface impressions, and GA4's AI-referral panel shows 'Connect Google Analytics to measure' rather than a fabricated zero. Each connector's snapshot hash resolves to the literal UNCONNECTED.",
    rationale:
      "packages/tools/karos-seo-geo/src/config/connectors-config.data.ts works_unconnected.guarantee — connecting Google is a per-input accuracy upgrade and never a hard dependency; revoking cannot break the product.",
    shortfall: "no Google connection — first-party SEO data unavailable",
  },
  {
    id: "google-connectors-psi",
    title: "Core Web Vitals field data — real-user p75 LCP/INP/CLS from PageSpeed Insights / CrUX",
    owner: "packages/tools/karos-connectors (connectors.googleDataSync)",
    requires: [{ name: "PSI_API_KEY", kind: "required" }],
    whenAbsent:
      "SEO-04 scores from the lab p75 the Lighthouse audit already produces, against the SAME 8/7/5 bands — the Technical/CWV bucket scores in full either way. The field-data swap changes the measured value and its confidence label (estimated -> measured_field), not the formula. Note the key alone does not switch anything: field data is read only for a client who has also set the per-client Google-connect opt-in, so the lab->field move is always a logged per-client source change (Defect-2).",
    rationale: "connectors-config.data.ts crux_per_client_gate, and per_metric_degradation's SEO-04 line.",
    shortfall: "no field CWV — lab p75 only",
  },

  // ── Landing builder ──────────────────────────────────────────────────────
  {
    id: "landing-builder",
    title: "Landing page building — the template kit a generated site is composed from",
    owner: "packages/tools/karos-landing",
    requires: [
      { name: "LANDING_ENGINE_TEMPLATE_ROOT", kind: "required" },
      { name: "LANDING_ENGINE_ROOT", kind: "required" },
    ],
    whenAbsent: "Every landing.* tool returns tooling_error, so landing-builder runs cannot start.",
    rationale: "Both are set in cloudbuild.yaml and cloudbuild.promote.yaml for deploy-http and deploy-worker.",
    shortfall: "no landing template kit",
  },

  // ── Persistence ──────────────────────────────────────────────────────────
  {
    id: "durable-workspace",
    title: "Durable tenant state — brand kits, topics, memory, the deliverable ledger",
    owner: "packages/tools/common (createWorkspaceStoreFromEnv)",
    requires: [{ name: "GCS_WORKSPACE_BUCKET", kind: "required" }],
    whenAbsent:
      "Falls back to LOCAL DISK, silently and without erroring. On Cloud Run that means each instance reads an empty workspace: every client tool returns 'not set up yet' for a fully onboarded client, and anything written vanishes on instance recycle. This is the single most dangerous absence in this table because nothing about it looks like a failure (T-P0b / SCRUM-263).",
    rationale: "Wired in both cloudbuild files for both services, and pinned by apps/agent-server/__tests__/workspace-store-wiring.test.ts.",
    shortfall: "no durable workspace",
  },
  {
    id: "media-artifact-storage",
    title: "Rendered media and archived run output stored outside the container",
    owner: "packages/tools/common (createArtifactStoreFromEnv)",
    requires: [
      { name: "GCS_MEDIA_BUCKET", kind: "enhances" },
      { name: "GCS_ARTIFACTS_BUCKET", kind: "enhances" },
    ],
    whenAbsent:
      "Renders stay on the container's ephemeral disk and are lost on recycle; oversized step output stays inline in Firestore instead of being archived.",
    rationale: "Both wired in cloudbuild for both services.",
    shortfall: "no media storage",
  },
  {
    id: "prompt-store",
    title: "Prompt serving — the craft policy every agent step runs on",
    owner: "packages/core (createPromptStoreFromEnv)",
    requires: [{ name: "PROMPT_STORE_DRIVER", kind: "required" }],
    whenAbsent:
      "Defaults to an EMPTY in-memory store. The server boots clean and then every skillRef resolution fails at run time, so 100% of agent steps degrade with no startup error. Fail-quiet in exactly the way this catalogue exists to surface.",
    rationale: "Set to 'firestore' in both cloudbuild files for both services.",
    shortfall: "no prompt store",
  },

  // ── Observability ────────────────────────────────────────────────────────
  {
    id: "tracing",
    title: "Distributed tracing — per-step latency and failure attribution",
    owner: "packages/telemetry",
    requires: [{ name: "GOOGLE_CLOUD_PROJECT", kind: "required" }],
    whenAbsent: "initTelemetry() is a no-op. Runs still work; nothing is traced, so a slow or failing step cannot be attributed after the fact.",
    rationale: "Set in both cloudbuild files.",
  },
  {
    id: "cost-accounting",
    title: "Cost and token accounting per run",
    owner: "packages/telemetry (BigQuery sink)",
    requires: [
      { name: "BQ_PROJECT_ID", kind: "alternative" },
      { name: "GOOGLE_CLOUD_PROJECT", kind: "alternative" },
      { name: "BQ_DATASET_ID", kind: "enhances" },
    ],
    whenAbsent: "Per-step cost rows are not written. Spend becomes invisible per client and per agent.",
    rationale: "BQ_PROJECT_ID is set in cloudbuild.yaml; prod falls back to GOOGLE_CLOUD_PROJECT, which is correct for that project.",
  },

  // ── Model routing ────────────────────────────────────────────────────────
  {
    id: "model-fallback-anthropic",
    title: "Direct-Anthropic fallback when the Vertex route is rate-limited or a model is unavailable there",
    owner: "packages/core (ResilientClaudeAdapter)",
    requires: [{ name: "ANTHROPIC_API_KEY", kind: "required" }],
    whenAbsent: "A 429 or 404 on the Vertex route has one fewer hop before it reaches the Gemini last resort.",
    rationale: "Wired from Secret Manager in both cloudbuild files.",
  },
  {
    id: "model-vendor-alternatives",
    title: "Non-Anthropic model vendors reached through Vertex AI (Gemini, Model Garden)",
    owner: "packages/core (createModelRouterFromEnv)",
    requires: [{ name: "MODEL_GARDEN_PROJECT_ID", kind: "enhances" }],
    whenAbsent:
      "Model Garden is not built. A step whose modelPolicy names it fails loudly at the point of use naming the exact missing variable — which is correct, and is why this is not a silent degradation. (Gemini's own Agent Platform route needs no separate opt-in beyond GEMINI_VERTEX_PROJECT_ID / GOOGLE_CLOUD_PROJECT, already required elsewhere.)",
    rationale:
      "agent_vendor_switching.md: no agent sets a non-default vendor today, so this is not needed until one does. AU59/SCRUM-358 (Vertex-only model surface) removed the direct-Gemini and OpenAI-compatible routes outright, so they were dropped from this row rather than left as orphaned rows. Nothing reads OPENAI_COMPATIBLE_BASE_URL / OPENAI_COMPATIBLE_API_KEY / OPENAI_API_KEY any more. GEMINI_API_KEY is the exception: no MODEL route reads it, but T-A3/SCRUM-237 reintroduced it for Gemini Grounding visibility capture, so it is a live credential on the seo-geo-ai-visibility-capture row — not here.",
  },

  // ── Security: absences that remove a CHECK, not a feature ────────────────
  {
    id: "push-oidc",
    title: "Pub/Sub push identity verification",
    owner: "apps/agent-server (routes/queue.ts)",
    requires: [{ name: "PUBSUB_PUSH_AUDIENCE_URL", kind: "required" }],
    whenAbsent: "OIDC verification is skipped entirely and any caller past Cloud Run IAM can start a run through the push endpoint.",
    rationale: "Wired in both cloudbuild files for deploy-http (AU2 / SCRUM-288).",
    security: true,
  },
  {
    id: "service-identity-auth",
    title: "Caller authentication on the HTTP API",
    owner: "apps/agent-server (auth/service-identity.ts)",
    requires: [
      { name: "AUTH_ENABLED", kind: "required" },
      { name: "AUTH_AUDIENCE", kind: "required" },
    ],
    whenAbsent:
      "Every route is reachable by anything that can invoke the Cloud Run service, with no application-layer identity check. Tenancy below the API stays structural, but the API itself performs no authorisation.",
    rationale:
      "AUTH_ENABLED shipped false on purpose (AU1 / SCRUM-287) while SCRUM-330 (the portal's fail-open token fetch) was outstanding. SCRUM-331 (AU48) turned it ON in PREP on 2026-09-02, once SCRUM-330 was merged and deployed there; the value is pinned in cloudbuild.yaml rather than injected, so it cannot arrive from outside that file. PRODUCTION stays false until the portal promotion carries SCRUM-330 there — enabling first would turn a metadata blip into an intermittent 401. The worker surface has no AUTH_* variables at all and needs none: it is a Pub/Sub PULL consumer with no inbound HTTP.",
    security: true,
  },
  {
    id: "local-dev-auth-bypass",
    title: "Local development sign-in — a static token standing in for a Google identity",
    owner: "apps/agent-server (auth/service-identity.ts)",
    requires: [{ name: "AUTH_DEV_TOKEN", kind: "enhances" }],
    whenAbsent:
      "curl and a local portal cannot authenticate against a locally-enabled auth setup; they must mint a real Google identity token instead. Absent is the SAFE state, and this row exists so that its PRESENCE is visible: a stray value on a deployment that reads as production is refused outright by isProduction, but the report should still show it rather than leave it unaccounted for.",
    rationale: "Unset everywhere, which is correct. It is refused outright when FIRESTORE_DATABASE_ID is not 'prep', so it cannot become a production bypass.",
    security: true,
  },
  {
    id: "tenant-assertion",
    title: "Tenant entitlement at the HTTP edge",
    owner: "apps/agent-server (auth/tenant-assertion.ts)",
    requires: [
      { name: "TENANT_ASSERTION_ENABLED", kind: "required" },
      { name: "TENANT_ASSERTION_SECRET", kind: "required" },
    ],
    whenAbsent:
      "clientSlug stays caller-asserted: service-identity-auth (above) proves the portal called, but nothing checks that a given request's clientSlug is the one the portal is actually entitled to act for on behalf of. A runId-addressed route (status, resume, deliverables) trusts whichever clientSlug the stored run record names, with no cross-check against who is asking.",
    rationale:
      "AU46 / SCRUM-329, decision 9 (Tomer, 2026-08-28, SCRUM-333 comment 10404): the portal signs a per-request tenant assertion; the engine verifies it. Off by default because the portal-side signer does not exist in karosCMO yet — see docs/decisions/AU46-tenant-identity.md.",
    security: true,
  },
  {
    id: "dynamic-code-steps",
    title: "Dynamic code steps — running Studio-authored code inside a sandbox",
    owner: "packages/dynamic-sandbox",
    requires: [{ name: "DYNAMIC_CODE_STEPS_ENABLED", kind: "required" }],
    whenAbsent: "A dynamic agent definition containing a code stage fails that stage rather than executing it.",
    rationale: "Deliberately off: the module's own comment records that sandbox hardening has had no security review.",
    security: true,
  },
] as const;

/** Every variable named anywhere in the catalogue. `scripts/config-inventory.ts` checks this against what the code actually reads. */
export function catalogueVariables(): readonly string[] {
  return [...new Set(CAPABILITY_CATALOGUE.flatMap((c) => c.requires.map((r) => r.name)))].sort();
}
