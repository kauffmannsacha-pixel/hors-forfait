// Import : documents (texte / Markdown / PDF texte collé), transcriptions manuelles (.srt / .vtt / .txt), principes manuels.
import { useMemo, useState, type DragEvent, type ReactNode } from 'react';
import { youtube } from '../../connectors/api';
import { toast } from '../../ui/appState';
import { Button, Field, Input, Select, TextArea } from '../../ui/kit';
import { fmtTime, parseVideoId, TOPIC_LABELS, TOPICS, type Source, type Topic } from '../api';
import { engine } from '../engine';
import { importDocument } from '../ingest/documents';
import { runSingleVideo } from '../ingest/pipeline';
import { useKnJob } from '../job';
import { parseTimestamp, parseTranscriptText } from '../transcript/parse';
import { saveManualTranscript } from '../transcript/service';

type Mode = 'document' | 'transcript' | 'manual';
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function DropText({ accept, onText, children }: { accept: string; onText: (text: string, name: string) => void; children: ReactNode }) {
  const [over, setOver] = useState(false);
  const read = async (f: File | undefined) => {
    if (!f) return;
    if (/\.pdf$/i.test(f.name)) { toast('PDF : copie le texte du document et colle-le dans le champ ci-dessous.', 'warning'); return; }
    try { onText(await f.text(), f.name); } catch { toast('Fichier illisible.', 'error'); }
  };
  const onDrop = (e: DragEvent) => { e.preventDefault(); setOver(false); void read(e.dataTransfer.files[0]); };
  return (
    <div className={`kn-drop${over ? ' over' : ''}`} onDragOver={e => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}>
      {children}{' '}
      <label style={{ color: 'var(--accent)', cursor: 'pointer', fontWeight: 600 }}>
        choisir un fichier<input type="file" accept={accept} hidden onChange={e => { void read(e.target.files?.[0]); e.target.value = ''; }} />
      </label>
    </div>
  );
}

function DocumentForm() {
  const busy = useKnJob(s => s.running);
  const [title, setTitle] = useState(''); const [creator, setCreator] = useState(''); const [url, setUrl] = useState('');
  const [text, setText] = useState(''); const [mode, setMode] = useState<'claude' | 'brut'>('claude');
  const submit = async () => {
    try {
      const r = await importDocument({ title, creator, text, url, mode });
      toast(`${r.added} principe(s) importé(s)${r.duplicates ? `, ${r.duplicates} doublon(s) écarté(s)` : ''}.`, 'success');
      setText('');
    } catch (e) { toast(errMsg(e), 'error'); }
  };
  return (
    <div className="kn-form">
      <p className="kn-hint">Guide, mémo, notes, document de production (ex. le document de production MrBeast), newsletter… Colle le texte (y compris le texte copié d'un PDF) ou dépose un fichier .txt / .md. Chaque principe gardera ce document comme source.</p>
      <div className="kn-form-row">
        <Field label="Titre du document"><Input value={title} onChange={e => setTitle(e.target.value)} placeholder="ex. How to Succeed in MrBeast Production" /></Field>
        <Field label="Créateur / auteur"><Input value={creator} onChange={e => setCreator(e.target.value)} placeholder="ex. MrBeast" /></Field>
      </div>
      <Field label="Lien (facultatif)"><Input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://…" /></Field>
      <DropText accept=".txt,.md,.markdown,.pdf" onText={(t, name) => { setText(t); if (!title) setTitle(name.replace(/\.[^.]+$/, '')); }}>Dépose un fichier texte ou Markdown ici, ou</DropText>
      <Field label="Texte" hint={`${text.length.toLocaleString('fr-FR')} caractères`}><TextArea rows={10} value={text} onChange={e => setText(e.target.value)} placeholder="Colle le contenu ici…" /></Field>
      <Field label="Méthode" hint={mode === 'claude' ? 'Claude (modèle rapide) extrait et reformule les principes actionnables en français.' : 'Chaque puce ou paragraphe devient un principe, sujet deviné par mots-clés (hors ligne, sans Claude).'}>
        <Select value={mode} onChange={e => setMode(e.target.value as 'claude' | 'brut')}>
          <option value="claude">Extraction par Claude (recommandé)</option>
          <option value="brut">Découpage brut (sans Claude)</option>
        </Select>
      </Field>
      <div className="row"><Button variant="primary" loading={busy} disabled={busy || text.trim().length < 40} onClick={submit}>Importer le document</Button></div>
    </div>
  );
}

function TranscriptForm({ initialVideo }: { initialVideo?: string }) {
  const busy = useKnJob(s => s.running);
  const [video, setVideo] = useState(initialVideo ?? ''); const [creator, setCreator] = useState(''); const [title, setTitle] = useState('');
  const [raw, setRaw] = useState(''); const [fetching, setFetching] = useState(false);
  const videoId = parseVideoId(video.trim());
  const parsed = useMemo(() => (raw.trim() ? parseTranscriptText(raw) : null), [raw]);
  const last = parsed?.segments[parsed.segments.length - 1];
  const fill = async () => {
    if (!videoId) return;
    setFetching(true);
    try {
      const [v] = await youtube.videos([videoId]);
      if (!v) throw new Error('Vidéo introuvable.');
      setTitle(v.title); if (!creator) setCreator(v.channelTitle);
    } catch (e) { toast(errMsg(e), 'error'); } finally { setFetching(false); }
  };
  const submit = async () => {
    if (!videoId || !parsed) return;
    try {
      await engine.init();
      await saveManualTranscript(videoId, parsed);
      const r = await runSingleVideo({ videoId, title: title.trim() || videoId, creator: creator.trim() || 'Inconnu', priority: 0, origin: 'manual' }, { refresh: false });
      toast(r.status === 'ok' ? `${r.added} principe(s) extrait(s).` : (r.detail ?? 'Aucun principe extrait.'), r.status === 'ok' ? 'success' : 'warning');
      setRaw('');
    } catch (e) { toast(errMsg(e), 'error'); }
  };
  return (
    <div className="kn-form">
      <p className="kn-hint">Quand ni les sous-titres officiels (tes vidéos) ni un outil MCP de transcription ne sont disponibles : importe un fichier .srt, .vtt ou .txt (horodaté de préférence), ou colle le texte. Prisme le découpe en fenêtres de ~75 s et Claude en extrait les principes avec l'horodatage du segment.</p>
      <div className="kn-form-row">
        <Field label="Lien ou ID de la vidéo YouTube" hint={video && !videoId ? 'Lien non reconnu.' : undefined}>
          <div className="kn-inline"><Input value={video} onChange={e => setVideo(e.target.value)} placeholder="https://www.youtube.com/watch?v=…" /><Button size="sm" disabled={!videoId || fetching} loading={fetching} onClick={fill}>Compléter</Button></div>
        </Field>
        <Field label="Créateur"><Input value={creator} onChange={e => setCreator(e.target.value)} placeholder="ex. Paddy Galloway" /></Field>
      </div>
      <Field label="Titre de la vidéo"><Input value={title} onChange={e => setTitle(e.target.value)} placeholder="Titre (facultatif)" /></Field>
      <DropText accept=".srt,.vtt,.txt" onText={t => setRaw(t)}>Dépose un fichier .srt, .vtt ou .txt ici, ou</DropText>
      <Field label="Transcription" hint={parsed ? `${parsed.segments.length} segment(s) · format ${parsed.format.toUpperCase()}${last ? ` · ${fmtTime(last.start + last.dur)}` : ''}${parsed.timed ? ' · horodatée' : ' · sans horodatage (les principes n\'auront pas de minutage)'}` : undefined}>
        <TextArea rows={9} value={raw} onChange={e => setRaw(e.target.value)} placeholder={'1\n00:00:01,000 --> 00:00:04,000\nPremière phrase…'} />
      </Field>
      <div className="row"><Button variant="primary" loading={busy} disabled={busy || !videoId || !parsed?.segments.length} onClick={submit}>Importer et analyser</Button></div>
    </div>
  );
}

function ManualForm() {
  const [topic, setTopic] = useState<Topic>('script'); const [title, setTitle] = useState(''); const [text, setText] = useState('');
  const [creator, setCreator] = useState(''); const [link, setLink] = useState(''); const [ts, setTs] = useState(''); const [saving, setSaving] = useState(false);
  const videoId = link.trim() ? parseVideoId(link.trim()) : null;
  const tsVal = ts.trim() ? parseTimestamp(ts.trim()) : null;
  const submit = async () => {
    setSaving(true);
    try {
      const source: Source = { kind: 'manual', creator: creator.trim() || 'Moi' };
      if (videoId) { source.videoId = videoId; source.url = `https://www.youtube.com/watch?v=${videoId}`; if (tsVal != null) source.timestamp = Math.floor(tsVal); }
      else if (link.trim()) source.url = link.trim();
      const before = engine.list().length;
      const p = await engine.add({ topic, title, text, source });
      toast(engine.list().length > before ? 'Principe ajouté.' : `Déjà présent : « ${p.title} ».`, engine.list().length > before ? 'success' : 'warning');
      setTitle(''); setText('');
    } catch (e) { toast(errMsg(e), 'error'); } finally { setSaving(false); }
  };
  return (
    <div className="kn-form">
      <div className="kn-form-row">
        <Field label="Sujet"><Select value={topic} onChange={e => setTopic(e.target.value as Topic)}>{TOPICS.map(t => <option key={t} value={t}>{TOPIC_LABELS[t]}</option>)}</Select></Field>
        <Field label="Créateur / source"><Input value={creator} onChange={e => setCreator(e.target.value)} placeholder="ex. Squiduu (vide = Moi)" /></Field>
      </div>
      <Field label="Principe (titre court)"><Input value={title} onChange={e => setTitle(e.target.value)} placeholder="ex. Hook en moins de 5 secondes" /></Field>
      <Field label="Explication"><TextArea rows={4} value={text} onChange={e => setText(e.target.value)} placeholder="La règle, le pourquoi, un exemple…" /></Field>
      <div className="kn-form-row">
        <Field label="Lien YouTube ou URL (facultatif)"><Input value={link} onChange={e => setLink(e.target.value)} placeholder="https://www.youtube.com/watch?v=…" /></Field>
        <Field label="Horodatage (facultatif)" hint={ts && tsVal == null ? 'Format mm:ss ou h:mm:ss.' : videoId ? 'Moment exact où le conseil est donné.' : 'Seulement avec un lien YouTube.'}>
          <Input value={ts} onChange={e => setTs(e.target.value)} placeholder="03:42" disabled={!videoId} />
        </Field>
      </div>
      <div className="row"><Button variant="primary" loading={saving} disabled={saving || title.trim().length < 3 || text.trim().length < 10} onClick={submit}>Ajouter le principe</Button></div>
    </div>
  );
}

export function ImportPanel({ prefillVideo }: { prefillVideo?: string }) {
  const [mode, setMode] = useState<Mode>(prefillVideo ? 'transcript' : 'document');
  return (
    <div>
      <div className="kn-seg" role="tablist" style={{ marginTop: 0, marginBottom: 16 }}>
        {([['document', 'Document'], ['transcript', 'Transcription'], ['manual', 'Principe manuel']] as [Mode, string][]).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={mode === id} onClick={() => setMode(id)}>
            {mode === id && <span className="kn-seg-pill" />}<span>{label}</span>
          </button>
        ))}
      </div>
      {mode === 'document' ? <DocumentForm /> : mode === 'transcript' ? <TranscriptForm key={prefillVideo} initialVideo={prefillVideo} /> : <ManualForm />}
    </div>
  );
}
