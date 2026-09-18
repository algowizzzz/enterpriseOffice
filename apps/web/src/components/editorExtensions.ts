import StarterKit from '@tiptap/starter-kit';
import { Extension, Mark, Node, mergeAttributes, type Attribute } from '@tiptap/core';
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
import { CommentHighlights } from './commentHighlights';
import { Deletion, Insertion, TrackChanges } from './trackChanges';
import { SearchReplace } from './searchReplace';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import type { Doc as YDoc } from 'yjs';

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
 * Cells that keep the colour they were given.
 *
 * Tiptap's table cells have no colour attribute, so a banded table imported
 * from Word lost its shading the moment the editor loaded it, and the export
 * had nothing left to write. The attribute is stored as the model stores it and
 * drawn as the background of the cell.
 */
const shadedCell = <T extends typeof TableCell | typeof TableHeader>(base: T) =>
  base.extend({
    addAttributes() {
      return {
        ...this.parent?.(),
        background: {
          default: null,
          parseHTML: (element: HTMLElement) =>
            element.getAttribute('data-background') || element.style.backgroundColor || null,
          renderHTML: (attributes: Record<string, unknown>) => {
            const colour = attributes['background'];
            if (typeof colour !== 'string' || colour.length === 0) return {};
            return { 'data-background': colour, style: `background-color: ${colour}` };
          },
        },
      };
    },
  });

const ShadedTableCell = shadedCell(TableCell);
const ShadedTableHeader = shadedCell(TableHeader);

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

const kebab = (name: string): string => name.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);

/**
 * An attribute the editor carries and never interprets.
 *
 * Tiptap drops whatever its schema does not declare, on the first transaction.
 * That is how table shading was once lost for a whole round, and it is what
 * would happen to a paragraph's Word style, a list's numbering or a reference
 * to kept markup. Each one is declared here, written to the page as a data
 * attribute so that copy and paste inside the editor keeps it too.
 */
const carried = (name: string, numeric = false): Record<string, Attribute> => ({
  [name]: {
    default: null,
    parseHTML: (element: HTMLElement) => {
      const raw = element.getAttribute(`data-${kebab(name)}`);
      if (raw === null || raw === '') return null;
      if (!numeric) return raw;
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : null;
    },
    renderHTML: (attributes: Record<string, unknown>) => {
      const value = attributes[name];
      if (value === null || value === undefined || value === '') return {};
      if (typeof value !== 'string' && typeof value !== 'number') return {};
      return { [`data-${kebab(name)}`]: String(value) };
    },
  },
});

const twips = (value: unknown): string | null =>
  typeof value === 'number' && Number.isFinite(value) ? `${Math.round((value / 15) * 100) / 100}px` : null;

/**
 * What Word says about a paragraph, carried on the node and drawn.
 *
 * The style is drawn by a stylesheet built from the document's own styles; what
 * was set on the paragraph itself is drawn inline, so it wins, as it does in
 * Word. Measurements are twips, as the file states them.
 */
const ParagraphIdentity = Extension.create({
  name: 'paragraphIdentity',
  addGlobalAttributes() {
    return [
      {
        types: ['paragraph', 'heading'],
        attributes: {
          styleId: {
            default: null,
            parseHTML: (element: HTMLElement) => element.getAttribute('data-style'),
            renderHTML: (attributes: Record<string, unknown>) =>
              typeof attributes['styleId'] === 'string' && attributes['styleId']
                ? { 'data-style': attributes['styleId'] }
                : {},
          },
          ...carried('pprRef'),
          ...carried('numLevel', true),
          ...carried('indentLeft', true),
          ...carried('indentRight', true),
          ...carried('indentFirstLine', true),
          ...carried('spacingBefore', true),
          ...carried('spacingAfter', true),
          ...carried('lineHeight', true),
          lineExact: {
            ...(carried('lineExact', true)['lineExact'] as Attribute),
            // Every attribute's renderer is given all of them, so the look of
            // the paragraph is drawn once, here, from the numbers above. A
            // separate attribute for it would be stored in every paragraph of
            // every document and mean nothing.
            renderHTML: (attributes: Record<string, unknown>) => {
              const css: string[] = [];
              const push = (property: string, value: string | null): void => {
                if (value !== null) css.push(`${property}: ${value}`);
              };
              push('margin-left', twips(attributes['indentLeft']));
              push('margin-right', twips(attributes['indentRight']));
              push('text-indent', twips(attributes['indentFirstLine']));
              push('margin-top', twips(attributes['spacingBefore']));
              push('margin-bottom', twips(attributes['spacingAfter']));
              const height = attributes['lineHeight'];
              if (typeof height === 'number' && height > 0) {
                css.push(`line-height: ${Math.round(height * 1.2 * 100) / 100}`);
              } else {
                push('line-height', twips(attributes['lineExact']));
              }
              const exact = attributes['lineExact'];
              return {
                ...(typeof exact === 'number' ? { 'data-line-exact': String(exact) } : {}),
                ...(css.length > 0 ? { style: css.join('; ') } : {}),
              };
            },
          },
        },
      },
      {
        types: ['bulletList', 'orderedList'],
        attributes: {
          ...carried('numId'),
          ...carried('numLevel', true),
          listFormat: {
            default: null,
            parseHTML: (element: HTMLElement) => element.getAttribute('data-list-format'),
            renderHTML: (attributes: Record<string, unknown>) => {
              const format = attributes['listFormat'];
              if (typeof format !== 'string' || !LIST_STYLES[format]) return {};
              return { 'data-list-format': format, style: `list-style-type: ${LIST_STYLES[format]}` };
            },
          },
        },
      },
      { types: ['table'], attributes: { ...carried('tblRef'), ...carried('gridRef'), ...carried('gridColumns', true) } },
      { types: ['tableRow'], attributes: carried('trRef') },
      { types: ['tableCell', 'tableHeader'], attributes: carried('tcRef') },
      { types: ['image'], attributes: carried('wordRef') },
    ];
  },
});

/** Word's numbering formats, as the browser names them. */
const LIST_STYLES: Record<string, string> = {
  decimal: 'decimal',
  decimalZero: 'decimal-leading-zero',
  lowerLetter: 'lower-alpha',
  upperLetter: 'upper-alpha',
  lowerRoman: 'lower-roman',
  upperRoman: 'upper-roman',
  bullet: 'disc',
  none: 'none',
};

/** What each kind of kept object is called when there is nothing else to show. */
const OBJECT_NAMES: Record<string, string> = {
  chart: 'Chart',
  diagram: 'Diagram',
  shape: 'Shape',
  textbox: 'Text box',
  object: 'Embedded object',
  picture: 'Picture',
  equation: 'Equation',
  toc: 'Table of contents',
  field: 'Field',
};

/** Kinds that mark a place and show nothing, such as the ends of a bookmark. */
const INVISIBLE_KINDS = new Set(['bookmark', 'comment', 'permission']);

/**
 * Something Word holds that the editor cannot edit: a field, a footnote mark, a
 * chart, a shape, a bookmark. It is one unit here, it can be moved or deleted,
 * and the export puts the original markup back wherever it now sits.
 */
export const WordInline = Node.create({
  name: 'wordInline',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return { ...carried('ref'), ...carried('kind'), ...carried('label') };
  },
  parseHTML() {
    return [{ tag: 'span[data-word-inline]' }];
  },
  renderHTML({ node, HTMLAttributes }) {
    const kind = String(node.attrs['kind'] ?? 'other');
    const label = String(node.attrs['label'] ?? '');
    const hidden = INVISIBLE_KINDS.has(kind) && !(kind === 'comment' && label);
    const shown =
      kind === 'footnote' || kind === 'endnote'
        ? label || '*'
        : kind === 'field' || kind === 'symbol' || kind === 'tab'
          ? label
          : label
            ? `${OBJECT_NAMES[kind] ?? 'Object'}: ${label}`
            : (OBJECT_NAMES[kind] ?? 'Object');
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-word-inline': '',
        class: `word-inline word-inline-${kind.replace(/[^a-z]/giu, '')}${hidden ? ' word-inline-hidden' : ''}`,
        contenteditable: 'false',
        title: OBJECT_NAMES[kind] ?? kind,
      }),
      hidden ? '' : shown,
    ];
  },
});

export const WordBlock = Node.create({
  name: 'wordBlock',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return { ...carried('ref'), ...carried('kind'), ...carried('label') };
  },
  parseHTML() {
    return [{ tag: 'div[data-word-block]' }];
  },
  addNodeView() {
    // A contents table is drawn from the headings as they are now, so it is
    // never out of date here. Anything else is drawn as it was kept.
    return ({ node, editor }) => {
      const kind = typeof node.attrs['kind'] === 'string' ? node.attrs['kind'] : 'object';
      const dom = document.createElement('div');
      dom.className = `word-block word-block-${kind.replace(/[^a-z]/giu, '')}`;
      dom.contentEditable = 'false';
      dom.setAttribute('data-word-block', '');
      if (kind !== 'toc') {
        const title = document.createElement('div');
        title.className = 'word-block-title';
        title.textContent = OBJECT_NAMES[kind] ?? 'Kept from the Word file';
        dom.append(title);
        const label = typeof node.attrs['label'] === 'string' ? node.attrs['label'] : '';
        for (const text of label.split('\n').filter(Boolean).slice(0, 60)) {
          const line = document.createElement('div');
          line.className = 'word-block-line';
          line.textContent = text;
          dom.append(line);
        }
        return { dom, ignoreMutation: () => true };
      }
      const draw = (): void => {
        dom.replaceChildren();
        const title = document.createElement('div');
        title.className = 'word-block-title';
        title.textContent = 'Table of contents';
        dom.append(title);
        let found = 0;
        editor.state.doc.descendants((inner) => {
          if (inner.type.name !== 'heading') return !inner.isTextblock;
          const level = Number(inner.attrs['level'] ?? 1);
          if (level > 3 || inner.textContent.trim() === '' || found >= 300) return false;
          found += 1;
          const line = document.createElement('div');
          line.className = 'word-block-line';
          line.style.paddingLeft = `${(level - 1) * 18}px`;
          line.textContent = inner.textContent;
          dom.append(line);
          return false;
        });
        if (found === 0) {
          const empty = document.createElement('div');
          empty.className = 'word-block-line muted';
          empty.textContent = 'Headings will be listed here.';
          dom.append(empty);
        }
      };
      draw();
      editor.on('update', draw);
      return {
        dom,
        ignoreMutation: () => true,
        destroy: () => {
          editor.off('update', draw);
        },
      };
    };
  },
  renderHTML({ node, HTMLAttributes }) {
    const kind = String(node.attrs['kind'] ?? 'object');
    const lines = String(node.attrs['label'] ?? '')
      .split('\n')
      .filter((line) => line.length > 0);
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-word-block': '',
        class: `word-block word-block-${kind.replace(/[^a-z]/giu, '')}`,
        contenteditable: 'false',
      }),
      ['div', { class: 'word-block-title' }, OBJECT_NAMES[kind] ?? 'Kept from the Word file'],
      ...lines.slice(0, 60).map((line) => ['div', { class: 'word-block-line' }, line]),
    ];
  },
});

/**
 * The run properties Word wrote that no other mark stands for: a character
 * style, small caps, spacing, a language. Drawn through the document's own
 * character styles; otherwise only carried.
 */
export const WordRun = Mark.create({
  name: 'wordRun',
  // Many of these sit side by side, and none of them excludes another mark.
  excludes: '',
  addAttributes() {
    return {
      ...carried('ref'),
      ...carried('font'),
      styleId: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-run-style'),
        renderHTML: (attributes: Record<string, unknown>) =>
          typeof attributes['styleId'] === 'string' && attributes['styleId']
            ? { 'data-run-style': attributes['styleId'] }
            : {},
      },
    };
  },
  parseHTML() {
    return [{ tag: 'span[data-word-run]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-word-run': '' }), 0];
  },
});

/** What the editor needs to join a shared document. */
export interface SharedEditing {
  document: YDoc;
  /** The connection that carries everybody's cursors. */
  provider: { awareness: unknown };
  user: { name: string; color: string };
}

/**
 * The editor's extension set.
 *
 * It must stay in step with the node and mark vocabulary in `@docforge/model`,
 * because the server validates every save against that vocabulary and rejects
 * anything it does not recognise. Code and code blocks are switched off for
 * that reason: a word processor has no use for them and the model has no node.
 *
 * With `shared`, the text comes from a document several people hold at once,
 * and undo belongs to that document, so that undoing takes back what you did
 * and never what somebody else was typing at the same moment.
 */
export function buildExtensions(shared?: SharedEditing): Extensions {
  return [
    StarterKit.configure({
      code: false,
      codeBlock: false,
      heading: { levels: [1, 2, 3, 4, 5, 6] },
      // Replaced below by one that refuses targets the model will not store.
      link: false,
      trailingNode: false,
      ...(shared ? { undoRedo: false as const } : {}),
    }),
    ...(shared
      ? [
          Collaboration.configure({ document: shared.document }),
          CollaborationCaret.configure({ provider: shared.provider, user: shared.user }),
        ]
      : []),
    StorableLink.configure({
      openOnClick: false,
      autolink: true,
      // Only protocols that cannot execute script.
      protocols: ['http', 'https', 'mailto'],
      // Every other way a link is made, typing one, pasting one over a
      // selection, the ribbon button, goes through this rather than through the
      // parse rule below. Leaving it at the default meant typing an ftp address
      // still produced a link the model strips on every save, which is the
      // banner-after-every-keystroke this was meant to end.
      isAllowedUri: (url: string) => isSafeHref(url),
      HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' },
    }),
    PageBreak,
    WordInline,
    WordBlock,
    WordRun,
    ParagraphIdentity,
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
    ShadedTableHeader,
    ShadedTableCell,
    WordNavigation,
    CommentHighlights,
    Insertion,
    Deletion,
    TrackChanges,
    SearchReplace,
  ];
}

/** The set for a document one person has to themselves. */
export const editorExtensions: Extensions = buildExtensions();

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
