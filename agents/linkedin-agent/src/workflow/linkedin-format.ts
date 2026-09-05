/**
 * LinkedIn formatting: short lines, a blank line between them, a clear
 * takeaway (2026-09).
 *
 * ## Why code and not only prompt
 *
 * The craft prompt has asked for "short paragraphs separated by a blank line"
 * since v1, and a Sonnet draft honours it most of the time. Most of the time
 * is the wrong bar for the one thing every LinkedIn reader sees before a word
 * registers: the shape of the post. A four-sentence paragraph reads as a wall
 * on a phone, and the "see more" fold cuts it mid-thought. So the SHAPE is
 * enforced deterministically here and the prompt keeps the judgment calls
 * (which sentence leads, where the takeaway lands).
 *
 * `reflowLinkedInText` changes only whitespace: it never rewrites, reorders
 * or drops a character of the model's prose, so every content gate that runs
 * after it judges exactly the words the model wrote. `checkLinkedInFormatting`
 * then reports what the reflow could not fix (a single 300-character sentence)
 * as notes for the reviewer — a note, never a hold, because a long sentence is
 * an editorial call and a fixed threshold is not entitled to overrule the
 * person reviewing at 15.
 */

/** A line longer than this is flagged; the reflow tries to split anything with more than one sentence well before it. */
export const MAX_LINE_CHARS = 240;
/** The hook line has to survive the fold on a phone; LinkedIn shows roughly 140-210 characters before "see more". */
export const MAX_HOOK_CHARS = 210;
/** How many sentences one line may carry before it is split one-per-line. */
const MAX_SENTENCES_PER_LINE = 2;

/** A hashtag-only line, a list item, or a quote — kept exactly as written, never reflowed. */
const STRUCTURAL_LINE = /^(#\S+(\s+#\S+)*|[-•*·]\s.+|\d{1,2}[.)]\s.+|>\s.+)$/u;

/**
 * Sentence boundaries: a terminator (with an optional closing quote or
 * bracket) followed by whitespace and a non-space character. Script-agnostic
 * on purpose — Hebrew and Arabic have no capitals to key on — and tolerant of
 * decimals ("3.5 percent" does not split) because the terminator must be
 * followed by whitespace.
 */
const SENTENCE_BREAK = /(?<=[.!?…][”"')\]]?)\s+(?=\S)/u;

export function splitSentences(paragraph: string): string[] {
  return paragraph
    .split(SENTENCE_BREAK)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Re-flows a post into LinkedIn's shape without touching a word.
 *
 * - Paragraphs (blank-line separated) are the unit. Within a paragraph, a
 *   single newline is treated as the author's own break and kept.
 * - A paragraph with more than `MAX_SENTENCES_PER_LINE` sentences, or one
 *   longer than `MAX_LINE_CHARS`, is split one sentence per line, each its
 *   own paragraph.
 * - Structural lines (hashtags, list items, quotes) are never split, and a
 *   run of list items stays together as one block.
 * - Exactly one blank line between paragraphs; no leading/trailing blank lines.
 */
export function reflowLinkedInText(text: string): string {
  const normalized = text.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
  if (normalized.length === 0) return normalized;
  const paragraphs = normalized.split(/\n{2,}/);
  const out: string[] = [];
  for (const paragraph of paragraphs) {
    const lines = paragraph.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    if (lines.length === 0) continue;
    // A block of structural lines (a list, a hashtag row) stays one block.
    if (lines.every((l) => STRUCTURAL_LINE.test(l))) {
      out.push(lines.join("\n"));
      continue;
    }
    for (const line of lines) {
      if (STRUCTURAL_LINE.test(line)) {
        out.push(line);
        continue;
      }
      const sentences = splitSentences(line);
      if (sentences.length <= MAX_SENTENCES_PER_LINE && line.length <= MAX_LINE_CHARS) {
        out.push(line);
        continue;
      }
      // Too many sentences, or too long: one sentence per line. Two very
      // short sentences in a row may share a line (never three) so a staccato
      // pair is not scattered across the post.
      let buffer = "";
      let bufferedSentences = 0;
      for (const sentence of sentences) {
        if (bufferedSentences === 1 && buffer.length + 1 + sentence.length <= 90) {
          buffer = `${buffer} ${sentence}`;
          bufferedSentences = 2;
          continue;
        }
        if (buffer.length > 0) out.push(buffer);
        buffer = sentence;
        bufferedSentences = 1;
      }
      if (buffer.length > 0) out.push(buffer);
    }
  }
  return out.join("\n\n");
}

export interface LinkedInFormattingReport {
  ok: boolean;
  /** Human-readable findings for the reviewer. Empty when the shape is clean. */
  notes: string[];
  lineCount: number;
  longestLine: number;
}

/**
 * Reports what is still wrong with a post's SHAPE after the reflow. Content
 * is not judged here; the gates do that.
 */
export function checkLinkedInFormatting(text: string, takeaway?: string): LinkedInFormattingReport {
  const lines = text.split("\n");
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  const notes: string[] = [];
  const longestLine = nonEmpty.reduce((max, l) => Math.max(max, l.length), 0);

  const hook = nonEmpty[0] ?? "";
  if (hook.length > MAX_HOOK_CHARS) {
    notes.push(`the opening line runs ${hook.length} characters; LinkedIn folds the post at roughly ${MAX_HOOK_CHARS}, so the hook is cut mid-thought on a phone`);
  }
  for (const line of nonEmpty) {
    if (line.length > MAX_LINE_CHARS && !STRUCTURAL_LINE.test(line)) {
      notes.push(`a line runs ${line.length} characters (${line.slice(0, 40)}…); one sentence per line reads better on LinkedIn`);
    }
  }
  // Consecutive non-blank prose lines: the reflow inserts blank lines, so a
  // run here means a structural block, which is fine — flag only prose walls.
  let run = 0;
  for (const line of lines) {
    if (line.trim().length === 0) {
      run = 0;
      continue;
    }
    if (STRUCTURAL_LINE.test(line.trim())) {
      run = 0;
      continue;
    }
    run += 1;
    if (run === 3) notes.push("three or more prose lines run together without a blank line between them");
  }
  if (takeaway !== undefined && takeaway.trim().length > 0 && !normalizeForMatch(text).includes(normalizeForMatch(takeaway))) {
    notes.push("the stated takeaway does not appear in the post text; the reader never gets the one line they should remember");
  }
  return { ok: notes.length === 0, notes, lineCount: nonEmpty.length, longestLine };
}

function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(/[“”"'‘’]/g, "").replace(/\s+/g, " ").trim();
}
