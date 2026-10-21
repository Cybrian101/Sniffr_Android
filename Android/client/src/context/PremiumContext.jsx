import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { useAuth } from './AuthContext';
import { useSocket } from './SocketContext';
import api from '../services/api';

// Single source of truth on the frontend for "what can this user do right
// now" -- every page reads from here instead of re-deriving premium status
// from scattered plan-string comparisons. The backend is still the actual
// enforcement authority (see server/services/premiumGate.js); this context
// only mirrors what the backend already decided, for UI purposes.
const PremiumContext = createContext(null);

export function PremiumProvider({ children }) {
  const { isAuthenticated } = useAuth();
  const { socket } = useSocket();
  const [premium, setPremium] = useState(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const data = await api.get('/premium/status');
      setPremium(data);
      return data;
    } catch (err) {
      console.error('Failed to load premium status:', err);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isAuthenticated) {
      refresh();
    } else {
      setPremium(null);
      setLoading(false);
    }
  }, [isAuthenticated, refresh]);

  // Realtime: upgrade/downgrade/cancel/expiry and boost-credit spends all
  // push here live, via the same user_<id> socket room the notification
  // system already joins every connected client to -- no new join logic
  // needed, just new event names.
  useEffect(() => {
    if (!socket) return;

    const handleStatusUpdate = (data) => setPremium(data);
    const handleBoostUpdate = (data) => setPremium(prev => (prev ? { ...prev, boostCreditsRemaining: data.remaining } : prev));

    socket.on('premium_status_updated', handleStatusUpdate);
    socket.on('boost_credits_updated', handleBoostUpdate);
    return () => {
      socket.off('premium_status_updated', handleStatusUpdate);
      socket.off('boost_credits_updated', handleBoostUpdate);
    };
  }, [socket]);

  return (
    <PremiumContext.Provider value={{ premium, loading, refresh }}>
      {children}
    </PremiumContext.Provider>
  );
}

export function usePremium() {
  const ctx = useContext(PremiumContext);
  if (!ctx) throw new Error('usePremium must be used within a PremiumProvider');
  return ctx;
}
