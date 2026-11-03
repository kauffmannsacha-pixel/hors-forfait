// Registre des vues : chaque module enregistre ses écrans ici (évite les conflits sur App.tsx).
import type { ComponentType } from 'react';
export interface ViewDef { id: string; label: string; icon: string; component: ComponentType; section: 'studio' | 'assistants' | 'outils' }
export const views: ViewDef[] = [];
export const registerView = (v: ViewDef) => { if (!views.find(x => x.id === v.id)) views.push(v); };
