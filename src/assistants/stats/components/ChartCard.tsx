// Carte de graphique : titre, sous-titre, export PNG (SVG → canvas) et CSV, bascule vers la vue tableau (accessibilité).
import { useRef, useState, type ReactNode } from 'react';
import { Button } from '../../../ui/kit';
import { toast } from '../../../ui/appState';
import { toCSV, safeFilename, type CsvTable } from '../lib/csv';
import { svgToPng } from '../lib/exportImage';
import { saveBlob, saveText } from '../lib/save';

interface Props {
  title: string;
  subtitle?: ReactNode;
  /** Titre du fichier exporté (titre de la vidéo, etc.). */
  exportName: string;
  csv?: () => CsvTable | null;
  png?: boolean;
  table?: () => ReactNode;
  actions?: ReactNode;
  note?: ReactNode;
  loading?: boolean;
  children: ReactNode;
  className?: string;
}

export function ChartCard({ title, subtitle, exportName, csv, png = true, table, actions, note, loading, children, className = '' }: Props) {
  const body = useRef<HTMLDivElement>(null);
  const [asTable, setAsTable] = useState(false);
  const [busy, setBusy] = useState<'png' | 'csv' | null>(null);

  const exportPng = async () => {
    const svg = body.current?.querySelector<SVGSVGElement>('svg[data-export]') ?? body.current?.querySelector<SVGSVGElement>('svg.recharts-surface') ?? body.current?.querySelector<SVGSVGElement>('svg');
    if (!svg) { toast('Rien à exporter : affiche le graphique (pas la vue tableau).', 'warning'); return; }
    setBusy('png');
    try {
      const blob = await svgToPng(svg, { title, subtitle: exportName });
      const path = await saveBlob(`${safeFilename(title)}-${safeFilename(exportName, 40)}.png`, blob, 'Image PNG');
      if (path) toast(path === 'download' ? 'Image PNG téléchargée.' : `Image enregistrée : ${path}`, 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Export PNG impossible.', 'error');
    } finally { setBusy(null); }
  };
  const exportCsv = async () => {
    const t = csv?.();
    if (!t || !t.rows.length) { toast('Aucune donnée à exporter.', 'warning'); return; }
    setBusy('csv');
    try {
      const path = await saveText(`${safeFilename(t.filename)}.csv`, toCSV(t.header, t.rows), 'text/csv;charset=utf-8', 'CSV (Excel)');
      if (path) toast(path === 'download' ? 'CSV téléchargé.' : `CSV enregistré : ${path}`, 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Export CSV impossible.', 'error');
    } finally { setBusy(null); }
  };

  return (
    <section className={`glass st-card ${className}`} aria-label={title}>
      <div className="st-card-head">
        <div>
          <div className="st-card-title">{title}</div>
          {subtitle && <div className="st-card-sub">{subtitle}</div>}
        </div>
        <div className="st-card-actions">
          {actions}
          {table && <Button size="sm" variant="ghost" aria-pressed={asTable} onClick={() => setAsTable(v => !v)}>{asTable ? 'Graphique' : 'Tableau'}</Button>}
          {png && <Button size="sm" variant="ghost" loading={busy === 'png'} onClick={exportPng} title="Exporter en PNG">PNG</Button>}
          {csv && <Button size="sm" variant="ghost" loading={busy === 'csv'} onClick={exportCsv} title="Exporter les données en CSV">CSV</Button>}
        </div>
      </div>
      <div ref={body} className="st-card-body" data-loading={loading ? 'true' : 'false'}>
        {asTable && table ? <div className="st-scroll">{table()}</div> : children}
      </div>
      {note}
    </section>
  );
}

/** Note d'honnêteté sur les limites de l'API. */
export const ApiNote = ({ children }: { children: ReactNode }) => <div className="st-note" role="note"><span aria-hidden>ⓘ</span><div>{children}</div></div>;
export const ErrorBox = ({ children }: { children: ReactNode }) => <div className="st-error" role="alert">{children}</div>;
