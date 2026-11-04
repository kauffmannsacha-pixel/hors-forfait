// Cellule interactive : clic = édition dans un popover (case à cocher : bascule directe).
import { useRef, useState } from 'react';
import type { Page } from '../../db/types';
import { asBool, rawValue, type EngineCtx } from '../engine';
import { isComputed, type PropDef } from '../model';
import { setValue } from '../mutations';
import { Popover } from '../ui/Popover';
import { CellValue, type Variant } from './CellView';
import { CellEditor, COVER_TYPES, report } from './editors';

export function Cell({ row, prop, ctx, dbId, variant = 'table', className = '', readOnly, style }: {
  row: Page; prop: PropDef; ctx: EngineCtx; dbId: string; variant?: Variant; className?: string; readOnly?: boolean; style?: React.CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);
  const editable = !readOnly && !isComputed(prop.type);
  const activate = () => {
    if (!editable) return;
    if (prop.type === 'checkbox') { setValue(row.id, prop, !asBool(rawValue(row, prop))).catch(report); return; }
    setEditing(true);
  };
  const cover = COVER_TYPES.includes(prop.type);
  return (
    <div ref={ref} style={style} role="gridcell" tabIndex={editable ? 0 : -1} aria-label={prop.name}
      className={`db-cell db-cell-${prop.type}${editing ? ' editing' : ''}${editable ? '' : ' ro'} ${className}`}
      onClick={activate}
      onKeyDown={e => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); activate(); } }}>
      <CellValue row={row} prop={prop} ctx={ctx} variant={variant} />
      {editable && prop.type !== 'checkbox' && (
        <Popover open={editing} onClose={() => setEditing(false)} anchor={ref.current} placement={cover ? 'cover' : 'bottom-start'}
          minWidth={cover ? 240 : undefined} width={cover ? undefined : prop.type === 'date' ? 284 : 300} label={`Modifier « ${prop.name} »`}
          className={cover ? 'db-pop-cover' : undefined}>
          <CellEditor row={row} prop={prop} ctx={ctx} dbId={dbId} onDone={() => setEditing(false)} />
        </Popover>
      )}
    </div>
  );
}
