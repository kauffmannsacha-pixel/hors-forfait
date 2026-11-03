// Liste de suggestions (menu « / » et mentions « @ ») + fabrique de rendu pour @tiptap/suggestion.
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ComponentType, type ReactNode, type RefAttributes } from 'react';
import { ReactRenderer } from '@tiptap/react';
import { exitSuggestion, type SuggestionOptions, type SuggestionProps } from '@tiptap/suggestion';
import type { PluginKey } from '@tiptap/pm/state';

export interface ListItem { key: string; title: string; description?: string; icon?: ReactNode; group?: string; hint?: string }
export interface SuggestionListProps { items: ListItem[]; onSelect: (index: number) => void; loading?: boolean; emptyText?: string; title?: string }
export interface SuggestionListRef { onKeyDown: (e: KeyboardEvent) => boolean }

export const SuggestionList = forwardRef<SuggestionListRef, SuggestionListProps>(function SuggestionList({ items, onSelect, loading, emptyText = 'Aucun résultat', title }, ref) {
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const pointerMoved = useRef(false);
  useEffect(() => setActive(0), [items]);
  useLayoutEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  useImperativeHandle(ref, () => ({
    onKeyDown: (e: KeyboardEvent) => {
      if (!items.length) return false;
      if (e.key === 'ArrowDown') { setActive(i => (i + 1) % items.length); return true; }
      if (e.key === 'ArrowUp') { setActive(i => (i - 1 + items.length) % items.length); return true; }
      if (e.key === 'Enter' || e.key === 'Tab') { onSelect(active); return true; }
      return false;
    },
  }), [items, active, onSelect]);

  let lastGroup: string | undefined;
  return (
    <div className="suggest glass" ref={listRef} role="listbox" onPointerMove={() => { pointerMoved.current = true; }} onMouseDown={e => e.preventDefault()}>
      {title && <div className="suggest-title">{title}</div>}
      {items.length === 0 && <div className="suggest-empty">{loading ? 'Recherche…' : emptyText}</div>}
      {items.map((it, i) => {
        const header = it.group && it.group !== lastGroup ? <div className="suggest-group" key={'g' + it.group + i}>{it.group}</div> : null;
        lastGroup = it.group;
        return [header,
          <button key={it.key} type="button" data-index={i} role="option" aria-selected={i === active}
            className={`suggest-item${i === active ? ' active' : ''}`}
            onPointerEnter={() => { if (pointerMoved.current) setActive(i); }}
            onClick={() => onSelect(i)}>
            <span className="suggest-icon">{it.icon}</span>
            <span className="suggest-text">
              <span className="suggest-name">{it.title}</span>
              {it.description && <span className="suggest-desc">{it.description}</span>}
            </span>
            {it.hint && <kbd className="suggest-hint">{it.hint}</kbd>}
          </button>];
      })}
    </div>
  );
});

type Renderer<I, S> = NonNullable<SuggestionOptions<I, S>['render']>;

/**
 * Fabrique `render` pour @tiptap/suggestion : un composant React monté via props.mount (floating-ui).
 * `toList` convertit les items ; `autoExitOnEmptySpace` ferme le menu quand rien ne correspond et qu'on tape un espace.
 */
export function suggestionRenderer<I, S>(opts: {
  pluginKey: PluginKey;
  toList: (items: I[], props: SuggestionProps<I, S>) => ListItem[];
  title?: (props: SuggestionProps<I, S>) => string | undefined;
  emptyText?: string;
  autoExitOnEmptySpace?: boolean;
  component?: ComponentType<SuggestionListProps & RefAttributes<SuggestionListRef>>;
}): Renderer<I, S> {
  return () => {
    let renderer: ReactRenderer<SuggestionListRef, SuggestionListProps> | null = null;
    let unmount: (() => void) | null = null;
    let current: SuggestionProps<I, S> | null = null;
    const listProps = (p: SuggestionProps<I, S>): SuggestionListProps => ({
      items: opts.toList(p.items, p),
      loading: p.loading,
      emptyText: opts.emptyText,
      title: opts.title?.(p),
      onSelect: (index: number) => { const it = current?.items[index]; if (it !== undefined) current?.command(it as unknown as S); },
    });
    return {
      onStart: p => {
        current = p;
        renderer = new ReactRenderer(opts.component ?? SuggestionList, { props: listProps(p), editor: p.editor });
        const el = renderer.element as HTMLElement;
        el.classList.add('suggest-popup');
        el.style.zIndex = '120';
        unmount = p.mount(el);
      },
      onUpdate: p => {
        current = p;
        renderer?.updateProps(listProps(p));
        if (opts.autoExitOnEmptySpace && !p.loading && p.items.length === 0 && /\s{1,}$/.test(p.query)) {
          const view = p.editor.view;
          setTimeout(() => { if (!p.editor.isDestroyed) exitSuggestion(view, opts.pluginKey); }, 0);
        }
      },
      onKeyDown: ({ event }) => (event.key === 'Escape' ? false : renderer?.ref?.onKeyDown(event) ?? false),
      onExit: () => { unmount?.(); unmount = null; renderer?.destroy(); renderer = null; current = null; },
    };
  };
}
