// Chargement asynchrone avec conservation de l'affichage précédent pendant l'actualisation (pas de flash).
import { useCallback, useEffect, useRef, useState } from 'react';
import { explainError, type ErrorContext } from '../data/errors';

export interface AsyncState<T> {
  data?: T;
  error?: string;
  loading: boolean;
  reload: (force?: boolean) => void;
}

export function useAsync<T>(fn: (force: boolean) => Promise<T>, deps: unknown[], opts: { enabled?: boolean; ctx?: ErrorContext } = {}): AsyncState<T> {
  const enabled = opts.enabled ?? true;
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: enabled });
  const req = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const run = useCallback((force: boolean) => {
    const id = ++req.current;
    setState(s => ({ ...s, loading: true, error: undefined }));
    fnRef.current(force).then(
      data => { if (id === req.current) setState({ data, loading: false }); },
      e => { if (id === req.current) setState(s => ({ data: s.data, error: explainError(e, opts.ctx), loading: false })); },
    );
  }, [opts.ctx]);
  useEffect(() => {
    if (!enabled) { req.current++; setState({ loading: false }); return; }
    run(false);
    return () => { req.current++; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...deps]);
  return { ...state, reload: (force = true) => run(force) };
}
