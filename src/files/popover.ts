// État du popover d'aperçu (un seul pour toute l'app, rendu par overlay.tsx).
import { create } from 'zustand';
import type { PinAttrs } from './insert';

interface PopoverState {
  attrs: PinAttrs | null;
  anchor: HTMLElement | null;
  /** Ouvert au clavier (Espace = « Coup d'œil ») : reste affiché jusqu'à Échap / Espace. */
  quickLook: boolean;
}
export const usePinPopover = create<PopoverState>(() => ({ attrs: null, anchor: null, quickLook: false }));

let hideTimer: ReturnType<typeof setTimeout> | undefined;
export function showPinPopover(anchor: HTMLElement, attrs: PinAttrs, quickLook = false) {
  clearTimeout(hideTimer);
  usePinPopover.setState({ anchor, attrs, quickLook });
}
export function hidePinPopover() {
  clearTimeout(hideTimer);
  if (usePinPopover.getState().attrs) usePinPopover.setState({ attrs: null, anchor: null, quickLook: false });
}
/** Masquage différé : laisse le temps de passer de la puce au popover. */
export function hidePinPopoverSoon(delay = 220) {
  clearTimeout(hideTimer);
  if (usePinPopover.getState().quickLook) return;
  hideTimer = setTimeout(hidePinPopover, delay);
}
export const keepPinPopover = () => clearTimeout(hideTimer);
export const isPopoverFor = (el: HTMLElement) => usePinPopover.getState().anchor === el;
