/**
 * Which capabilities each product depends on (the capability-by-product work — shipped without a Jira ticket).
 *
 * ## Why this exists
 *
 * AU55's catalogue answers "what is switched off, and what does it cost". It
 * answers that one variable at a time, which is the wrong altitude for the
 * decision anyone actually makes. Four reasonable-looking rows —
 * `video-transcription` DISABLED, `video-engine` DISABLED, and two adjacent
 * media rows DEGRADED — never added up, on the page, to the sentence that
 * mattered:
 *
 *   branded-shorts-agent: UNRUNNABLE — render engine pending development
 *
 * That line is worth more than the four rows it summarises. The rows are not
 * wrong and they are not removed; they move underneath it.
 *
 * ## The rule for writing a row
 *
 * `requires` means what it says: without EVERY one of these, the product
 * cannot produce its deliverable. Do not put a nice-to-have here to signal
 * that it matters — a `requires` entry makes the whole product read
 * UNRUNNABLE, and a product wrongly marked unrunnable trains people to
 * disbelieve the flag.
 *
 * `enhances` is for capabilities that change coverage or quality while the
 * product still ships something. A product with only `enhances` gaps is
 * RUNNABLE, reported DEGRADED.
 *
 * `productId` must match `apps/agent-server/src/wiring/workflows.ts`'s switch
 * exactly. A test asserts both directions, because a product that quietly
 * stops being covered here is precisely the blind spot this file closes.
 *
 * ## What is deliberately absent
 *
 * `cost-accounting` and `tracing` are on NO product. They were, in the first
 * cut, and the result proved the point better than any argument: twelve of
 * thirteen headlines read "DEGRADED — cost-accounting unavailable", which is
 * the same failure this layer exists to fix, inverted. A line that says the
 * same thing about everything says nothing, and it buried the two products
 * that were genuinely dead.
 *
 * They are engine-wide observability, not product capability. A blog post is
 * not a worse blog post because BQ_DATASET_ID is unset. Their catalogue rows
 * still report them, at the level they actually belong to.
 */
export interface ProductCapabilities {
  /** Matches the dispatchable `productId`. */
  readonly productId: string;
  /** How a person refers to it, not the package name. */
  readonly title: string;
  /** Without ALL of these the product cannot produce its deliverable. */
  readonly requires: readonly string[];
  /** Absent means less coverage or lower quality; the product still ships. */
  readonly enhances: readonly string[];
}

/**
 * Every dispatchable product, and what it needs.
 *
 * `external-research` and `durable-workspace` are near-universal on purpose
 * rather than factored into a "base" set: a reader scanning one product's row
 * should see everything that product needs without following an indirection,
 * and the two agents that genuinely do NOT need research (landing-builder,
 * which composes from a template kit, and campaign-orchestrator, which
 * dispatches channel workflows that each pull their own) would be silently
 * wrong under an inherited base.
 */
export const PRODUCT_CAPABILITIES: readonly ProductCapabilities[] = [
  // ── Channel content ──────────────────────────────────────────────────────
  // 2026-09: both text-first channels now source a picture (attached, a
  // screenshot of the cited page, the article's lead image, stock, generation
  // last) and read it with a vision model. Every one of those is an
  // enhancement — the post ships as text without them.
  {
    productId: "x-agent",
    title: "X posts",
    requires: ["external-research", "durable-workspace", "prompt-store"],
    enhances: ["image-search-curated", "image-generation", "vision-inspection", "media-artifact-storage"],
  },
  {
    productId: "linkedin-agent",
    title: "LinkedIn posts",
    requires: ["external-research", "durable-workspace", "prompt-store"],
    enhances: ["image-search-curated", "image-generation", "vision-inspection", "media-artifact-storage"],
  },
  {
    productId: "reddit-agent",
    title: "Reddit posts",
    requires: ["external-research", "durable-workspace", "prompt-store"],
    enhances: [],
  },
  {
    productId: "blog-agent",
    title: "Blog posts",
    requires: ["external-research", "durable-workspace", "prompt-store"],
    enhances: ["image-search-curated", "media-artifact-storage"],
  },
  {
    productId: "newsletter-agent",
    title: "Newsletters",
    requires: ["external-research", "durable-workspace", "prompt-store"],
    enhances: ["image-search-curated", "media-artifact-storage"],
  },
  {
    productId: "campaign-orchestrator",
    title: "Multi-channel campaigns",
    // Dispatches the five channel workflows; each pulls its own research.
    requires: ["durable-workspace", "prompt-store"],
    enhances: ["external-research"],
  },

  // ── Visual content ───────────────────────────────────────────────────────
  {
    productId: "instagram-agent",
    title: "Instagram carousels",
    requires: ["external-research", "durable-workspace", "prompt-store", "media-artifact-storage"],
    enhances: ["image-search-curated", "venue-photography", "image-generation", "vision-inspection"],
  },
  {
    productId: "branded-shorts-agent",
    title: "Branded short-form video",
    requires: ["durable-workspace", "prompt-store", "video-transcription", "video-engine"],
    enhances: ["media-artifact-storage"],
  },
  {
    productId: "tiktok-agent",
    title: "TikTok video",
    requires: ["external-research", "durable-workspace", "prompt-store", "video-transcription", "video-engine"],
    enhances: ["media-artifact-storage"],
  },

  // ── Sites and reports ────────────────────────────────────────────────────
  {
    productId: "landing-builder-agent",
    title: "Landing pages",
    // Composes from the shipped template kit; it does not pull live research.
    requires: ["durable-workspace", "prompt-store", "landing-builder"],
    enhances: ["image-search-curated", "media-artifact-storage"],
  },
  {
    productId: "reputation-agent",
    title: "Reputation pulse",
    requires: ["durable-workspace", "prompt-store"],
    // Not `requires`: with no credentialed source the pulse still runs on App
    // Store RSS and hand exports, and the UNAVAILABLE tombstones keep the gap
    // visible. See the reputation-capture row for what that actually costs.
    enhances: ["reputation-capture"],
  },
  {
    productId: "seo-geo-agent",
    title: "SEO/GEO visibility reports",
    requires: ["external-research", "durable-workspace", "prompt-store"],
    enhances: [],
  },
  {
    productId: "intel-report-agent",
    title: "Competitive intel reports",
    requires: ["external-research", "durable-workspace", "prompt-store"],
    enhances: [],
  },
];
