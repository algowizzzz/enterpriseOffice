import StarterKit from '@tiptap/starter-kit';
import { Node, mergeAttributes } from '@tiptap/core';
import Highlight from '@tiptap/extension-highlight';
import Image from '@tiptap/extension-image';
import Link from '@tiptap/extension-link';
import { isEmbeddedImageSrc, isSafeHref } from '@docforge/model';
import Subscript from '@tiptap/extension-subscript';
import Superscript from '@tiptap/extension-superscript';
import TextAlign from '@tiptap/extension-text-align';
import { Color, FontFamily, FontSize, TextStyle } from '@tiptap/extension-text-style';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import type { Extensions } from '@tiptap/react';
import { WordNavigation } from './wordNavigation';

/**
 * Pictures must be embedded in the document itself.
 *
 * A remote address would make the page fetch something, which the air gap
 * forbids and the content security policy blocks, and the server refuses to
 * store one. Rejecting it at the parse step means a pasted remote image is
 * dropped as it arrives, rather than appearing in the editor and then quietly
 * vanishing when the document is saved.
 */
const EmbeddedImage = Image.extend({
  parseHTML() {
    return [
      {
        tag: 'img[src]',
        getAttrs: (element) => (isEmbeddedImageSrc(element.getAttribute('src')) ? null : false),
      },
    ];
  },
});

/**
 * A link the model will actually store.
 *
 * The rule lived on the server alone, so the editor happily held a `tel:`, an
 * `ftp:` or a relative link that was stripped from every save. The person saw a
 * link on screen that was never stored, that vanished on the next reload, and
 * that made the editor report a removal after every keystroke. Refusing it as
 * it arrives keeps what is on screen and what is stored the same thing.
 */
const StorableLink = Link.extend({
  parseHTML() {
    return [
      {
        tag: 'a[href]',
        getAttrs: (element) => (isSafeHref(element.getAttribute('href')) ? null : false),
      },
    ];
  },
});

/**
 * A page break, which the model has a node for and the Word exporter writes.
 *
 * Without it here, a document containing one could not be built: Tiptap
 * substituted an empty document and warned to the console, so the whole
 * document read as blank and the first save stored that.
 */
export const PageBreak = Node.create({
  name: 'pageBreak',
  group: 'block',
  parseHTML() {
    return [{ tag: 'div[data-page-break]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, { 'data-page-break': '', class: 'page-break' }),
      ['span', { class: 'page-break-label' }, 'Page break'],
    ];
  },
});

/**
 * The editor's extension set.
 *
 * It must stay in step with the node and mark vocabulary in `@docforge/model`,
 * because the server validates every save against that vocabulary and rejects
 * anything it does not recognise. Code and code blocks are switched off for
 * that reason: a word processor has no use for them and the model has no node.
 */
export const editorExtensions: Extensions = [
  StarterKit.configure({
    code: false,
    codeBlock: false,
    heading: { levels: [1, 2, 3, 4, 5, 6] },
    // Replaced below by one that refuses targets the model will not store.
    link: false,
    trailingNode: false,
  }),
  StorableLink.configure({
    openOnClick: false,
    autolink: true,
    // Only protocols that cannot execute script.
    protocols: ['http', 'https', 'mailto'],
    HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' },
  }),
  PageBreak,
  TextStyle,
  Color,
  FontFamily,
  FontSize,
  Highlight,
  Superscript,
  Subscript,
  TextAlign.configure({ types: ['heading', 'paragraph'] }),
  EmbeddedImage.configure({ inline: true, allowBase64: true }),
  Table.configure({ resizable: true }),
  TableRow,
  TableHeader,
  TableCell,
  WordNavigation,
];

/** Font families bundled with the application. No web fonts are fetched. */
export const FONT_FAMILIES = [
  { label: 'Default', value: '' },
  { label: 'Liberation Serif', value: '"Liberation Serif", "Times New Roman", serif' },
  { label: 'Liberation Sans', value: '"Liberation Sans", Arial, sans-serif' },
  { label: 'Liberation Mono', value: '"Liberation Mono", "Courier New", monospace' },
  { label: 'Carlito', value: 'Carlito, Calibri, sans-serif' },
  { label: 'Caladea', value: 'Caladea, Cambria, serif' },
  { label: 'Noto Nastaliq Urdu', value: '"Noto Nastaliq Urdu", serif' },
];

export const FONT_SIZES = ['8', '9', '10', '11', '12', '14', '16', '18', '24', '36', '48', '72'];
