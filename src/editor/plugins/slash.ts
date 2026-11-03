// Menu « / » : @tiptap/suggestion + recherche floue + éléments enregistrés par les modules.
import { Extension } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import Suggestion from '@tiptap/suggestion';
import { createElement } from 'react';
import type { SlashItem } from '../../ui/registry';
import { filterSlashItems, runSlashItem } from '../slashItems';
import { suggestionRenderer } from '../ui/SuggestionList';

export const SlashPluginKey = new PluginKey('slashCommand');

const iconNode = (icon: string) => createElement('span', { className: icon.length <= 3 && /^[\x20-\x7E√∑▦◫▥•☑▸❝—⧉]+$/.test(icon) ? 'glyph' : 'emoji' }, icon);

export const SlashCommand = Extension.create({
  name: 'slashCommand',
  addProseMirrorPlugins() {
    return [Suggestion<SlashItem, SlashItem>({
      editor: this.editor,
      pluginKey: SlashPluginKey,
      char: '/',
      allowSpaces: true,
      allowedPrefixes: [' ', ' ', '(', '"', '«'],
      decorationClass: 'slash-query',
      floatingUi: { strategy: 'fixed' },
      allow: ({ state, range }) => {
        const $from = state.doc.resolve(range.from);
        return !$from.parent.type.spec.code && !state.selection.$from.marks().some(m => m.type.name === 'code');
      },
      items: ({ query }) => filterSlashItems(query),
      command: ({ editor, range, props }) => runSlashItem(props, editor, range),
      render: suggestionRenderer<SlashItem, SlashItem>({
        pluginKey: SlashPluginKey,
        autoExitOnEmptySpace: true,
        emptyText: 'Aucun bloc ne correspond',
        toList: items => items.map(i => ({ key: i.id, title: i.title, description: i.description, icon: iconNode(i.icon), group: i.group })),
      }),
    })];
  },
});
