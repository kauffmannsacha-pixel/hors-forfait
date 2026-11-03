// Sélecteurs flottants de l'éditeur (emoji, texte/LaTeX, date, média) via une API à promesses.
// <EditorOverlays/> est monté une fois par la coque ; sans hôte, repli sur window.prompt.
import { useEffect } from 'react';
import { create } from 'zustand';
import { Popover, toAnchor, type AnchorRect, type Placement } from '../../ui/Popover';
import { EmojiPicker, type EmojiResult } from './EmojiPicker';
import { DatePicker } from './DatePicker';
import { PromptBox } from './PromptBox';
import { MediaPicker } from './MediaPicker';
import type { MediaKind, MediaResult } from '../media';

type Base = { anchor: AnchorRect; placement?: Placement };
export type OverlayReq =
  | (Base & { kind: 'emoji'; colors?: boolean; color?: string; allowRemove?: boolean; resolve: (r: EmojiResult | null) => void })
  | (Base & { kind: 'prompt'; title: string; placeholder?: string; value?: string; multiline?: boolean; preview?: 'math-inline' | 'math-block'; confirmLabel?: string; validate?: (v: string) => string | null; resolve: (v: string | null) => void })
  | (Base & { kind: 'date'; title?: string; withTime: boolean; value?: Date; reminder?: boolean; resolve: (d: Date | null) => void })
  | (Base & { kind: 'media'; media: MediaKind | 'embed'; resolve: (r: MediaResult | null) => void });

const useOverlay = create<{ req: OverlayReq | null; hosted: number }>(() => ({ req: null, hosted: 0 }));

function open<T>(make: (resolve: (v: T | null) => void) => OverlayReq): Promise<T | null> {
  return new Promise<T | null>(resolve => {
    useOverlay.getState().req?.resolve(null as never);
    useOverlay.setState({ req: make(resolve) });
  });
}
const anchorOf = (a: AnchorRect | Element | DOMRect) => toAnchor(a);
const hosted = () => useOverlay.getState().hosted > 0;

export function pickEmoji(anchor: AnchorRect | Element | DOMRect, opts: { colors?: boolean; color?: string; allowRemove?: boolean } = {}): Promise<EmojiResult | null> {
  if (!hosted()) { const e = window.prompt('Emoji :'); return Promise.resolve(e ? { emoji: e } : null); }
  return open<EmojiResult>(resolve => ({ kind: 'emoji', anchor: anchorOf(anchor), ...opts, resolve }));
}
export function promptText(anchor: AnchorRect | Element | DOMRect, opts: { title: string; placeholder?: string; value?: string; multiline?: boolean; preview?: 'math-inline' | 'math-block'; confirmLabel?: string; validate?: (v: string) => string | null; placement?: Placement }): Promise<string | null> {
  if (!hosted()) return Promise.resolve(window.prompt(opts.title, opts.value ?? ''));
  return open<string>(resolve => ({ kind: 'prompt', anchor: anchorOf(anchor), ...opts, resolve }));
}
export function pickDate(anchor: AnchorRect | Element | DOMRect, opts: { title?: string; withTime: boolean; value?: Date; reminder?: boolean }): Promise<Date | null> {
  if (!hosted()) {
    const v = window.prompt(opts.title ?? 'Date (AAAA-MM-JJ HH:MM)', '');
    const d = v ? new Date(v.replace(' ', 'T')) : null;
    return Promise.resolve(d && !Number.isNaN(d.getTime()) ? d : null);
  }
  return open<Date>(resolve => ({ kind: 'date', anchor: anchorOf(anchor), ...opts, resolve }));
}
export function pickMedia(anchor: AnchorRect | Element | DOMRect, media: MediaKind | 'embed'): Promise<MediaResult | null> {
  if (!hosted()) { const url = window.prompt('Adresse (URL) :'); return Promise.resolve(url ? { src: url, name: url, mime: '' } : null); }
  return open<MediaResult>(resolve => ({ kind: 'media', anchor: anchorOf(anchor), media, resolve }));
}

/** Rectangle du curseur de l'éditeur (pour ancrer un sélecteur). */
export function caretAnchor(view: { coordsAtPos: (pos: number) => { left: number; right: number; top: number; bottom: number }; state: { selection: { from: number } } }): AnchorRect {
  try { const c = view.coordsAtPos(view.state.selection.from); return { left: c.left, top: c.top, width: Math.max(1, c.right - c.left), height: c.bottom - c.top }; }
  catch { return { left: window.innerWidth / 2 - 150, top: 120, width: 0, height: 0 }; }
}

export function EditorOverlays() {
  const req = useOverlay(s => s.req);
  useEffect(() => { useOverlay.setState(s => ({ hosted: s.hosted + 1 })); return () => useOverlay.setState(s => ({ hosted: s.hosted - 1 })); }, []);
  if (!req) return null;
  const done = (v: unknown) => { useOverlay.setState({ req: null }); (req.resolve as (x: unknown) => void)(v); };
  const close = () => done(null);
  return (
    <Popover anchor={req.anchor} placement={req.placement ?? 'bottom-start'} onClose={close} className={`overlay overlay-${req.kind}`}>
      {req.kind === 'emoji' && <EmojiPicker colors={req.colors} color={req.color} allowRemove={req.allowRemove} onPick={done} />}
      {req.kind === 'prompt' && <PromptBox {...req} onDone={done} onCancel={close} />}
      {req.kind === 'date' && <DatePicker title={req.title} withTime={req.withTime} value={req.value} reminder={req.reminder} onDone={done} onCancel={close} />}
      {req.kind === 'media' && <MediaPicker media={req.media} onDone={done} />}
    </Popover>
  );
}
