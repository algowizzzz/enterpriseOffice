import { useEffect, useRef, useState, type JSX } from 'react';
import type { Editor } from '@tiptap/react';
import { clearSearch, replaceAll, replaceCurrent, searchState, setSearch, stepSearch } from './searchReplace';

interface FindBarProps {
  editor: Editor;
  readOnly: boolean;
  onClose: () => void;
}

/** Find, and replace, as a bar under the ribbon. Enter finds the next; Escape closes. */
export function FindBar({ editor, readOnly, onClose }: FindBarProps): JSX.Element {
  const [text, setText] = useState('');
  const [replacement, setReplacement] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [count, setCount] = useState({ current: 0, total: 0 });
  const [said, setSaid] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    field.current?.focus();
    // What is selected is what somebody most likely wants to look for.
    const { from, to } = editor.state.selection;
    const selected = editor.state.doc.textBetween(from, to, ' ');
    if (selected && selected.length < 200 && !selected.includes('\n')) setText(selected);
    return () => clearSearch(editor);
  }, [editor]);

  useEffect(() => {
    setSearch(editor, { text, matchCase, wholeWord });
  }, [editor, text, matchCase, wholeWord]);

  useEffect(() => {
    const recount = (): void => {
      const state = searchState(editor);
      setCount({ current: (state?.current ?? -1) + 1, total: state?.matches.length ?? 0 });
    };
    recount();
    editor.on('transaction', recount);
    return () => {
      editor.off('transaction', recount);
    };
  }, [editor]);

  return (
    <div
      className="find-bar"
      role="search"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
    >
      <input
        ref={field}
        value={text}
        aria-label="Find"
        placeholder="Find"
        onChange={(event) => {
          setText(event.target.value);
          setSaid(null);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') stepSearch(editor, event.shiftKey ? -1 : 1);
        }}
      />
      <span className="muted find-count" aria-live="polite">
        {text ? `${count.current} of ${count.total}` : ''}
      </span>
      <button type="button" title="Previous match (Shift+Enter)" disabled={count.total === 0} onClick={() => stepSearch(editor, -1)}>
        Previous
      </button>
      <button type="button" title="Next match (Enter)" disabled={count.total === 0} onClick={() => stepSearch(editor, 1)}>
        Next
      </button>
      <label title="Treat capital and small letters as different">
        <input type="checkbox" checked={matchCase} onChange={(event) => setMatchCase(event.target.checked)} /> Match case
      </label>
      <label title="Only find the text as a word on its own">
        <input type="checkbox" checked={wholeWord} onChange={(event) => setWholeWord(event.target.checked)} /> Whole word
      </label>
      {readOnly ? null : (
        <>
          <input
            value={replacement}
            aria-label="Replace with"
            placeholder="Replace with"
            onChange={(event) => setReplacement(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') replaceCurrent(editor, replacement);
            }}
          />
          <button type="button" title="Replace this match and move to the next" disabled={count.total === 0} onClick={() => replaceCurrent(editor, replacement)}>
            Replace
          </button>
          <button
            type="button"
            title="Replace every match. One undo takes it all back"
            disabled={count.total === 0}
            onClick={() => {
              const replaced = replaceAll(editor, replacement);
              setSaid(`${replaced} replaced`);
            }}
          >
            Replace all
          </button>
        </>
      )}
      {said ? <span className="muted">{said}</span> : null}
      <button type="button" className="link" title="Close (Escape)" onClick={onClose}>
        Close
      </button>
    </div>
  );
}
