// Barre flottante de mise en forme (sélection de texte) : gras, italique, souligné, barré, code, lien, couleurs, « Transformer en ».
import { useCallback, useState, type ReactNode } from 'react';
import { useEditorState, type Editor } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import { NodeSelection } from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';
import { openMenu, type MenuItem } from '../../ui/Menu';
import { IconBold, IconCode, IconItalic, IconLink, IconStrike, IconUnderline, IconChevronDown, IconTrash, IconCheck } from '../../ui/icons';
import { COLORS } from '../colors';
import { availableTurnInto, turnInto } from '../blockOps';

function currentBlockLabel(e: Editor): string {
  if (e.isActive('heading', { level: 1 })) return 'Titre 1';
  if (e.isActive('heading', { level: 2 })) return 'Titre 2';
  if (e.isActive('heading', { level: 3 })) return 'Titre 3';
  if (e.isActive('taskList')) return 'Tâches';
  if (e.isActive('bulletList')) return 'Liste';
  if (e.isActive('orderedList')) return 'Liste num.';
  if (e.isActive('blockquote')) return 'Citation';
  if (e.isActive('callout')) return 'Callout';
  return 'Texte';
}

const normalizeUrl = (u: string) => {
  const v = u.trim();
  if (!v) return '';
  if (/^(https?:|mailto:|tel:|#)/i.test(v)) return v;
  if (/^[\w.+-]+@[\w-]+\.[\w.]+$/.test(v)) return 'mailto:' + v;
  return 'https://' + v;
};

function Btn({ active, title, onClick, children }: { active?: boolean; title: string; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void; children: ReactNode }) {
  return <button type="button" className={`fb-btn${active ? ' on' : ''}`} title={title} aria-label={title} aria-pressed={active} onMouseDown={e => e.preventDefault()} onClick={onClick}>{children}</button>;
}

export function FormatBubble({ editor }: { editor: Editor }) {
  const [linkMode, setLinkMode] = useState(false);
  const [href, setHref] = useState('');
  const st = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'), italic: e.isActive('italic'), underline: e.isActive('underline'), strike: e.isActive('strike'),
      code: e.isActive('code'), link: e.isActive('link'), href: (e.getAttributes('link').href as string | undefined) ?? '',
      color: (e.getAttributes('textStyle').color as string | undefined) ?? null, bg: (e.getAttributes('highlight').color as string | undefined) ?? null,
      block: currentBlockLabel(e),
    }),
  });

  const shouldShow = useCallback(({ editor: e, state, from, to }: { editor: Editor; state: Editor['state']; from: number; to: number }) => {
    if (!e.isEditable || from === to) return false;
    if (state.selection instanceof NodeSelection) return false;
    if (e.isActive('codeBlock')) return false;
    if (state.selection instanceof CellSelection) return false;
    return state.doc.textBetween(from, to, ' ').trim().length > 0;
  }, []);

  const applyLink = () => {
    const url = normalizeUrl(href);
    const chain = editor.chain().focus().extendMarkRange('link');
    if (url) chain.setLink({ href: url }).run(); else chain.unsetLink().run();
    setLinkMode(false);
  };

  const colorMenu = (el: HTMLElement) => {
    const items: MenuItem[] = [
      { heading: true, label: 'Couleur du texte' },
      ...COLORS.map(c => ({ label: c.label, checked: (st?.color ?? null) === c.text, icon: <span className="menu-swatch" style={{ color: c.text ?? 'var(--fg)' }}>A</span>,
        onSelect: () => { const ch = editor.chain().focus(); if (c.text) ch.setColor(c.text).run(); else ch.unsetColor().run(); } })),
      { separator: true },
      { heading: true, label: 'Couleur de fond' },
      ...COLORS.map(c => ({ label: c.id === 'default' ? 'Aucune' : `Fond ${c.label.toLowerCase()}`, checked: (st?.bg ?? null) === c.bg, icon: <span className="menu-swatch bg" style={{ background: c.bg ?? 'transparent' }}>A</span>,
        onSelect: () => { const ch = editor.chain().focus(); if (c.bg) ch.setHighlight({ color: c.bg }).run(); else ch.unsetHighlight().run(); } })),
    ];
    openMenu(el, items, { placement: 'bottom-start', minWidth: 200 });
  };
  const turnMenu = (el: HTMLElement) => openMenu(el, availableTurnInto(editor).map(t => ({ label: t.label, icon: <span className="glyph">{t.icon}</span>, onSelect: () => { turnInto(editor, t.id); } })), { placement: 'bottom-start', minWidth: 190 });

  return (
    <BubbleMenu editor={editor} pluginKey="formatBubble" shouldShow={shouldShow} className="format-bubble glass"
      options={{ placement: 'top', offset: 8, flip: true, shift: { padding: 8 }, onHide: () => setLinkMode(false) }}>
      {linkMode ? (
        <form className="fb-link" onSubmit={e => { e.preventDefault(); applyLink(); }}>
          <IconLink />
          <input autoFocus className="fb-input" placeholder="Colle ou tape un lien…" value={href} onChange={e => setHref(e.target.value)}
            onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); setLinkMode(false); editor.commands.focus(); } }} />
          <button type="submit" className="fb-btn" title="Valider"><IconCheck /></button>
          {st?.link && <button type="button" className="fb-btn" title="Retirer le lien" onClick={() => { editor.chain().focus().extendMarkRange('link').unsetLink().run(); setLinkMode(false); }}><IconTrash /></button>}
        </form>
      ) : (
        <>
          <button type="button" className="fb-turn" onMouseDown={e => e.preventDefault()} onClick={e => turnMenu(e.currentTarget)}>{st?.block}<IconChevronDown size={12} /></button>
          <span className="fb-sep" />
          <Btn active={st?.bold} title="Gras (Ctrl+B)" onClick={() => editor.chain().focus().toggleBold().run()}><IconBold /></Btn>
          <Btn active={st?.italic} title="Italique (Ctrl+I)" onClick={() => editor.chain().focus().toggleItalic().run()}><IconItalic /></Btn>
          <Btn active={st?.underline} title="Souligné (Ctrl+U)" onClick={() => editor.chain().focus().toggleUnderline().run()}><IconUnderline /></Btn>
          <Btn active={st?.strike} title="Barré (Ctrl+Maj+S)" onClick={() => editor.chain().focus().toggleStrike().run()}><IconStrike /></Btn>
          <Btn active={st?.code} title="Code (Ctrl+E)" onClick={() => editor.chain().focus().toggleCode().run()}><IconCode /></Btn>
          <span className="fb-sep" />
          <Btn active={st?.link} title="Lien" onClick={() => { setHref(st?.href ?? ''); setLinkMode(true); }}><IconLink /></Btn>
          <Btn active={!!st?.bg} title="Surligner (Ctrl+Maj+H)" onClick={() => editor.chain().focus().toggleHighlight({ color: 'var(--bc-yellow)' }).run()}><span className="fb-hl">H</span></Btn>
          <Btn active={!!st?.color} title="Couleur" onClick={e => colorMenu(e.currentTarget)}><span className="fb-color" style={{ color: st?.color ?? undefined }}>A</span><IconChevronDown size={10} /></Btn>
        </>
      )}
    </BubbleMenu>
  );
}
