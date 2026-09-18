import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { locateAnchor, textBlocks, type CommentAnchor, type PMNode } from '@docforge/model';

export interface HighlightedThread {
  id: string;
  anchor: CommentAnchor;
  resolved: boolean;
}

interface HighlightState {
  threads: HighlightedThread[];
  active: string | null;
  decorations: DecorationSet;
  /** Threads whose words could not be found, which the panel shows as detached. */
  detached: string[];
}

export const commentHighlightsKey = new PluginKey<HighlightState>('commentHighlights');

type Meta = { threads?: HighlightedThread[]; active?: string | null };

/**
 * Draws comments on the words they were made on.
 *
 * A comment is not part of the document: it is a highlight laid over it, found
 * again each time from the words it quotes. While somebody types, the
 * highlights are carried along with the text rather than searched for again on
 * every keystroke; they are only searched for when the list of comments changes.
 */
export const CommentHighlights = Extension.create({
  name: 'commentHighlights',
  addProseMirrorPlugins() {
    const build = (doc: { toJSON: () => unknown }, threads: HighlightedThread[], active: string | null) => {
      const blocks = textBlocks(doc.toJSON() as PMNode);
      const decorations: Decoration[] = [];
      const detached: string[] = [];
      for (const thread of threads) {
        const found = locateAnchor(blocks, thread.anchor);
        const block = found ? blocks[found.block] : undefined;
        if (!found || !block) {
          detached.push(thread.id);
          continue;
        }
        decorations.push(
          Decoration.inline(block.start + found.from, block.start + found.to, {
            class: `comment-mark${thread.resolved ? ' comment-mark-resolved' : ''}${
              thread.id === active ? ' comment-mark-active' : ''
            }`,
            'data-thread': thread.id,
          }),
        );
      }
      return { decorations, detached };
    };

    return [
      new Plugin<HighlightState>({
        key: commentHighlightsKey,
        state: {
          init: () => ({ threads: [], active: null, decorations: DecorationSet.empty, detached: [] }),
          apply(transaction, value, _old, state) {
            const meta = transaction.getMeta(commentHighlightsKey) as Meta | undefined;
            if (meta) {
              const threads = meta.threads ?? value.threads;
              const active = meta.active === undefined ? value.active : meta.active;
              const built = build(state.doc, threads, active);
              return {
                threads,
                active,
                decorations: DecorationSet.create(state.doc, built.decorations),
                detached: built.detached,
              };
            }
            if (!transaction.docChanged) return value;
            return { ...value, decorations: value.decorations.map(transaction.mapping, transaction.doc) };
          },
        },
        props: {
          decorations(state) {
            return commentHighlightsKey.getState(state)?.decorations ?? DecorationSet.empty;
          },
        },
      }),
    ];
  },
});
