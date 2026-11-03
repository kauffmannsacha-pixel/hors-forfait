import { useState } from 'react';
import { addDays, addMonths, format, isSameDay, isSameMonth, startOfMonth, startOfWeek, addHours, setHours, setMinutes, nextMonday } from 'date-fns';
import { fr } from 'date-fns/locale';
import { IconChevronLeft, IconChevronRight } from '../../ui/icons';

const pad = (n: number) => String(n).padStart(2, '0');

export function DatePicker({ title, withTime, value, reminder, onDone, onCancel }: { title?: string; withTime: boolean; value?: Date; reminder?: boolean; onDone: (d: Date) => void; onCancel: () => void }) {
  const init = value ?? (reminder ? addHours(setMinutes(new Date(), 0), 1) : new Date());
  const [month, setMonth] = useState(startOfMonth(init));
  const [sel, setSel] = useState<Date>(init);
  const [time, setTime] = useState(`${pad(init.getHours())}:${pad(init.getMinutes())}`);
  const today = new Date();
  const gridStart = startOfWeek(startOfMonth(month), { weekStartsOn: 1 });
  const days = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  const lastRowNeeded = days.slice(35).some(d => isSameMonth(d, month));
  const shown = lastRowNeeded ? days : days.slice(0, 35);

  const withClock = (d: Date) => {
    if (!withTime) return d;
    const [h, m] = time.split(':').map(Number);
    return setMinutes(setHours(d, Number.isFinite(h) ? h : 9), Number.isFinite(m) ? m : 0);
  };
  const quick: { label: string; date: Date }[] = reminder
    ? [
      { label: 'Dans 1 h', date: addHours(new Date(), 1) },
      { label: 'Ce soir 18:00', date: setMinutes(setHours(new Date(), 18), 0) },
      { label: 'Demain 9:00', date: setMinutes(setHours(addDays(new Date(), 1), 9), 0) },
      { label: 'Lundi 9:00', date: setMinutes(setHours(nextMonday(new Date()), 9), 0) },
    ].filter(q => q.date > new Date())
    : [
      { label: "Aujourd'hui", date: new Date() },
      { label: 'Demain', date: addDays(new Date(), 1) },
      { label: 'Lundi prochain', date: nextMonday(new Date()) },
    ];

  return (
    <div className="date-picker" onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); onDone(withClock(sel)); } }}>
      {title && <div className="dp-title">{title}</div>}
      <div className="dp-quick">{quick.map(q => <button key={q.label} type="button" className="chip-btn" onClick={() => onDone(q.date)}>{q.label}</button>)}</div>
      <div className="dp-head">
        <button type="button" className="icon-btn" aria-label="Mois précédent" onClick={() => setMonth(addMonths(month, -1))}><IconChevronLeft /></button>
        <span className="dp-month">{format(month, 'LLLL yyyy', { locale: fr })}</span>
        <button type="button" className="icon-btn" aria-label="Mois suivant" onClick={() => setMonth(addMonths(month, 1))}><IconChevronRight /></button>
      </div>
      <div className="dp-grid" role="grid">
        {['L', 'M', 'M', 'J', 'V', 'S', 'D'].map((d, i) => <span key={i} className="dp-dow">{d}</span>)}
        {shown.map(d => (
          <button key={d.toISOString()} type="button" role="gridcell"
            className={`dp-day${isSameMonth(d, month) ? '' : ' out'}${isSameDay(d, today) ? ' today' : ''}${isSameDay(d, sel) ? ' sel' : ''}`}
            onClick={() => { setSel(d); if (!withTime) onDone(d); }}
            onDoubleClick={() => onDone(withClock(d))}>{d.getDate()}</button>
        ))}
      </div>
      {withTime && (
        <div className="dp-foot">
          <label className="dp-time">Heure <input type="time" className="input" value={time} onChange={e => setTime(e.target.value)} /></label>
          <div className="row">
            <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>Annuler</button>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => onDone(withClock(sel))}>Valider</button>
          </div>
        </div>
      )}
    </div>
  );
}
