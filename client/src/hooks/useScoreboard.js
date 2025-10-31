import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { API_URL, SOCKET_URL } from '../config/env.js';

const NETWORK_ERROR_MESSAGE = 'Unable to reach the server. Please try again shortly.';

/**
 * Hook that keeps a scoreboard document in sync with the server via REST + Socket.IO.
 */
export function useScoreboard(scoreboardId) {
  const [scoreboard, setScoreboard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const socketRef = useRef(null);

  useEffect(() => {
    let isMounted = true;

    if (!scoreboardId) {
      setScoreboard(null);
      setLoading(false);
      setError(null);
      socketRef.current?.removeAllListeners?.();
      socketRef.current?.disconnect?.();
      socketRef.current = null;
      return () => {
        isMounted = false;
      };
    }

    async function loadScoreboard() {
      setLoading(true);
      setError(null);

      try {
        const response = await fetch(`${API_URL}/api/scoreboards/${scoreboardId}`);

        if (!response.ok) {
          const message = response.status === 404 ? 'Scoreboard not found' : 'Unable to load scoreboard';
          throw new Error(message);
        }

        const data = await response.json();
        if (isMounted) {
          setScoreboard(data);
        }
      } catch (err) {
        if (isMounted) {
          const message = String(err?.message || '').toLowerCase();
          if (
            message === 'failed to fetch' ||
            message === 'networkerror when attempting to fetch resource.' ||
            message === 'load failed'
          ) {
            setError(NETWORK_ERROR_MESSAGE);
          } else {
            setError(err.message || NETWORK_ERROR_MESSAGE);
          }
        }
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    }

    loadScoreboard();

    const socketEndpoint = SOCKET_URL || undefined;
    const socket = io(socketEndpoint, {
      transports: ['websocket'],
      autoConnect: false,
    });

    socketRef.current?.removeAllListeners?.();
    socketRef.current?.disconnect?.();
    socketRef.current = socket;

    socket.on('connect_error', (err) => {
      if (isMounted) {
        setError(err.message);
      }
    });

    socket.on('scoreboard:error', ({ message }) => {
      if (isMounted) {
        setError(message);
      }
    });

    socket.on('scoreboard:state', (state) => {
      if (isMounted) {
        setScoreboard(state);
        setError(null);
      }
    });

    socket.connect();
    socket.emit('scoreboard:join', { scoreboardId });

    return () => {
      isMounted = false;
      socket.removeAllListeners();
      socket.disconnect();
    };
  }, [scoreboardId]);

  const updateScoreboard = useCallback(
    (nextStateOrUpdater) => {
      setError(null);
      setScoreboard((current) => {
        if (!current) {
          return current;
        }

        const nextPartial =
          typeof nextStateOrUpdater === 'function'
            ? nextStateOrUpdater(current)
            : nextStateOrUpdater;

        if (!nextPartial) {
          return current;
        }

        const merged = {
          ...current,
          ...nextPartial,
          teams: nextPartial.teams ?? current.teams,
          servingTeamIndex:
            typeof nextPartial.servingTeamIndex === 'number'
              ? nextPartial.servingTeamIndex
              : current.servingTeamIndex,
          sets: Array.isArray(nextPartial.sets) ? nextPartial.sets : current.sets,
        };

        const payload = {
          teams: merged.teams,
          servingTeamIndex: merged.servingTeamIndex,
          sets: merged.sets,
        };

        if (typeof merged.title === 'string') {
          payload.title = merged.title;
        }

        socketRef.current?.emit('scoreboard:update', {
          scoreboardId,
          state: payload,
        });

        return merged;
      });
    },
    [scoreboardId]
  );

  const controls = useMemo(
    () => ({
      loading,
      error,
      scoreboard,
      updateScoreboard,
      clearError: () => setError(null),
    }),
    [error, loading, scoreboard, updateScoreboard]
  );

  return controls;
}
