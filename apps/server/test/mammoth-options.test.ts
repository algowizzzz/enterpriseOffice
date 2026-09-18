import { describe, expect, it } from 'vitest';
import {
  buildStyleMap,
  kindForStyleName,
  markerFor,
  normalizeAlignment,
} from '../src/docx/mammothOptions.js';

describe('import style map', () => {
  it('maps underline through, which mammoth drops by default', () => {
    expect(buildStyleMap()).toContain('u => u');
  });

  it('keeps the plain style mappings for titles and quotes', () => {
    const map = buildStyleMap();
    expect(map).toContain("p[style-name='Title'] => h1:fresh");
    expect(map).toContain("p[style-name='Quote'] => blockquote:fresh");
  });

  it('has an entry for every alignment and paragraph kind combination', () => {
    const map = buildStyleMap();
    for (const alignment of ['center', 'right', 'justify']) {
      for (const kind of ['body', 'h1', 'h6', 'quote']) {
        const marker = markerFor(alignment as 'center', kind);
        expect(map.some((entry) => entry.includes(marker)), `${marker}`).toBe(true);
      }
    }
  });

  it('sends each kind to the right element', () => {
    const map = buildStyleMap();
    expect(map.some((e) => e.includes(markerFor('center', 'h3')) && e.includes('h3.align-center'))).toBe(true);
    expect(map.some((e) => e.includes(markerFor('right', 'body')) && e.includes('p.align-right'))).toBe(true);
    expect(
      map.some((e) => e.includes(markerFor('justify', 'quote')) && e.includes('blockquote.align-justify')),
    ).toBe(true);
  });
});

describe('style name to paragraph kind', () => {
  it('treats a paragraph with no style as body text', () => {
    expect(kindForStyleName(null)).toBe('body');
    expect(kindForStyleName('')).toBe('body');
  });

  it('recognises every heading level', () => {
    for (let level = 1; level <= 6; level += 1) {
      expect(kindForStyleName(`Heading ${level}`)).toBe(`h${level}`);
    }
    expect(kindForStyleName('heading3')).toBe('h3');
  });

  it('treats a title and a subtitle as headings', () => {
    expect(kindForStyleName('Title')).toBe('h1');
    expect(kindForStyleName('Subtitle')).toBe('h2');
  });

  it('recognises both quote styles Word ships', () => {
    expect(kindForStyleName('Quote')).toBe('quote');
    expect(kindForStyleName('Intense Quote')).toBe('quote');
  });

  it('leaves an unmodelled style alone rather than guessing', () => {
    // Returning undefined means the paragraph is passed through untouched, so a
    // custom style keeps whatever mammoth would have done with it.
    expect(kindForStyleName('Company Letterhead')).toBeUndefined();
    expect(kindForStyleName('Heading 7')).toBeUndefined();
  });
});

describe('alignment normalisation', () => {
  it('translates the name Word uses for justified text', () => {
    expect(normalizeAlignment('both')).toBe('justify');
    expect(normalizeAlignment('distribute')).toBe('justify');
  });

  it('passes centre and right through', () => {
    expect(normalizeAlignment('center')).toBe('center');
    expect(normalizeAlignment('right')).toBe('right');
  });

  it('treats left and absent alignment as nothing to record', () => {
    expect(normalizeAlignment('left')).toBeUndefined();
    expect(normalizeAlignment(null)).toBeUndefined();
    expect(normalizeAlignment(undefined)).toBeUndefined();
    expect(normalizeAlignment('')).toBeUndefined();
  });
});
