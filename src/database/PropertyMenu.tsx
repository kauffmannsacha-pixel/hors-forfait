// Menu d'une propriété : renommer, changer de type (avec conversion), options, relation, rollup, formule, actions.
import { closestCenter, DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { arrayMove, SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { usePages } from '../db/pages';
import type { Page, PropertyType, SelectOption } from '../db/types';
import { confirmAction } from '../ui/appState';
import { Tag } from './cells/CellView';
import { report } from './cells/editors';
import { planConversion } from './convert';
import { formatFValue, formulaValue, type EngineCtx } from './engine';
import { compile, FORMULA_HELP, FormulaError } from './formula';
import {
  isComputed, isSelectLike, nextColor, PROPERTY_TYPES, TYPE_LABELS, type PropDef, type Schema, type ViewX,
} from './model';
import {
  addOption, changePropertyType, deleteOption, deleteProperty, duplicateProperty, reorderOptions, setRelationTarget,
  updateOption, updateProperty, updateView,
} from './mutations';
import { defaultOp } from './query';
import { useSchema } from './schemaStore';
import { Icon } from './ui/icons';
import { Menu, MenuItem, MenuLabel, MenuSep, Popover, Toggle } from './ui/Popover';

export interface PropertyMenuProps {
  dbId: string; schema: Schema; prop: PropDef; ctx: EngineCtx; rows: Page[];
  view?: ViewX; onClose: () => void; autoFocusName?: boolean;
  /** Ouvre le panneau de filtres après ajout d'un filtre. */
  onFilter?: () => void;
  /** Insère une propriété à gauche/droite (tableau) ; renvoie son id pour ouvrir son menu. */
  onInsert?: (side: 'left' | 'right') => void;
}

const FN_LABELS = { count: 'Compter', sum: 'Somme', avg: 'Moyenne', min: 'Minimum', max: 'Maximum', show: 'Afficher les valeurs' } as const;

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="db-field"><span>{label}</span>{children}</label>;
}

// ── Options (sélections) ─────────────────────────────────────
function SortableOption({ o, dot, onEdit }: { o: SelectOption; dot: boolean; onEdit: (el: HTMLElement) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: o.id });
  return (
    <div ref={setNodeRef} className={`db-optcfg-row${isDragging ? ' dragging' : ''}`} style={{ transform: CSS.Translate.toString(transform), transition }}>
      <span className="db-grip" {...attributes} {...listeners} aria-label="Déplacer"><Icon name="grip" /></span>
      <button type="button" className="db-optcfg-tag" onClick={e => onEdit(e.currentTarget)}><Tag name={o.name} color={o.color} dot={dot} /></button>
      <button type="button" className="db-icon-btn" aria-label={`Modifier ${o.name}`} onClick={e => onEdit(e.currentTarget)}><Icon name="more" /></button>
    </div>
  );
}
function OptionsConfig({ dbId, prop, rows }: { dbId: string; prop: PropDef; rows: Page[] }) {
  const [name, setName] = useState('');
  const [edit, setEdit] = useState<{ o: SelectOption; el: HTMLElement } | null>(null);
  const [rename, setRename] = useState('');
  const opts = prop.options ?? [];
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 3 } }));
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const from = opts.findIndex(o => o.id === e.active.id), to = opts.findIndex(o => o.id === e.over!.id);
    void reorderOptions(dbId, prop.id, arrayMove(opts, from, to).map(o => o.id)).catch(report);
  };
  const add = () => { if (name.trim()) void addOption(dbId, prop.id, name, nextColor(opts.map(o => o.color))).catch(report); setName(''); };
  const used = (o: SelectOption) => rows.some(r => { const v = r.props?.[prop.id]; return v === o.name || v === o.id || (Array.isArray(v) && (v.includes(o.name) || v.includes(o.id))); });
  return (
    <div className="db-section">
      <MenuLabel>Options</MenuLabel>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={opts.map(o => o.id)} strategy={verticalListSortingStrategy}>
          {opts.map(o => <SortableOption key={o.id} o={o} dot={prop.type === 'status'} onEdit={el => { setEdit({ o, el }); setRename(o.name); }} />)}
        </SortableContext>
      </DndContext>
      <div className="db-pad db-row-gap">
        <input className="db-input" value={name} placeholder="Nouvelle option…" onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') add(); }} />
        <button type="button" className="db-icon-btn" aria-label="Ajouter l’option" onClick={add}><Icon name="plus" /></button>
      </div>
      {edit && (
        <Popover open anchor={edit.el} placement="right-start" width={220} label="Option"
          onClose={() => { if (rename.trim() && rename.trim() !== edit.o.name) void updateOption(dbId, prop.id, edit.o.id, { name: rename }).catch(report); setEdit(null); }}>
          <div className="db-pad"><input className="db-input" autoFocus value={rename} onChange={e => setRename(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { if (rename.trim()) void updateOption(dbId, prop.id, edit.o.id, { name: rename }).catch(report); setEdit(null); } }} /></div>
          <Menu>
            <MenuItem icon="trash" danger label="Supprimer l’option" onSelect={async () => {
              if (used(edit.o) && !(await confirmAction(`Supprimer « ${edit.o.name} » ? Elle sera retirée des lignes qui l’utilisent.`, { danger: true, confirmLabel: 'Supprimer' }))) return;
              await deleteOption(dbId, prop.id, edit.o.id).catch(report); setEdit(null);
            }} />
            <MenuSep />
            <MenuLabel>Couleur</MenuLabel>
            <div className="db-swatches">
              {(['default', 'gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'] as const).map(c => (
                <button key={c} type="button" title={c} className={`db-swatch-btn db-c-${c}${(opts.find(o => o.id === edit.o.id)?.color ?? edit.o.color) === c ? ' on' : ''}`}
                  onClick={() => void updateOption(dbId, prop.id, edit.o.id, { color: c }).catch(report)}><span className="db-swatch" /></button>
              ))}
            </div>
          </Menu>
        </Popover>
      )}
    </div>
  );
}

// ── Relation ─────────────────────────────────────────────────
function RelationConfig({ dbId, prop, rows }: { dbId: string; prop: PropDef; rows: Page[] }) {
  const dbs = usePages(useShallow(s => Object.values(s.pages).filter(p => p.kind === 'database' && !p.trashed)));
  const target = prop.relation?.databaseId ?? '';
  const targetSchema = useSchema(target || null);
  const mirror = targetSchema?.properties.find(p => p.id === prop.relation?.syncedPropId);
  const [twoWay, setTwoWay] = useState(!!prop.relation?.syncedPropId);
  useEffect(() => setTwoWay(!!prop.relation?.syncedPropId), [prop.relation?.syncedPropId]);
  const hasValues = rows.some(r => Array.isArray(r.props?.[prop.id]) && (r.props![prop.id] as unknown[]).length > 0);
  const apply = async (t: string, tw: boolean) => {
    if (t !== target && hasValues && !(await confirmAction('Changer de base liée efface les liens existants de cette propriété. Continuer ?', { danger: true, confirmLabel: 'Changer' }))) return;
    if (!tw && prop.relation?.syncedPropId && !(await confirmAction(`Désactiver la relation bidirectionnelle supprime la propriété « ${mirror?.name ?? 'liée'} » de l’autre base. Continuer ?`, { danger: true, confirmLabel: 'Désactiver' }))) { setTwoWay(true); return; }
    await setRelationTarget(dbId, prop.id, t || null, tw).catch(report);
  };
  return (
    <div className="db-section db-pad db-stack">
      <Field label="Base liée">
        <select className="db-select" value={target} onChange={e => void apply(e.target.value, twoWay)}>
          <option value="">— Choisir une base —</option>
          {dbs.map(d => <option key={d.id} value={d.id}>{d.icon ? d.icon + ' ' : ''}{d.title || 'Sans titre'}{d.id === dbId ? ' (cette base)' : ''}</option>)}
        </select>
      </Field>
      {target && (
        <label className="db-opt-line">
          <span>Bidirectionnelle{mirror ? <span className="db-muted-sm"> · « {mirror.name} »</span> : null}</span>
          <Toggle checked={twoWay} label="Relation bidirectionnelle" onChange={v => { setTwoWay(v); void apply(target, v); }} />
        </label>
      )}
    </div>
  );
}

// ── Rollup ───────────────────────────────────────────────────
function RollupConfig({ dbId, prop, schema }: { dbId: string; prop: PropDef; schema: Schema }) {
  const conf = prop.rollup ?? { relationPropId: '', targetPropId: '', fn: 'count' as const };
  const rels = schema.properties.filter(p => p.type === 'relation');
  const rel = rels.find(p => p.id === conf.relationPropId);
  const target = useSchema(rel?.relation?.databaseId ?? null);
  const set = (patch: Partial<typeof conf>) => void updateProperty(dbId, prop.id, { rollup: { ...conf, ...patch } }).catch(report);
  if (!rels.length) return <div className="db-pad db-note">Ajoute d’abord une propriété « Relation » vers une autre base.</div>;
  return (
    <div className="db-section db-pad db-stack">
      <Field label="Relation">
        <select className="db-select" value={conf.relationPropId} onChange={e => set({ relationPropId: e.target.value, targetPropId: '' })}>
          <option value="">— Choisir —</option>
          {rels.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </Field>
      <Field label="Propriété">
        <select className="db-select" value={conf.targetPropId} disabled={!target} onChange={e => set({ targetPropId: e.target.value })}>
          <option value="">— Choisir —</option>
          {target?.properties.map(p => <option key={p.id} value={p.id}>{p.name} · {TYPE_LABELS[p.type]}</option>)}
        </select>
      </Field>
      <Field label="Calcul">
        <select className="db-select" value={conf.fn} onChange={e => set({ fn: e.target.value as typeof conf.fn })}>
          {(Object.keys(FN_LABELS) as (keyof typeof FN_LABELS)[]).map(k => <option key={k} value={k}>{FN_LABELS[k]}</option>)}
        </select>
      </Field>
    </div>
  );
}

// ── Formule ──────────────────────────────────────────────────
function FormulaConfig({ dbId, prop, schema, ctx, rows }: { dbId: string; prop: PropDef; schema: Schema; ctx: EngineCtx; rows: Page[] }) {
  const [src, setSrc] = useState(prop.formula ?? '');
  const ta = useRef<HTMLTextAreaElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const latest = useRef(src);
  useEffect(() => () => {
    window.clearTimeout(timer.current);
    if (latest.current !== (prop.formula ?? '')) void updateProperty(dbId, prop.id, { formula: latest.current }).catch(report);
  }, [dbId, prop.id, prop.formula]);
  const change = (v: string) => {
    setSrc(v); latest.current = v;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void updateProperty(dbId, prop.id, { formula: v }).catch(report), 500);
  };
  const preview = useMemo(() => {
    if (!src.trim()) return { text: 'Écris une formule, ex. prop("Prix") * 2', error: false };
    try { compile(src); } catch (e) { return { text: (e as FormulaError).message, error: true }; }
    const r = rows[0];
    if (!r) return { text: 'Syntaxe valide', error: false };
    try {
      const v = formulaValue(r, { ...prop, id: prop.id + ':apercu', formula: src }, { ...ctx, memo: new Map() });
      return { text: `${r.title || 'Sans titre'} → ${formatFValue(v, prop) || '(vide)'}`, error: false };
    } catch (e) { return { text: e instanceof FormulaError ? e.message : String(e), error: true }; }
  }, [src, rows, ctx, prop]);
  const insert = (text: string) => {
    const el = ta.current; if (!el) return;
    const a = el.selectionStart, b = el.selectionEnd;
    const v = src.slice(0, a) + text + src.slice(b);
    change(v);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(a + text.length, a + text.length); });
  };
  return (
    <div className="db-section db-pad db-stack db-formula">
      <textarea ref={ta} className="db-input db-code" rows={3} spellCheck={false} value={src} autoFocus placeholder='if(prop("Vues") > 10000, "🔥", "")'
        onChange={e => change(e.target.value)} />
      <div className={`db-formula-preview${preview.error ? ' error' : ''}`} role="status">{preview.text}</div>
      <div className="db-formula-help">
        <div className="db-menu-label">Propriétés</div>
        <div className="db-chips">
          {schema.properties.filter(p => p.id !== prop.id).map(p => (
            <button key={p.id} type="button" className="db-chip-btn" onClick={() => insert(`prop("${p.name}")`)}><Icon name={p.type} size={12} />{p.name}</button>
          ))}
        </div>
        <div className="db-menu-label">Fonctions</div>
        <div className="db-chips">
          {FORMULA_HELP.filter(f => f.name !== 'prop').map(f => (
            <button key={f.name} type="button" className="db-chip-btn mono" title={`${f.syntax} — ${f.description}`}
              onClick={() => insert(['and', 'or', 'not'].includes(f.name) ? ` ${f.name} ` : `${f.name}(`)}>{f.name}</button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Formats ──────────────────────────────────────────────────
function NumberConfig({ dbId, prop }: { dbId: string; prop: PropDef }) {
  const set = (p: Partial<PropDef>) => void updateProperty(dbId, prop.id, p).catch(report);
  return (
    <div className="db-section db-pad db-stack">
      <Field label="Format">
        <select className="db-select" value={prop.numberFormat ?? 'number'} onChange={e => set({ numberFormat: e.target.value as PropDef['numberFormat'] })}>
          <option value="number">Nombre</option><option value="percent">Pourcentage</option><option value="euro">Euro (€)</option><option value="dollar">Dollar ($)</option>
        </select>
      </Field>
      <Field label="Décimales">
        <select className="db-select" value={prop.decimals ?? ''} onChange={e => set({ decimals: e.target.value === '' ? undefined : Number(e.target.value) })}>
          <option value="">Auto</option>{[0, 1, 2, 3, 4].map(n => <option key={n} value={n}>{n}</option>)}
        </select>
      </Field>
      {prop.type === 'number' && (
        <Field label="Afficher comme">
          <select className="db-select" value={prop.showAs ?? 'number'} onChange={e => set({ showAs: e.target.value as PropDef['showAs'] })}>
            <option value="number">Nombre</option><option value="bar">Barre</option><option value="ring">Anneau</option>
          </select>
        </Field>
      )}
      {prop.showAs && prop.showAs !== 'number' && (
        <Field label="Diviser par">
          <input className="db-input" type="number" min={1} defaultValue={prop.divideBy ?? 100} onBlur={e => set({ divideBy: Math.max(1, Number(e.target.value) || 100) })} />
        </Field>
      )}
    </div>
  );
}
function DateConfig({ dbId, prop }: { dbId: string; prop: PropDef }) {
  const set = (p: Partial<PropDef>) => void updateProperty(dbId, prop.id, p).catch(report);
  return (
    <div className="db-section db-pad db-stack">
      <Field label="Format de date">
        <select className="db-select" value={prop.dateFormat ?? 'short'} onChange={e => set({ dateFormat: e.target.value as PropDef['dateFormat'] })}>
          <option value="short">3 nov. 2026</option><option value="full">3 novembre 2026</option><option value="dmy">03/11/2026</option>
          <option value="mdy">11/03/2026</option><option value="iso">2026-11-03</option><option value="relative">Relatif (Aujourd’hui, Demain…)</option>
        </select>
      </Field>
      <Field label="Format d’heure">
        <select className="db-select" value={prop.timeFormat ?? '24h'} onChange={e => set({ timeFormat: e.target.value as PropDef['timeFormat'] })}>
          <option value="24h">24 h (14:30)</option><option value="12h">12 h (2:30 PM)</option>
        </select>
      </Field>
    </div>
  );
}

// ── Menu principal ───────────────────────────────────────────
export function PropertyMenu({ dbId, schema, prop, view, ctx, rows, onClose, autoFocusName, onFilter, onInsert }: PropertyMenuProps) {
  const [name, setName] = useState(prop.name);
  const [typeAnchor, setTypeAnchor] = useState<HTMLElement | null>(null);
  useEffect(() => setName(prop.name), [prop.name]);
  const isTitle = prop.type === 'title';
  const saveName = () => {
    if (name.trim() && name.trim() !== prop.name) updateProperty(dbId, prop.id, { name }).catch(e => { report(e); setName(prop.name); });
  };
  const changeType = async (t: PropertyType) => {
    setTypeAnchor(null);
    if (t === prop.type) return;
    const plan = planConversion(prop, t, rows, ctx);
    if (plan.lossy && !(await confirmAction(`Convertir « ${prop.name} » en « ${TYPE_LABELS[t]} » ? Certaines valeurs ne pourront pas être converties et seront perdues.`, { danger: true, confirmLabel: 'Convertir' }))) return;
    await changePropertyType(dbId, prop.id, t).catch(report);
  };
  const sort = (dir: 'asc' | 'desc') => {
    if (!view) return;
    void updateView(dbId, view.id, v => ({ sorts: [{ propId: prop.id, dir }, ...v.sorts.filter(s => s.propId !== prop.id)] })).catch(report);
    onClose();
  };
  const filter = () => {
    if (!view) return;
    void updateView(dbId, view.id, v => ({ filters: [...v.filters, { propId: prop.id, op: defaultOp(prop, ctx, rows) }] })).then(() => onFilter?.()).catch(report);
    onClose();
  };
  const hide = () => {
    if (!view) return;
    void updateView(dbId, view.id, v => ({ hiddenProps: [...new Set([...(v.hiddenProps ?? []), prop.id])] })).catch(report);
    onClose();
  };
  const remove = async () => {
    if (!(await confirmAction(`Supprimer la propriété « ${prop.name} » et toutes ses valeurs ? Cette action est définitive.`, { danger: true, confirmLabel: 'Supprimer' }))) return;
    await deleteProperty(dbId, prop.id).catch(report);
    onClose();
  };
  return (
    <div className="db-prop-menu">
      <div className="db-pad db-row-gap">
        <span className="db-prop-ico"><Icon name={prop.type} /></span>
        <input className="db-input" value={name} autoFocus={autoFocusName} aria-label="Nom de la propriété" onChange={e => setName(e.target.value)} onBlur={saveName}
          onKeyDown={e => { if (e.key === 'Enter') { saveName(); onClose(); } }} />
      </div>
      <Menu>
        {!isTitle && <MenuItem icon={prop.type} label="Type" hint={TYPE_LABELS[prop.type]} right={<Icon name="chevronRight" className="db-muted-icon" />} onSelect={e => setTypeAnchor(e.currentTarget)} />}
      </Menu>
      {prop.type === 'number' && <NumberConfig dbId={dbId} prop={prop} />}
      {prop.type === 'formula' && <NumberConfig dbId={dbId} prop={prop} />}
      {isSelectLike(prop.type) && <OptionsConfig dbId={dbId} prop={prop} rows={rows} />}
      {(prop.type === 'date' || prop.type === 'created_time' || prop.type === 'updated_time') && <DateConfig dbId={dbId} prop={prop} />}
      {prop.type === 'relation' && <RelationConfig dbId={dbId} prop={prop} rows={rows} />}
      {prop.type === 'rollup' && <RollupConfig dbId={dbId} prop={prop} schema={schema} />}
      {prop.type === 'formula' && <FormulaConfig dbId={dbId} prop={prop} schema={schema} ctx={ctx} rows={rows} />}
      <MenuSep />
      <Menu>
        {view && <>
          <MenuItem icon="arrowUp" label="Trier par ordre croissant" onSelect={() => sort('asc')} />
          <MenuItem icon="arrowDown" label="Trier par ordre décroissant" onSelect={() => sort('desc')} />
          <MenuItem icon="filter" label="Filtrer" onSelect={filter} />
          {!isTitle && <MenuItem icon="eyeOff" label="Masquer dans la vue" onSelect={hide} />}
        </>}
        {onInsert && <>
          <MenuItem icon="chevronLeft" label="Insérer à gauche" onSelect={() => { onInsert('left'); }} />
          <MenuItem icon="chevronRight" label="Insérer à droite" onSelect={() => { onInsert('right'); }} />
        </>}
        {!isTitle && <MenuItem icon="copy" label="Dupliquer la propriété" onSelect={() => { void duplicateProperty(dbId, prop.id).catch(report); onClose(); }} />}
        {!isTitle && <MenuItem icon="trash" danger label="Supprimer la propriété" onSelect={() => void remove()} />}
      </Menu>
      <Popover open={!!typeAnchor} anchor={typeAnchor} placement="right-start" onClose={() => setTypeAnchor(null)} width={230} label="Type de propriété">
        <Menu autoFocus>
          <MenuLabel>Type de propriété</MenuLabel>
          {PROPERTY_TYPES.map(t => <MenuItem key={t} icon={t} label={TYPE_LABELS[t]} checked={prop.type === t} onSelect={() => void changeType(t)} />)}
        </Menu>
      </Popover>
    </div>
  );
}

/** Menu « nouvelle propriété » : choix du type puis création. */
export function NewPropertyMenu({ onPick }: { onPick: (t: PropertyType) => void }) {
  return (
    <Menu autoFocus>
      <MenuLabel>Nouvelle propriété</MenuLabel>
      {PROPERTY_TYPES.map(t => <MenuItem key={t} icon={t} label={TYPE_LABELS[t]} hint={isComputed(t) ? 'calculée' : undefined} onSelect={() => onPick(t)} />)}
    </Menu>
  );
}
