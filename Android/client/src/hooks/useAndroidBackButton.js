import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Capacitor } from '@capacitor/core';
import { showAppToast } from '../utils/appToast';
import { consumeBackOverride } from '../utils/backButtonOverride';

const EXIT_CONFIRM_WINDOW_MS = 2000;

export default function useAndroidBackButton() {
  const location = useLocation();
  const navigate = useNavigate();
  const locationRef = useRef(location);
  const navigateRef = useRef(navigate);
  const lastExitPressRef = useRef(0);
  const exitPromptTimerRef = useRef(null);

  locationRef.current = location;
  navigateRef.current = navigate;

  // Any real navigation (back, forward, a tab switch, drilling into a
  // profile/community/post) cancels a pending "press back again to exit"
  // countdown left over from whatever screen we were just on -- it should
  // never carry over onto a different screen.
  useEffect(() => {
    lastExitPressRef.current = 0;
    if (exitPromptTimerRef.current) {
      clearTimeout(exitPromptTimerRef.current);
      exitPromptTimerRef.current = null;
    }
  }, [location.pathname]);

  useEffect(() => {
    if (Capacitor.getPlatform() !== 'android') return undefined;

    let listenerHandle;
    let cancelled = false;

    import('@capacitor/app').then(({ App }) => {
      if (cancelled) return;

      const backButtonListener = ({ canGoBack }) => {
        if (consumeBackOverride()) return;

        // Real rollback to whatever screen was actually open before this
        // one. Every exit-for-good transition in the app (login success,
        // finishing onboarding, switching bottom-nav tabs) replaces its
        // history entry instead of pushing one (see AuthPage,
        // PetSelectionPage, CreateProfilePage, BottomNav) specifically so
        // it can never be the target of a real back navigation -- that's
        // what stops e.g. "log in -> home -> back" from landing on the
        // login screen again.
        if (canGoBack) {
          window.history.back();
          return;
        }

        // Nothing left to roll back to. Every social-media app treats the
        // Home feed as the mandatory floor before exiting, no matter which
        // tab you've wandered into -- so land there first if we aren't
        // already, and only arm the double-press-to-exit once we are.
        // Except '/' itself (the signed-out Auth/landing page): /home is a
        // ProtectedRoute, so navigating there while signed out just
        // bounces straight back to '/' (replace), which looked like back
        // doing nothing at all -- pressing back on the very first screen
        // should go to the exit prompt directly, same as reaching the
        // floor anywhere else.
        const pathname = locationRef.current.pathname.replace(/\/+$/, '') || '/';
        if (pathname !== '/home' && pathname !== '/') {
          navigateRef.current('/home', { replace: true });
          return;
        }

        const now = Date.now();
        if (now - lastExitPressRef.current < EXIT_CONFIRM_WINDOW_MS) {
          lastExitPressRef.current = 0;
          if (exitPromptTimerRef.current) {
            clearTimeout(exitPromptTimerRef.current);
            exitPromptTimerRef.current = null;
          }
          App.exitApp().catch((err) => console.error('Failed to exit Android app:', err));
          return;
        }

        lastExitPressRef.current = now;
        if (exitPromptTimerRef.current) clearTimeout(exitPromptTimerRef.current);
        exitPromptTimerRef.current = setTimeout(() => {
          lastExitPressRef.current = 0;
          exitPromptTimerRef.current = null;
        }, EXIT_CONFIRM_WINDOW_MS);
        showAppToast('Press back again to exit', 'exit_to_app');
      };

      return App.addListener('backButton', backButtonListener).then((handle) => {
        if (cancelled) handle.remove();
        else listenerHandle = handle;
      });
    }).catch((err) => {
      console.error('Failed to register Android back-button listener:', err);
    });

    return () => {
      cancelled = true;
      if (exitPromptTimerRef.current) clearTimeout(exitPromptTimerRef.current);
      listenerHandle?.remove();
    };
  }, []);
}
