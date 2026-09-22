import { useCallback, useEffect, useRef, useState, type JSX, type ReactNode } from 'react';
import type { PMNode, StyleTable } from '@docforge/model';
import type { SpellLanguage } from './spellcheck';
import { useEditorState, type Editor } from '@tiptap/react';
import { FONT_FAMILIES, FONT_SIZES } from './editorExtensions';
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Bold,
  Columns3,
  CornerDownLeft,
  Eraser,
  Highlighter,
  Image as ImageIcon,
  IndentDecrease,
  IndentIncrease,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  ListTree,
  Merge,
  Minus,
  PaintRoller,
  Printer,
  Quote,
  Redo2,
  Rows3,
  Search,
  SeparatorHorizontal,
  SpellCheck2,
  Split,
  Strikethrough,
  Subscript as SubscriptIcon,
  Superscript as SuperscriptIcon,
  Table as TableIcon,
  TableProperties,
  Underline,
  Undo2,
} from 'lucide-react';
import { IconLabel } from './IconLabel';

interface ToolbarProps {
  editor: Editor;
  disabled?: boolean;
  /** The document's own paragraph styles, offered in the styles list. */
  styles?: StyleTable | null;
  onFind?: () => void;
  /** Spelling: off, or the dictionary in use. */
  spelling?: SpellLanguage | null;
  onSpelling?: (language: SpellLanguage | null) => void;
}

interface ButtonProps {
  /**
   * What is inside the button. `title` alone carries the accessible name and
   * the tooltip, so this can be an icon, an icon and a word, or plain text,
   * without ever changing what a screen reader or a test that queries by
   * role and name sees.
   */
  label: ReactNode;
  title: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

function ToolButton({ label, title, active, disabled, onClick }: ButtonProps): JSX.Element {
  return (
    <button
      type="button"
      className={`tool${active ? ' is-active' : ''}`}
      title={title}
      aria-label={title}
      aria-pressed={active ?? false}
      disabled={disabled ?? false}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

const ALIGNMENTS = ['left', 'center', 'right', 'justify'] as const;
const LINE_SPACINGS = ['1', '1.15', '1.5', '2', '2.5', '3'];
const HIGHLIGHTS = [
  ['Yellow', '#ffff00'],
  ['Green', '#00ff00'],
  ['Turquoise', '#00ffff'],
  ['Pink', '#ff00ff'],
  ['Red', '#ff0000'],
  ['Grey', '#c0c0c0'],
] as const;
/** The marks that are formatting, and so are what the format painter carries. */
const PAINTED = new Set(['bold', 'italic', 'underline', 'strike', 'superscript', 'subscript', 'textStyle', 'highlight']);
/** Half an inch, in the twentieths of a point Word measures indents in. */
const INDENT_STEP = 720;

const text = (value: string): PMNode[] => (value ? [{ type: 'text', text: value }] : []);
const cell = (value: string, header = false): PMNode => ({
  type: header ? 'tableHeader' : 'tableCell',
  attrs: { colspan: 1, rowspan: 1 },
  content: [{ type: 'paragraph', content: text(value) }],
});
const row = (values: string[], header = false): PMNode => ({
  type: 'tableRow',
  content: values.map((value) => cell(value, header)),
});

/**
 * The tables every controlled document carries, ready to fill in. Kept as plain
 * documents so that they are ordinary tables once inserted, not a special kind
 * of thing that needs its own editor.
 */
export const TABLE_TEMPLATES: Record<string, { label: string; build: () => PMNode[] }> = {
  versions: {
    label: 'Version history table',
    build: () => [
      {
        type: 'table',
        content: [
          row(['Version', 'Date', 'Author', 'Summary of changes'], true),
          row(['0.1', '', '', 'First draft']),
          row(['', '', '', '']),
          row(['', '', '', '']),
        ],
      },
      { type: 'paragraph' },
    ],
  },
  metadata: {
    label: 'Document details table',
    build: () => [
      {
        type: 'table',
        content: [
          'Document title', 'Document type', 'Owner', 'Approver', 'Classification',
          'Version', 'Effective date', 'Next review date',
        ].map((label) => ({ type: 'tableRow', content: [cell(label, true), cell('')] })),
      },
      { type: 'paragraph' },
    ],
  },
  approvals: {
    label: 'Approvals table',
    build: () => [
      {
        type: 'table',
        content: [row(['Name', 'Role', 'Decision', 'Date'], true), row(['', '', '', '']), row(['', '', '', ''])],
      },
      { type: 'paragraph' },
    ],
  },
};
const HEADING_LEVELS = [1, 2, 3, 4, 5, 6] as const;

/**
 * The formatting ribbon. Every control acts on the current selection.
 *
 * The state each control shows is read through `useEditorState`, so the ribbon
 * re-renders whenever the document or the selection changes. Reading it during
 * an ordinary render instead left the ribbon stale: moving the caret between
 * bold and plain text did not update the buttons, and the table controls stayed
 * disabled after a table was inserted until something else forced a render.
 */
export function Toolbar({
  editor,
  disabled = false,
  styles = null,
  onFind,
  spelling = null,
  onSpelling,
}: ToolbarProps): JSX.Element {
  const state = useEditorState({
    editor,
    selector: ({ editor: instance }) => {
      const textStyle = instance.getAttributes('textStyle');
      const headingLevel = HEADING_LEVELS.find((level) => instance.isActive('heading', { level }));
      return {
        bold: instance.isActive('bold'),
        italic: instance.isActive('italic'),
        underline: instance.isActive('underline'),
        strike: instance.isActive('strike'),
        superscript: instance.isActive('superscript'),
        subscript: instance.isActive('subscript'),
        highlight: instance.isActive('highlight'),
        bulletList: instance.isActive('bulletList'),
        orderedList: instance.isActive('orderedList'),
        blockquote: instance.isActive('blockquote'),
        alignment: ALIGNMENTS.find((value) => instance.isActive({ textAlign: value })),
        heading: headingLevel === undefined ? 'p' : String(headingLevel),
        fontFamily: (textStyle['fontFamily'] as string | undefined) ?? '',
        fontSize: String(textStyle['fontSize'] ?? '').replace('pt', ''),
        color: (textStyle['color'] as string | undefined) ?? '#000000',
        linkHref: (instance.getAttributes('link')['href'] as string | undefined) ?? '',
        canUndo: instance.can().undo(),
        canRedo: instance.can().redo(),
        canAddRow: instance.can().addRowAfter(),
        canAddColumn: instance.can().addColumnAfter(),
        canDeleteRow: instance.can().deleteRow(),
        canMerge: instance.can().mergeCells(),
        canSplit: instance.can().splitCell(),
        inTable: instance.isActive('table'),
        inList: instance.isActive('listItem'),
        styleId:
          ((instance.getAttributes('heading')['styleId'] ?? instance.getAttributes('paragraph')['styleId']) as
            | string
            | undefined) ?? '',
        lineHeight: String(
          instance.getAttributes('paragraph')['lineHeight'] ?? instance.getAttributes('heading')['lineHeight'] ?? '',
        ),
        indentLeft: Number(
          instance.getAttributes('paragraph')['indentLeft'] ?? instance.getAttributes('heading')['indentLeft'] ?? 0,
        ),
      };
    },
  });

  const chain = useCallback(() => editor.chain().focus(), [editor]);

  /** Set an attribute on whichever kind of text block the cursor is in. */
  const setBlockAttribute = useCallback(
    (attributes: Record<string, unknown>) => {
      const type = editor.isActive('heading') ? 'heading' : 'paragraph';
      editor.chain().focus().updateAttributes(type, attributes).run();
    },
    [editor],
  );

  const indent = useCallback(
    (direction: 1 | -1) => {
      // In a list, indenting means going a level deeper, as it does in Word.
      if (state.inList) {
        if (direction === 1) editor.chain().focus().sinkListItem('listItem').run();
        else editor.chain().focus().liftListItem('listItem').run();
        return;
      }
      const next = Math.max(0, Math.min(state.indentLeft + direction * INDENT_STEP, 10 * INDENT_STEP));
      setBlockAttribute({ indentLeft: next === 0 ? null : next });
    },
    [editor, setBlockAttribute, state.inList, state.indentLeft],
  );

  const applyStyle = useCallback(
    (styleId: string) => {
      if (styleId === '') {
        setBlockAttribute({ styleId: null });
        return;
      }
      const entry = styles?.paragraph[styleId];
      const named = /^heading\s*([1-6])$/iu.exec(entry?.name ?? '');
      const outline = entry?.props.outlineLevel;
      const level = named ? Number(named[1]) : outline !== undefined && outline <= 5 ? outline + 1 : null;
      const attributes = { ...editor.getAttributes(editor.isActive('heading') ? 'heading' : 'paragraph'), styleId };
      // A heading style makes the paragraph a heading, so that it appears in
      // the contents table and the outline, and the other way about.
      if (level !== null) editor.chain().focus().setNode('heading', { ...attributes, level }).run();
      else editor.chain().focus().setNode('paragraph', attributes).run();
    },
    [editor, setBlockAttribute, styles],
  );

  // The format painter: pick up the formatting under the cursor, then the next
  // stretch of text that is selected takes it on. One use, as in Word.
  const [painting, setPainting] = useState(false);
  const picked = useRef<{ type: string; attrs: Record<string, unknown> }[]>([]);
  useEffect(() => {
    if (!painting) return undefined;
    const apply = (): void => {
      const { from, to, empty } = editor.state.selection;
      if (empty) return;
      const transaction = editor.state.tr;
      // Formatting only. A comment, a tracked change or kept Word properties
      // belong to the words they are on and are not something to paint about.
      for (const [name, type] of Object.entries(editor.state.schema.marks)) {
        if (PAINTED.has(name)) transaction.removeMark(from, to, type);
      }
      for (const mark of picked.current) {
        const type = editor.state.schema.marks[mark.type];
        if (type) transaction.addMark(from, to, type.create(mark.attrs));
      }
      editor.view.dispatch(transaction);
      setPainting(false);
    };
    editor.on('selectionUpdate', apply);
    return () => {
      editor.off('selectionUpdate', apply);
    };
  }, [editor, painting]);

  const togglePainter = useCallback(() => {
    if (painting) {
      setPainting(false);
      return;
    }
    const marks = editor.state.storedMarks ?? editor.state.selection.$from.marks();
    picked.current = marks
      .filter((mark) => PAINTED.has(mark.type.name))
      .map((mark) => ({ type: mark.type.name, attrs: { ...mark.attrs } }));
    setPainting(true);
  }, [editor, painting]);

  const setLink = useCallback(() => {
    const href = window.prompt('Link address', state.linkHref);
    if (href === null) return;
    if (href.trim() === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    if (!/^(https?:\/\/|mailto:)/iu.test(href)) {
      window.alert('Links must start with http://, https:// or mailto:');
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
  }, [editor, state.linkHref]);

  const insertImage = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/gif';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      if (file.size > 10 * 1024 * 1024) {
        window.alert('Images must be smaller than 10 MB.');
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        // readAsDataURL always yields a string, but the type allows a buffer.
        if (typeof reader.result !== 'string') return;
        // A file the system has no type for reads back as "data:;base64,…",
        // which is not an image and cannot be stored.
        if (!/^data:image\/[a-z0-9.+-]+;base64,/iu.test(reader.result)) {
          window.alert('That file was not recognised as a PNG, JPEG or GIF image.');
          return;
        }
        editor.chain().focus().setImage({ src: reader.result }).run();
      };
      reader.readAsDataURL(file);
    };
    input.click();
  }, [editor]);

  return (
    <div className="toolbar" role="toolbar" aria-label="Formatting" aria-disabled={disabled}>
      <div className="tool-group">
        <ToolButton
          label={<IconLabel icon={Undo2} />}
          title="Undo"
          disabled={disabled || !state.canUndo}
          onClick={() => chain().undo().run()}
        />
        <ToolButton
          label={<IconLabel icon={Redo2} />}
          title="Redo"
          disabled={disabled || !state.canRedo}
          onClick={() => chain().redo().run()}
        />
      </div>

      <div className="tool-group">
        <label className="visually-hidden" htmlFor="tb-style">
          Paragraph style
        </label>
        <select
          id="tb-style"
          className="tool-select"
          disabled={disabled}
          value={state.heading}
          onChange={(event) => {
            const value = event.target.value;
            if (value === 'p') chain().setParagraph().run();
            else chain().toggleHeading({ level: Number(value) as 1 | 2 | 3 | 4 | 5 | 6 }).run();
          }}
        >
          <option value="p">Normal text</option>
          {HEADING_LEVELS.map((level) => (
            <option key={level} value={String(level)}>
              Heading {level}
            </option>
          ))}
        </select>

        {styles && Object.keys(styles.paragraph).length > 0 ? (
          <>
            <label className="visually-hidden" htmlFor="tb-docstyle">
              Document style
            </label>
            <select
              id="tb-docstyle"
              className="tool-select"
              title="The styles this document came with. Choosing one keeps the document consistent with its template"
              disabled={disabled}
              value={state.styleId}
              onChange={(event) => applyStyle(event.target.value)}
            >
              <option value="">Document styles</option>
              {Object.entries(styles.paragraph)
                .sort((a, b) => a[1].name.localeCompare(b[1].name))
                .slice(0, 200)
                .map(([id, entry]) => (
                  <option key={id} value={id}>
                    {entry.name}
                  </option>
                ))}
            </select>
          </>
        ) : null}

        <label className="visually-hidden" htmlFor="tb-font">
          Font
        </label>
        <select
          id="tb-font"
          className="tool-select"
          disabled={disabled}
          value={state.fontFamily}
          onChange={(event) => {
            const value = event.target.value;
            if (value === '') chain().unsetFontFamily().run();
            else chain().setFontFamily(value).run();
          }}
        >
          {FONT_FAMILIES.map((font) => (
            <option key={font.label} value={font.value}>
              {font.label}
            </option>
          ))}
        </select>

        <label className="visually-hidden" htmlFor="tb-size">
          Font size
        </label>
        <select
          id="tb-size"
          className="tool-select tool-select-narrow"
          disabled={disabled}
          value={state.fontSize}
          onChange={(event) => {
            const value = event.target.value;
            if (value === '') chain().unsetFontSize().run();
            else chain().setFontSize(`${value}pt`).run();
          }}
        >
          <option value="">Size</option>
          {FONT_SIZES.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
      </div>

      <div className="tool-group">
        <ToolButton
          label={<IconLabel icon={Bold} />}
          title="Bold"
          active={state.bold}
          disabled={disabled}
          onClick={() => chain().toggleBold().run()}
        />
        <ToolButton
          label={<IconLabel icon={Italic} />}
          title="Italic"
          active={state.italic}
          disabled={disabled}
          onClick={() => chain().toggleItalic().run()}
        />
        <ToolButton
          label={<IconLabel icon={Underline} />}
          title="Underline"
          active={state.underline}
          disabled={disabled}
          onClick={() => chain().toggleUnderline().run()}
        />
        <ToolButton
          label={<IconLabel icon={Strikethrough} />}
          title="Strikethrough"
          active={state.strike}
          disabled={disabled}
          onClick={() => chain().toggleStrike().run()}
        />
        <ToolButton
          label={<IconLabel icon={SuperscriptIcon} />}
          title="Superscript"
          active={state.superscript}
          disabled={disabled}
          onClick={() => chain().toggleSuperscript().run()}
        />
        <ToolButton
          label={<IconLabel icon={SubscriptIcon} />}
          title="Subscript"
          active={state.subscript}
          disabled={disabled}
          onClick={() => chain().toggleSubscript().run()}
        />
        <ToolButton
          label={<IconLabel icon={Highlighter} />}
          title="Highlight"
          active={state.highlight}
          disabled={disabled}
          onClick={() => chain().toggleHighlight().run()}
        />
        <label className="visually-hidden" htmlFor="tb-highlight">
          Highlight colour
        </label>
        <select
          id="tb-highlight"
          className="tool-select tool-select-narrow"
          title="Highlight the selected text"
          disabled={disabled}
          value=""
          onChange={(event) => {
            const value = event.target.value;
            if (value === 'none') chain().unsetHighlight().run();
            else if (value) chain().setHighlight({ color: value }).run();
          }}
        >
          <option value="">Colour</option>
          {HIGHLIGHTS.map(([name, colour]) => (
            <option key={colour} value={colour}>
              {name}
            </option>
          ))}
          <option value="none">No highlight</option>
        </select>
        <label className="tool-color" title="Text colour">
          <span className="visually-hidden">Text colour</span>
          <input
            type="color"
            disabled={disabled}
            value={state.color}
            onChange={(event) => chain().setColor(event.target.value).run()}
          />
        </label>
        <ToolButton
          label={<IconLabel icon={PaintRoller} />}
          title="Format painter: copies the formatting where the cursor is. Then select the text to give it to"
          active={painting}
          disabled={disabled}
          onClick={togglePainter}
        />
        <ToolButton
          label={<IconLabel icon={Eraser} />}
          title="Clear formatting"
          disabled={disabled}
          onClick={() => chain().unsetAllMarks().clearNodes().run()}
        />
      </div>

      <div className="tool-group">
        {(
          [
            ['left', AlignLeft],
            ['center', AlignCenter],
            ['right', AlignRight],
            ['justify', AlignJustify],
          ] as const
        ).map(([alignment, Icon]) => (
          <ToolButton
            key={alignment}
            label={<IconLabel icon={Icon} />}
            title={`Align ${alignment}`}
            active={state.alignment === alignment}
            disabled={disabled}
            onClick={() => chain().setTextAlign(alignment).run()}
          />
        ))}
      </div>

      <div className="tool-group">
        <ToolButton
          label={<IconLabel icon={List} />}
          title="Bulleted list"
          active={state.bulletList}
          disabled={disabled}
          onClick={() => chain().toggleBulletList().run()}
        />
        <ToolButton
          label={<IconLabel icon={ListOrdered} />}
          title="Numbered list"
          active={state.orderedList}
          disabled={disabled}
          onClick={() => chain().toggleOrderedList().run()}
        />
        <ToolButton
          label={<IconLabel icon={Quote} />}
          title="Block quote"
          active={state.blockquote}
          disabled={disabled}
          onClick={() => chain().toggleBlockquote().run()}
        />
        <ToolButton
          label={<IconLabel icon={IndentDecrease} />}
          title="Decrease indent (in a list: up a level)"
          disabled={disabled || (!state.inList && state.indentLeft <= 0)}
          onClick={() => indent(-1)}
        />
        <ToolButton
          label={<IconLabel icon={IndentIncrease} />}
          title="Increase indent (in a list: down a level)"
          disabled={disabled}
          onClick={() => indent(1)}
        />
        <label className="visually-hidden" htmlFor="tb-spacing">
          Line spacing
        </label>
        <select
          id="tb-spacing"
          className="tool-select tool-select-narrow"
          title="Line spacing"
          disabled={disabled}
          value={LINE_SPACINGS.includes(state.lineHeight) ? state.lineHeight : ''}
          onChange={(event) => {
            const value = event.target.value;
            setBlockAttribute({ lineHeight: value === '' ? null : Number(value), lineExact: null });
          }}
        >
          <option value="">Spacing</option>
          {LINE_SPACINGS.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </div>

      <div className="tool-group">
        <ToolButton label={<IconLabel icon={LinkIcon} />} title="Insert link" disabled={disabled} onClick={setLink} />
        <ToolButton label={<IconLabel icon={ImageIcon} />} title="Insert image" disabled={disabled} onClick={insertImage} />
        <ToolButton
          label={<IconLabel icon={TableIcon} />}
          title="Insert table"
          disabled={disabled}
          onClick={() => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
        />
        <ToolButton
          label={<IconLabel icon={Rows3}>Row+</IconLabel>}
          title="Add row below"
          disabled={disabled || !state.canAddRow}
          onClick={() => chain().addRowAfter().run()}
        />
        <ToolButton
          label={<IconLabel icon={Columns3}>Col+</IconLabel>}
          title="Add column after"
          disabled={disabled || !state.canAddColumn}
          onClick={() => chain().addColumnAfter().run()}
        />
        <ToolButton
          label={<IconLabel icon={Rows3}>Del</IconLabel>}
          title="Delete row"
          disabled={disabled || !state.canDeleteRow}
          onClick={() => chain().deleteRow().run()}
        />
        <ToolButton
          label={<IconLabel icon={Columns3}>Del</IconLabel>}
          title="Delete column"
          disabled={disabled || !state.inTable}
          onClick={() => chain().deleteColumn().run()}
        />
        <ToolButton
          label={<IconLabel icon={Merge} />}
          title="Merge the selected cells"
          disabled={disabled || !state.canMerge}
          onClick={() => chain().mergeCells().run()}
        />
        <ToolButton
          label={<IconLabel icon={Split} />}
          title="Split a merged cell"
          disabled={disabled || !state.canSplit}
          onClick={() => chain().splitCell().run()}
        />
        <ToolButton
          label={<IconLabel icon={TableProperties}>Header</IconLabel>}
          title="Make the first row a header row, repeated at the top of each page in Word"
          disabled={disabled || !state.inTable}
          onClick={() => chain().toggleHeaderRow().run()}
        />
        <label className="tool-color" title="Cell shading">
          <span className="visually-hidden">Cell shading</span>
          <input
            type="color"
            disabled={disabled || !state.inTable}
            defaultValue="#ffffff"
            onChange={(event) => chain().setCellAttribute('background', event.target.value).run()}
          />
        </label>
        <ToolButton
          label={<IconLabel icon={TableIcon}>Delete</IconLabel>}
          title="Delete the whole table"
          disabled={disabled || !state.inTable}
          onClick={() => chain().deleteTable().run()}
        />
        <ToolButton
          label={<IconLabel icon={Minus} />}
          title="Horizontal rule"
          disabled={disabled}
          onClick={() => chain().setHorizontalRule().run()}
        />
        <ToolButton
          label={<IconLabel icon={SeparatorHorizontal}>Break</IconLabel>}
          title="Page break"
          disabled={disabled}
          onClick={() =>
            // A trailing paragraph, like the rule button inserts. Without one
            // the break is the last node, so the cursor selects it and the next
            // thing typed replaces it.
            chain()
              .insertContent([{ type: 'pageBreak' }, { type: 'paragraph' }])
              .run()
          }
        />
        <ToolButton
          label={<IconLabel icon={CornerDownLeft}>Footnote</IconLabel>}
          title="Insert a footnote where the cursor is"
          disabled={disabled}
          onClick={() => {
            const words = window.prompt('Wording of the footnote');
            if (!words || words.trim() === '') return;
            chain()
              .insertContent({ type: 'wordInline', attrs: { kind: 'footnote', label: '', note: words.trim() } })
              .run();
          }}
        />
        <ToolButton
          label={<IconLabel icon={ListTree}>Contents</IconLabel>}
          title="Insert a table of contents built from the headings. It keeps itself up to date here, and Word updates its page numbers"
          disabled={disabled}
          onClick={() =>
            chain()
              .insertContent([{ type: 'wordBlock', attrs: { kind: 'toc', label: '' } }, { type: 'paragraph' }])
              .run()
          }
        />
        <label className="visually-hidden" htmlFor="tb-template">
          Insert a standard table
        </label>
        <select
          id="tb-template"
          className="tool-select"
          title="Insert one of the standard tables, ready to fill in"
          disabled={disabled}
          value=""
          onChange={(event) => {
            const template = TABLE_TEMPLATES[event.target.value];
            if (template) chain().insertContent(template.build()).run();
          }}
        >
          <option value="">Standard tables</option>
          {Object.entries(TABLE_TEMPLATES).map(([key, template]) => (
            <option key={key} value={key}>
              {template.label}
            </option>
          ))}
        </select>
      </div>

      <div className="tool-group">
        {onFind ? (
          <ToolButton label={<IconLabel icon={Search} />} title="Find and replace (Ctrl+F)" onClick={onFind} />
        ) : null}
        {onSpelling ? (
          <>
            <label className="visually-hidden" htmlFor="tb-spelling">
              Spelling
            </label>
            <span className="tool-select-icon" aria-hidden="true">
              <SpellCheck2 size={14} />
            </span>
            <select
              id="tb-spelling"
              className="tool-select"
              title="Check spelling with the dictionary that comes with the application. Right-click an underlined word for suggestions"
              value={spelling ?? ''}
              onChange={(event) => onSpelling((event.target.value || null) as SpellLanguage | null)}
            >
              <option value="">Spelling off</option>
              <option value="en-GB">Spelling: British</option>
              <option value="en-US">Spelling: American</option>
            </select>
          </>
        ) : null}
        <ToolButton
          label={<IconLabel icon={Printer} />}
          title="Print, or save as PDF from the print dialog"
          onClick={() => window.print()}
        />
      </div>
    </div>
  );
}
