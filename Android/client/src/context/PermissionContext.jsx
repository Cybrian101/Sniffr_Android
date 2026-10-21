import { createContext, useContext, useState, useCallback } from 'react';
import {
  CAPABILITY_CONFIG,
  getCapabilityStatus,
  requestSystemPermission,
  savePermissionStatus
} from '../services/permissionService';

const PermissionContext = createContext(null);

export function PermissionProvider({ children }) {
  const [activeRequest, setActiveRequest] = useState(null); // { capability, featureKey, resolve }
  const [deniedToast, setDeniedToast] = useState(null);

  /**
   * Main feature-driven permission request method.
   * Usage:
   *   const granted = await requestFeaturePermission('location', 'Use Current GPS Location');
   *   if (!granted) return;
   */
  const requestFeaturePermission = useCallback(async (capability, featureLabel = '') => {
    const currentStatus = await getCapabilityStatus(capability);

    // 1. If already granted, proceed immediately without prompting
    if (currentStatus === 'granted') {
      return true;
    }

    // 2. If not granted, prompt the user with a friendly explanation modal
    return new Promise((resolve) => {
      setActiveRequest({
        capability,
        featureLabel,
        config: CAPABILITY_CONFIG[capability] || CAPABILITY_CONFIG.location,
        resolve
      });
    });
  }, []);

  const handleConfirmPrompt = async () => {
    if (!activeRequest) return;
    const { capability, resolve } = activeRequest;
    setActiveRequest(null);

    const result = await requestSystemPermission(capability);
    if (result === 'granted') {
      resolve(true);
    } else {
      savePermissionStatus(capability, 'denied');
      const cfg = CAPABILITY_CONFIG[capability];
      setDeniedToast(`${cfg?.title || 'Permission'} was not granted. You can enable it later from Me → Settings.`);
      setTimeout(() => setDeniedToast(null), 4000);
      resolve(false);
    }
  };

  const handleCancelPrompt = () => {
    if (!activeRequest) return;
    const { capability, resolve } = activeRequest;
    savePermissionStatus(capability, 'prompt');
    setActiveRequest(null);
    resolve(false);
  };

  return (
    <PermissionContext.Provider value={{ requestFeaturePermission }}>
      {children}

      {/* Feature-Based Permission Explanation Modal */}
      {activeRequest && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in select-none">
          <div className="bg-white dark:bg-zinc-900 border border-outline-variant/15 rounded-[2.5rem] p-6 sm:p-8 max-w-sm w-full shadow-2xl text-center space-y-4 animate-scale-up">
            <div className={`w-16 h-16 rounded-full ${activeRequest.config.color} flex items-center justify-center mx-auto text-3xl shadow-inner`}>
              <span className="material-symbols-outlined text-3xl">{activeRequest.config.icon}</span>
            </div>

            <div>
              <h3 className="text-lg font-extrabold text-on-surface">
                {activeRequest.config.title}
              </h3>
              {activeRequest.featureLabel && (
                <span className="inline-block mt-1 text-[11px] font-extrabold text-primary bg-primary/10 px-3 py-0.5 rounded-full uppercase tracking-wider">
                  Feature: {activeRequest.featureLabel}
                </span>
              )}
              <p className="text-xs text-zinc-500 font-medium leading-relaxed mt-2.5">
                {activeRequest.config.description}
              </p>
            </div>

            <div className="flex gap-2 pt-2">
              <button
                type="button"
                onClick={handleCancelPrompt}
                className="flex-1 py-3 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 font-extrabold text-xs rounded-xl hover:bg-zinc-200 transition-colors uppercase tracking-wider cursor-pointer"
              >
                Not Now
              </button>
              <button
                type="button"
                onClick={handleConfirmPrompt}
                className="flex-1 py-3 bg-primary hover:bg-primary-fixed-dim text-white font-extrabold text-xs rounded-xl transition-all shadow-md active:scale-95 uppercase tracking-wider cursor-pointer"
              >
                Allow Access
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Permission Denied Soft Toast */}
      {deniedToast && (
        <div className="fixed top-12 left-1/2 -translate-x-1/2 z-[10000] bg-zinc-900/95 text-white dark:bg-white/95 dark:text-zinc-900 px-5 py-3 rounded-2xl text-xs font-extrabold shadow-2xl animate-bounce text-center max-w-xs whitespace-pre-line pointer-events-none">
          {deniedToast}
        </div>
      )}
    </PermissionContext.Provider>
  );
}

export function usePermissions() {
  const ctx = useContext(PermissionContext);
  if (!ctx) {
    // Fallback if accessed outside provider
    return {
      requestFeaturePermission: async (capability) => {
        const res = await requestSystemPermission(capability);
        return res === 'granted';
      }
    };
  }
  return ctx;
}
