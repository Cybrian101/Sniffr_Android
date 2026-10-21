import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import SettingsModals from './settings/SettingsModals';
import BlockedAccountsModal from './settings/BlockedAccountsModal';
import Portal from './Portal';

export default function SettingsPanel({ isOpen, onClose, onOpenSwitchPet, initialModal }) {
  const { user, pet, allPets, logout } = useAuth();
  const navigate = useNavigate();

  const primaryPet = allPets && allPets.length > 0 ? allPets[0] : pet;
  const isPrimaryPet = !pet || !primaryPet || pet.id === primaryPet.id;

  const [expandedSection, setExpandedSection] = useState(null); // 'premium' | 'help' | null
  const [activeModal, setActiveModal] = useState(null);
  const [toastMessage, setToastMessage] = useState(null);
  const [showConfirmSignout, setShowConfirmSignout] = useState(false);

  // Touch tracking for swipe-to-close
  const touchStartX = useRef(0);
  const touchEndX = useRef(0);

  useEffect(() => {
    if (isOpen && initialModal) {
      if (!isPrimaryPet) {
        setToastMessage(`PawPrint Verification can only be managed from your primary pet profile (${primaryPet?.name || 'Primary'}).`);
        setTimeout(() => setToastMessage(null), 4000);
      } else {
        setActiveModal(initialModal);
      }
    }
  }, [isOpen, initialModal, isPrimaryPet]);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape' && isOpen) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const toggleSection = (section) => {
    setExpandedSection(prev => prev === section ? null : section);
  };

  const showManagePetPlaceholder = () => {
    setToastMessage('Coming Soon\nManaging pet profiles will be available in a future update!');
    setTimeout(() => setToastMessage(null), 3500);
  };

  const handleShareSniffr = async () => {
    const shareData = {
      title: 'Sniffr 🐾',
      text: 'Find playmates, share adorable pet moments, and explore local pet rankings on Sniffr!',
      url: 'https://sniffrweb.com',
    };
    if (navigator.share) {
      try {
        await navigator.share(shareData);
      } catch (err) {
        // User cancelled share
      }
    } else {
      navigator.clipboard.writeText('https://sniffrweb.com');
      setToastMessage('Sniffr share link copied to clipboard!');
      setTimeout(() => setToastMessage(null), 3000);
    }
  };

  const handleTouchStart = (e) => {
    touchStartX.current = e.touches[0].clientX;
  };

  const handleTouchMove = (e) => {
    touchEndX.current = e.touches[0].clientX;
  };

  const handleTouchEnd = () => {
    if (touchEndX.current && touchEndX.current - touchStartX.current > 70) {
      onClose(); // Swiped right
    }
    touchStartX.current = 0;
    touchEndX.current = 0;
  };

  return (
    <Portal trapFocus>
    <div className="fixed inset-0 z-[200] select-none">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/40 backdrop-blur-md transition-opacity duration-300 animate-fade-in"
        onClick={onClose}
      />

      {/* Slide-out Panel */}
      <div
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        className="safe-area-top-panel fixed top-0 right-0 h-full w-[85vw] sm:w-[65%] lg:w-[45%] max-w-md bg-white dark:bg-zinc-900 border-l border-outline-variant/10 shadow-2xl z-[210] flex flex-col animate-slide-in-right overflow-hidden"
      >
        {/* Header */}
        <div className="p-6 border-b border-zinc-100 dark:border-zinc-800 flex items-center justify-between bg-zinc-50/50 dark:bg-zinc-800/30">
          <div className="flex items-center gap-2.5">
            <div className="w-10 h-10 rounded-full bg-primary/10 text-primary flex items-center justify-center font-bold text-lg">
              <span className="material-symbols-outlined">settings</span>
            </div>
            <div>
              <h2 className="text-lg font-extrabold text-on-surface leading-tight">Settings</h2>
              <p className="text-[11px] text-zinc-400 font-medium">Account & App Preferences</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-9 h-9 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500 hover:text-on-surface flex items-center justify-center transition-transform active:scale-90"
            aria-label="Close Settings"
          >
            <span className="material-symbols-outlined text-lg">close</span>
          </button>
        </div>


        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto p-6 pb-32 space-y-6 no-scrollbar">

          {/* 🐾 Account Section */}
          <section className="space-y-2">
            <h3 className="text-xs font-extrabold uppercase tracking-wider text-zinc-400 flex items-center gap-1.5 px-1">
              <span className="material-symbols-outlined text-sm">person</span> Account
            </h3>
            <div className="space-y-1 bg-zinc-50 dark:bg-zinc-800/40 p-1.5 rounded-2xl border border-zinc-100 dark:border-zinc-800">
              <button
                onClick={() => setActiveModal('change-password')}
                className="w-full flex items-center justify-between p-3 rounded-xl hover:bg-white dark:hover:bg-zinc-800 transition-colors text-left"
              >
                <div className="flex items-center gap-3">
                  <span className="material-symbols-outlined text-primary text-sm">lock_reset</span>
                  <span className="text-xs font-bold text-on-surface">Change Password</span>
                </div>
                <span className="material-symbols-outlined text-zinc-400 text-sm">chevron_right</span>
              </button>

              <div
                onClick={() => {
                  if (!isPrimaryPet) {
                    setToastMessage(`PawPrint Verification can only be managed from your primary pet profile (${primaryPet?.name || 'Primary'}).`);
                    setTimeout(() => setToastMessage(null), 3500);
                    return;
                  }
                  if (user?.pawprint_2fa_enabled) {
                    setActiveModal('disable-pawprint-2fa');
                  } else {
                    setActiveModal('pawprint-2fa');
                  }
                }}
                className={`w-full flex items-center justify-between p-3 rounded-xl transition-colors text-left ${
                  isPrimaryPet ? 'hover:bg-white dark:hover:bg-zinc-800 cursor-pointer' : 'opacity-70 cursor-pointer hover:bg-white/50 dark:hover:bg-zinc-800/50'
                }`}
              >
                <div className="flex items-center gap-3">
                  <span className="material-symbols-outlined text-primary text-sm">security</span>
                  <div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-bold text-on-surface block">PawPrint Verification</span>
                      {!isPrimaryPet && (
                        <span className="text-[9px] font-extrabold bg-zinc-200 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-300 px-1.5 py-0.5 rounded-md flex items-center gap-0.5">
                          <span className="material-symbols-outlined text-[10px]">lock</span> Primary Only
                        </span>
                      )}
                    </div>
                    <span className={`text-[10px] font-bold ${user?.pawprint_2fa_enabled ? 'text-emerald-500' : 'text-zinc-400'}`}>
                      {user?.pawprint_2fa_enabled ? 'Enabled' : 'Disabled'}
                    </span>
                  </div>
                </div>
                {isPrimaryPet ? (
                  <label className="relative inline-flex items-center cursor-pointer select-none" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={!!user?.pawprint_2fa_enabled}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setActiveModal('pawprint-2fa');
                        } else {
                          setActiveModal('disable-pawprint-2fa');
                        }
                      }}
                      className="sr-only peer"
                    />
                    <div className="w-9 h-5 bg-zinc-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-zinc-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-primary" />
                  </label>
                ) : (
                  <span className="material-symbols-outlined text-zinc-400 text-sm">lock</span>
                )}
              </div>

              <button
                onClick={() => setActiveModal('location-permissions')}
                className="w-full flex items-center justify-between p-3 rounded-xl hover:bg-white dark:hover:bg-zinc-800 transition-colors text-left cursor-pointer"
              >
                <div className="flex items-center gap-3">
                  <span className="material-symbols-outlined text-primary text-sm">location_on</span>
                  <div>
                    <span className="text-xs font-bold text-on-surface block">Location Permissions</span>
                    <span className="text-[10px] font-bold text-zinc-400">Manage GPS & Location Access</span>
                  </div>
                </div>
                <span className="material-symbols-outlined text-zinc-400 text-sm">chevron_right</span>
              </button>

              <button
                onClick={showManagePetPlaceholder}
                className="w-full flex items-center justify-between p-3 rounded-xl hover:bg-white dark:hover:bg-zinc-800 transition-colors text-left"
              >
                <div className="flex items-center gap-3">
                  <span className="material-symbols-outlined text-primary text-sm">pets</span>
                  <span className="text-xs font-bold text-on-surface">Manage Pet Profiles</span>
                </div>
                <span className="material-symbols-outlined text-zinc-400 text-sm">chevron_right</span>
              </button>
            </div>
          </section>

          {/* 💎 Sniffr Premium (Expandable Accordion) */}
          <section className="space-y-2">
            <button
              onClick={() => toggleSection('premium')}
              className="w-full flex items-center justify-between px-1 py-1"
            >
              <h3 className="text-xs font-extrabold uppercase tracking-wider text-amber-600 dark:text-amber-400 flex items-center gap-1.5">
                <span className="material-symbols-outlined text-sm">diamond</span> Sniffr Premium
              </h3>
              <span className={`material-symbols-outlined text-amber-500 text-sm transition-transform duration-200 ${expandedSection === 'premium' ? 'rotate-180' : ''}`}>
                expand_more
              </span>
            </button>


            {expandedSection === 'premium' && (
              <div className="space-y-1 bg-amber-50/50 dark:bg-amber-950/20 p-2 rounded-2xl border border-amber-200/50 dark:border-amber-900/30 animate-fade-in">
                <button
                  onClick={() => setActiveModal('upgrade-premium')}
                  className="w-full flex items-center justify-between p-3 rounded-xl hover:bg-white dark:hover:bg-zinc-800 transition-colors text-left"
                >
                  <div className="flex items-center gap-2.5">
                    <span className="material-symbols-outlined text-amber-500 text-sm">auto_awesome</span>
                    <span className="text-xs font-bold text-amber-800 dark:text-amber-200">Upgrade to Premium</span>
                  </div>
                  <span className="material-symbols-outlined text-amber-400 text-sm">chevron_right</span>
                </button>

                <button
                  onClick={() => setActiveModal('manage-subscription')}
                  className="w-full flex items-center justify-between p-3 rounded-xl hover:bg-white dark:hover:bg-zinc-800 transition-colors text-left"
                >
                  <div className="flex items-center gap-2.5">
                    <span className="material-symbols-outlined text-amber-500 text-sm">auto_awesome</span>
                    <span className="text-xs font-bold text-amber-800 dark:text-amber-200">Manage Subscription</span>
                  </div>
                  <span className="material-symbols-outlined text-amber-400 text-sm">chevron_right</span>
                </button>

                <button
                  onClick={() => setActiveModal('billing-history')}
                  className="w-full flex items-center justify-between p-3 rounded-xl hover:bg-white dark:hover:bg-zinc-800 transition-colors text-left"
                >
                  <div className="flex items-center gap-2.5">
                    <span className="material-symbols-outlined text-amber-500 text-sm">auto_awesome</span>
                    <span className="text-xs font-bold text-amber-800 dark:text-amber-200">Billing History</span>
                  </div>
                  <span className="material-symbols-outlined text-amber-400 text-sm">chevron_right</span>
                </button>

                <button
                  onClick={() => setActiveModal('premium-benefits')}
                  className="w-full flex items-center justify-between p-3 rounded-xl hover:bg-white dark:hover:bg-zinc-800 transition-colors text-left"
                >
                  <div className="flex items-center gap-2.5">
                    <span className="material-symbols-outlined text-amber-500 text-sm">auto_awesome</span>
                    <span className="text-xs font-bold text-amber-800 dark:text-amber-200">Premium Benefits</span>
                  </div>
                  <span className="material-symbols-outlined text-amber-400 text-sm">chevron_right</span>
                </button>
              </div>
            )}
          </section>

          {/* ❓ Help & Support (Expandable Accordion) */}
          <section className="space-y-2">
            <button
              onClick={() => toggleSection('help')}
              className="w-full flex items-center justify-between px-1 py-1"
            >
              <h3 className="text-xs font-extrabold uppercase tracking-wider text-zinc-400 flex items-center gap-1.5">
                <span className="material-symbols-outlined text-sm">help</span> Help & Support
              </h3>
              <span className={`material-symbols-outlined text-zinc-400 text-sm transition-transform duration-200 ${expandedSection === 'help' ? 'rotate-180' : ''}`}>
                expand_more
              </span>
            </button>

            {expandedSection === 'help' && (
              <div className="space-y-3 bg-zinc-50 dark:bg-zinc-800/40 p-2.5 rounded-2xl border border-zinc-100 dark:border-zinc-800 animate-fade-in">
                <div className="space-y-1">
                  <button
                    onClick={() => setActiveModal('faq')}
                    className="w-full flex items-center justify-between p-2.5 rounded-xl hover:bg-white dark:hover:bg-zinc-800 transition-colors text-left"
                  >
                    <span className="text-xs font-bold text-on-surface">Frequently Asked Questions</span>
                    <span className="material-symbols-outlined text-zinc-400 text-sm">chevron_right</span>
                  </button>

                  <button
                    onClick={() => setActiveModal('contact-support')}
                    className="w-full flex items-center justify-between p-2.5 rounded-xl hover:bg-white dark:hover:bg-zinc-800 transition-colors text-left"
                  >
                    <span className="text-xs font-bold text-on-surface">Contact Support</span>
                    <span className="material-symbols-outlined text-zinc-400 text-sm">chevron_right</span>
                  </button>

                  <button
                    onClick={() => setActiveModal('user-guide')}
                    className="w-full flex items-center justify-between p-2.5 rounded-xl hover:bg-white dark:hover:bg-zinc-800 transition-colors text-left"
                  >
                    <span className="text-xs font-bold text-on-surface">User Guide</span>
                    <span className="material-symbols-outlined text-zinc-400 text-sm">chevron_right</span>
                  </button>

                  <button
                    onClick={() => setActiveModal('community-guidelines')}
                    className="w-full flex items-center justify-between p-2.5 rounded-xl hover:bg-white dark:hover:bg-zinc-800 transition-colors text-left"
                  >
                    <span className="text-xs font-bold text-on-surface">Community Guidelines</span>
                    <span className="material-symbols-outlined text-zinc-400 text-sm">chevron_right</span>
                  </button>
                </div>

                <button
                  onClick={() => setActiveModal('contact-support')}
                  className="w-full py-3 bg-primary/10 hover:bg-primary/20 text-primary font-extrabold text-xs rounded-xl transition-all flex items-center justify-center gap-2 active:scale-95 shadow-2xs"
                >
                  <span className="material-symbols-outlined text-sm">support_agent</span> Need More Help? Contact
                </button>
              </div>
            )}
          </section>

          {/* 💡 Feedback */}
          <section className="space-y-2">
            <h3 className="text-xs font-extrabold uppercase tracking-wider text-zinc-400 flex items-center gap-1.5 px-1">
              <span className="material-symbols-outlined text-sm">lightbulb</span> Feedback
            </h3>
            <div className="space-y-1 bg-zinc-50 dark:bg-zinc-800/40 p-1.5 rounded-2xl border border-zinc-100 dark:border-zinc-800">
              <button
                onClick={() => setActiveModal('report-bug')}
                className="w-full flex items-center justify-between p-3 rounded-xl hover:bg-white dark:hover:bg-zinc-800 transition-colors text-left"
              >
                <span className="text-xs font-bold text-on-surface">Report a Bug</span>
                <span className="material-symbols-outlined text-zinc-400 text-sm">chevron_right</span>
              </button>

              <button
                onClick={() => setActiveModal('suggest-feature')}
                className="w-full flex items-center justify-between p-3 rounded-xl hover:bg-white dark:hover:bg-zinc-800 transition-colors text-left"
              >
                <span className="text-xs font-bold text-on-surface">Suggest a Feature</span>
                <span className="material-symbols-outlined text-zinc-400 text-sm">chevron_right</span>
              </button>

              <button
                onClick={() => setActiveModal('rate-sniffr')}
                className="w-full flex items-center justify-between p-3 rounded-xl hover:bg-white dark:hover:bg-zinc-800 transition-colors text-left"
              >
                <span className="text-xs font-bold text-on-surface">Rate Sniffr</span>
                <span className="material-symbols-outlined text-zinc-400 text-sm">chevron_right</span>
              </button>

              <button
                onClick={handleShareSniffr}
                className="w-full flex items-center justify-between p-3 rounded-xl hover:bg-white dark:hover:bg-zinc-800 transition-colors text-left"
              >
                <span className="text-xs font-bold text-on-surface">Share Sniffr</span>
                <span className="material-symbols-outlined text-zinc-400 text-sm">share</span>
              </button>
            </div>
          </section>

          {/* 💕 Support Sniffr */}
          <section className="bg-rose-50/60 dark:bg-rose-950/20 p-4 rounded-2xl border border-rose-200/40 dark:border-rose-900/30 space-y-3">
            <div>
              <h3 className="text-xs font-extrabold text-rose-700 dark:text-rose-300 flex items-center gap-1.5">
                <span className="material-symbols-outlined text-sm">volunteer_activism</span> Support Sniffr
              </h3>
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-1 font-medium leading-relaxed">
                Love what we're building? Feed a stray. Fuel Sniffr.
              </p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setActiveModal('feed-strays')}
                className="flex-1 py-2.5 bg-white dark:bg-zinc-800 hover:bg-rose-100/50 text-rose-700 dark:text-rose-300 font-extrabold text-[11px] rounded-xl border border-rose-200/50 shadow-2xs transition-all active:scale-95"
              >
                <span className="material-symbols-outlined text-sm align-middle">restaurant</span> Feed Pack
              </button>
              <button
                onClick={() => setActiveModal('donate-creators')}
                className="flex-1 py-2.5 bg-rose-500 hover:bg-rose-600 text-white font-extrabold text-[11px] rounded-xl shadow-xs transition-all active:scale-95"
              >
                <span className="material-symbols-outlined text-sm align-middle">favorite</span> Donate
              </button>
            </div>
          </section>

          {/* 🛡️ Safety Center */}
          <section className="space-y-2">
            <h3 className="text-xs font-extrabold uppercase tracking-wider text-zinc-400 flex items-center gap-1.5 px-1">
              <span className="material-symbols-outlined text-sm">shield</span> Safety Center
            </h3>
            <div className="space-y-1 bg-zinc-50 dark:bg-zinc-800/40 p-1.5 rounded-2xl border border-zinc-100 dark:border-zinc-800">
              <button
                onClick={() => setActiveModal('report-history')}
                className="w-full flex items-center justify-between p-3 rounded-xl hover:bg-white dark:hover:bg-zinc-800 transition-colors text-left"
              >
                <span className="text-xs font-bold text-on-surface">Report History</span>
                <span className="material-symbols-outlined text-zinc-400 text-sm">chevron_right</span>
              </button>


              <button
                onClick={() => setActiveModal('blocked-accounts')}
                className="w-full flex items-center justify-between p-3 rounded-xl hover:bg-white dark:hover:bg-zinc-800 transition-colors text-left"
              >
                <span className="text-xs font-bold text-on-surface">Blocked Accounts</span>
                <span className="material-symbols-outlined text-zinc-400 text-sm">chevron_right</span>
              </button>

              <button
                onClick={() => setActiveModal('safety-tips')}
                className="w-full flex items-center justify-between p-3 rounded-xl hover:bg-white dark:hover:bg-zinc-800 transition-colors text-left"
              >
                <span className="text-xs font-bold text-on-surface">Safety Tips</span>
                <span className="material-symbols-outlined text-zinc-400 text-sm">chevron_right</span>
              </button>
            </div>
          </section>

          {/* 🌍 Preferences */}
          <section className="space-y-2">
            <h3 className="text-xs font-extrabold uppercase tracking-wider text-zinc-400 flex items-center gap-1.5 px-1">
              <span className="material-symbols-outlined text-sm">tune</span> Preferences
            </h3>
            <div className="space-y-1 bg-zinc-50 dark:bg-zinc-800/40 p-1.5 rounded-2xl border border-zinc-100 dark:border-zinc-800">
              <div className="flex items-center justify-between p-3">
                <span className="text-xs font-bold text-on-surface">App Version</span>
                <span className="text-[10px] font-extrabold text-primary bg-primary/10 px-2 py-0.5 rounded-full">v1.0.0 (#2026.07.22)</span>
              </div>

              <button
                onClick={() => setActiveModal('whats-new')}
                className="w-full flex items-center justify-between p-3 rounded-xl hover:bg-white dark:hover:bg-zinc-800 transition-colors text-left"
              >
                <span className="text-xs font-bold text-on-surface">What's New</span>
                <span className="material-symbols-outlined text-zinc-400 text-sm">chevron_right</span>
              </button>
            </div>
          </section>

          {/* 📄 Legal */}
          <section className="space-y-2">
            <h3 className="text-xs font-extrabold uppercase tracking-wider text-zinc-400 flex items-center gap-1.5 px-1">
              <span className="material-symbols-outlined text-sm">description</span> Legal
            </h3>
            <div className="space-y-1 bg-zinc-50 dark:bg-zinc-800/40 p-1.5 rounded-2xl border border-zinc-100 dark:border-zinc-800">
              <button
                onClick={() => {
                  onClose();
                  navigate('/privacy');
                }}
                className="w-full flex items-center justify-between p-3 rounded-xl hover:bg-white dark:hover:bg-zinc-800 transition-colors text-left"
              >
                <span className="text-xs font-bold text-on-surface">Privacy Policy</span>
                <span className="material-symbols-outlined text-zinc-400 text-sm">chevron_right</span>
              </button>
              <button
                onClick={() => {
                  onClose();
                  navigate('/terms');
                }}
                className="w-full flex items-center justify-between p-3 rounded-xl hover:bg-white dark:hover:bg-zinc-800 transition-colors text-left"
              >
                <span className="text-xs font-bold text-on-surface">Terms & Conditions</span>
                <span className="material-symbols-outlined text-zinc-400 text-sm">chevron_right</span>
              </button>
            </div>
          </section>

          {/* ⚠️ Danger Zone */}
          <section className="space-y-2">
            <h3 className="text-xs font-extrabold uppercase tracking-wider text-rose-500 flex items-center gap-1.5 px-1">
              <span className="material-symbols-outlined text-sm">warning</span> Danger Zone
            </h3>
            <div className="space-y-1 bg-rose-50/60 dark:bg-rose-950/20 p-1.5 rounded-2xl border border-rose-200/40 dark:border-rose-900/30">
              <button
                onClick={() => setActiveModal('delete-account')}
                className="w-full flex items-center justify-between p-3 rounded-xl hover:bg-white dark:hover:bg-zinc-800 transition-colors text-left"
              >
                <div className="flex items-center gap-3">
                  <span className="material-symbols-outlined text-rose-500 text-sm">delete_forever</span>
                  <span className="text-xs font-bold text-rose-600 dark:text-rose-300">Delete Account</span>
                </div>
                <span className="material-symbols-outlined text-rose-300 text-sm">chevron_right</span>
              </button>
            </div>
          </section>

          {/* 🛠️ Admin */}
          {user?.is_admin === true && (
            <section className="space-y-2">
              <h3 className="text-xs font-extrabold uppercase tracking-wider text-zinc-400 flex items-center gap-1.5 px-1">
                <span className="material-symbols-outlined text-sm">admin_panel_settings</span> Admin
              </h3>
              <div className="space-y-1 bg-zinc-50 dark:bg-zinc-800/40 p-1.5 rounded-2xl border border-zinc-100 dark:border-zinc-800">
                <button
                  onClick={() => {
                    onClose();
                    navigate('/admin/payments');
                  }}
                  className="w-full flex items-center justify-between p-3 rounded-xl hover:bg-white dark:hover:bg-zinc-800 transition-colors text-left"
                >
                  <span className="text-xs font-bold text-on-surface">Payment Reviews</span>
                  <span className="material-symbols-outlined text-zinc-400 text-sm">chevron_right</span>
                </button>
              </div>
            </section>
          )}

          {/* 🚪 Log Out */}
          <section className="pt-4 border-t border-zinc-100 dark:border-zinc-800">
            <button
              type="button"
              onClick={() => setShowConfirmSignout(true)}
              className="w-full py-3.5 px-4 bg-rose-100/70 hover:bg-rose-200/80 text-rose-700 dark:bg-rose-950/40 dark:hover:bg-rose-900/50 dark:text-rose-300 font-extrabold text-xs rounded-2xl transition-all flex items-center justify-center gap-2 active:scale-95 shadow-2xs cursor-pointer"
            >
              <span className="material-symbols-outlined text-sm">logout</span>
              Log Out
            </button>
          </section>

        </div>
      </div>

      {/* Render Active Modal */}
      <SettingsModals
        activeModal={activeModal === 'blocked-accounts' ? null : activeModal}
        onClose={() => setActiveModal(null)}
        onOpenModal={(modalKey) => setActiveModal(modalKey)}
      />
      {activeModal === 'blocked-accounts' && <BlockedAccountsModal onClose={() => setActiveModal(null)} />}

      {/* Log Out Confirmation Dialog */}
      {showConfirmSignout && (
        <div className="fixed inset-0 z-[350] flex items-center justify-center p-4 select-none">
          <div className="fixed inset-0 bg-black/50 backdrop-blur-sm animate-fade-in" onClick={() => setShowConfirmSignout(false)} />
          <div className="relative w-full max-w-sm bg-white dark:bg-zinc-900 rounded-3xl p-6 shadow-2xl z-[360] text-center space-y-4 animate-scale-up border border-outline-variant/10">
            <div className="w-14 h-14 rounded-full bg-rose-100 text-rose-600 dark:bg-rose-950 dark:text-rose-300 flex items-center justify-center text-2xl mx-auto shadow-inner">
              <span className="material-symbols-outlined text-2xl">logout</span>
            </div>
            <div className="space-y-1">
              <h3 className="text-lg font-extrabold text-on-surface">Log out of Sniffr?</h3>
              <p className="text-xs text-zinc-500 font-medium leading-relaxed">
                Are you sure you want to log out of your Sniffr account? You can log back in at any time.
              </p>
            </div>
            <div className="flex gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowConfirmSignout(false)}
                className="flex-1 py-3 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 font-extrabold text-xs rounded-xl hover:bg-zinc-200 transition-colors uppercase tracking-wider cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowConfirmSignout(false);
                  onClose();
                  logout();
                }}
                className="flex-1 py-3 bg-rose-600 hover:bg-rose-700 text-white font-extrabold text-xs rounded-xl shadow-md active:scale-95 uppercase tracking-wider cursor-pointer transition-all"
              >
                Log Out
              </button>
            </div>
          </div>
        </div>
      )}

      {/* In-app Toast */}
      {toastMessage && (
        <div className="fixed top-12 left-1/2 -translate-x-1/2 z-[300] bg-zinc-900/90 text-white dark:bg-white/90 dark:text-zinc-900 px-5 py-3 rounded-2xl text-xs font-extrabold shadow-2xl animate-bounce text-center max-w-xs whitespace-pre-line pointer-events-none">
          {toastMessage}
        </div>
      )}
    </div>
    </Portal>
  );
}
