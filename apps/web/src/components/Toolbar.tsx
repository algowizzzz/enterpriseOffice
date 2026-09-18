import { useCallback, type JSX } from 'react';
import { useEditorState, type Editor } from '@tiptap/react';
import { FONT_FAMILIES, FONT_SIZES } from './editorExtensions';

interface ToolbarProps {
  editor: Editor;
  disabled?: boolean;
}

interface ButtonProps {
  label: string;
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
export function Toolbar({ editor, disabled = false }: ToolbarProps): JSX.Element {
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
      };
    },
  });

  const chain = useCallback(() => editor.chain().focus(), [editor]);

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
      if (file.size > 2 * 1024 * 1024) {
        window.alert('Images must be smaller than 2 MB.');
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        // readAsDataURL always yields a string, but the type allows a buffer.
        if (typeof reader.result !== 'string') return;
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
          label="Undo"
          title="Undo"
          disabled={disabled || !state.canUndo}
          onClick={() => chain().undo().run()}
        />
        <ToolButton
          label="Redo"
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
          label="B"
          title="Bold"
          active={state.bold}
          disabled={disabled}
          onClick={() => chain().toggleBold().run()}
        />
        <ToolButton
          label="I"
          title="Italic"
          active={state.italic}
          disabled={disabled}
          onClick={() => chain().toggleItalic().run()}
        />
        <ToolButton
          label="U"
          title="Underline"
          active={state.underline}
          disabled={disabled}
          onClick={() => chain().toggleUnderline().run()}
        />
        <ToolButton
          label="S"
          title="Strikethrough"
          active={state.strike}
          disabled={disabled}
          onClick={() => chain().toggleStrike().run()}
        />
        <ToolButton
          label="x²"
          title="Superscript"
          active={state.superscript}
          disabled={disabled}
          onClick={() => chain().toggleSuperscript().run()}
        />
        <ToolButton
          label="x₂"
          title="Subscript"
          active={state.subscript}
          disabled={disabled}
          onClick={() => chain().toggleSubscript().run()}
        />
        <ToolButton
          label="Mark"
          title="Highlight"
          active={state.highlight}
          disabled={disabled}
          onClick={() => chain().toggleHighlight().run()}
        />
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
          label="Clear"
          title="Clear formatting"
          disabled={disabled}
          onClick={() => chain().unsetAllMarks().clearNodes().run()}
        />
      </div>

      <div className="tool-group">
        {ALIGNMENTS.map((alignment) => (
          <ToolButton
            key={alignment}
            label={
              alignment === 'justify'
                ? 'Just'
                : alignment.slice(0, 1).toUpperCase() + alignment.slice(1, 4)
            }
            title={`Align ${alignment}`}
            active={state.alignment === alignment}
            disabled={disabled}
            onClick={() => chain().setTextAlign(alignment).run()}
          />
        ))}
      </div>

      <div className="tool-group">
        <ToolButton
          label="Bullets"
          title="Bulleted list"
          active={state.bulletList}
          disabled={disabled}
          onClick={() => chain().toggleBulletList().run()}
        />
        <ToolButton
          label="Numbers"
          title="Numbered list"
          active={state.orderedList}
          disabled={disabled}
          onClick={() => chain().toggleOrderedList().run()}
        />
        <ToolButton
          label="Quote"
          title="Block quote"
          active={state.blockquote}
          disabled={disabled}
          onClick={() => chain().toggleBlockquote().run()}
        />
      </div>

      <div className="tool-group">
        <ToolButton label="Link" title="Insert link" disabled={disabled} onClick={setLink} />
        <ToolButton label="Image" title="Insert image" disabled={disabled} onClick={insertImage} />
        <ToolButton
          label="Table"
          title="Insert table"
          disabled={disabled}
          onClick={() => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
        />
        <ToolButton
          label="Row+"
          title="Add row below"
          disabled={disabled || !state.canAddRow}
          onClick={() => chain().addRowAfter().run()}
        />
        <ToolButton
          label="Col+"
          title="Add column after"
          disabled={disabled || !state.canAddColumn}
          onClick={() => chain().addColumnAfter().run()}
        />
        <ToolButton
          label="Del row"
          title="Delete row"
          disabled={disabled || !state.canDeleteRow}
          onClick={() => chain().deleteRow().run()}
        />
        <ToolButton
          label="Rule"
          title="Horizontal rule"
          disabled={disabled}
          onClick={() => chain().setHorizontalRule().run()}
        />
      </div>
    </div>
  );
}
