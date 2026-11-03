// Personnes locales (kv 'people') pour les propriétés « Personne ».
import { useEffect } from 'react';
import { create } from 'zustand';
import { repo } from '../db/store';
import { COLORS, newId, type Person } from './model';

interface PeopleState { people: Person[]; loaded: boolean }
export const usePeopleStore = create<PeopleState>(() => ({ people: [], loaded: false }));

let loading: Promise<Person[]> | null = null;
export function loadPeople(): Promise<Person[]> {
  if (usePeopleStore.getState().loaded) return Promise.resolve(usePeopleStore.getState().people);
  loading ??= repo.kvGet<Person[]>('people').then(list => {
    const people = (Array.isArray(list) ? list : []).filter(p => p && p.id && p.name);
    usePeopleStore.setState({ people, loaded: true });
    return people;
  }).catch(() => { usePeopleStore.setState({ loaded: true }); return []; });
  return loading;
}
async function save(people: Person[]) {
  usePeopleStore.setState({ people, loaded: true });
  await repo.kvSet('people', people);
}
const colorFor = (i: number) => COLORS[1 + (i % (COLORS.length - 1))];

export async function addPerson(name: string, email?: string): Promise<Person> {
  const people = await loadPeople();
  const clean = name.trim();
  const found = people.find(p => p.name.toLowerCase() === clean.toLowerCase());
  if (found) return found;
  const p: Person = { id: newId(), name: clean, color: colorFor(people.length), ...(email ? { email } : {}) };
  await save([...people, p]);
  return p;
}
export async function addPeople(list: Person[]) {
  if (!list.length) return;
  const people = await loadPeople();
  await save([...people, ...list.filter(p => !people.some(x => x.id === p.id))]);
}
export async function updatePerson(id: string, patch: Partial<Omit<Person, 'id'>>) {
  const people = await loadPeople();
  await save(people.map(p => (p.id === id ? { ...p, ...patch } : p)));
}
export async function removePerson(id: string) {
  const people = await loadPeople();
  await save(people.filter(p => p.id !== id));
}

/** Liste réactive (chargée à la demande). */
export function usePeople(): Person[] {
  const people = usePeopleStore(s => s.people);
  const loaded = usePeopleStore(s => s.loaded);
  useEffect(() => { if (!loaded) void loadPeople(); }, [loaded]);
  return people;
}
