import { useLocation, useNavigate } from 'react-router-dom';
import { Capacitor } from '@capacitor/core';
import { useAuth } from '../context/AuthContext';
import { avatarUrl } from '../utils/media';
import { isOwnProfilePath } from '../utils/profileRoutes';

const tabs = [
  { path: '/home',      label: 'Home',      icon: 'home',         tip: 'Home Feed' },
  { path: '/meet',      label: 'Meet',      icon: 'pets',         tip: 'Find Playmates' },
  { path: '/spotlight', label: 'Spotlight', icon: 'star',         tip: 'Top Rankings' },
  { path: '/chat',      label: 'Chat',      icon: 'chat_bubble',  tip: 'Messages & Calls' },
  { path: '/profile',   label: 'Me',        icon: 'person',       tip: 'My Profile' },
];

/* ─── Desktop / Tablet Sidebar ───────────────────────────────── */
export function SidebarNav() {
  const location  = useLocation();
  const navigate  = useNavigate();
  const replaceTabNavigation = Capacitor.getPlatform() === 'android';
  const { user, pet, logout } = useAuth();
  const isMeSelected = isOwnProfilePath(location.pathname, pet);

  return (
    <aside className="app-sidebar glass border-r border-outline-variant/20 px-3 py-6 flex flex-col gap-2 animate-sidebar-in z-40">
      {/* Brand */}
      <div className="flex items-center gap-3 px-3 mb-8 select-none">
        <div className="w-10 h-10 rounded-full bg-gradient-to-br from-primary to-primary-fixed-dim flex items-center justify-center shadow-lg animate-pulse-glow flex-shrink-0">
          <span className="material-symbols-outlined text-white text-xl" style={{ fontVariationSettings: "'FILL' 1" }}>pets</span>
        </div>
        {/* Text only on wide sidebar */}
        <span className="hidden lg:block font-extrabold tracking-tighter text-xl text-on-surface gradient-text-warm">Sniffr</span>
      </div>

      {/* Nav items */}
      <nav className="flex-1 flex flex-col gap-1">
        {tabs.map((tab, i) => {
          const isActive = tab.path === '/profile'
            ? isMeSelected
            : location.pathname.startsWith(tab.path);
          return (
            <button
              key={tab.path}
              onClick={() => {
                if (isActive && tab.path === '/home') {
                  window.scrollTo({ top: 0, behavior: 'smooth' });
                  return;
                }
                navigate(tab.path, { replace: replaceTabNavigation });
              }}
              data-tip={tab.tip}
              className={`tooltip group flex items-center gap-3 px-3 py-3.5 rounded-2xl font-bold transition-all duration-200 ripple-container
                animate-slide-in-left delay-${(i + 1) * 100}
                ${isActive
                  ? 'nav-active-pill bg-gradient-to-r from-primary-container to-secondary-container/50 text-primary shadow-sm'
                  : 'text-on-surface-variant hover:bg-surface-container-high hover:text-primary'
                }`}
            >
              <span
                className={`material-symbols-outlined transition-all duration-200 flex-shrink-0 ${isActive ? 'text-primary' : 'group-hover:scale-110'}`}
                style={{ fontVariationSettings: isActive ? "'FILL' 1" : "'FILL' 0" }}
              >
                {tab.icon}
              </span>
              <span className="hidden lg:block text-sm tracking-wide">{tab.label}</span>
              {isActive && (
                <span className="hidden lg:block ml-auto w-2 h-2 rounded-full bg-primary animate-pulse" />
              )}
            </button>
          );
        })}
      </nav>

      {/* User / Logout at bottom */}
      <div className="pt-4 border-t border-outline-variant/20 flex flex-col gap-2">
        {user && (
          <div className="flex items-center gap-3 px-3 py-2">
            <div className="w-8 h-8 rounded-full bg-primary-container flex items-center justify-center flex-shrink-0 overflow-hidden border border-primary/20">
              {pet?.avatar_url ? (
                <img src={avatarUrl(pet.avatar_url)} alt={pet.name} loading="lazy" decoding="async" className="w-full h-full object-cover" />
              ) : (
                <span className="text-primary font-bold text-xs">{user.username?.[0]?.toUpperCase()}</span>
              )}
            </div>
            <div className="hidden lg:block overflow-hidden">
              <p className="text-xs font-bold text-on-surface truncate">{pet?.name || `@${user.username}`}</p>
              <p className="text-[10px] text-on-surface-variant truncate">{pet?.pet_username || user.email}</p>
            </div>
          </div>
        )}
        <button
          onClick={logout}
          data-tip="Sign Out"
          className="tooltip group flex items-center gap-3 px-3 py-3 rounded-2xl text-on-surface-variant hover:bg-error-container hover:text-on-error-container transition-all duration-200"
        >
          <span className="material-symbols-outlined flex-shrink-0 group-hover:rotate-12 transition-transform">logout</span>
          <span className="hidden lg:block text-sm font-bold">Sign Out</span>
        </button>
      </div>
    </aside>
  );
}

/* ─── Mobile Bottom Nav ───────────────────────────────────────── */
export default function BottomNav() {
  const location = useLocation();
  const navigate = useNavigate();
  const { pet } = useAuth();
  const replaceTabNavigation = Capacitor.getPlatform() === 'android';
  const isMeSelected = isOwnProfilePath(location.pathname, pet);

  return (
    <nav className="mobile-bottom-nav fixed bottom-0 left-0 w-full z-50 flex justify-around items-center px-2 pt-2.5 bg-white/90 dark:bg-zinc-950/90 backdrop-blur-xl shadow-[0_-10px_40px_-15px_rgba(168,216,234,0.3)] rounded-t-[2.2rem]">
      {tabs.map((tab) => {
        const isActive = tab.path === '/profile'
          ? isMeSelected
          : location.pathname.startsWith(tab.path);
        return (
          <button
            key={tab.path}
            onClick={() => {
              // Tapping the already-active Home tab scrolls back to the
              // top of the feed instead of a no-op navigate to the same
              // route -- same "tap the tab again" convention Instagram/
              // Twitter use for their home tab.
              if (isActive && tab.path === '/home') {
                window.scrollTo({ top: 0, behavior: 'smooth' });
                return;
              }
              navigate(tab.path, { replace: replaceTabNavigation });
            }}
            className={`flex flex-col items-center justify-center transition-all duration-300 active:scale-90 ripple-container ${
              isActive
                ? 'bg-gradient-to-br from-pink-100 to-sky-100 dark:from-pink-900/40 dark:to-sky-900/40 text-pink-500 dark:text-pink-200 rounded-full px-2.5 py-1.5'
                : 'text-zinc-400 dark:text-zinc-500 p-1.5 hover:text-pink-400 dark:hover:text-pink-300'
            }`}
          >
            <span
              className="material-symbols-outlined text-xl"
              style={{ fontVariationSettings: isActive ? "'FILL' 1" : "'FILL' 0" }}
            >
              {tab.icon}
            </span>
            <span className="font-['Plus_Jakarta_Sans'] text-[9px] font-extrabold uppercase tracking-wider mt-0.5">
              {tab.label}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
