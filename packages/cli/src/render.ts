import type { Dimension, ScoreRecord } from "@builder/types";
import { DIMENSIONS, displayScore } from "@builder/types";

/** Terminal rendering. Kept apart from analysis so output is easy to change. */

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";

function styled(code: string, text: string): string {
  // Honour NO_COLOR, and drop styling when piped so output stays greppable.
  return process.stdout.isTTY && !process.env.NO_COLOR ? `${code}${text}${RESET}` : text;
}

export function bar(value: number, width = 20): string {
  const filled = Math.max(0, Math.min(width, Math.round((value / 100) * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

export interface ProfileViewData {
  record: ScoreRecord;
  handle?: string;
  sources: { source: string; sessions: number; events: number }[];
  episodes: number;
  commits: number;
  repos: number;
  missingSignals: string[];
}

export function renderProfile(d: ProfileViewData): string {
  const out: string[] = [];
  const r = d.record;
  out.push("");
  out.push(styled(BOLD, `  BUILDER PROFILE${d.handle ? `  ·  ${d.handle}` : ""}`));
  out.push("");

  for (const dim of DIMENSIONS) {
    const s = r[dim as Dimension];
    // Doc 4 §6 keeps capability and confidence separate in the UI; a low
    // confidence must be visible next to the number it qualifies.
    const flag = s.confidence < 0.6 ? styled(DIM, "  low confidence") : "";
    out.push(
      `  ${dim.toUpperCase().padEnd(12)} ${String(s.score).padStart(6)}  ${bar(s.score)}  ` +
        `${styled(DIM, s.confidence.toFixed(2))}${flag}`,
    );
  }

  out.push("");
  out.push(
    `  ${styled(BOLD, "PROOF SCORE")}   ${styled(BOLD, displayScore(r.composite_score).toLocaleString().padStart(6))}` +
      styled(DIM, `      composite ${r.composite_score.toFixed(2)} / 100`),
  );
  out.push(`  CONFIDENCE      ${r.confidence.toFixed(2)}`);
  out.push("");
  out.push(styled(DIM, "  EVIDENCE"));
  for (const s of d.sources) {
    out.push(
      styled(DIM, `    ${s.source.padEnd(16)} ${String(s.sessions).padStart(4)} sessions  ${s.events.toLocaleString().padStart(9)} events`),
    );
  }
  out.push(styled(DIM, `    ${"episodes".padEnd(16)} ${String(d.episodes).padStart(4)}`));
  out.push(styled(DIM, `    ${"repositories".padEnd(16)} ${String(d.repos).padStart(4)}`));
  out.push(styled(DIM, `    ${"commits".padEnd(16)} ${String(d.commits).padStart(4)}`));
  if (d.missingSignals.length > 0) {
    out.push("");
    out.push(styled(DIM, `  NOT OBSERVABLE BY YOUR TOOLS`));
    out.push(styled(DIM, `    ${d.missingSignals.join(", ")}`));
    out.push(styled(DIM, `    scored around, not counted as zero`));
  }
  out.push("");
  return out.join("\n");
}
