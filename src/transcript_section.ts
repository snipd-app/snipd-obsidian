/**
 * A note can end with a full episode transcript section, or a short callout in its place.
 * Syncs keep the transcript: new snips go above it, and a full rewrite carries it over.
 */

export const TRANSCRIPT_HEADER = '## Full episode transcript';
export const SNIPD_FOOTER = 'Created with [Snipd](https://www.snipd.com) | Highlight & Take Notes from Podcasts';

export function findTranscriptHeaderIndex(content: string): number {
  // Whole-line match only: the header text can also occur inside snip content.
  const lines = content.split('\n');
  let offset = 0;
  for (const line of lines) {
    if (line.trim() === TRANSCRIPT_HEADER) {
      return offset;
    }
    offset += line.length + 1;
  }
  return -1;
}

export function spliceBeforeTranscriptHeader(existingContent: string, newSnipsBlock: string): string {
  const idx = findTranscriptHeaderIndex(existingContent);
  if (idx < 0) {
    return existingContent.trimEnd() + '\n' + newSnipsBlock;
  }
  return existingContent.slice(0, idx) + newSnipsBlock + (newSnipsBlock.endsWith('\n') ? '' : '\n') + existingContent.slice(idx);
}

/**
 * A full rewrite from the server has no transcript section; keep the one the existing note has
 * instead of silently dropping it. A callout is not kept.
 */
export function preserveExistingTranscript(newContent: string, existingContent: string): string {
  const existingIdx = findTranscriptHeaderIndex(existingContent);
  if (existingIdx < 0) {
    return newContent;
  }
  const existingTranscriptSection = existingContent.slice(existingIdx);
  if (isTranscriptCallout(existingTranscriptSection)) {
    return newContent;
  }
  const newIdx = findTranscriptHeaderIndex(newContent);
  if (newIdx >= 0 && !isTranscriptCallout(newContent.slice(newIdx))) {
    return newContent;
  }
  return replaceTranscriptSection(newContent, existingTranscriptSection);
}

/** Replaces everything from the transcript header to EOF; the Snipd footer stays the last line. */
function replaceTranscriptSection(existingContent: string, newBlock: string): string {
  const existingWithoutFooter = extractSnipdFooter(existingContent);
  const newBlockWithoutFooter = extractSnipdFooter(newBlock);
  const footer = existingWithoutFooter.footer ?? newBlockWithoutFooter.footer;
  const idx = findTranscriptHeaderIndex(existingWithoutFooter.body);
  const beforeTranscript = idx < 0 ? existingWithoutFooter.body : existingWithoutFooter.body.slice(0, idx);
  const beforeStripped = stripTrailingDividers(beforeTranscript);
  const newBlockStripped = stripTrailingDividers(newBlockWithoutFooter.body);
  let result = beforeStripped + '\n\n---\n\n' + newBlockStripped;
  if (footer) {
    result += '\n\n---\n\n' + footer;
  }
  return result + '\n';
}

/** A callout is the transcript header followed by a single blockquote; transcript lines never start with `>`. */
function isTranscriptCallout(transcriptSection: string): boolean {
  const body = stripTrailingDividers(extractSnipdFooter(transcriptSection).body);
  const lines = body.split('\n').slice(1).map(line => line.trim()).filter(line => line !== '');
  return lines.length > 0 && lines.every(line => line.startsWith('>'));
}

function extractSnipdFooter(content: string): { body: string; footer: string | null } {
  const lines = content.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() === SNIPD_FOOTER) {
      lines.splice(i, 1);
      return { body: lines.join('\n'), footer: SNIPD_FOOTER };
    }
  }
  return { body: content, footer: null };
}

function stripTrailingDividers(content: string): string {
  const lines = content.replace(/\s+$/, '').split('\n');
  let i = lines.length - 1;
  while (i >= 0) {
    const trimmed = lines[i].trim();
    if (trimmed === '' || trimmed === '---') {
      i--;
    } else {
      break;
    }
  }
  return lines.slice(0, i + 1).join('\n');
}
