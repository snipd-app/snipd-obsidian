import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  preserveExistingTranscript,
  spliceBeforeTranscriptHeader,
  SNIPD_FOOTER,
  TRANSCRIPT_HEADER,
} from '../src/transcript_section';

// Snips, then the transcript section, then the footer.
const TRANSCRIPT = `${TRANSCRIPT_HEADER}\n\n**Host** (00:00:01)\nWelcome to the show.\n\n**Guest** (00:00:05)\nThanks for having me.`;
const CALLOUT = `${TRANSCRIPT_HEADER}\n\n> [!INFO] Transcript not available`;

function note(body: string, transcriptSection?: string): string {
  const parts = [body];
  if (transcriptSection) {
    parts.push(transcriptSection);
  }
  parts.push(SNIPD_FOOTER);
  return parts.join('\n\n---\n\n') + '\n';
}

const OLD_BODY = '# Episode\n\n## Snips\n\n### First snip\nOld text';
const NEW_BODY = '# Episode\n\n## Snips\n\n### First snip\nEdited text\n\n### Second snip\nNew text';

describe('full rewrite', () => {
  it('keeps a transcript the existing note has', () => {
    const result = preserveExistingTranscript(note(NEW_BODY), note(OLD_BODY, TRANSCRIPT));

    assert.equal(result, note(NEW_BODY, TRANSCRIPT));
  });

  it('drops a callout', () => {
    const result = preserveExistingTranscript(note(NEW_BODY), note(OLD_BODY, CALLOUT));

    assert.equal(result, note(NEW_BODY));
  });

  it('leaves notes without a transcript alone', () => {
    const result = preserveExistingTranscript(note(NEW_BODY), note(OLD_BODY));

    assert.equal(result, note(NEW_BODY));
  });

  it('does not take the header text inside a snip for the transcript section', () => {
    const existing = note(`${OLD_BODY}\nQuote: ${TRANSCRIPT_HEADER} is mentioned here`);

    assert.equal(preserveExistingTranscript(note(NEW_BODY), existing), note(NEW_BODY));
  });
});

describe('appending new snips', () => {
  const NEW_SNIPS = '### Second snip\nNew text\n';

  it('inserts them above the transcript', () => {
    const result = spliceBeforeTranscriptHeader(note(OLD_BODY, TRANSCRIPT), NEW_SNIPS);

    const transcriptIdx = result.indexOf(TRANSCRIPT_HEADER);
    assert.ok(result.indexOf('### Second snip') < transcriptIdx);
    assert.ok(result.endsWith(`${TRANSCRIPT}\n\n---\n\n${SNIPD_FOOTER}\n`));
  });

  it('appends them at the end when there is no transcript', () => {
    const existing = `${OLD_BODY}\n`;

    assert.equal(spliceBeforeTranscriptHeader(existing, NEW_SNIPS), `${OLD_BODY}\n${NEW_SNIPS}`);
  });
});
