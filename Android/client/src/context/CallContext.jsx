import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { useSocket } from './SocketContext';
import CallModal from '../components/CallModal';

import { publicAsset } from '../utils/publicPath';
const CallContext = createContext({ startCall: () => {} });

export function CallProvider({ children }) {
  const { socket } = useSocket();
  const [activeCall, setActiveCall] = useState(null);

  // IMPORTANT: depend on the reactive `socket` state, not `getSocket`
  // (a function reference that never changes identity). An effect keyed
  // on a never-changing dependency only ever runs once, at mount -- if
  // this provider (which wraps the whole app) happens to mount before
  // SocketProvider's own effect has finished calling connectSocket() for
  // this session, `getSocket()` returns null, the old code bailed via
  // `if (!socket) return`, and -- because the effect never reran -- the
  // global incoming-call listener was never attached for the rest of the
  // session. That was the root cause of calls not reliably ringing.
  // Depending on `socket` here makes the effect correctly re-run the
  // moment SocketProvider's setSocket() actually provides a live socket.
  useEffect(() => {
    if (!socket) return;

    const onIncomingCall = ({ callId, from, type, callerPet }) => {
      console.log('[Call] Incoming call received:', { callId, from, type });
      setActiveCall({
        type,
        name: callerPet?.name || 'Playmate',
        username: callerPet?.pet_username || '',
        avatar: callerPet?.avatar_url || publicAsset('/logo.png'),
        petId: callerPet?.id || null,
        isIncoming: true,
        callId,
        toUserId: from,
      });
    };

    socket.on('call_incoming', onIncomingCall);
    return () => socket.off('call_incoming', onIncomingCall);
  }, [socket]);

  const startCall = useCallback(({ type, name, username, avatar, petId, toUserId }) => {
    setActiveCall({
      type,
      name,
      username,
      avatar,
      petId,
      isIncoming: false,
      callId: null,
      toUserId,
    });
  }, []);

  const endCall = useCallback(() => {
    setActiveCall(null);
  }, []);

  return (
    <CallContext.Provider value={{ startCall }}>
      {children}
      {activeCall && (
        <CallModal
          type={activeCall.type}
          partnerName={activeCall.name}
          partnerUsername={activeCall.username}
          partnerAvatar={activeCall.avatar}
          partnerPetId={activeCall.petId}
          isIncoming={activeCall.isIncoming}
          callId={activeCall.callId}
          toUserId={activeCall.toUserId}
          onEnd={endCall}
        />
      )}
    </CallContext.Provider>
  );
}

export function useCall() {
  return useContext(CallContext);
}