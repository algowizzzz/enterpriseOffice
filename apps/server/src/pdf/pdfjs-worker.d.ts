/**
 * pdf.js ships no declarations for its worker module. It is imported only so
 * the bundler carries it inside the single server file, and the one thing read
 * from it is the handler pdf.js looks for on `globalThis.pdfjsWorker`.
 */
declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs' {
  export const WorkerMessageHandler: unknown;
}
