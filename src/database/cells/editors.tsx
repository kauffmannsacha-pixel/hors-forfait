// Éditeurs de cellules (dans un popover) pour chaque type modifiable.
import {
  addMonths, eachDayOfInterval, endOfMonth, endOfWeek, format, isSameDay, isSameMonth, isToday, startOfMonth, startOfWeek,
} from 'date-fns';
import { fr } from 'date-fns/locale';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { usePages } from '../../db/pages';
import { isTauri } from '../../db/store';
import type { Page } from '../../db/types';
import { files } from '../../files/api';
import { confirmAction, toast } from '../../ui/appState';
import { liveRows } from '../ctx';
import { parseDateInput, readDate, writeDate } from '../dates';
import { asFiles, asList, asNumber, asText, optionsFor, rawValue, type EngineCtx } from '../engine';
import { addOption, createRow, deleteOption, setValue, updateOption } from '../mutations';
import { COLOR_LABELS, COLORS, colorOf, nextColor, norm, type FileRef, type Person, type PropDef } from '../model';
import { addPerson, removePerson, updatePerson, usePeople } from '../people';
import { useSchema } from '../schemaStore';
import { Icon } from '../ui/icons';
import { Menu, MenuItem, MenuLabel, MenuSep, Popover, Toggle } from '../ui/Popover';
import { Avatar, FileChip, isImageRef, normalizeUrl, openExternal, openFile, PersonChip, Tag, useFileUrl } from './CellView';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
export const report = (e: unknown) => toast(errMsg(e), 'error');

// ── Texte / nombre / liens ───────────────────────────────────
function autosize(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = '0px';
  el.style.height = Math.min(el.scrollHeight, 320) + 'px';
}

export function TextEditor({ initial, commit, multiline, onDone, placeholder, kind = 'text', parse }: {
  initial: string; commit: (v: string) => void; multiline?: boolean; onDone: () => void; placeholder?: string;
  kind?: 'text' | 'url' | 'email' | 'phone' | 'number'; parse?: (v: string) => string | null;
}) {
  const [v, setV] = useState(initial);
  const latest = useRef(initial);
  const saved = useRef(initial);
  const timer = useRef<number | undefined>(undefined);
  const commitRef = useRef(commit); commitRef.current = commit;
  const flush = useCallback(() => {
    window.clearTimeout(timer.current);
    if (latest.current !== saved.current) { saved.current = latest.current; commitRef.current(latest.current); }
  }, []);
  useEffect(() => () => flush(), [flush]);
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => autosize(ref.current), [v]);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    el.focus(); el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const invalid = parse && v.trim() !== '' && parse(v) === null;
  const href = v.trim() && (kind === 'url' ? normalizeUrl(v) : kind === 'email' ? `mailto:${v.trim()}` : kind === 'phone' ? `tel:${v.replace(/\s/g, '')}` : null);
  return (
    <div className="db-edit-text">
      <textarea
        ref={ref} rows={1} value={v} placeholder={placeholder} spellCheck={kind === 'text'}
        inputMode={kind === 'number' ? 'decimal' : kind === 'email' ? 'email' : kind === 'phone' ? 'tel' : kind === 'url' ? 'url' : undefined}
        className={invalid ? 'invalid' : undefined}
        onChange={e => {
          const x = multiline ? e.target.value : e.target.value.replace(/\n/g, ' ');
          setV(x); latest.current = x;
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(flush, 350);
        }}
        onKeyDown={e => {
          if (e.key === 'Enter' && (!multiline || !e.shiftKey)) { e.preventDefault(); flush(); onDone(); }
        }}
      />
      {href && (
        <button type="button" className="db-icon-btn" title="Ouvrir le lien" onClick={() => void openExternal(href)}>
          <Icon name="open" />
        </button>
      )}
      {invalid && <div className="db-edit-hint">Nombre invalide</div>}
    </div>
  );
}

// ── Sélections ───────────────────────────────────────────────
function OptionEditMenu({ dbId, prop, optionId, anchor, onClose }: { dbId: string; prop: PropDef; optionId: string; anchor: HTMLElement | null; onClose: () => void }) {
  const option = prop.options?.find(o => o.id === optionId);
  const [name, setName] = useState(option?.name ?? '');
  if (!option) return null;
  const save = () => { if (name.trim() && name.trim() !== option.name) updateOption(dbId, prop.id, option.id, { name }).catch(report); };
  const remove = async () => {
    const used = liveRows(dbId).some(r => optionsFor(prop, rawValue(r, prop)).some(o => o.name === option.name));
    if (used && !(await confirmAction(`Supprimer l’option « ${option.name} » ? Elle sera retirée de toutes les lignes qui l’utilisent.`, { danger: true, confirmLabel: 'Supprimer' }))) return;
    await deleteOption(dbId, prop.id, option.id).catch(report);
    onClose();
  };
  return (
    <Popover open anchor={anchor} placement="right-start" onClose={() => { save(); onClose(); }} width={220} label="Modifier l’option">
      <div className="db-pad">
        <input className="db-input" value={name} autoFocus onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { save(); onClose(); } }} />
      </div>
      <Menu>
        <MenuItem icon="trash" label="Supprimer" danger onSelect={() => void remove()} />
        <MenuSep />
        <MenuLabel>Couleurs</MenuLabel>
        {COLORS.map(c => (
          <MenuItem key={c} icon={<span className={`db-swatch db-c-${c}`} />} label={COLOR_LABELS[c]} checked={colorOf(option.color) === c}
            onSelect={() => updateOption(dbId, prop.id, option.id, { color: c }).catch(report)} />
        ))}
      </Menu>
    </Popover>
  );
}

export function OptionsEditor({ dbId, prop, value, multi, commit, onDone }: {
  dbId: string; prop: PropDef; value: string[]; multi: boolean; commit: (names: string[]) => void; onDone: () => void;
}) {
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const [sel, setSel] = useState<string[]>(value);
  const [editing, setEditing] = useState<{ id: string; el: HTMLElement } | null>(null);
  const opts = prop.options ?? [];
  const nq = norm(q.trim());
  const list = opts.filter(o => !nq || norm(o.name).includes(nq));
  const canCreate = !!q.trim() && !opts.some(o => o.name.toLowerCase() === q.trim().toLowerCase());
  const count = list.length + (canCreate ? 1 : 0);
  useEffect(() => { setHi(h => Math.min(h, Math.max(0, count - 1))); }, [count]);

  const choose = (name: string) => {
    if (multi) {
      const next = sel.includes(name) ? sel.filter(x => x !== name) : [...sel, name];
      setSel(next); commit(next); setQ('');
    } else {
      const next = sel[0] === name ? [] : [name];
      setSel(next); commit(next); onDone();
    }
  };
  const create = async () => {
    const o = await addOption(dbId, prop.id, q.trim()).catch(report);
    if (o) choose(o.name);
    setQ('');
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi(h => (h + 1) % Math.max(1, count)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi(h => (h - 1 + count) % Math.max(1, count)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (hi < list.length) choose(list[hi].name); else if (canCreate) void create();
    } else if (e.key === 'Backspace' && !q && sel.length) {
      const next = sel.slice(0, -1); setSel(next); commit(next);
    }
  };
  const optByName = (n: string) => opts.find(o => o.name === n);
  return (
    <div className="db-opt-editor">
      <div className="db-opt-input">
        {sel.map(n => <Tag key={n} name={n} color={optByName(n)?.color} dot={prop.type === 'status'} onRemove={() => { const next = sel.filter(x => x !== n); setSel(next); commit(next); }} />)}
        <input autoFocus value={q} placeholder={sel.length ? '' : 'Rechercher ou créer une option…'} onChange={e => { setQ(e.target.value); setHi(0); }} onKeyDown={onKey} />
      </div>
      <div className="db-menu-label">{opts.length ? 'Choisis une option ou crée-en une' : 'Tape un nom pour créer une option'}</div>
      <div className="db-opt-list" role="listbox" aria-multiselectable={multi}>
        {list.map((o, i) => (
          <div key={o.id} role="option" aria-selected={sel.includes(o.name)} className={`db-opt-row${hi === i ? ' hi' : ''}`}
            onMouseEnter={() => setHi(i)} onClick={() => choose(o.name)}>
            <Tag name={o.name} color={o.color} dot={prop.type === 'status'} />
            <span className="db-grow" />
            {sel.includes(o.name) && <Icon name="check" className="db-accent" />}
            <button type="button" className="db-icon-btn db-opt-more" aria-label={`Modifier ${o.name}`}
              onClick={e => { e.stopPropagation(); setEditing({ id: o.id, el: e.currentTarget }); }}>
              <Icon name="more" />
            </button>
          </div>
        ))}
        {canCreate && (
          <div role="option" aria-selected={false} className={`db-opt-row${hi === list.length ? ' hi' : ''}`} onMouseEnter={() => setHi(list.length)} onClick={() => void create()}>
            <span className="db-muted-sm">Créer</span>
            <Tag name={q.trim()} color={nextColor(opts.map(o => o.color))} dot={prop.type === 'status'} />
          </div>
        )}
      </div>
      {editing && <OptionEditMenu dbId={dbId} prop={prop} optionId={editing.id} anchor={editing.el} onClose={() => setEditing(null)} />}
    </div>
  );
}

// ── Date ─────────────────────────────────────────────────────
function DateField({ date, onChange, hasTime, label }: { date: Date | null; onChange: (d: Date) => void; hasTime: boolean; label: string }) {
  const fmt = (d: Date | null) => (d ? format(d, 'dd/MM/yyyy') : '');
  const [text, setText] = useState(fmt(date));
  useEffect(() => setText(fmt(date)), [date]);
  const apply = () => {
    const d = parseDateInput(text);
    if (!d) { setText(fmt(date)); return; }
    if (date && hasTime) d.setHours(date.getHours(), date.getMinutes());
    onChange(d);
  };
  return (
    <div className="db-date-field">
      <input className="db-input" aria-label={label} placeholder="jj/mm/aaaa" value={text} onChange={e => setText(e.target.value)} onBlur={apply}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); apply(); } }} />
      {hasTime && (
        <input className="db-input db-time" type="time" aria-label={`${label} — heure`} value={date ? format(date, 'HH:mm') : ''}
          onChange={e => {
            const [h, m] = e.target.value.split(':').map(Number);
            const d = new Date(date ?? new Date()); d.setHours(h || 0, m || 0, 0, 0); onChange(d);
          }} />
      )}
    </div>
  );
}

export function MiniCalendar({ month, onMonth, isSelected, inRange, onPick }: {
  month: Date; onMonth: (d: Date) => void; isSelected: (d: Date) => boolean; inRange?: (d: Date) => boolean; onPick: (d: Date) => void;
}) {
  const days = useMemo(() => eachDayOfInterval({ start: startOfWeek(startOfMonth(month), { weekStartsOn: 1 }), end: endOfWeek(endOfMonth(month), { weekStartsOn: 1 }) }), [month]);
  return (
    <div className="db-mini-cal">
      <div className="db-mini-head">
        <span className="db-mini-title">{format(month, 'MMMM yyyy', { locale: fr })}</span>
        <button type="button" className="db-icon-btn" onClick={() => onMonth(startOfMonth(new Date()))} title="Aujourd’hui">●</button>
        <button type="button" className="db-icon-btn" aria-label="Mois précédent" onClick={() => onMonth(addMonths(month, -1))}><Icon name="chevronLeft" /></button>
        <button type="button" className="db-icon-btn" aria-label="Mois suivant" onClick={() => onMonth(addMonths(month, 1))}><Icon name="chevronRight" /></button>
      </div>
      <div className="db-mini-grid">
        {['lu', 'ma', 'me', 'je', 've', 'sa', 'di'].map(d => <span key={d} className="db-mini-dow">{d}</span>)}
        {days.map(d => (
          <button type="button" key={d.toISOString()} onClick={() => onPick(d)}
            className={`db-mini-day${isSameMonth(d, month) ? '' : ' out'}${isToday(d) ? ' today' : ''}${isSelected(d) ? ' sel' : ''}${inRange?.(d) ? ' range' : ''}`}>
            {d.getDate()}
          </button>
        ))}
      </div>
    </div>
  );
}

export function DateEditor({ value, commit }: { value: unknown; commit: (v: unknown) => void }) {
  const r0 = readDate(value);
  const [start, setStart] = useState<Date | null>(r0?.start ?? null);
  const [end, setEnd] = useState<Date | null>(r0?.end ?? null);
  const [hasEnd, setHasEnd] = useState(!!r0?.end);
  const [hasTime, setHasTime] = useState(!!r0?.hasTime);
  const [month, setMonth] = useState(startOfMonth(r0?.start ?? new Date()));
  const [picking, setPicking] = useState<'start' | 'end'>('start');
  const save = (s: Date | null, e: Date | null, he: boolean, ht: boolean) => commit(writeDate(s, he ? e : null, ht));
  const keepTime = (base: Date | null, day: Date) => { const x = new Date(day); if (base) x.setHours(base.getHours(), base.getMinutes(), 0, 0); return x; };
  const pick = (d: Date) => {
    if (hasEnd && picking === 'end' && start) {
      let s = start, e = keepTime(end ?? start, d);
      if (e < s) [s, e] = [e, s];
      setStart(s); setEnd(e); setPicking('start'); save(s, e, true, hasTime);
    } else {
      const s = keepTime(start, d);
      setStart(s);
      if (hasEnd) { const e = end && end >= s ? end : s; setEnd(e); setPicking('end'); save(s, e, true, hasTime); }
      else save(s, null, false, hasTime);
    }
  };
  const lo = start && end ? (start < end ? start : end) : null;
  const hi = start && end ? (start < end ? end : start) : null;
  return (
    <div className="db-date-editor">
      <div className="db-date-fields">
        <DateField label="Début" date={start} hasTime={hasTime} onChange={d => { setStart(d); setMonth(startOfMonth(d)); save(d, end, hasEnd, hasTime); }} />
        {hasEnd && <>
          <Icon name="chevronRight" className="db-muted-icon" />
          <DateField label="Fin" date={end} hasTime={hasTime} onChange={d => { setEnd(d); save(start, d, true, hasTime); }} />
        </>}
      </div>
      <MiniCalendar month={month} onMonth={setMonth} onPick={pick}
        isSelected={d => (!!start && isSameDay(d, start)) || (hasEnd && !!end && isSameDay(d, end))}
        inRange={d => !!(hasEnd && lo && hi && d > lo && d < hi)} />
      <div className="db-date-opts">
        <label className="db-opt-line"><span>Date de fin</span>
          <Toggle checked={hasEnd} label="Date de fin" onChange={v => { setHasEnd(v); const e = v ? end ?? start : null; setEnd(e); setPicking(v ? 'end' : 'start'); save(start, e, v, hasTime); }} />
        </label>
        <label className="db-opt-line"><span>Inclure l’heure</span>
          <Toggle checked={hasTime} label="Inclure l’heure" onChange={v => {
            setHasTime(v);
            const s = start && !v ? new Date(start.getFullYear(), start.getMonth(), start.getDate()) : start;
            const e = end && !v ? new Date(end.getFullYear(), end.getMonth(), end.getDate()) : end;
            if (s && v && !r0?.hasTime) s.setHours(9, 0, 0, 0);
            setStart(s); setEnd(e); save(s, e, hasEnd, v);
          }} />
        </label>
      </div>
      <div className="db-pop-foot">
        <button type="button" className="db-btn-text" onClick={() => { setStart(null); setEnd(null); setHasEnd(false); commit(null); }}>Effacer</button>
        <button type="button" className="db-btn-text" onClick={() => { const t = new Date(); setMonth(startOfMonth(t)); pick(t); }}>Aujourd’hui</button>
      </div>
    </div>
  );
}

// ── Personnes ────────────────────────────────────────────────
function PersonMenu({ person, anchor, onClose }: { person: Person; anchor: HTMLElement; onClose: () => void }) {
  const [name, setName] = useState(person.name);
  const [email, setEmail] = useState(person.email ?? '');
  const save = () => {
    const n = name.trim();
    if ((n && n !== person.name) || email.trim() !== (person.email ?? '')) void updatePerson(person.id, { name: n || person.name, email: email.trim() || undefined });
  };
  return (
    <Popover open anchor={anchor} placement="right-start" width={240} onClose={() => { save(); onClose(); }} label="Modifier la personne">
      <div className="db-pad db-stack">
        <input className="db-input" value={name} autoFocus onChange={e => setName(e.target.value)} placeholder="Nom" onKeyDown={e => { if (e.key === 'Enter') { save(); onClose(); } }} />
        <input className="db-input" value={email} onChange={e => setEmail(e.target.value)} placeholder="E-mail (optionnel)" onKeyDown={e => { if (e.key === 'Enter') { save(); onClose(); } }} />
      </div>
      <Menu>
        <MenuItem icon="trash" danger label="Retirer de la liste des personnes" onSelect={async () => {
          if (await confirmAction(`Retirer « ${person.name} » de la liste des personnes ? Les cellules qui la référencent afficheront son identifiant.`, { danger: true, confirmLabel: 'Retirer' })) { await removePerson(person.id); onClose(); }
        }} />
      </Menu>
    </Popover>
  );
}

export function PersonEditor({ value, commit, ctx }: { value: string[]; commit: (ids: string[]) => void; ctx: EngineCtx }) {
  const people = usePeople();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string[]>(value);
  const [hi, setHi] = useState(0);
  const [menu, setMenu] = useState<{ p: Person; el: HTMLElement } | null>(null);
  const nq = norm(q.trim());
  const list = people.filter(p => !nq || norm(p.name).includes(nq) || norm(p.email ?? '').includes(nq));
  const canCreate = !!q.trim() && !people.some(p => p.name.toLowerCase() === q.trim().toLowerCase());
  const count = list.length + (canCreate ? 1 : 0);
  const toggle = (id: string) => { const next = sel.includes(id) ? sel.filter(x => x !== id) : [...sel, id]; setSel(next); commit(next); setQ(''); };
  const create = async () => { const p = await addPerson(q.trim()); toggle(p.id); };
  const personOf = (id: string) => people.find(p => p.id === id) ?? { id, name: ctx.people.find(p => p.id === id)?.name ?? id, color: 'default' };
  return (
    <div className="db-opt-editor">
      <div className="db-opt-input">
        {sel.map(id => <PersonChip key={id} person={personOf(id)} onRemove={() => toggle(id)} />)}
        <input autoFocus value={q} placeholder={sel.length ? '' : 'Rechercher ou ajouter une personne…'} onChange={e => { setQ(e.target.value); setHi(0); }}
          onKeyDown={e => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setHi(h => (h + 1) % Math.max(1, count)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setHi(h => (h - 1 + count) % Math.max(1, count)); }
            else if (e.key === 'Enter') { e.preventDefault(); if (hi < list.length) toggle(list[hi].id); else if (canCreate) void create(); }
            else if (e.key === 'Backspace' && !q && sel.length) toggle(sel[sel.length - 1]);
          }} />
      </div>
      <div className="db-menu-label">{people.length ? 'Personnes' : 'Tape un nom pour ajouter une personne'}</div>
      <div className="db-opt-list" role="listbox" aria-multiselectable>
        {list.map((p, i) => (
          <div key={p.id} role="option" aria-selected={sel.includes(p.id)} className={`db-opt-row${hi === i ? ' hi' : ''}`} onMouseEnter={() => setHi(i)} onClick={() => toggle(p.id)}>
            <Avatar person={p} /><span className="db-opt-name">{p.name}</span>
            {p.email && <span className="db-muted-sm">{p.email}</span>}
            <span className="db-grow" />
            {sel.includes(p.id) && <Icon name="check" className="db-accent" />}
            <button type="button" className="db-icon-btn db-opt-more" aria-label={`Modifier ${p.name}`} onClick={e => { e.stopPropagation(); setMenu({ p, el: e.currentTarget }); }}><Icon name="more" /></button>
          </div>
        ))}
        {canCreate && (
          <div role="option" aria-selected={false} className={`db-opt-row${hi === list.length ? ' hi' : ''}`} onMouseEnter={() => setHi(list.length)} onClick={() => void create()}>
            <span className="db-muted-sm">Ajouter</span><b>{q.trim()}</b>
          </div>
        )}
      </div>
      {menu && <PersonMenu person={menu.p} anchor={menu.el} onClose={() => setMenu(null)} />}
    </div>
  );
}

// ── Fichiers ─────────────────────────────────────────────────
function pickBrowserFiles(): Promise<File[]> {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file'; input.multiple = true;
    input.onchange = () => resolve([...(input.files ?? [])]);
    input.click();
  });
}
function FileRow({ f, onRemove }: { f: FileRef; onRemove: () => void }) {
  const url = useFileUrl(isImageRef(f) ? f : null);
  return (
    <div className="db-file-row">
      <span className="db-file-prev">{url ? <img src={url} alt="" draggable={false} /> : <Icon name="file" />}</span>
      <span className="db-file-row-name" title={f.name}>{f.name}</span>
      <button type="button" className="db-icon-btn" title="Ouvrir" onClick={() => openFile(f)}><Icon name="open" /></button>
      <button type="button" className="db-icon-btn" title="Retirer" onClick={onRemove}><Icon name="close" /></button>
    </div>
  );
}
export function FileEditor({ value, commit }: { value: FileRef[]; commit: (v: FileRef[]) => void }) {
  const [list, setList] = useState<FileRef[]>(value);
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState('');
  const update = (next: FileRef[]) => { setList(next); commit(next); };
  const pick = async (linkOnly: boolean) => {
    setBusy(true);
    try {
      const added: FileRef[] = [];
      if (isTauri) {
        const { open } = await import('@tauri-apps/plugin-dialog');
        const sel = await open({ multiple: true, title: linkOnly ? 'Lier des fichiers (sans copie)' : 'Ajouter des fichiers' });
        const paths = Array.isArray(sel) ? sel : sel ? [sel] : [];
        for (const p of paths) { const vf = await files.importPath(p, { link: linkOnly }); added.push({ hash: vf.hash, name: vf.name, mime: vf.mime }); }
      } else {
        for (const f of await pickBrowserFiles()) {
          const vf = await files.importBytes(f.name, f.type || 'application/octet-stream', new Uint8Array(await f.arrayBuffer()));
          added.push({ hash: vf.hash, name: vf.name, mime: vf.mime });
        }
      }
      if (added.length) update([...list, ...added.filter(a => !list.some(x => x.hash && x.hash === a.hash))]);
    } catch (e) { toast(`Import impossible : ${errMsg(e)}`, 'error'); }
    finally { setBusy(false); }
  };
  const addLink = () => {
    const u = link.trim(); if (!u) return;
    const url = normalizeUrl(u);
    update([...list, { url, name: url.replace(/^https?:\/\//, '').split(/[?#]/)[0].split('/').filter(Boolean).pop() ?? url }]);
    setLink('');
  };
  return (
    <div className="db-file-editor">
      {list.length > 0 && <div className="db-file-list">{list.map((f, i) => <FileRow key={(f.hash ?? f.url ?? '') + i} f={f} onRemove={() => update(list.filter((_, j) => j !== i))} />)}</div>}
      <Menu>
        <MenuItem icon="plus" label={busy ? 'Import en cours…' : 'Ajouter un fichier…'} disabled={busy} onSelect={() => void pick(false)} />
        {isTauri && <MenuItem icon="link" label="Lier un fichier (sans copie)…" disabled={busy} onSelect={() => void pick(true)} />}
      </Menu>
      <div className="db-pad db-row-gap">
        <input className="db-input" value={link} placeholder="Coller un lien (image, vidéo…)" onChange={e => setLink(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addLink(); }} />
        <button type="button" className="db-btn-text" disabled={!link.trim()} onClick={addLink}>Ajouter</button>
      </div>
    </div>
  );
}

// ── Relation ─────────────────────────────────────────────────
export function RelationEditor({ prop, value, commit }: { prop: PropDef; value: string[]; commit: (ids: string[]) => void }) {
  const target = prop.relation?.databaseId;
  const tSchema = useSchema(target);
  const tPage = usePages(s => (target ? s.pages[target] : undefined));
  const rows = usePages(useShallow(s => (target ? liveRows(target, s.pages) : [])));
  const [sel, setSel] = useState<string[]>(value);
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  if (!target) return <div className="db-pad db-note">Choisis d’abord la base liée dans le menu de la propriété « {prop.name} ».</div>;
  if (tSchema === null || tPage?.trashed || !tPage) return <div className="db-pad db-note">La base liée n’existe plus.</div>;
  const nq = norm(q.trim());
  const byId = new Map(rows.map(r => [r.id, r]));
  const chosen = sel.map(id => byId.get(id)).filter((r): r is Page => !!r);
  const others = rows.filter(r => !sel.includes(r.id) && (!nq || norm(r.title).includes(nq))).slice(0, 80);
  const all = [...chosen.filter(r => !nq || norm(r.title).includes(nq)), ...others];
  const toggle = (id: string) => { const next = sel.includes(id) ? sel.filter(x => x !== id) : [...sel, id]; setSel(next); commit(next); };
  const create = async () => {
    const p = await createRow(target, { title: q.trim() }).catch(report);
    if (p) { toggle(p.id); setQ(''); }
  };
  return (
    <div className="db-opt-editor">
      <div className="db-opt-input">
        <Icon name="search" className="db-muted-icon" />
        <input autoFocus value={q} placeholder={`Rechercher dans ${tPage.title || 'la base'}…`} onChange={e => { setQ(e.target.value); setHi(0); }}
          onKeyDown={e => {
            const n = all.length + (q.trim() ? 1 : 0);
            if (e.key === 'ArrowDown') { e.preventDefault(); setHi(h => (h + 1) % Math.max(1, n)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setHi(h => (h - 1 + n) % Math.max(1, n)); }
            else if (e.key === 'Enter') { e.preventDefault(); if (hi < all.length) toggle(all[hi].id); else if (q.trim()) void create(); }
          }} />
      </div>
      <div className="db-opt-list" role="listbox" aria-multiselectable>
        {chosen.length > 0 && !nq && <div className="db-menu-label">Liées</div>}
        {all.map((r, i) => (
          <div key={r.id} role="option" aria-selected={sel.includes(r.id)} className={`db-opt-row${hi === i ? ' hi' : ''}`} onMouseEnter={() => setHi(i)} onClick={() => toggle(r.id)}>
            <span className="db-rel-icon">{r.icon ?? <Icon name="page" size={13} />}</span>
            <span className="db-opt-name">{r.title || 'Sans titre'}</span>
            <span className="db-grow" />
            {sel.includes(r.id) ? <Icon name="check" className="db-accent" /> : <Icon name="plus" className="db-muted-icon" />}
          </div>
        ))}
        {!all.length && !q.trim() && <div className="db-pad db-note">Aucune ligne dans {tPage.title || 'la base liée'}.</div>}
        {q.trim() && (
          <div role="option" aria-selected={false} className={`db-opt-row${hi === all.length ? ' hi' : ''}`} onMouseEnter={() => setHi(all.length)} onClick={() => void create()}>
            <Icon name="plus" /><span>Nouvelle page « <b>{q.trim()}</b> »</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Aiguillage ───────────────────────────────────────────────
export const COVER_TYPES: PropDef['type'][] = ['title', 'text', 'number', 'url', 'email', 'phone'];

export function CellEditor({ row, prop, ctx, dbId, onDone }: { row: Page; prop: PropDef; ctx: EngineCtx; dbId: string; onDone: () => void }) {
  const raw = rawValue(row, prop);
  const commit = (v: unknown) => { setValue(row.id, prop, v).catch(report); };
  switch (prop.type) {
    case 'title': return <TextEditor initial={row.title} commit={commit} onDone={onDone} placeholder="Sans titre" />;
    case 'text': return <TextEditor initial={asText(raw)} commit={commit} multiline onDone={onDone} placeholder="Texte…" />;
    case 'url': return <TextEditor initial={asText(raw)} commit={commit} onDone={onDone} kind="url" placeholder="https://…" />;
    case 'email': return <TextEditor initial={asText(raw)} commit={commit} onDone={onDone} kind="email" placeholder="nom@exemple.fr" />;
    case 'phone': return <TextEditor initial={asText(raw)} commit={commit} onDone={onDone} kind="phone" placeholder="06 12 34 56 78" />;
    case 'number': {
      const n = asNumber(raw);
      return <TextEditor initial={n === null ? '' : String(n).replace('.', ',')} kind="number" onDone={onDone} placeholder="0"
        parse={s => (asNumber(s) === null ? null : s)} commit={s => commit(asNumber(s))} />;
    }
    case 'select': case 'status': case 'multi_select':
      return <OptionsEditor dbId={dbId} prop={prop} multi={prop.type === 'multi_select'} value={optionsFor(prop, raw).map(o => o.name)}
        commit={names => commit(prop.type === 'multi_select' ? names : names[0] ?? null)} onDone={onDone} />;
    case 'date': return <DateEditor value={raw} commit={commit} />;
    case 'person': return <PersonEditor value={asList(raw)} commit={commit} ctx={ctx} />;
    case 'file': return <FileEditor value={asFiles(raw)} commit={commit} />;
    case 'relation': return <RelationEditor prop={prop} value={asList(raw)} commit={commit} />;
  }
  return null;
}

/** Petit badge d'aperçu d'un fichier (utilisé par les cartes). */
export const FilePreview = FileChip;
