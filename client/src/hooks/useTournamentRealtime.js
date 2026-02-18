import { useEffect, useRef } from 'react';
import { io } from 'socket.io-client';

import { SOCKET_URL } from '../config/env.js';

function normalizeTournamentCode(value) {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

export function useTournamentRealtime({
  tournamentCode,
  onEvent,
  onError,
  enabled = true,
}) {
  const eventHandlerRef = useRef(onEvent);
  const errorHandlerRef = useRef(onError);

  useEffect(() => {
    eventHandlerRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    errorHandlerRef.current = onError;
  }, [onError]);

  useEffect(() => {
    const normalizedCode = normalizeTournamentCode(tournamentCode);

    if (!enabled || !normalizedCode) {
      return undefined;
    }

    const socketEndpoint = SOCKET_URL || undefined;
    const socket = io(socketEndpoint, {
      transports: ['websocket'],
      autoConnect: false,
    });

    const handleTournamentEvent = (payload) => {
      if (!payload || payload.tournamentCode !== normalizedCode) {
        return;
      }

      eventHandlerRef.current?.(payload);
    };

    const handleTournamentError = ({ message } = {}) => {
      errorHandlerRef.current?.(message || 'Realtime connection failed');
    };

    const joinTournamentRoom = () => {
      socket.emit('tournament:join', { code: normalizedCode });
    };

    socket.on('connect', joinTournamentRoom);
    socket.on('tournament:event', handleTournamentEvent);
    socket.on('tournament:error', handleTournamentError);
    socket.connect();

    if (socket.connected) {
      joinTournamentRoom();
    }

    return () => {
      socket.emit('tournament:leave', { code: normalizedCode });
      socket.off('connect', joinTournamentRoom);
      socket.off('tournament:event', handleTournamentEvent);
      socket.off('tournament:error', handleTournamentError);
      socket.disconnect();
    };
  }, [enabled, tournamentCode]);
}
