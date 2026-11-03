// Coque provisoire : remplacée par l'agent UI/éditeur (sidebar arborescente, Ctrl+K…).
import { useState } from 'react';
import { views } from './registry';
export function Shell() {
  const [cur, setCur] = useState(views[0]?.id);
  const V = views.find(v => v.id === cur)?.component;
  return (<div className="shell"><nav className="glass sidebar">{views.map(v => <button key={v.id} onClick={() => setCur(v.id)}>{v.icon} {v.label}</button>)}</nav><main>{V ? <V /> : 'Prisme'}</main></div>);
}
