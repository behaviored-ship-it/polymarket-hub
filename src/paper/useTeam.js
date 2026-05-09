import { useCallback, useEffect, useState } from 'react';
import { STORAGE_MODE, getTeamCode, setTeamCode, createTeam, joinTeam, leaveTeam } from './paperStore.js';

// Simple hook that exposes the active team code + create/join/leave actions.
// In 'idb' mode this is mostly a no-op (returns null code; create/join throw).
//
// Components use this to:
//   - decide whether to show the TeamGate
//   - render the team badge in the header
//   - sign out / switch teams
export function useTeam() {
  const [teamCode, setCodeState] = useState(() => (STORAGE_MODE === 'api' ? getTeamCode() : null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // Re-read on mount (handles Vite HMR + first paint).
  useEffect(() => {
    if (STORAGE_MODE !== 'api') return;
    setCodeState(getTeamCode());
  }, []);

  const create = useCallback(async (name) => {
    setBusy(true); setError(null);
    try {
      const team = await createTeam(name || null);
      setCodeState(team.code);
      return team;
    } catch (e) {
      setError(e.message || String(e));
      throw e;
    } finally {
      setBusy(false);
    }
  }, []);

  const join = useCallback(async (code) => {
    setBusy(true); setError(null);
    try {
      const team = await joinTeam(code);
      setCodeState(team.code);
      return team;
    } catch (e) {
      setError(e.message || String(e));
      throw e;
    } finally {
      setBusy(false);
    }
  }, []);

  const leave = useCallback(() => {
    leaveTeam();
    setCodeState(null);
  }, []);

  return {
    storageMode: STORAGE_MODE,
    teamCode,
    busy,
    error,
    create,
    join,
    leave,
    needsTeam: STORAGE_MODE === 'api' && !teamCode,
  };
}
