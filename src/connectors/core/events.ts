// Petit bus réactif : les cartes de Réglages → Connexions se rafraîchissent après une connexion / déconnexion.
import { create } from 'zustand';

export const useConnectorsVersion = create<{ v: number; busy: Record<string, string | undefined> }>(() => ({ v: 0, busy: {} }));
export const bumpConnectors = () => useConnectorsVersion.setState(s => ({ v: s.v + 1 }));
/** Indique qu'un connecteur attend une action (ex. « Termine la connexion dans ton navigateur… »). */
export const setBusy = (id: string, text?: string) => useConnectorsVersion.setState(s => ({ busy: { ...s.busy, [id]: text } }));
