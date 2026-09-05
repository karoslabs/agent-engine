# RFC-12 — Social agents, elite tier: media, trend-jacking, platform craft, model routing

**Date:** 2026-09-05 · **Branch:** `feat/social-agents-elite` · **Status:** implemented and verified offline (build, typecheck, every touched suite green); no live prep run yet.

This document is the review of the four content agents (X, LinkedIn, Instagram, TikTok) against the elite-tier bar, and the record of what changed. It is written so a reader who did not watch the work can see, per agent, what was wrong, what changed, what the updated flow looks like, and which model each step should run on in Agent Studio.

## 0. What was wrong, in one table

| Area | X | LinkedIn | Instagram |
| --- | --- | --- | --- |
| Media | none — `mediaRefs` always `[]` | no media field at all | tiered pipeline, but every image judged from alt text; client uploads never read |
| Research → draft | draft got a **headline**; sources never reached the writer; numbers gate fed a URL | same | facts extracted by a Sonnet step; fine |
| Trends | one query, `${industry} trends this week`, first headline with a digit wins | same, 7-day window | fallback topic was the query itself |
| Brand fit | none | none | none |
| Topic mix | lane rotation (6 lanes) | archetype rotation (11) | none |
| Platform shape | threads forbidden; no media brief | "short paragraphs" as a prompt wish only; no takeaway | carousel only, 6–8 slides |
| Models | Sonnet for everything | Sonnet for everything | Sonnet for everything, including extraction and QA |

## 1. Shared layer (used by all three, TikTok can adopt it)

### 1.1 Media tools — `packages/tools/karos-media`

Four new tools, all registered unconditionally and honest per call (`not_available` when unconfigured), same contract as every other capability here.

| Tool | What it does | Backend | Provenance |
| --- | --- | --- | --- |
| `media.inspectImages` | A vision model reads up to 12 images (cached files or URLs): description, subjects, legible text, mood, watermark / screenshot / AI-look tells, usability grade, and a 0–5 fit score against a brief. Never selects. | Gemini 2.5 Flash on Vertex, same credential as `image.generate` | n/a |
| `media.harvestArticleImages` | The lead / `og:image` of the articles a post cites, via the scraper's `extractUrl` then meta tags. | ScrappyCoco | `unknown`, publisher-owned, credit line carried |
| `media.screenshotPage` | Above-the-fold capture of the cited page at card size (1200×675 for X, 1200×1200 for LinkedIn). | Playwright Chromium (already in the image) | `unknown`, third-party page, credit carried |
| `media.stageAsset` | Uploads a cached file to the GCS media store and returns a signed URL so a LinkedIn/X deliverable carries a picture the portal can re-host. | `GCS_MEDIA_BUCKET` | — |

`createKarosMediaTools` gained `mediaStore` and `browserLauncher` options; `apps/agent-server/src/wiring/tools.ts` passes the media store it already builds.

### 1.2 Media resolver — `packages/workflow/src/primitives/social-media.ts`

`analyzeAttachedMedia` runs **before drafting**: a client upload is ingested and described by the vision model, and the description reaches the writer as `attachedMedia` (subjects, text in image, mood, a suggested angle). The copy is written *to* the picture.

`resolveSocialMedia` runs **after every text gate**, answers the draft's own `mediaBrief`, and never holds a run:

```
attached upload  →  screenshot of the cited page  →  cited article's lead image  →  stock/CC  →  AI generation
   (wins always)     (only for kind: screenshot)      (vision fit ≥ 3, no watermark)    (query)     (LAST, photo briefs only)
```

Every sourced candidate is vision-judged against the brief when the tool is available. Generation carries a fixed realism direction (photorealistic editorial, natural light, no render sheen, no surreal elements, no close-up faces) on top of the client's brand art direction. A brief of `needsVisual: false` is a complete, valid answer and costs no tool call.

### 1.3 Trend scout and content mix — `packages/workflow/src/primitives/social-trend-scout.ts`

- `buildTrendQueries`: research asks several questions per run — `<industry> news this week`, `<industry> launch announcement funding acquisition report`, `"<company>" news`, plus the client's standing `trendQueries` from `client/config.json` (e.g. Geektime: `"OpenAI new model"`, `"Israeli startup exit"`), capped at 4, most specific first.
- `pullTrendResearch`: one checkpointed step, every query through `research.pull` (cached, egress-bound), documents merged and de-duplicated by URL.
- `runTrendScout`: a `DynamicAgent` (inline prompt, same footing as the topic guardrail — shared by three agents, owned by none) on **Gemini 2.5 Flash** returns 3–8 grounded candidates, each with `brandFit` 1–5 and the bridge sentence, `mode` (`hot-news` / `deep-value` / `open-discussion`), angle, hook, why-now, source URLs, `hasNumbers`, `mediaHint`, plus a `skipped` list with reasons. Below `MIN_BRAND_FIT = 3` nothing is forced.
- `selectContentMode`: never the prior mode, least-used first, weights deep-value 40 / hot-news 35 / open-discussion 25. Survives across runs inside the decision summary (`(… mode: hot-news)`), exactly as the X lane does.
- `selectTrendCandidate`: brand fit, then a citable number, then recency; the requested mode is a steer, not a wall.

When the scout runs: only where the old code fell back to "first headline with a digit" — no typed topic, no configured topic, empty catalog. A planned catalog row still wins by default; `trendJacking: "always"` in client config lets a fresh brand-fit ≥ 4 story preempt it.

## 2. X agent — updated flow

```
00 intake (xHandle, forbiddenTopics, trendQueries, xAllowThreads, trendJacking, requestedMode)
01 client context (profile, brand, voice, account charter)
02 beliefs · 03 decisions (lane + mode history)
04 research pull — MULTI-QUERY, merged                     ← changed
05 extract fallback candidate
06 reserve catalog topic
04e past feedback · read-output-history · read-intel-context (intel report + knowledge base)
07a trend scout (Gemini Flash) — only when nothing planned  ← new
07b select content mode (rotation)                          ← new
07 select candidate: typed → configured → catalog → trend → research fallback
08 select lane — narrowed to the mode's lanes               ← changed
09 engagement cap
09b analyze attached media (vision) — only when attached    ← new
10 draft (Sonnet): gets research digest, trend candidate, mode, attached media, thread permission
10a verified dedupe (whole post incl. thread)
11 numbers sourced — against source TEXT + intel + topic    ← fixed
12 brand compliance (whole post)
13 link placement (every part)
13b verify thread — ≤7 posts, each ≤280, charter allows     ← new
14 render preview · 14c placeholder · 14d leak
14e resolve media (brief → tiers → vision → stage)          ← new
topic guardrail
15 human review (payload: thread, media URL + rationale, mode, why-now, brand-fit bridge)
18/19 deliverable (mediaRefs = staged URL, media block, thread, 1/N DRAFTS.md markers) · 20 decision (lane, angle, mode)
```

Schema: `thread: string[]` (parts 2..N), `mediaBrief`. Prompt `x-craft@5`: read-first block, the three modes, honest trend-jacking (the bridge in the first two lines), research use, threads only when earned, screenshots/data over illustration, machine-writing tells named. Client config keys: `trendQueries`, `xAllowThreads` (default true), `trendJacking`, run input `requestedMode`.

## 3. LinkedIn agent — updated flow

Same spine as X with these differences:

- **07b** content mode steers which archetype **family** step 08 draws from (`ARCHETYPES_FOR_MODE`: hot-news → industry-reaction / contrarian; deep-value → teardown, lesson, customer story, build-in-public, milestone, origin; open-discussion → community question, contrarian, vulnerability, hiring). All eleven stay reachable; the never-repeat rule still applies inside the family.
- **09b verify formatting**: the post is re-flowed **deterministically** (`reflowLinkedInText`: one or two sentences per line, a blank line between every line, hashtag rows and lists untouched, script-agnostic so Hebrew works) without changing a word, then `checkLinkedInFormatting` reports what could not be fixed (a 300-character sentence, a takeaway the model stated but never wrote into the text) as **notes for the reviewer, never a hold**. The recorded excerpt and every gate see the reflowed text.
- Schema: `takeaway` (required, must appear in `text`), `mediaBrief`. Prompt `linkedin-craft@5`: the shape spec (short lines, double spacing, 900–1,600 chars), the takeaway line, real photo / document screenshot over stock, the modes, trend-jacking, research use.
- DRAFTS.md gains `Takeaway:` and `Media:` bullets (the portal's `li-drafts.ts` already reads `Media:` into `mediaNames`).

## 4. Instagram agent — what changed

- **Format**: `format: "carousel" | "single"`. Source of truth: run input `requestedFormat` → client config `instagramFormat` (`carousel` / `single` / `auto`) → `carousel`. `auto` makes every third post a single image with a deep caption (600–1,500 chars, short lines, takeaway, invitation). `checkSlidesData` holds the slide count to the format; QA and the deliverable carry it. Prompt `instagram-copy@11` §12.
- **Trend scout on the fallback path** (03a–03c): when no catalog row and no request, the run pulls the field's news, scouts brand-fit candidates, rotates the mode on the shipped-post count, and researches the winner instead of the literal query `${industry} trends this week`.
- **Vision on attached media** (05z): each upload is described and the description reaches the copy step (`attachedMedia`, §13) so slide N is written to the client's picture N; the vetting candidate carries the same description.
- **Vision on the candidate pool** (05c): before the vetting judgment, every sourced candidate is read by the vision model; unusable / watermarked ones are dropped, the rest carry `[vision: …]` so the text-only vetting agent finally judges what is in frame.
- **Vision on the rendered PNGs** (08a4): each rendered slide is read by the vision model and the readings reach the visual QA step as `renderedInspections` (prompt `instagram-visual-qa@3`), so overlap, cut-off text and near-empty slides are judged from pixels, not from the shape of the JSON.
- **Models**: research extraction, image vetting and visual QA move to Gemini 2.5 Flash on Vertex; copy stays on Sonnet.

## 5. TikTok — verified, not edited

Another session is actively editing `agents/tiktok-agent` (uncommitted changes in the `agent-engine-tiktok` worktree), so nothing there was touched. Against the request:

| Requirement | State in that worktree | Gap |
| --- | --- | --- |
| Full video script | `tiktok-script` agent, `ShortScriptSchema`: `hook`, 3–5 `beats` × (`narration`, `onScreenText`, `visualBrief`, `seconds`), `caption`, `voiceover` decision, `language` | — |
| Verbal hook for the first 3 seconds | `hook` (≤200 chars) is the first line; the prompt calls it "the whole game" | no explicit ≤3-second bound on the spoken hook |
| **Visual** hook for the first 3 seconds | beat 1's `visualBrief` is the opening scene | **missing as a named field** |
| B-roll directions | `visualBrief` per beat (scene, light, motion; no text/logos) | — |
| On-screen text | `onScreenText` per beat (≤8 words) | — |
| Trend research | `tiktok-topic-scout` on Gemini 2.5 Pro, grounded in `research.pull` | can adopt `buildTrendQueries` / `selectContentMode` for the multi-query pull and mode rotation |

Proposed patch for the TikTok session (two fields on `ShortScriptSchema`, one paragraph in `tiktok-script` prompt): `visualHook: string` (what is on screen in the first 3 seconds, a scene the generator can render before any narration lands) and `hookSeconds: 2 | 3`; and hold at the workflow's script gate when beat 1's `seconds` exceeds the hook window without a distinct `visualHook`.

## 6. Model recommendations per step (Agent Studio)

The Studio picks a model per stage by the step id below (`stageModels[stepId]`); a deployment moves a step with `MODEL_STEP_<ID>_VENDOR` / `_MODEL`. The catalog (`model-capabilities.ts`) is the identity authority. "Now" is what this branch ships.

| Step (stage id) | Task | Now | Recommendation | Why |
| --- | --- | --- | --- | --- |
| `social-trend-scout` | read documents, rank, score brand fit | gemini-2.5-flash (gemini) | keep Flash; Pro for outlets whose whole product is being first (Geektime) | breadth + 1M window; ranking not voice; ~1/10 the cost of Sonnet |
| `media.inspectImages` (tool) | vision: describe, fit-score, tells | gemini-2.5-flash | keep | multimodal, cheap, same credential |
| `x-draft` | client-facing copy | claude-sonnet-4-6 | Sonnet; opus-4-8 for founder seats where phrasing is the product | voice; `contentLanguageSensitive` re-points per client language |
| `linkedin-draft` | client-facing copy | claude-sonnet-4-6 | Sonnet; opus-4-8 for executive identity | long-form voice; newsletter moved to Opus for the same reason (PR #49) |
| `instagram-copy` | client-facing copy | claude-sonnet-4-6 | keep | slide copy + deep caption |
| `instagram-research` | extraction | gemini-2.5-flash | keep | read-and-list, structured output |
| `instagram-image-vet` | QA over text | gemini-2.5-flash | keep | runs up to 3× per attempt across tiers |
| `instagram-visual-qa` | QA over structured data + rendered-PNG readings | gemini-2.5-flash | keep | pass/fail with findings; the PNG readings come from `media.inspectImages` (08a4) |
| `guardrail` (topic) | classification | claude-haiku-4-5 | keep | unchanged |
| `tiktok-topic-scout` | ranking | gemini-2.5-pro | Flash is enough for most clients | same job as the social scout |
| `tiktok-script` / `tiktok-commentary` | copy | claude-sonnet-4-6 | keep | voice |
| `tiktok-moment` | whole-episode read | gemini-2.5-pro | keep | the transcript has to fit |

Operational note: Claude on Vertex currently returns 429 on every model in prep and prod and fails over to the direct Anthropic key; Gemini on Vertex works. Moving extraction, vision and QA to Gemini therefore also moves them off the failing route.

## 7. Portal changes (karosCMO, companion PR `feat/social-agents-portal-fields`)

1. `agentEngineProductAcceptsMediaAssets` now returns `true` for `x-agent` and `linkedin-agent`, so the run dialog paints the upload field for them; the helper text says the upload is optional for the text-first channels.
2. New wire fields, read by the engine and rendered as dialog selects: `requestedMode` ("Kind of post": rotate / hot-news / deep-value / open-discussion) on the X draft and LinkedIn post dialogs; `requestedFormat` ("Instagram format": carousel / single / auto) on the social content system dialog. Both have `ENGINE_FIELD_CONTRACT` rows with engine-side evidence; `mediaAssets`' row now lists x-agent and linkedin-agent as readers.
3. Still to do on the portal side: the X materializer's `metaFields` already carries `mediaRefs` (now a staged https URL) — re-hosting it into the asset's image the way carousel slides are re-hosted is a small follow-up in `materialize.ts`.

## 8. Verification

- `npm run build` (41 packages) and root `tsc --noEmit`: clean.
- Suites: x-agent 68/68, linkedin-agent 67/67, instagram-agent 307 passed / 5 skipped (Chromium self-skips), karos-media 9 new + existing, workflow 12 new.
- `scripts/check-prompts.ts`: 28 declared / 28 on disk, every pin agrees. `check-model-pricing.ts`: 0 unpriced. `check-tool-versions.ts`: clean against `origin/main`.
- Not done: a live prep run of each agent. The first three to watch: an X run for a client with `trendQueries` set and an empty catalog (scout path), a LinkedIn run with an attached image (vision + attached path), an Instagram run with `instagramFormat: "auto"` on its third post.
