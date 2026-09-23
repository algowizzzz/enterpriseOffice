import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, '..', 'src', 'styles', 'app.css'), 'utf8');

/**
 * jsdom does not compute real layout, so the bug this guards against cannot
 * be caught by rendering anything and reading a height: every element in
 * this project's test suite reports whatever getBoundingClientRect always
 * returns in jsdom, real layout or not. This was found, and fixed, by
 * running the app in an actual browser on a 601-row table and watching the
 * toolbar and ribbon scroll away with the document -- see the comment on
 * `.editor-with-side` in app.css for the full mechanism. This test is a
 * guard rail, not a behavioural proof: it stops the specific line from being
 * silently reverted, on the same document that broke it. The real proof
 * lives in the commit that introduced this file, run in a browser.
 */
describe('the editor page does not grow to the height of the document', () => {
  it('stretches .editor within .editor-with-side, rather than sizing it to its content', () => {
    const rule = /\.editor-with-side\s*\{[^}]*\}/u.exec(css)?.[0];
    expect(rule, '.editor-with-side rule should exist in app.css').toBeTruthy();
    expect(rule).toMatch(/align-items:\s*stretch/u);
    expect(rule).not.toMatch(/align-items:\s*flex-start/u);
  });
});
