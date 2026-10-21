import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import api from '../services/api';
import { useSocket } from '../context/SocketContext';
import NotificationPostViewerModal from './NotificationPostViewerModal';
import PremiumBadge from './PremiumBadge';
import SniffedOutName, { SniffedOutAvatar } from './SniffedOutName';
import { SNIFFED_OUT_NAME, SNIFFED_OUT_MESSAGE, isSniffedOutError } from '../utils/sniffedOut';

import { publicAsset } from '../utils/publicPath';
import { notifyActionError } from '../utils/appToast';
const categories = [
  { id: 'all', label: 'All', icon: 'auto_awesome' },
  { id: 'matches', label: 'Matches', icon: 'favorite' },
  { id: 'activity', label: 'Activity', icon: 'pets' },
  { id: 'pawcircle', label: 'PawCircle', icon: 'groups' },
  { id: 'nearby', label: 'Nearby', icon: 'near_me' },
  { id: 'offers', label: 'Offers', icon: 'local_offer' },
  { id: 'email', label: 'Email', icon: 'mail' },
];

function formatRelativeTime(dateStr) {
  if (!dateStr) return 'Now';
  const now = new Date();
  const date = new Date(dateStr);
  const diffSec = Math.floor((now - date) / 1000);

  if (diffSec < 60) return 'Now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  if (diffSec < 172800) return 'Yesterday';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// Notification types whose tap opens the SENDER's profile (or a chat with
// them) -- nothing to open once the sender deleted their account.
const SENDER_PROFILE_TYPES = ['match_request', 'new_match', 'profile_view'];

// The stored title already says "SniffedOut"; render that word as the
// shared, non-tappable SniffedOutName.
function renderNotifTitle(notif) {
  if (!notif.sender_sniffed_out || !notif.title?.includes(SNIFFED_OUT_NAME)) return notif.title;
  return notif.title.split(SNIFFED_OUT_NAME).flatMap((part, i) => (i === 0 ? [part] : [<SniffedOutName key={i} />, part]));
}

function parseCommunityId(notif) {
  if (!notif) return 1;
  let raw = notif.target_id;
  if (notif.metadata_json) {
    try {
      const meta = typeof notif.metadata_json === 'string' ? JSON.parse(notif.metadata_json) : notif.metadata_json;
      if (meta.community_id) raw = meta.community_id;
      else if (meta.communityId) raw = meta.communityId;
    } catch (e) {}
  }
  if (!raw) return 1;
  const num = parseInt(String(raw).replace(/\D+/g, ''), 10);
  return isNaN(num) || num <= 0 ? 1 : num;
}

// Where a PawCircle notification opens the circle: a join request goes to the
// Requests tab (Owner/Admin), an accepted/declined request just to the circle,
// everything else to its announcements.
function circleNavState(notif, isExpired) {
  if (String(notif.type || '').startsWith('community_join_')) return { openRequests: notif.type === 'community_join_request' };
  if (String(notif.type || '').startsWith('community_ownership_')) return {};
  return { announcementId: notif.target_id, eventId: notif.target_id, openAnnouncements: true, isExpired };
}

export default function NotificationsPanel({ isOpen, onClose, onUnreadCountChange }) {
  const navigate = useNavigate();
  const { socket } = useSocket() || {};

  const [activeCategory, setActiveCategory] = useState('all');
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);

  // Settings / Preferences Overlay
  const [showPreferences, setShowPreferences] = useState(false);
  const [preferences, setPreferences] = useState({
    matches: 1, activity: 1, pawcircle: 1, nearby: 1, offers: 1, email: 1
  });

  const [toastMessage, setToastMessage] = useState(null); // { id, text } -- id is the notif id when applicable, else null
  const [nearbyPromptModal, setNearbyPromptModal] = useState(null); // { notif, communityId, isExpired }
  const [selectedPostViewer, setSelectedPostViewer] = useState(null); // { postId, autoOpenComments }
  const [joinedCommIds, setJoinedCommIds] = useState(new Set());
  const [brokenAvatarIds, setBrokenAvatarIds] = useState(new Set());

  // Touch tracking for swipe-to-close & pull-to-refresh
  const scrollRef = useRef(null);
  const touchStartX = useRef(0);
  const touchEndX = useRef(0);
  const touchStartY = useRef(0);
  const [pullDistance, setPullDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const showToast = useCallback((msg, notifId = null) => {
    setToastMessage({ id: notifId, text: msg });
    setTimeout(() => setToastMessage(prev => (prev && prev.id === notifId && prev.text === msg ? null : prev)), 3000);
  }, []);

  const loadJoinedCommunities = useCallback(async () => {
    try {
      const res = await api.get('/communities');
      if (res && res.communities) {
        const joined = new Set(
          res.communities
            .filter(c => c.joinStatus === 'Joined' || c.joinStatus === 'Owner')
            .map(c => c.id)
        );
        setJoinedCommIds(joined);
      }
    } catch (e) { console.error(e); }
  }, []);

  // Load initial notifications
  const loadNotifications = useCallback(async (cat = activeCategory, pg = 1) => {
    if (pg === 1) setLoading(true);
    else setLoadingMore(true);

    try {
      const res = await api.get(`/notifications?page=${pg}&limit=20&category=${cat}`);
      if (res) {
        if (pg === 1) {
          setNotifications(res.notifications || []);
        } else {
          setNotifications(prev => [...prev, ...(res.notifications || [])]);
        }
        setUnreadCount(res.unreadCount || 0);
        setHasMore(res.hasMore || false);
        setPage(pg);

        if (onUnreadCountChange) {
          onUnreadCountChange(res.unreadCount || 0);
        }
      }
    } catch (err) {
      console.error('Failed to load notifications:', err);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [activeCategory, onUnreadCountChange]);

  // Load preferences
  const loadPreferences = useCallback(async () => {
    try {
      const res = await api.get('/notifications/preferences');
      if (res && res.preferences) {
        setPreferences(res.preferences);
      }
    } catch (err) {
      console.error('Failed to load notification preferences:', err);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      loadNotifications(activeCategory, 1);
      loadPreferences();
      loadJoinedCommunities();
    }
  }, [isOpen, activeCategory, loadNotifications, loadPreferences, loadJoinedCommunities]);

  // Real-time Socket.IO synchronization
  useEffect(() => {
    if (!socket) return;

    const handleNotificationReceived = (data) => {
      if (data && data.notification) {
        const notif = data.notification;
        if (activeCategory === 'all' || activeCategory === notif.category) {
          // M13: a grouped lick/comment notification (server:
          // NotificationRepository._createGroupedActivityNotificationLocked)
          // UPDATES the same row -- same id -- when a second actor joins
          // within the 12h window, and the server only ever emits
          // 'notification_received' for it (no separate 'updated' event).
          // Blindly prepending on every receipt duplicated the card: the
          // list ended up with both the stale single-actor row and the
          // fresh grouped one, same id, two entries. Replace-in-place (by
          // id) instead, which also correctly moves it back to the top.
          setNotifications(prev => [notif, ...prev.filter(n => n.id !== notif.id)]);
        }
        const updatedCount = data.unreadCount !== undefined ? data.unreadCount : unreadCount + 1;
        setUnreadCount(updatedCount);
        if (onUnreadCountChange) onUnreadCountChange(updatedCount);

        showToast(notif.title, notif.id);
      }
    };

    // Sent when someone undoes a Meet like before their 5s window closes --
    // remove the "someone liked you" notification live, no refresh needed.
    const handleNotificationRemoved = (data) => {
      if (!data || data.notificationId === undefined) return;
      setNotifications(prev => prev.filter(n => n.id !== data.notificationId));
      const updatedCount = data.unreadCount !== undefined ? data.unreadCount : Math.max(0, unreadCount - 1);
      setUnreadCount(updatedCount);
      if (onUnreadCountChange) onUnreadCountChange(updatedCount);
      setToastMessage(prev => (prev && prev.id === data.notificationId ? null : prev));
    };

    // Sent when a request notification's action_status changes via a path
    // OTHER than this panel's own Accept/Reject buttons (i.e. resolved from
    // the Meet page's Pending tab) -- patches that one card in place so an
    // already-open panel never shows stale Accept/Reject buttons.
    const handleNotificationUpdated = (data) => {
      if (!data || !data.notification) return;
      setNotifications(prev => prev.map(n => n.id === data.notification.id ? data.notification : n));
    };

    socket.on('notification_received', handleNotificationReceived);
    socket.on('notification_removed', handleNotificationRemoved);
    socket.on('notification_updated', handleNotificationUpdated);
    return () => {
      socket.off('notification_received', handleNotificationReceived);
      socket.off('notification_removed', handleNotificationRemoved);
      socket.off('notification_updated', handleNotificationUpdated);
    };
  }, [socket, activeCategory, unreadCount, onUnreadCountChange, showToast]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape' && isOpen) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // ALL HOOKS ARE ABOVE. Conditional return below:
  if (!isOpen) return null;

  const handleMarkAsRead = async (notifId) => {
    try {
      const res = await api.post(`/notifications/${notifId}/read`);
      if (res && res.success) {
        setNotifications(prev => prev.map(n => n.id === notifId ? { ...n, is_read: 1 } : n));
        setUnreadCount(res.unreadCount || 0);
        if (onUnreadCountChange) onUnreadCountChange(res.unreadCount || 0);
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleMarkAllAsRead = async () => {
    try {
      const res = await api.post('/notifications/read-all');
      if (res && res.success) {
        setNotifications(prev => prev.map(n => ({ ...n, is_read: 1 })));
        setUnreadCount(0);
        if (onUnreadCountChange) onUnreadCountChange(0);
        showToast('All notifications marked as read!');
      }
    } catch (err) {
      notifyActionError(err, "Couldn't mark your notifications as read. Please try again.");
    }
  };

  // PawCircle ownership transfer offered to you: Accept / Decline from here.
  const handleTransferRespond = async (notif, action) => {
    let meta = {};
    try {
      meta = typeof notif.metadata_json === 'string' ? JSON.parse(notif.metadata_json) : (notif.metadata_json || {});
    } catch { /* no metadata */ }
    if (!meta.community_id || !meta.transfer_id) return;
    try {
      await api.post(`/communities/${meta.community_id}/ownership-transfer/${meta.transfer_id}/${action}`);
      setNotifications(prev => prev.map(n => n.id === notif.id ? { ...n, action_status: action === 'accept' ? 'accepted' : 'declined', is_read: 1 } : n));
      showToast(action === 'accept' ? "You're now the owner of this PawCircle!" : 'Ownership transfer declined.', notif.id);
    } catch (err) {
      if (['TRANSFER_NOT_PENDING', 'TRANSFER_EXPIRED', 'TRANSFER_NOT_FOUND', 'NOT_A_MEMBER', 'TRANSFER_STALE'].includes(err?.code)) {
        const status = err?.body?.transferStatus || (err?.code === 'TRANSFER_EXPIRED' ? 'expired' : 'cancelled');
        setNotifications(prev => prev.map(n => n.id === notif.id ? { ...n, action_status: status, is_read: 1 } : n));
      }
      // e.g. OWNER_LIMIT_REACHED: the message says what to do; the offer stays open.
      showToast(err?.message || 'Something went wrong. Please try again.', notif.id);
    }
  };

  const handleMatchRequestRespond = async (notifId, action) => {
    try {
      const res = await api.post(`/notifications/match-request/${notifId}/respond`, { action });
      if (res && res.success) {
        const resolvedStatus = res.notification?.action_status || (action === 'accept' ? 'accepted' : 'declined');
        setNotifications(prev => prev.map(n => n.id === notifId ? { ...n, action_status: resolvedStatus, is_read: 1 } : n));
        setUnreadCount(res.unreadCount || 0);
        if (onUnreadCountChange) onUnreadCountChange(res.unreadCount || 0);

        if (action === 'accept') {
          showToast('Match Accepted! Opening chat...');
          setTimeout(() => {
            onClose();
            navigate('/chat');
          }, 1200);
        } else {
          showToast('Match request declined.');
        }
      }
    } catch (err) {
      if (isSniffedOutError(err) || err?.code === 'EXPIRED') {
        setNotifications(prev => prev.map(n => n.id === notifId ? { ...n, action_status: 'expired', is_read: 1 } : n));
        showToast(isSniffedOutError(err) ? SNIFFED_OUT_MESSAGE : 'This request is no longer available.', notifId);
      } else {
        console.error(err);
      }
    }
  };

  const handleTogglePref = async (key) => {
    const updated = { ...preferences, [key]: preferences[key] ? 0 : 1 };
    setPreferences(updated);
    try {
      await api.post('/notifications/preferences', updated);
    } catch (err) {
      setPreferences(preferences);
      notifyActionError(err, "Couldn't save your notification settings. Please try again.");
    }
  };

  const handleContainerTouchStart = (e) => {
    touchStartX.current = e.touches[0].clientX;
    if (scrollRef.current && scrollRef.current.scrollTop === 0) {
      touchStartY.current = e.touches[0].clientY;
    }
  };

  const handleContainerTouchMove = (e) => {
    touchEndX.current = e.touches[0].clientX;
    if (!refreshing && touchStartY.current > 0 && scrollRef.current && scrollRef.current.scrollTop === 0) {
      const diff = e.touches[0].clientY - touchStartY.current;
      if (diff > 0) {
        const dist = Math.min(70, Math.pow(diff, 0.75) * 1.5);
        setPullDistance(dist);
      }
    }
  };

  const handleContainerTouchEnd = async () => {
    if (touchEndX.current && touchEndX.current - touchStartX.current > 70) {
      onClose();
    }
    if (pullDistance > 40 && !refreshing) {
      setRefreshing(true);
      try {
        await loadNotifications(activeCategory, 1);
      } catch (err) {
        console.error(err);
      } finally {
        setRefreshing(false);
        setPullDistance(0);
      }
    } else {
      setPullDistance(0);
    }
    touchStartX.current = 0;
    touchEndX.current = 0;
    touchStartY.current = 0;
  };

  return (
    <div className="fixed inset-0 z-[200] select-none">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/40 backdrop-blur-md transition-opacity duration-300 animate-fade-in"
        onClick={onClose}
      />

      {/* Slide-out Panel */}
      <div
        onTouchStart={handleContainerTouchStart}
        onTouchMove={handleContainerTouchMove}
        onTouchEnd={handleContainerTouchEnd}
        className="safe-area-top-panel fixed top-0 right-0 h-full w-[85vw] sm:w-[65%] lg:w-[45%] max-w-md bg-white dark:bg-zinc-900 border-l border-outline-variant/10 shadow-2xl z-[210] flex flex-col animate-slide-in-right overflow-hidden"
      >
        {/* Header */}
        <div className="p-5 border-b border-zinc-100 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-800/30 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="relative w-10 h-10 rounded-full bg-rose-500/10 text-rose-500 flex items-center justify-center font-bold text-lg">
              <span className="material-symbols-outlined">notifications</span>
              {unreadCount > 0 && (
                <span className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-rose-500 text-white text-[10px] font-extrabold flex items-center justify-center border-2 border-white dark:border-zinc-900 shadow-2xs">
                  {unreadCount > 9 ? '9+' : unreadCount}
                </span>
              )}
            </div>
            <div>
              <h2 className="text-lg font-extrabold text-on-surface leading-tight">Notifications</h2>
              <p className="text-[11px] text-zinc-400 font-medium">
                {unreadCount > 0 ? `${unreadCount} unread updates` : 'All caught up!'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            {unreadCount > 0 && (
              <button
                onClick={handleMarkAllAsRead}
                className="px-2.5 py-1.5 rounded-xl bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-zinc-600 dark:text-zinc-300 text-[10px] font-bold transition-all"
                title="Mark all as read"
              >
                Read All
              </button>
            )}
            <button
              onClick={() => setShowPreferences(!showPreferences)}
              className={`w-9 h-9 rounded-full flex items-center justify-center transition-transform active:scale-90 ${showPreferences ? 'bg-primary text-white' : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-500'}`}
              title="Notification Settings"
            >
              <span className="material-symbols-outlined text-lg">settings</span>
            </button>
            <button
              onClick={onClose}
              className="w-9 h-9 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500 hover:text-on-surface flex items-center justify-center transition-transform active:scale-90"
              aria-label="Close Notifications"
            >
              <span className="material-symbols-outlined text-lg">close</span>
            </button>
          </div>
        </div>

        {/* Categories Bar — Respects Notification Preferences */}
        <div className="px-4 py-3 border-b border-zinc-100 dark:border-zinc-800 overflow-x-auto no-scrollbar flex items-center gap-1.5 bg-zinc-50/30 dark:bg-zinc-900/50">
          {categories
            .filter(cat => cat.id === 'all' || preferences[cat.id] !== 0)
            .map(cat => (
              <button
                key={cat.id}
                onClick={() => setActiveCategory(cat.id)}
                className={`px-3 py-1.5 rounded-full text-[11px] font-extrabold flex items-center gap-1 transition-all whitespace-nowrap active:scale-95 ${activeCategory === cat.id ? 'bg-primary text-white shadow-xs' : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-500 hover:text-on-surface'}`}
              >
                <span className="material-symbols-outlined text-sm">{cat.icon}</span>
                <span>{cat.label}</span>
              </button>
            ))}
        </div>

        {/* Pull-To-Refresh Visual Bar */}
        {(pullDistance > 0 || refreshing) && (
          <div className="py-2 bg-primary/5 border-b border-primary/10 flex items-center justify-center gap-1 text-xs font-bold text-primary animate-pulse">
            <span className="material-symbols-outlined text-sm">pets</span> {refreshing ? 'Sniffing out fresh updates...' : 'Pull down to refresh'}
          </div>
        )}

        {/* Preferences Toggle Overlay View */}
        {showPreferences ? (
          <div className="flex-1 overflow-y-auto p-6 space-y-4 animate-fade-in">
            <div className="flex items-center justify-between pb-3 border-b border-zinc-100 dark:border-zinc-800">
              <h3 className="text-xs font-extrabold uppercase tracking-wider text-zinc-400">Category Preferences</h3>
              <button onClick={() => setShowPreferences(false)} className="text-xs font-bold text-primary hover:underline">
                Done
              </button>
            </div>
            <p className="text-xs text-zinc-500">Toggle which notification categories you want to receive in real time:</p>

            <div className="space-y-2 bg-zinc-50 dark:bg-zinc-800/40 p-2 rounded-2xl border border-zinc-100 dark:border-zinc-800">
              {[
                { key: 'matches', label: 'Matches & Playdate Requests', icon: 'favorite', desc: 'New matches and playdate requests from Meet' },
                { key: 'activity', label: 'Activity & Licks', icon: 'pets', desc: 'Likes, comments, and post mentions' },
                { key: 'pawcircle', label: 'PawCircle & Communities', icon: 'groups', desc: 'Community invites, mentions, and announcements' },
                { key: 'nearby', label: 'Nearby Pets & Events', icon: 'near_me', desc: 'Local park events and nearby playmate alerts' },
                { key: 'offers', label: 'Offers & Promotions', icon: 'local_offer', desc: 'Discounts, special offers, and Sniffr Gold perks' },
                { key: 'email', label: 'Email Summaries', icon: 'mail', desc: 'Digest summaries and account-related updates' },
              ].map(item => (
                <div key={item.key} className="flex items-center justify-between p-3 rounded-xl hover:bg-white dark:hover:bg-zinc-800 transition-colors">
                  <div className="flex items-center gap-2">
                    <span className="material-symbols-outlined text-base text-zinc-400">{item.icon}</span>
                    <div>
                      <h4 className="text-xs font-bold text-on-surface">{item.label}</h4>
                      <p className="text-[10px] text-zinc-400 mt-0.5">{item.desc}</p>
                    </div>
                  </div>
                  <button
                    onClick={() => handleTogglePref(item.key)}
                    className={`w-11 h-6 rounded-full transition-colors relative flex items-center px-0.5 ${preferences[item.key] ? 'bg-primary' : 'bg-zinc-300 dark:bg-zinc-700'}`}
                  >
                    <div className={`w-5 h-5 rounded-full bg-white shadow-xs transition-transform transform ${preferences[item.key] ? 'translate-x-5' : 'translate-x-0'}`} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : (
          /* Notifications List View — Filtered by Active Preferences */
          <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3 no-scrollbar">
            {loading ? (
              <div className="flex items-center justify-center py-16">
                <div className="w-8 h-8 border-3 border-primary border-t-transparent rounded-full animate-spin" />
              </div>
            ) : notifications.filter(n => preferences[n.category] !== 0).length === 0 ? (
              <div className="text-center py-16 space-y-2">
                <div className="w-14 h-14 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-400 flex items-center justify-center mx-auto">
                  <span className="material-symbols-outlined text-2xl">notifications</span>
                </div>
                <h3 className="text-sm font-extrabold text-on-surface">No notifications found</h3>
                <p className="text-xs text-zinc-400 max-w-xs mx-auto">
                  {activeCategory === 'all'
                    ? 'When other pets like your posts or request playdates, they will show up here.'
                    : `No notifications under ${activeCategory.toUpperCase()} yet.`}
                </p>
              </div>
            ) : (
              <>
                <div className="space-y-2.5">
                  {notifications
                    .filter(n => preferences[n.category] !== 0)
                    .map(notif => (
                    <div
                      key={notif.id}
                      onClick={() => {
                        handleMarkAsRead(notif.id);
                        if (notif.sender_sniffed_out && SENDER_PROFILE_TYPES.includes(notif.type)) {
                          showToast(SNIFFED_OUT_MESSAGE, notif.id);
                          return;
                        }
                        if (
    (notif.type === 'spotlight_achievement' ||
     notif.type === 'spotlight_new_champion' ||
     notif.type === 'profile_view') &&
     notif.target_id
) {
    onClose();
    navigate(`/profile/${notif.target_id}`);
}
else if (notif.type === 'admin_payment_review_needed') {
    onClose();
    navigate('/admin/payments');
}
else if (
    (notif.type === 'lick' ||
     notif.type === 'comment' ||
     notif.category === 'activity') &&
    notif.target_id
) {
    setSelectedPostViewer({
        postId: notif.target_id,
        autoOpenComments: notif.type === 'comment'
    });
} else if (notif.type === 'community_announcement' || notif.category === 'pawcircle') {
                          onClose();
                          const commId = parseCommunityId(notif);
                          const isExpired = notif.is_expired || notif.metadata_json?.is_expired || notif.description?.toLowerCase().includes('ended');
                          navigate(`/community/${commId}`, { state: circleNavState(notif, isExpired) });
                        } else if (notif.type === 'nearby_event' || notif.category === 'nearby') {
                          const commId = parseCommunityId(notif);
                          const isMember = joinedCommIds.has(commId);
                          const isExpired = notif.is_expired || notif.metadata_json?.is_expired || notif.description?.toLowerCase().includes('ended');

                          if (isMember) {
                            onClose();
                            navigate(`/community/${commId}`, { state: { announcementId: notif.target_id, eventId: notif.target_id, openAnnouncements: true, isExpired } });
                          } else {
                            setNearbyPromptModal({ notif, communityId: commId, isExpired });
                          }
                        } else if (notif.category === 'offers' || notif.type === 'premium_offer' || notif.type === 'subscription_reminder' || notif.type === 'premium_benefits' || notif.type === 'upgrade_promotion') {
                          onClose();
                          navigate('/profile', { state: { openSettings: true, openPremium: true } });
                        } else if (notif.type === 'match_request') {
                          onClose();
                          navigate(`/profile/${notif.sender_pet_id}`);
                        } else if (notif.type === 'new_match' || notif.category === 'matches') {
                          onClose();
                          navigate(`/profile/${notif.sender_pet_id}`);
                        }
                      }}
                      className={`p-3.5 rounded-2xl border transition-all relative cursor-pointer ${notif.is_read ? 'bg-zinc-50/70 dark:bg-zinc-800/30 border-zinc-100 dark:border-zinc-800/50' : 'bg-white dark:bg-zinc-800 border-rose-200/80 dark:border-rose-900/50 shadow-xs ring-1 ring-rose-400/20'}`}
                    >
                      {!notif.is_read && (
                        <span className="absolute top-3.5 right-3.5 w-2 h-2 rounded-full bg-rose-500 animate-pulse" />
                      )}

                      <div className="flex items-start gap-3">
                        {/* Avatar / Category Badge */}
                        <div className="relative flex-shrink-0">
                          <div className="w-10 h-10 rounded-full overflow-hidden bg-zinc-100 border border-zinc-200/50">
                            {notif.sender_sniffed_out ? (
                              <SniffedOutAvatar className="w-full h-full" />
                            ) : (
                            <img
                              src={notif.avatar_url && !brokenAvatarIds.has(notif.id) ? notif.avatar_url : publicAsset('/logo.png')}
                              alt={notif.title}
                              className="w-full h-full object-cover"
                              onError={() => {
                                setBrokenAvatarIds(prev => new Set(prev).add(notif.id));
                              }}
                            />
                            )}
                          </div>
                          <span className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-white dark:bg-zinc-900 shadow-xs flex items-center justify-center text-[10px]">
                            <span className="material-symbols-outlined text-[12px]">{notif.category === 'matches' ? 'favorite' : notif.category === 'activity' ? 'pets' : notif.category === 'pawcircle' ? 'groups' : notif.category === 'nearby' ? 'near_me' : notif.category === 'offers' ? 'local_offer' : 'mail'}</span>
                          </span>
                        </div>

                        {/* Title, Body, Timestamp */}
                        <div className="flex-1 pr-4 text-left">
                          <div className="flex items-baseline justify-between gap-1">
                            <h4 className="text-xs font-extrabold text-on-surface leading-tight flex items-center gap-1">
                              <span>{renderNotifTitle(notif)}</span>
                              <PremiumBadge pet={notif} size="text-sm" />
                            </h4>
                          </div>
                          <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-1 leading-snug">{notif.description}</p>
                          <span className="text-[10px] text-zinc-400 font-semibold block mt-1.5">
                            {formatRelativeTime(notif.created_at)}
                          </span>

                          {/* Deep Link Action Buttons */}
                          {notif.type === 'match_request' && (
                            <div className="flex gap-2 mt-2.5 pt-2 border-t border-zinc-100 dark:border-zinc-800">
                              {notif.action_status === 'expired' ? (
                                <span className="text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-zinc-200 dark:bg-zinc-700 text-zinc-500 dark:text-zinc-300">
                                  Request expired
                                </span>
                              ) : notif.action_status === 'pending' ? (
                                <>
                                  <button
                                    onClick={(e) => { e.stopPropagation(); handleMatchRequestRespond(notif.id, 'accept'); }}
                                    className="flex-1 py-1.5 bg-rose-500 hover:bg-rose-600 text-white font-extrabold text-[11px] rounded-xl shadow-xs transition-transform active:scale-95 flex items-center justify-center gap-1"
                                  >
                                    <span className="material-symbols-outlined text-sm">check</span> Accept
                                  </button>
                                  <button
                                    onClick={(e) => { e.stopPropagation(); handleMatchRequestRespond(notif.id, 'decline'); }}
                                    className="flex-1 py-1.5 bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 text-zinc-600 dark:text-zinc-300 font-extrabold text-[11px] rounded-xl transition-transform active:scale-95 flex items-center justify-center gap-1"
                                  >
                                    <span className="material-symbols-outlined text-sm">close</span> Reject
                                  </button>
                                </>
                              ) : (
                                <span className={`text-[10px] font-extrabold px-2 py-0.5 rounded-full ${notif.action_status === 'accepted' ? 'bg-emerald-100 text-emerald-700' : 'bg-zinc-200 text-zinc-600'}`}>
                                  {notif.action_status === 'accepted' ? 'Match Accepted' : 'Request Declined'}
                                </span>
                              )}
                            </div>
                          )}

                          {notif.type === 'community_ownership_transfer' && (
                            <div className="flex gap-2 mt-2.5 pt-2 border-t border-zinc-100 dark:border-zinc-800">
                              {notif.action_status === 'pending' ? (
                                <>
                                  <button
                                    onClick={(e) => { e.stopPropagation(); handleTransferRespond(notif, 'accept'); }}
                                    className="flex-1 py-1.5 bg-primary hover:opacity-90 text-white font-extrabold text-[11px] rounded-xl transition-transform active:scale-95 flex items-center justify-center gap-1"
                                  >
                                    <span className="material-symbols-outlined text-sm">check</span> Accept
                                  </button>
                                  <button
                                    onClick={(e) => { e.stopPropagation(); handleTransferRespond(notif, 'decline'); }}
                                    className="flex-1 py-1.5 bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 text-zinc-600 dark:text-zinc-300 font-extrabold text-[11px] rounded-xl transition-transform active:scale-95 flex items-center justify-center gap-1"
                                  >
                                    <span className="material-symbols-outlined text-sm">close</span> Decline
                                  </button>
                                </>
                              ) : (
                                <span className={`text-[10px] font-extrabold px-2 py-0.5 rounded-full ${notif.action_status === 'accepted' ? 'bg-emerald-100 text-emerald-700' : 'bg-zinc-200 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-300'}`}>
                                  {notif.action_status === 'accepted' ? 'You are the owner'
                                    : notif.action_status === 'declined' ? 'Declined'
                                    : notif.action_status === 'expired' ? 'Expired' : 'Cancelled'}
                                </span>
                              )}
                            </div>
                          )}

                          {notif.type === 'new_match' && !notif.sender_sniffed_out && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleMarkAsRead(notif.id);
                                onClose();
                                navigate('/chat', { state: { petId: notif.sender_pet_id || notif.target_id, autoOpen: true } });
                              }}
                              className="mt-2.5 px-3 py-1.5 bg-rose-500 text-white font-extrabold text-[11px] rounded-xl shadow-2xs hover:bg-rose-600 transition-all flex items-center gap-1 active:scale-95"
                            >
                              <span className="material-symbols-outlined text-sm">chat_bubble</span> Chat Now
                            </button>
                          )}

                          {(notif.type === 'lick' || notif.type === 'comment' || (notif.category === 'activity' && notif.type !== 'profile_view' && notif.type !== 'admin_payment_review_needed')) && notif.target_id && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleMarkAsRead(notif.id);
                                setSelectedPostViewer({
                                  postId: notif.target_id,
                                  autoOpenComments: notif.type === 'comment'
                                });
                              }}
                              className="mt-2.5 px-3 py-1.5 bg-primary/10 text-primary font-extrabold text-[11px] rounded-xl hover:bg-primary/20 transition-all flex items-center gap-1 active:scale-95"
                            >
                              <span className="material-symbols-outlined text-sm">visibility</span> View Post
                            </button>
                          )}

                          {notif.type === 'profile_view' && notif.target_id && !notif.sender_sniffed_out && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleMarkAsRead(notif.id);
                                onClose();
                                navigate(`/profile/${notif.target_id}`);
                              }}
                              className="mt-2.5 px-3 py-1.5 bg-primary/10 text-primary font-extrabold text-[11px] rounded-xl hover:bg-primary/20 transition-all flex items-center gap-1 active:scale-95"
                            >
                              <span className="material-symbols-outlined text-sm">visibility</span> View Profile
                            </button>
                          )}

                          {/* Notification Type 1: Announcement (Member View) */}
                          {(notif.type === 'community_announcement' || notif.category === 'pawcircle') && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleMarkAsRead(notif.id);
                                onClose();
                                const commId = parseCommunityId(notif);
                                const isExpired = notif.is_expired || notif.metadata_json?.is_expired || notif.description?.toLowerCase().includes('ended');
                                navigate(`/community/${commId}`, { state: circleNavState(notif, isExpired) });
                              }}
                              className="mt-2.5 px-3 py-1.5 bg-indigo-500/10 text-indigo-600 font-extrabold text-[11px] rounded-xl hover:bg-indigo-500/20 transition-all flex items-center gap-1 active:scale-95"
                            >
                              <span className="material-symbols-outlined text-sm">groups</span> View PawCircle
                            </button>
                          )}

                          {/* Notification Type 2: Nearby Event (Check Membership) */}
                          {(notif.type === 'nearby_event' || notif.category === 'nearby') && (
                            (() => {
                              const commId = parseCommunityId(notif);
                              const isMember = joinedCommIds.has(commId);
                              const isExpired = notif.is_expired || notif.metadata_json?.is_expired || notif.description?.toLowerCase().includes('ended');

                              if (isMember) {
                                return (
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleMarkAsRead(notif.id);
                                      onClose();
                                      navigate(`/community/${commId}`, { state: { announcementId: notif.target_id, eventId: notif.target_id, openAnnouncements: true, isExpired } });
                                    }}
                                    className="mt-2.5 px-3 py-1.5 bg-indigo-500/10 text-indigo-600 font-extrabold text-[11px] rounded-xl hover:bg-indigo-500/20 transition-all flex items-center gap-1 active:scale-95"
                                  >
                                    <span className="material-symbols-outlined text-sm">groups</span> View PawCircle
                                  </button>
                                );
                              }

                              return (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleMarkAsRead(notif.id);
                                    setNearbyPromptModal({ notif, communityId: commId, isExpired });
                                  }}
                                  className={`mt-2.5 px-3 py-1.5 text-[11px] font-extrabold rounded-xl transition-all flex items-center gap-1 active:scale-95 ${isExpired ? 'bg-zinc-100 text-zinc-500 hover:bg-zinc-200' : 'bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/20'}`}
                                >
                                  <span className="material-symbols-outlined text-sm">{isExpired ? 'event_busy' : 'location_on'}</span> {isExpired ? 'View Event Details' : 'Join Event'}
                                </button>
                              );
                            })()
                          )}

                          {(notif.category === 'offers' || notif.type === 'premium_offer' || notif.type === 'subscription_reminder' || notif.type === 'premium_benefits' || notif.type === 'upgrade_promotion') && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleMarkAsRead(notif.id);
                                onClose();
                                navigate('/profile', { state: { openSettings: true, openPremium: true } });
                              }}
                              className="mt-2.5 px-3 py-1.5 bg-amber-500/10 text-amber-600 font-extrabold text-[11px] rounded-xl hover:bg-amber-500/20 transition-all flex items-center gap-1 active:scale-95"
                            >
                              <span className="material-symbols-outlined text-sm">redeem</span> View Premium Offer
                            </button>
                          )}

                          {notif.type === 'admin_payment_review_needed' && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleMarkAsRead(notif.id);
                                onClose();
                                navigate('/admin/payments');
                              }}
                              className="mt-2.5 px-3 py-1.5 bg-amber-500/10 text-amber-600 font-extrabold text-[11px] rounded-xl hover:bg-amber-500/20 transition-all flex items-center gap-1 active:scale-95"
                            >
                              <span className="material-symbols-outlined text-sm">receipt_long</span> Review Payment
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  ))
                }
                </div>

                {hasMore && (
                  <button
                    onClick={() => loadNotifications(activeCategory, page + 1)}
                    disabled={loadingMore}
                    className="w-full py-2.5 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 font-extrabold text-xs rounded-xl hover:bg-zinc-200 transition-colors flex items-center justify-center gap-1 mt-2"
                  >
                    {loadingMore ? <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" /> : 'Load Older Notifications'}
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* In-app Toast */}
      {toastMessage && (
        <div className="fixed top-12 left-1/2 -translate-x-1/2 z-[400] bg-zinc-900/90 text-white dark:bg-white/90 dark:text-zinc-900 px-5 py-3 rounded-2xl text-xs font-extrabold shadow-2xl animate-bounce text-center max-w-xs whitespace-pre-line pointer-events-none">
          {toastMessage.text}
        </div>
      )}

      {/* Nearby Event Join Prompt Modal with Expiry Check */}
      {nearbyPromptModal && createPortal(
        <div
          style={{
            position: 'fixed',
            top: 0, left: 0, right: 0, bottom: 0,
            zIndex: 99999,
            backgroundColor: 'rgba(0, 0, 0, 0.65)',
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '16px'
          }}
          onClick={() => setNearbyPromptModal(null)}
        >
          <div
            className="bg-white dark:bg-zinc-900 rounded-[2.5rem] p-6 max-w-sm w-full text-center shadow-2xl relative border border-outline-variant/10 text-left space-y-4 animate-scale-up"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="w-12 h-12 rounded-full bg-emerald-100 dark:bg-emerald-950/40 text-emerald-600 flex items-center justify-center mx-auto">
              <span className="material-symbols-outlined text-2xl">{nearbyPromptModal.isExpired ? 'event_busy' : 'location_on'}</span>
            </div>
            
            {nearbyPromptModal.notif?.is_expired || nearbyPromptModal.notif?.description?.toLowerCase().includes('ended') ? (
              <>
                <div className="text-center space-y-1">
                  <h3 className="text-base font-extrabold text-on-surface">This event has already ended.</h3>
                  <p className="text-xs text-zinc-500">Keep an eye on PawCircle for upcoming meetups!</p>
                </div>
                <div className="space-y-2 pt-2">
                  <button
                    type="button"
                    onClick={() => {
                      const commId = nearbyPromptModal.communityId;
                      const targetId = nearbyPromptModal.notif?.target_id;
                      setNearbyPromptModal(null);
                      onClose();
                      navigate(`/community/${commId}`, { state: { announcementId: targetId, eventId: targetId, openAnnouncements: true, isExpired: true } });
                    }}
                    className="w-full py-3 bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 text-zinc-700 dark:text-zinc-200 font-extrabold text-xs rounded-full transition-all active:scale-95"
                  >
                    View PawCircle Notice Board
                  </button>
                  <button
                    type="button"
                    onClick={() => setNearbyPromptModal(null)}
                    className="w-full py-2.5 text-zinc-400 font-bold text-xs hover:text-zinc-600"
                  >
                    Close
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="text-center space-y-1">
                  <h3 className="text-base font-extrabold text-on-surface">You're not a part of this PawCircle yet.</h3>
                  <p className="text-xs text-zinc-500">Would you like to join this PawCircle to participate in the event?</p>
                </div>
                <div className="space-y-2 pt-2">
                  <button
                    type="button"
                    onClick={async () => {
                      const commId = nearbyPromptModal.communityId;
                      const targetId = nearbyPromptModal.notif?.target_id;
                      try {
                        await api.post(`/communities/${commId}/join`);
                        setJoinedCommIds(prev => new Set([...prev, commId]));
                      } catch (e) { notifyActionError(e, "Couldn't join the PawCircle. Please try again."); }
                      setNearbyPromptModal(null);
                      onClose();
                      navigate(`/community/${commId}`, { state: { announcementId: targetId, eventId: targetId, openAnnouncements: true } });
                    }}
                    className="w-full py-3 bg-emerald-500 hover:bg-emerald-600 text-white font-extrabold text-xs rounded-full shadow-md transition-all active:scale-95"
                  >
                    Join Now
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const commId = nearbyPromptModal.communityId;
                      const targetId = nearbyPromptModal.notif?.target_id;
                      setNearbyPromptModal(null);
                      onClose();
                      navigate(`/community/${commId}`, { state: { announcementId: targetId, eventId: targetId, openAnnouncements: true } });
                    }}
                    className="w-full py-3 bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 text-zinc-600 dark:text-zinc-300 font-extrabold text-xs rounded-full transition-all active:scale-95"
                  >
                    Continue Without Joining
                  </button>
                </div>
              </>
            )}
          </div>
        </div>,
        document.body
      )}

      {/* Notification Post Viewer Overlay */}
      {selectedPostViewer && (
        <NotificationPostViewerModal
          postId={selectedPostViewer.postId}
          autoOpenComments={selectedPostViewer.autoOpenComments}
          onClose={() => setSelectedPostViewer(null)}
        />
      )}
    </div>
  );
}
