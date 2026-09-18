import { Extension, Mark, mergeAttributes, type Editor } from '@tiptap/core';
import type { Mark as PMMark, Node as PMNode, Slice } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection, type Transaction } from '@tiptap/pm/state';
import { ReplaceStep } from '@tiptap/pm/transform';

const change = (name: 'insertion' | 'deletion', tag: 'ins' | 'del') =>
  Mark.create({
    name,
    // A change sits alongside any formatting, and a word can be both inserted
    // by one person and deleted by another.
    excludes: '',
    inclusive: false,
    addAttributes() {
      return {
        author: {
          default: '',
          parseHTML: (element: HTMLElement) => element.getAttribute('data-author') ?? '',
          renderHTML: (attributes: Record<string, unknown>) => ({
            'data-author': typeof attributes['author'] === 'string' ? attributes['author'] : '',
          }),
        },
        date: {
          default: '',
          parseHTML: (element: HTMLElement) => element.getAttribute('data-date') ?? '',
          renderHTML: (attributes: Record<string, unknown>) => ({
            'data-date': typeof attributes['date'] === 'string' ? attributes['date'] : '',
          }),
        },
      };
    },
    parseHTML() {
      return [{ tag: `${tag}[data-author]` }];
    },
    renderHTML({ mark, HTMLAttributes }) {
      const author = String(mark.attrs['author'] ?? '');
      return [
        tag,
        mergeAttributes(HTMLAttributes, {
          class: `tracked tracked-${name}`,
          title: `${name === 'insertion' ? 'Inserted' : 'Deleted'}${author ? ` by ${author}` : ''}`,
        }),
        0,
      ];
    },
  });

export const Insertion = change('insertion', 'ins');
export const Deletion = change('deletion', 'del');

interface TrackState {
  enabled: boolean;
  author: string;
}

export const trackChangesKey = new PluginKey<TrackState>('trackChanges');
/** Set on a transaction that settles or records changes, so it is not tracked itself. */
const SKIP = 'trackChanges$skip';

export interface TrackedChange {
  type: 'insertion' | 'deletion';
  author: string;
  date: string;
  from: number;
  to: number;
  text: string;
}

const changeMark = (node: PMNode): PMMark | undefined =>
  node.marks.find((mark) => mark.type.name === 'insertion' || mark.type.name === 'deletion');

/** Every tracked change in the document, neighbouring pieces of one change joined. */
export function listChanges(doc: PMNode): TrackedChange[] {
  const changes: TrackedChange[] = [];
  doc.descendants((node, position) => {
    if (!node.isInline) return true;
    const mark = changeMark(node);
    if (!mark) return false;
    const last = changes.at(-1);
    const entry = {
      type: mark.type.name as TrackedChange['type'],
      author: String(mark.attrs['author'] ?? ''),
      date: String(mark.attrs['date'] ?? ''),
    };
    if (last && last.to === position && last.type === entry.type && last.author === entry.author && last.date === entry.date) {
      last.to = position + node.nodeSize;
      last.text += node.isText ? (node.text ?? '') : ' ';
    } else {
      changes.push({ ...entry, from: position, to: position + node.nodeSize, text: node.isText ? (node.text ?? '') : ' ' });
    }
    return false;
  });
  return changes;
}

/**
 * Settle changes: all of them, or only those touching a range.
 *
 * Accepting an insertion keeps the text and drops the mark; accepting a
 * deletion removes the text. Rejecting is the other way about. Worked from the
 * end of the document backwards so that removing text never moves a change
 * that is still to be dealt with.
 */
export function settleChanges(editor: Editor, how: 'accept' | 'reject', range?: { from: number; to: number }): boolean {
  const { state } = editor;
  const transaction = state.tr.setMeta(SKIP, true);
  const changes = listChanges(state.doc).filter(
    (entry) => !range || (entry.from <= range.to && entry.to >= range.from),
  );
  if (changes.length === 0) return false;
  for (const entry of [...changes].reverse()) {
    const removes = (entry.type === 'insertion') === (how === 'reject');
    if (removes) transaction.delete(entry.from, entry.to);
    else transaction.removeMark(entry.from, entry.to, state.schema.marks[entry.type]);
  }
  editor.view.dispatch(transaction);
  return true;
}

export function setTracking(editor: Editor, enabled: boolean, author: string): void {
  editor.view.dispatch(editor.state.tr.setMeta(trackChangesKey, { enabled, author }).setMeta(SKIP, true));
}

/** The parts of a deleted slice that should stay, struck out. */
function keptPieces(slice: Slice, author: string): PMNode[] {
  const kept: PMNode[] = [];
  slice.content.forEach((node) => {
    // Somebody deleting what they themselves just inserted is changing their
    // mind, not proposing a deletion: it simply goes.
    const own = node.marks.some((mark) => mark.type.name === 'insertion' && mark.attrs['author'] === author);
    if (!own) kept.push(node);
  });
  return kept;
}

/**
 * Track changes while somebody types.
 *
 * What was typed is marked as inserted. What was deleted is put back, marked as
 * deleted, so that it is still there to be restored. Done after the fact, in an
 * appended transaction, so every way of changing text (typing, pasting, cutting,
 * dragging, the ribbon) is covered without each having to know about it.
 *
 * Only text within one paragraph is tracked. Splitting or joining paragraphs,
 * and changes to the structure of a table, take effect directly: Word records
 * those on the paragraph mark, which the model does not hold.
 */
export const TrackChanges = Extension.create({
  name: 'trackChanges',
  addProseMirrorPlugins() {
    return [
      new Plugin<TrackState>({
        key: trackChangesKey,
        state: {
          init: () => ({ enabled: false, author: '' }),
          apply(transaction, value) {
            const meta = transaction.getMeta(trackChangesKey) as TrackState | undefined;
            return meta ?? value;
          },
        },
        appendTransaction(transactions, oldState, newState) {
          const tracking = trackChangesKey.getState(newState);
          if (!tracking?.enabled) return null;
          const relevant = transactions.filter(
            (transaction) =>
              transaction.docChanged &&
              !transaction.getMeta(SKIP) &&
              // Undo and redo put back exactly what was there, marks included.
              !transaction.getMeta('history$') &&
              // A change arriving from somebody else was tracked where it was made.
              !(transaction.getMeta('y-sync$') as { isChangeOrigin?: boolean } | undefined)?.isChangeOrigin,
          );
          if (relevant.length === 0) return null;

          const { insertion, deletion } = newState.schema.marks;
          if (!insertion || !deletion) return null;
          // To the minute, as Word records it. To the millisecond, every
          // keystroke was a change of its own and a sentence typed in one go
          // was forty entries in the review list.
          const stamp = { author: tracking.author, date: `${new Date().toISOString().slice(0, 16)}:00Z` };
          const repair: Transaction = newState.tr.setMeta(SKIP, true).setMeta('addToHistory', true);
          let cursor: number | null = null;
          let document = oldState.doc;

          transactions.forEach((transaction, index) => {
            const isRelevant = relevant.includes(transaction);
            transaction.steps.forEach((step, stepIndex) => {
              const before = document;
              document = transaction.docs[stepIndex + 1] ?? transaction.doc;
              if (!isRelevant || !(step instanceof ReplaceStep)) return;

              // A position in the document as this step left it, carried
              // through everything that happened afterwards, this repair
              // included.
              const carried = (position: number): number => {
                let mapped = transaction.mapping.slice(stepIndex + 1).map(position, -1);
                for (const later of transactions.slice(index + 1)) mapped = later.mapping.map(mapped, -1);
                return repair.mapping.map(mapped, -1);
              };

              const { from, to, slice } = step;
              const start = carried(from);
              if (slice.size > 0) {
                // Marked before anything is put back in front of it, so the
                // text that is put back is not marked as inserted as well.
                const end = carried(from + slice.size);
                if (end > start) {
                  // Carrying on from what this person was already inserting is
                  // the same insertion, not a new one beside it.
                  const previous = repair.doc.resolve(start).nodeBefore?.marks.find(
                    (mark) => mark.type === insertion && mark.attrs['author'] === tracking.author,
                  );
                  repair.addMark(start, end, previous ?? insertion.create(stamp));
                  repair.removeMark(start, end, deletion);
                }
              }
              if (to > from) {
                const $from = before.resolve(from);
                const $to = before.resolve(to);
                if ($from.sameParent($to) && $from.parent.isTextblock) {
                  const pieces = keptPieces(before.slice(from, to), tracking.author);
                  if (pieces.length > 0) {
                    const struck = pieces.map((node) =>
                      node.mark(deletion.create(stamp).addToSet(node.marks.filter((mark) => mark.type !== deletion))),
                    );
                    repair.insert(start, struck);
                    const size = struck.reduce((sum, node) => sum + node.nodeSize, 0);
                    // Backspace leaves the cursor before what it struck out, so
                    // pressing it again carries on leftwards. Delete, and typing
                    // over a selection, leave it after.
                    const wasBackspace = slice.size === 0 && oldState.selection.empty && oldState.selection.head === to;
                    cursor = wasBackspace ? start : start + size + slice.size;
                  }
                }
              }
            });
          });

          if (repair.steps.length === 0) return null;
          if (cursor !== null) {
            const at = Math.min(Math.max(cursor, 0), repair.doc.content.size);
            repair.setSelection(TextSelection.near(repair.doc.resolve(at)));
          }
          return repair;
        },
      }),
    ];
  },
});
