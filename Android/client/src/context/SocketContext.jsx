import { createContext, useContext, useEffect, useState } from 'react';
import { useAuth } from './AuthContext';
import { connectSocket, disconnectSocket, getSocket } from '../services/socket';
import { announceBlockChange } from '../utils/blocks';

const SocketContext = createContext({ socket: null, getSocket: () => null, onlineUsers: [] });

export function SocketProvider({ children }) {
  const { isAuthenticated, finishAccountDeletion } = useAuth();
  const [onlineUsers, setOnlineUsers] = useState([]);
  const [socket, setSocket] = useState(null);

  useEffect(() => {
    if (isAuthenticated) {
      const s = connectSocket();
      setSocket(s);

      s.on('user_online', ({ userId }) => {
        setOnlineUsers(prev => [...new Set([...prev, userId])]);
      });
      s.on('user_offline', ({ userId }) => {
        setOnlineUsers(prev => prev.filter(id => id !== userId));
      });
      // This account was deleted (here or on another device): sign out and
      // clear everything stored. The server disconnects the socket right after.
      s.on('account_deleted', () => finishAccountDeletion());
      // This account blocked/unblocked someone on another device or tab.
      s.on('block_updated', ({ userId, blockedByMe }) => announceBlockChange(userId, blockedByMe));

      return () => {
        disconnectSocket();
        setSocket(null);
      };
    } else {
      disconnectSocket();
      setSocket(null);
    }
  }, [isAuthenticated]);

  return (
    <SocketContext.Provider value={{ socket, getSocket, onlineUsers }}>
      {children}
    </SocketContext.Provider>
  );
}

export function useSocket() {
  return useContext(SocketContext) || { socket: null, getSocket: () => null, onlineUsers: [] };
}
