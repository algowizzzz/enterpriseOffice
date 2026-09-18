/**
 * Types for the one build of pdfkit that survives being bundled.
 *
 * The package's ordinary Node entry fetches the metrics of the built-in fonts
 * with a `require('#standard-fonts/...')` that is resolved at run time against
 * its own package.json. In a single-file bundle there is no package.json to
 * resolve against, so the first `new PDFDocument()` throws MODULE_NOT_FOUND.
 * The browser build takes the same metrics as ordinary imports instead, and
 * never touches the disk. Its path is not in the package's export map, which
 * is why it is imported by file path and typed here by pattern.
 */
declare module '*/pdfkit/js/pdfkit.browser.mjs' {
  import PDFDocument from 'pdfkit';
  export default PDFDocument;
  export function registerStdFonts(...fonts: unknown[]): void;
}

declare module 'pdfkit/standard-fonts/*' {
  const metrics: unknown;
  export default metrics;
}
