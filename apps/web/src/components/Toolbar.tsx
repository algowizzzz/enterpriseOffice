import { useCallback, type JSX } from 'react';
import type { Editor } from '@tiptap/react';
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

/** The formatting ribbon. Every control acts on the current selection. */
export function Toolbar({ editor, disabled = false }: ToolbarProps): JSX.Element {
  const chain = useCallback(() => editor.chain().focus(), [editor]);

  const setLink = useCallback(() => {
    const previous = (editor.getAttributes('link')['href'] as string | undefined) ?? '';
    const href = window.prompt('Link address', previous);
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
  }, [editor]);

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
        editor.chain().focus().setImage({ src: String(reader.result) }).run();
      };
      reader.readAsDataURL(file);
    };
    input.click();
  }, [editor]);

  const headingValue = (): string => {
    for (let level = 1; level <= 6; level += 1) {
      if (editor.isActive('heading', { level })) return String(level);
    }
    return 'p';
  };

  return (
    <div className="toolbar" role="toolbar" aria-label="Formatting" aria-disabled={disabled}>
      <div className="tool-group">
        <ToolButton
          label="Undo"
          title="Undo"
          disabled={disabled || !editor.can().undo()}
          onClick={() => chain().undo().run()}
        />
        <ToolButton
          label="Redo"
          title="Redo"
          disabled={disabled || !editor.can().redo()}
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
          value={headingValue()}
          onChange={(event) => {
            const value = event.target.value;
            if (value === 'p') chain().setParagraph().run();
            else chain().toggleHeading({ level: Number(value) as 1 | 2 | 3 | 4 | 5 | 6 }).run();
          }}
        >
          <option value="p">Normal text</option>
          <option value="1">Heading 1</option>
          <option value="2">Heading 2</option>
          <option value="3">Heading 3</option>
          <option value="4">Heading 4</option>
          <option value="5">Heading 5</option>
          <option value="6">Heading 6</option>
        </select>

        <label className="visually-hidden" htmlFor="tb-font">
          Font
        </label>
        <select
          id="tb-font"
          className="tool-select"
          disabled={disabled}
          value={(editor.getAttributes('textStyle')['fontFamily'] as string) ?? ''}
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
          value={String(editor.getAttributes('textStyle')['fontSize'] ?? '').replace('pt', '')}
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
          active={editor.isActive('bold')}
          disabled={disabled}
          onClick={() => chain().toggleBold().run()}
        />
        <ToolButton
          label="I"
          title="Italic"
          active={editor.isActive('italic')}
          disabled={disabled}
          onClick={() => chain().toggleItalic().run()}
        />
        <ToolButton
          label="U"
          title="Underline"
          active={editor.isActive('underline')}
          disabled={disabled}
          onClick={() => chain().toggleUnderline().run()}
        />
        <ToolButton
          label="S"
          title="Strikethrough"
          active={editor.isActive('strike')}
          disabled={disabled}
          onClick={() => chain().toggleStrike().run()}
        />
        <ToolButton
          label="x²"
          title="Superscript"
          active={editor.isActive('superscript')}
          disabled={disabled}
          onClick={() => chain().toggleSuperscript().run()}
        />
        <ToolButton
          label="x₂"
          title="Subscript"
          active={editor.isActive('subscript')}
          disabled={disabled}
          onClick={() => chain().toggleSubscript().run()}
        />
        <ToolButton
          label="Mark"
          title="Highlight"
          active={editor.isActive('highlight')}
          disabled={disabled}
          onClick={() => chain().toggleHighlight().run()}
        />
        <label className="tool-color" title="Text colour">
          <span className="visually-hidden">Text colour</span>
          <input
            type="color"
            disabled={disabled}
            value={(editor.getAttributes('textStyle')['color'] as string) ?? '#000000'}
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
        {(['left', 'center', 'right', 'justify'] as const).map((alignment) => (
          <ToolButton
            key={alignment}
            label={alignment === 'justify' ? 'Just' : alignment.slice(0, 1).toUpperCase() + alignment.slice(1, 4)}
            title={`Align ${alignment}`}
            active={editor.isActive({ textAlign: alignment })}
            disabled={disabled}
            onClick={() => chain().setTextAlign(alignment).run()}
          />
        ))}
      </div>

      <div className="tool-group">
        <ToolButton
          label="Bullets"
          title="Bulleted list"
          active={editor.isActive('bulletList')}
          disabled={disabled}
          onClick={() => chain().toggleBulletList().run()}
        />
        <ToolButton
          label="Numbers"
          title="Numbered list"
          active={editor.isActive('orderedList')}
          disabled={disabled}
          onClick={() => chain().toggleOrderedList().run()}
        />
        <ToolButton
          label="Quote"
          title="Block quote"
          active={editor.isActive('blockquote')}
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
          onClick={() =>
            chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
          }
        />
        <ToolButton
          label="Row+"
          title="Add row below"
          disabled={disabled || !editor.can().addRowAfter()}
          onClick={() => chain().addRowAfter().run()}
        />
        <ToolButton
          label="Col+"
          title="Add column after"
          disabled={disabled || !editor.can().addColumnAfter()}
          onClick={() => chain().addColumnAfter().run()}
        />
        <ToolButton
          label="Del row"
          title="Delete row"
          disabled={disabled || !editor.can().deleteRow()}
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
