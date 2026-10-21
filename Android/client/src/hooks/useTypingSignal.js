import { useCallback, useEffect, useRef } from 'react';

// Shared "I'm typing" sender used by both 1:1 chat and PawCircle chat.
// Two things the old inline implementation (ChatPage) got wrong:
//   1. It emitted a typing-start signal on every keystroke instead of once
//      per typing burst -- this hook only sends when transitioning from
//      "not typing" to "typing".
//   2. It never told the server typing had stopped when the user sent a
//      message, switched conversations, or navigated away -- only a local
//      pause timer or the server's own safety-net timeout would clear it,
//      leaving a stale indicator for the other party for a couple seconds.
//      This hook stops immediately on room change and on unmount.
//
// `send(isTyping)` is called with true on the leading edge of a typing burst
// and with false when the burst ends (pause, explicit stop, room change, or
// unmount) -- the caller decides how that maps to actual socket events.
export default function useTypingSignal(send, roomKey, stopDelay = 2000) {
  const isTypingRef = useRef(false);
  const stopTimerRef = useRef(null);
  const sendRef = useRef(send);
  sendRef.current = send;

  const clearStopTimer = () => {
    if (stopTimerRef.current) {
      clearTimeout(stopTimerRef.current);
      stopTimerRef.current = null;
    }
  };

  const stopTyping = useCallback(() => {
    clearStopTimer();
    if (isTypingRef.current) {
      isTypingRef.current = false;
      sendRef.current?.(false);
    }
  }, []);

  const notifyTyping = useCallback(() => {
    if (!roomKey) return;
    if (!isTypingRef.current) {
      isTypingRef.current = true;
      sendRef.current?.(true);
    }
    clearStopTimer();
    stopTimerRef.current = setTimeout(stopTyping, stopDelay);
  }, [roomKey, stopDelay, stopTyping]);

  // Stop broadcasting the moment the active conversation/community changes
  // or this component unmounts, rather than leaving it to the pause timer.
  useEffect(() => {
    return () => stopTyping();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomKey]);

  return { notifyTyping, stopTyping };
}
