export interface SplitResult {
  flushed: string;
  remainder: string;
}

const ABBREVIATIONS = new Set([
  "dr",
  "mr",
  "mrs",
  "ms",
  "prof",
  "sr",
  "jr",
  "jan",
  "feb",
  "mar",
  "apr",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
  "am",
  "pm",
  "a.m",
  "p.m",
  "vs",
  "etc",
  "approx",
  "dept",
  "est",
  "st",
]);

const SENTENCE_END = /([.!?]+)\s+/g;

/**
 * Split streaming text into a complete sentence prefix (flush to TTS) and a remainder
 * still waiting for a sentence end. Avoids splitting on common abbreviations and decimals.
 */
export function extractCompleteSentences(text: string): SplitResult {
  let lastValidEnd = -1;
  let match: RegExpExecArray | null;

  SENTENCE_END.lastIndex = 0;

  while ((match = SENTENCE_END.exec(text)) !== null) {
    const endPos = match.index;
    const afterPunct = match.index + match[0].length;

    const before =
      text.slice(0, endPos).split(/\s+/).pop()?.replace(/[,;:]+$/, "").toLowerCase() ??
      "";

    if (ABBREVIATIONS.has(before)) continue;

    if (/\d$/.test(before)) continue;

    lastValidEnd = afterPunct;
  }

  if (lastValidEnd === -1) {
    return { flushed: "", remainder: text };
  }

  return {
    flushed: text.slice(0, lastValidEnd).trim(),
    remainder: text.slice(lastValidEnd),
  };
}
