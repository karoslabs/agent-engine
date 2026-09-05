import type { SocialMediaPlan } from "@agent-engine/workflow";
import type { LinkedInPostOutput } from "../agent/linkedin-draft-agent.js";
import type { LinkedInIdentity } from "./types.js";

/**
 * Renders this run's single draft into the exact `# LinkedIn drafts` shape
 * karosCMO's `li-drafts.ts` parser expects (`# LinkedIn drafts` title / `##
 * Account N · <name>` / `### Post N · <archetype>` / a `> ` blockquote / a
 * `` `NNN chars` `` line / `- **` meta bullets — docs/linkedin-agent-portal.md
 * in karosCMO). One post, one run (RFC-02 §5), so this is always exactly one
 * account section with one post block.
 *
 * 2026-09: two more meta bullets the parser already understands — `Media:`
 * (it reads the names into `mediaNames` so the reviewer can attach the file)
 * and a `Takeaway:` line for the calendar view.
 *
 * Persisted alongside the existing structured `draft` object (additive, see
 * step 16's own call site), not in place of it.
 */
export function renderLinkedInDraftsMarkdown(input: {
  identity: LinkedInIdentity;
  companyName?: string;
  archetype: string;
  topic: string;
  draft: LinkedInPostOutput;
  media?: SocialMediaPlan | undefined;
}): string {
  const { identity, companyName, archetype, topic, draft, media } = input;
  const accountTitle =
    identity.scope === "executive"
      ? `${identity.executiveName}${identity.executiveTitle ? ` (${identity.executiveTitle})` : ""}`
      : companyName
        ? `${companyName} — Company page`
        : "Company page";
  const archetypeLabel = archetype.charAt(0).toUpperCase() + archetype.slice(1).replace(/-/g, " ");
  const quoted = draft.text
    .split("\n")
    .map((line) => (line.length > 0 ? `> ${line}` : ">"))
    .join("\n");

  const meta: string[] = [`- **Topic:** ${topic}`, `- **Takeaway:** ${draft.takeaway}`];
  if (media?.asset !== undefined) {
    const credit = media.asset.requiresCredit && media.asset.creditUrl ? ` · credit ${media.asset.creditUrl}` : "";
    meta.push(`- **Media:** ${media.asset.url ?? media.asset.path}`, `- **Media source:** ${media.status}, ${media.asset.provider}${credit}`);
  }

  return ["# LinkedIn drafts", "", `## Account 1 · ${accountTitle}`, "", `### Post 1 · ${archetypeLabel}`, "", quoted, "", `\`${draft.text.length} chars\``, "", ...meta].join("\n");
}
