import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Testing Library only registers its automatic cleanup when Vitest globals are
// enabled. This project keeps globals off, so unmount between tests explicitly,
// otherwise each render leaks into the next test's queries.
afterEach(() => {
  cleanup();
});

// jsdom has no layout engine. ProseMirror measures the document on every
// selection change, so stub the geometry it asks for. The values are not used
// by any assertion: they only stop the editor logging on every keystroke.
const emptyRect: DOMRect = {
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  bottom: 0,
  right: 0,
  width: 0,
  height: 0,
  toJSON: () => ({}),
};

const emptyRectList = Object.assign([], { item: () => null }) as unknown as DOMRectList;

if (!Range.prototype.getClientRects) {
  Range.prototype.getClientRects = (): DOMRectList => emptyRectList;
}
if (!Range.prototype.getBoundingClientRect) {
  Range.prototype.getBoundingClientRect = (): DOMRect => emptyRect;
}
if (!Element.prototype.getClientRects) {
  Element.prototype.getClientRects = (): DOMRectList => emptyRectList;
}
if (!document.elementFromPoint) {
  document.elementFromPoint = (): Element | null => null;
}
