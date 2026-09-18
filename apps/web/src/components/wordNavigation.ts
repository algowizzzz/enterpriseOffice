import { Extension } from '@tiptap/core';

/**
 * Document navigation shortcuts that Word users expect and ProseMirror's
 * default key map does not provide.
 *
 * Control and Home together jump to the start of the document, Control and End
 * to the end. Without these, pressing them does nothing and the caret stays put,
 * which silently turns the next keystroke into an edit of whatever was selected.
 */
export const WordNavigation = Extension.create({
  name: 'wordNavigation',

  addKeyboardShortcuts() {
    return {
      'Mod-Home': () => this.editor.commands.focus('start'),
      'Mod-End': () => this.editor.commands.focus('end'),
    };
  },
});
