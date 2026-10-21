import { useState, useEffect } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import { useSocket } from './context/SocketContext';
import { CallProvider } from './context/CallContext';
import BottomNav, { SidebarNav } from './components/BottomNav';
import EmailVerifyBanner from './components/EmailVerifyBanner';
import WelcomeSlider from './components/WelcomeSlider';
import SniffedOutToast from './components/SniffedOutToast';
import NoPetPrompt from './components/NoPetPrompt';
import AppToast from './components/AppToast';
import ConfirmDialogHost from './components/ConfirmDialogHost';
import AccountDeletedNotice from './components/AccountDeletedNotice';
import LoadingPage from './pages/LoadingPage';
import NotFoundPage from './pages/NotFoundPage';
import usePageMeta from './hooks/usePageMeta';
import useAndroidBackButton from './hooks/useAndroidBackButton';
import { isOwnProfilePath } from './utils/profileRoutes';
import { lazy, Suspense } from 'react';

const AuthPage          = lazy(() => import('./pages/AuthPage'));
const PetSelectionPage  = lazy(() => import('./pages/PetSelectionPage'));
const CreateProfilePage = lazy(() => import('./pages/CreateProfilePage'));
const HomePage          = lazy(() => import('./pages/HomePage'));
const MeetPage          = lazy(() => import('./pages/MeetPage'));
const ChatPage          = lazy(() => import('./pages/ChatPage'));
const ProfilePage       = lazy(() => import('./pages/ProfilePage'));
const SpotlightPage     = lazy(() => import('./pages/SpotlightPage'));
const PrivacyPage       = lazy(() => import('./pages/PrivacyPage'));
const TermsPage         = lazy(() => import('./pages/TermsPage'));
const FAQPage           = lazy(() => import('./pages/FAQPage'));
const ResetPasswordPage = lazy(() => import('./pages/ResetPasswordPage'));
const VerifyEmailPage   = lazy(() => import('./pages/VerifyEmailPage'));
const CommunityPage     = lazy(() => import('./pages/CommunityPage'));
const CreateCommunityPage = lazy(() => import('./pages/CreateCommunityPage'));
const AdminPaymentsPage = lazy(() => import('./pages/AdminPaymentsPage'));
const PostPage          = lazy(() => import('./pages/PostPage'));

function LoadingFallback() {
  return <LoadingPage />;
}

function ProtectedRoute({ children }) {
  const { isAuthenticated, loading } = useAuth();
  const hasToken = !!localStorage.getItem('sniffr_refresh_token');
  const location = useLocation();

  if (loading) return <LoadingFallback />;
  // N5: carry the originally-requested destination through the sign-in
  // redirect (AuthPage's applySession reads location.state.from) instead of
  // always dropping the user on the fixed default post-login page.
  if (!isAuthenticated && !hasToken) {
    return <Navigate to="/" replace state={{ from: location.pathname + location.search }} />;
  }

  return children;
}

// Route -> per-page <title>/description/indexability. The app previously
// shipped one static title for every route (see AUDIT_REPORT.md-style SEO
// review); authenticated pages are noindex since a crawler without a
// session can never actually see their content.
const PAGE_META = [
  { match: (p) => p === '/', meta: { title: null, description: null } },
  { match: (p) => p === '/privacy', meta: { title: 'Privacy Policy', description: "Sniffr's privacy policy - how we handle your and your pet's data." } },
  { match: (p) => p === '/terms', meta: { title: 'Terms & Conditions', description: "Sniffr's terms and conditions of use." } },
  { match: (p) => p === '/faq', meta: { title: 'FAQ', description: 'Frequently asked questions about matching, messaging, safety, and Premium on Sniffr.' } },
  { match: (p) => p === '/reset-password', meta: { title: 'Reset Password', description: 'Reset your Sniffr account password.', noindex: true } },
  { match: (p) => p === '/verify-email', meta: { title: 'Verify Email', description: 'Verify your Sniffr account email.', noindex: true } },
  { match: (p) => p === '/pet-selection', meta: { title: 'Select Your Pet', noindex: true } },
  { match: (p) => p === '/create-profile', meta: { title: 'Create Profile', noindex: true } },
  { match: (p) => p === '/home', meta: { title: 'Home Feed', description: 'See what pets in your community are up to on Sniffr.', noindex: true } },
  { match: (p) => p === '/meet', meta: { title: 'Find a Playmate', description: 'Discover and match with pets near you on Sniffr.', noindex: true } },
  { match: (p) => p === '/chat', meta: { title: 'Messages', description: "Chat with your pet's matches on Sniffr.", noindex: true } },
  { match: (p) => p.startsWith('/profile'), meta: { title: 'Profile', noindex: true } },
  { match: (p) => p === '/spotlight', meta: { title: 'Spotlight', description: "See today's Spotlight pets on Sniffr.", noindex: true } },
  { match: (p) => p.startsWith('/community'), meta: { title: 'Community', noindex: true } },
  { match: (p) => p.startsWith('/admin'), meta: { title: 'Admin', noindex: true } },
  // Catch-all for the top-level pet-profile route (app.sniffrweb.com/kitty)
  // -- every other single-segment path is matched by name above, so
  // reaching this means the :id route is handling a username. If it turns
  // out not to resolve to a real pet, ProfilePage itself renders
  // NotFoundPage; this is just the title/meta while that's being decided.
  { match: (p) => p.split('/').filter(Boolean).length === 1, meta: { title: 'Profile', noindex: true } },
];

function getPageMeta(pathname) {
  const found = PAGE_META.find(({ match }) => match(pathname));
  return found ? found.meta : { title: 'Page Not Found', noindex: true };
}

function PageMeta() {
  const location = useLocation();
  usePageMeta(getPageMeta(location.pathname));
  return null;
}

function CursorGlow() {
  const [pos, setPos] = useState({ x: -999, y: -999 });

  useEffect(() => {
    const move = (e) => setPos({ x: e.clientX, y: e.clientY });
    window.addEventListener('mousemove', move);
    return () => window.removeEventListener('mousemove', move);
  }, []);

  return (
    <div
      className="cursor-glow hidden lg:block"
      style={{ left: pos.x, top: pos.y }}
    />
  );
}

function BackgroundBlobs() {
  return (
    <div className="fixed inset-0 pointer-events-none -z-10 overflow-hidden">
      <div className="absolute -top-32 -left-32 w-96 h-96 rounded-full bg-primary/8 blur-3xl animate-float-slow" />
      <div
        className="absolute top-1/3 -right-24 w-72 h-72 rounded-full bg-secondary/8 blur-3xl animate-float"
        style={{ animationDelay: '2s' }}
      />
      <div
        className="absolute bottom-0 left-1/4 w-80 h-80 rounded-full bg-tertiary/6 blur-3xl animate-float-slow"
        style={{ animationDelay: '4s' }}
      />
    </div>
  );
}

function MainLayout({ children }) {
  const location = useLocation();
  const { user, pet, refreshProfile } = useAuth();
  const { socket } = useSocket();

  // Live update: if PawPrint gets enabled via the emailed link (e.g. opened
  // in another tab/device while this session stays open), reflect it here
  // immediately instead of waiting for the next manual refresh.
  useEffect(() => {
    if (!socket) return;
    const onPawprintEnabled = () => refreshProfile();
    socket.on('pawprint_enabled', onPawprintEnabled);
    return () => socket.off('pawprint_enabled', onPawprintEnabled);
  }, [socket, refreshProfile]);

  const showNav =
    ['/home', '/meet', '/chat', '/spotlight'].includes(location.pathname) ||
    isOwnProfilePath(location.pathname, pet) ||
    location.pathname.startsWith('/community');

  // Shown once per qualifying (first-100-signup) user, tracked by
  // welcome_slider_seen on the backend -- mounted here so it appears
  // regardless of which page they land on first after signup/login.
  const showWelcomeSlider = !!user?.is_founding_member && !user?.welcome_slider_seen;

  return (
    <div className="app-shell">
      {showNav && <SidebarNav />}

      <div className="app-main relative">

        {/* Email Verification Banner */}
        <EmailVerifyBanner />

        <div className="page-enter">
          {children}
        </div>

      </div>

      {showNav && <BottomNav />}

      {showWelcomeSlider && <WelcomeSlider />}
    </div>
  );
}

export default function App() {
  const { isAuthenticated, loading: authLoading, pet } = useAuth();
  // Called unconditionally, before the authLoading early return below --
  // hooks can't be conditional, and this needs to be live even while the
  // splash is showing (a back-press during that brief window should still
  // behave sanely, not silently do nothing).
  useAndroidBackButton();

  // The splash shows only while the session is being resolved -- no fixed
  // minimum wait (it used to be 2.5s, then 500ms, on every load).
  if (authLoading) return <LoadingPage />;

  return (
    <CallProvider>
      <PageMeta />
      <CursorGlow />
      <SniffedOutToast />
      <NoPetPrompt />
      <AppToast />
      <ConfirmDialogHost />
      <AccountDeletedNotice />
      <BackgroundBlobs />

      <Suspense fallback={<LoadingPage />}>
        <Routes>

          {/* Public Routes */}
          {/* N8: this used to always redirect an authenticated visit to
              "/" straight to /home, regardless of whether they have a pet
              yet. `isAuthenticated` (AuthContext: !!user) flips true the
              instant login/signup succeeds, one render BEFORE AuthPage's
              own post-login applySession() gets to navigate anywhere --
              so for a pet-less new signup, HomePage used to mount for one
              frame, then applySession's navigate('/pet-selection') landed
              a moment later, adding an extra Back-button history entry.
              Matching applySession's own destination here means both
              agree on the same first page, so there's nothing to correct
              a moment later. */}
          <Route
            path="/"
            element={isAuthenticated ? <Navigate to={pet ? '/home' : '/pet-selection'} replace /> : <AuthPage />}
          />

          <Route path="/privacy" element={<PrivacyPage />} />
          <Route path="/terms" element={<TermsPage />} />
          <Route path="/faq" element={<FAQPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route path="/verify-email" element={<VerifyEmailPage />} />

          {/* Protected Onboarding */}
          <Route
            path="/pet-selection"
            element={
              <ProtectedRoute>
                <PetSelectionPage />
              </ProtectedRoute>
            }
          />

          <Route
            path="/create-profile"
            element={
              <ProtectedRoute>
                <CreateProfilePage />
              </ProtectedRoute>
            }
          />

          {/* Main App */}
          <Route
            path="/home"
            element={
              <ProtectedRoute>
                <MainLayout>
                  <HomePage />
                </MainLayout>
              </ProtectedRoute>
            }
          />

          <Route
            path="/meet"
            element={
              <ProtectedRoute>
                <MainLayout>
                  <MeetPage />
                </MainLayout>
              </ProtectedRoute>
            }
          />

          <Route
            path="/chat"
            element={
              <ProtectedRoute>
                <MainLayout>
                  <ChatPage />
                </MainLayout>
              </ProtectedRoute>
            }
          />

          <Route
            path="/profile"
            element={
              <ProtectedRoute>
                <MainLayout>
                  <ProfilePage />
                </MainLayout>
              </ProtectedRoute>
            }
          />

          <Route
            path="/profile/:id"
            element={
              <ProtectedRoute>
                <MainLayout>
                  <ProfilePage />
                </MainLayout>
              </ProtectedRoute>
            }
          />

          <Route
            path="/spotlight"
            element={
              <ProtectedRoute>
                <MainLayout>
                  <SpotlightPage />
                </MainLayout>
              </ProtectedRoute>
            }
          />

          <Route
            path="/community/create"
            element={
              <ProtectedRoute>
                <MainLayout>
                  <CreateCommunityPage />
                </MainLayout>
              </ProtectedRoute>
            }
          />

          <Route
            path="/community/:id"
            element={
              <ProtectedRoute>
                <MainLayout>
                  <CommunityPage />
                </MainLayout>
              </ProtectedRoute>
            }
          />

          {/* Admin: reachable by URL for any logged-in user client-side --
              real access control is the backend's requireAdmin on every
              /admin/* call (see report: is_admin isn't available in the
              frontend user object to gate this further here). */}
          <Route
            path="/admin/payments"
            element={
              <ProtectedRoute>
                <MainLayout>
                  <AdminPaymentsPage />
                </MainLayout>
              </ProtectedRoute>
            }
          />

          {/* N1: shared-post links (copy-link in GalleryViewerModal,
              NotificationPostViewerModal, SharedPostViewerModal) point here.
              Must come before the top-level :id catch-all below, same as
              /community/:id above it. */}
          <Route
            path="/post/:id"
            element={
              <ProtectedRoute>
                <PostPage />
              </ProtectedRoute>
            }
          />

          {/* Top-level pet-profile URL (app.sniffrweb.com/kitty), matching
              Instagram/TikTok-style profile links -- must stay the LAST
              route before the 404 fallback. React Router v6 ranks static
              paths above dynamic ones regardless of declaration order, so
              this can never shadow /home, /chat, etc.; the reserved-word
              check at pet-username creation time (see
              server/utils/petUsername.js) is what actually prevents a pet
              from ever being named after one of those pages in the first
              place. :id reuses ProfilePage's existing param name -- see
              ProfilePage.jsx's loadProfile(), which already passes
              whatever this value is straight to GET /api/profile/:id,
              and that route already resolves either a numeric id or a
              username. */}
          <Route
            path="/:id"
            element={
              <ProtectedRoute>
                <MainLayout>
                  <ProfilePage />
                </MainLayout>
              </ProtectedRoute>
            }
          />

          <Route path="*" element={<NotFoundPage />} />

        </Routes>
      </Suspense>
    </CallProvider>
  );
}