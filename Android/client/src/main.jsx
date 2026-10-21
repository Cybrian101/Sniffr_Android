import React from 'react';
import ReactDOM from 'react-dom/client';
import { Capacitor } from '@capacitor/core';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { APP_BASENAME } from './utils/publicPath';
import { AuthProvider } from './context/AuthContext';
import { SocketProvider } from './context/SocketContext';
import { PremiumProvider } from './context/PremiumContext';
import { PermissionProvider } from './context/PermissionContext';
import './index.css';

if (Capacitor.getPlatform() === 'android') {
  document.documentElement.classList.add('capacitor-android');
}

// Section 6: AppContext/AppProvider (unreadMessages, notifications state)
// removed -- confirmed unreachable: nothing in client/src ever called
// useApp() to read it, only this file ever referenced it, so the provider
// was holding dead state for the lifetime of every session. See
// context/AppContext.jsx's git history if this is needed again later.
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter basename={APP_BASENAME || '/'}>
      <AuthProvider>
        <SocketProvider>
          <PremiumProvider>
            <PermissionProvider>
              <App />
            </PermissionProvider>
          </PremiumProvider>
        </SocketProvider>
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>
);
