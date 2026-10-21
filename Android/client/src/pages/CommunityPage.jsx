import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useSocket } from '../context/SocketContext';
import api from '../services/api';
import { publicWebOrigin } from '../utils/platform';
import UpsellModal from '../components/UpsellModal';
import { isPremiumGateError, isQuotaExceededError, quotaUpsellCopy } from '../utils/premiumErrors';
import PremiumBadge from '../components/PremiumBadge';
import Portal from '../components/Portal';
import useTypingSignal from '../hooks/useTypingSignal';
import useMessageInteractions from '../hooks/useMessageInteractions';
import TypingDots from '../components/chat/TypingDots';
import { REACTION_EMOJIS, REACTION_LABELS } from '../constants/reactions';
import { PawClipDefs, PAW_CLIP_STYLE } from '../components/PawShape';
import MemberSniffCard from '../components/MemberSniffCard';
import { avatarUrl, thumbnailUrl, feedMediaUrl, safeLinkUrl } from '../utils/media';

import { publicAsset } from '../utils/publicPath';
import SniffedOutName, { SniffedOutAvatar } from '../components/SniffedOutName';
import MediaUnavailable from '../components/MediaUnavailable';
import MediaViewerModal from '../components/MediaViewerModal';
import { isCommunityFrozen, isCommunityReadOnlyError, COMMUNITY_READ_ONLY_MESSAGE, COMMUNITY_DISABLED_MESSAGE, SNIFFED_OUT_NAME } from '../utils/sniffedOut';
import { notifyActionError } from '../utils/appToast';

// Message types that carry a file; with media_url NULL the file is gone.
const COMMUNITY_MEDIA_TYPES = ['image', 'video', 'voice', 'file'];
// ─── Custom Voice Playback Component with Paw timeline ──────────
function VoicePlayer({ audioUrl }) {
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const audioRef = useRef(null);

  const togglePlay = () => {
    if (!audioRef.current) return;
    if (playing) {
      audioRef.current.pause();
    } else {
      audioRef.current.play();
    }
  };

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onTimeUpdate = () => {
      if (audio.duration) {
        setProgress((audio.currentTime / audio.duration) * 100);
      }
    };
    const onEnded = () => {
      setPlaying(false);
      setProgress(0);
    };

    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('ended', onEnded);

    return () => {
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('ended', onEnded);
    };
  }, [audioUrl]);

  return (
    <div className="flex items-center gap-3 bg-zinc-50 dark:bg-zinc-800 rounded-full px-4 py-2 border border-zinc-100 dark:border-zinc-800 max-w-[240px]">
      <audio ref={audioRef} src={audioUrl} className="hidden" />
      <button
        type="button"
        onClick={togglePlay}
        className="w-8 h-8 rounded-full bg-primary text-white flex items-center justify-center shadow-md active:scale-90 transition-transform flex-shrink-0"
      >
        <span className="material-symbols-outlined text-sm">{playing ? 'pause' : 'play_arrow'}</span>
      </button>
      
      {/* Progress timeline with animated smooth paw head */}
      <div className="flex-1 pr-2 min-w-[120px]">
        <div className="paw-playback-timeline w-full">
          <div className="paw-playback-progress animate-pulse" style={{ width: `${progress}%` }} />
          <div className="paw-playback-head text-primary drop-shadow-sm" style={{ left: `${progress}%` }}>🐾</div>
        </div>
      </div>
    </div>
  );
}

export default function CommunityPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const { getSocket } = useSocket();

  const [community, setCommunity] = useState(null);
  const [activeSubTab, setActiveSubTab] = useState('chat'); // chat is default landing
  const [myMatches, setMyMatches] = useState([]);
  const [previewMember, setPreviewMember] = useState(null);
  const [inviteToast, setInviteToast] = useState(null);
  const [upsell, setUpsell] = useState(null); // { title, message } -- premium upsell modal
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deletingGroup, setDeletingGroup] = useState(false);
  const [showOptionsMenu, setShowOptionsMenu] = useState(false);

  // Retract (Leave) state
  const [showRetractModal, setShowRetractModal] = useState(false);
  const [retracting, setRetracting] = useState(false);

  // Report state
  const [showReportModal, setShowReportModal] = useState(false);
  const [reportReason, setReportReason] = useState('Inappropriate Content');
  const [reportDetails, setReportDetails] = useState('');
  const [submittingReport, setSubmittingReport] = useState(false);

  // Disable (Creator Only) state
  const [showDisableModal, setShowDisableModal] = useState(false);
  const [disablingCommunity, setDisablingCommunity] = useState(false);

  const handleDeleteGroup = async () => {
    setDeletingGroup(true);
    try {
      const res = await api.post(`/communities/${id}/delete-group`);
      setInviteToast(res?.left
        ? (res.deleted ? '🐾 You were the last member, so this PawCircle has been deleted.' : 'You left this PawCircle.')
        : 'PawCircle conversation deleted.');
      setTimeout(() => {
        navigate('/chat?tab=pawcircle');
      }, 800);
    } catch (err) {
      console.error(err);
      alert('Failed to delete PawCircle conversation.');
    } finally {
      setDeletingGroup(false);
      setShowDeleteModal(false);
    }
  };

  const handleRetractCommunity = async () => {
    setRetracting(true);
    try {
      const res = await api.post(`/communities/${id}/leave`);
      setInviteToast(res?.deleted
        ? '🐾 You were the last member, so this PawCircle has been deleted.'
        : 'Retracted from PawCircle.');
      setTimeout(() => navigate('/chat?tab=pawcircle'), 800);
    } catch (err) {
      console.error(err);
      // H9: the owner of a circle with other live members gets a specific,
      // actionable 409 (OWNER_MUST_TRANSFER) instead of a generic failure --
      // surface its real message instead of a one-size-fits-all string.
      alert(err.code === 'OWNER_MUST_TRANSFER' ? err.message : 'Failed to retract from PawCircle.');
    } finally {
      setRetracting(false);
      setShowRetractModal(false);
    }
  };

  const handleReportCommunity = async (e) => {
    e.preventDefault();
    setSubmittingReport(true);
    try {
      await api.post(`/communities/${id}/report`, { reason: reportReason, details: reportDetails });
      
      // Report History loads it from the server (GET /api/posts/reports).

      setInviteToast('Report submitted successfully.');
      setShowReportModal(false);
      setReportDetails('');
    } catch (err) {
      console.error(err);
      alert('Failed to submit report.');
    } finally {
      setSubmittingReport(false);
    }
  };

  // Disabling archives the circle (read-only for everyone); it stays in the
  // owner's list so they can re-enable it.
  const handleDisableCommunity = async () => {
    setDisablingCommunity(true);
    try {
      await api.post(`/communities/${id}/disable`);
      markFrozen('disabled');
      setTransfer(null);
      setJoinRequests([]);
      showToast('PawCircle disabled.');
    } catch (err) {
      if (!handleReadOnlyError(err)) showToast(err.message || 'Failed to disable PawCircle.');
    } finally {
      setDisablingCommunity(false);
      setShowDisableModal(false);
    }
  };

  const handleEnableCommunity = async () => {
    try {
      const res = await api.post(`/communities/${id}/enable`);
      setCommunity(prev => (res?.community ? res.community : (prev ? { ...prev, disabled: false } : prev)));
      showToast('🐾 This PawCircle is active again.');
    } catch (err) {
      showToast(err.message || 'Could not re-enable this PawCircle.');
    }
  };

  useEffect(() => {
    if (location.state?.announcementId || location.state?.eventId) {
      setActiveSubTab('announcements');
    }
  }, [location.state]);

  const [loading, setLoading] = useState(true);
  // Frozen circle opened by a non-member (e.g. an old invite link).
  const [noLongerAvailable, setNoLongerAvailable] = useState(false);

  // Sub-data inside community
  const [announcements, setAnnouncements] = useState([]);
  const [messages, setMessages] = useState([]);
  const [photos, setPhotos] = useState([]);
  const [files, setFiles] = useState([]);
  const [polls, setPolls] = useState([]);
  const [members, setMembers] = useState([]);
  const [mediaViewer, setMediaViewer] = useState(null);

  // Scrolls to the specific announcement a notification pointed at, once
  // it's actually loaded (getAnnouncements' highlightId ensures it's in
  // the list even if older than the default window -- see server fix).
  // Must stay below the `announcements`/`activeSubTab` state declarations
  // above -- referencing them in this effect's dependency array before
  // their own `useState` line runs throws "Cannot access before
  // initialization" on every render, crashing this whole page.
  useEffect(() => {
    if (activeSubTab !== 'announcements' || !location.state?.announcementId) return;
    const idToFind = location.state.announcementId;
    if (!announcements.some(a => String(a.id) === String(idToFind))) return;
    const el = document.getElementById(`announcement-${idToFind}`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [activeSubTab, announcements, location.state]);

  const handleCopyInviteLink = (e) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    const commId = community?.slug || community?.id || id;
    if (!commId) return;
    const inviteUrl = `${publicWebOrigin()}/community/${commId}?invite=true`;

    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(inviteUrl);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = inviteUrl;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
    } catch (err) {
      console.error('Clipboard copy error:', err);
    }

    setInviteToast('PawCircle link copied successfully.');
    setTimeout(() => setInviteToast(null), 2500);
  };

  // Input states
  const [newMsg, setNewMsg] = useState('');
  const [annTitle, setAnnTitle] = useState('');
  const [annContent, setAnnContent] = useState('');
  const [showAnnForm, setShowAnnForm] = useState(false);

  const [isEventAnnouncement, setIsEventAnnouncement] = useState(false);
  const [eventLocationQuery, setEventLocationQuery] = useState('');
  const [eventLocationResults, setEventLocationResults] = useState([]);
  const [eventLocationSearching, setEventLocationSearching] = useState(false);
  const [selectedEventLocation, setSelectedEventLocation] = useState(null);

  // Poll create states
  const [showPollForm, setShowPollForm] = useState(false);
  const [pollQuestion, setPollQuestion] = useState('');
  const [pollOptions, setPollOptions] = useState(['', '']);

  const chatBottomRef = useRef(null);
  const chatScrollRef = useRef(null);
  const fileInputRef = useRef(null);
  const composerInputRef = useRef(null);
  const messageRefsMap = useRef({});

  // Scrolls only the internal chat message pane -- setting scrollTop directly
  // (rather than chatBottomRef.scrollIntoView, which was used before) never
  // drags the surrounding page along with it, since scrollIntoView will also
  // scroll ancestor containers when the target isn't fully in view.
  const scrollChatToBottom = (smooth = true) => {
    const el = chatScrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  };

  const [messageReactions, setMessageReactions] = useState({});
  const [replyingTo, setReplyingTo] = useState(null);
  const [actionMenuMessage, setActionMenuMessage] = useState(null);
  const [confirmFetchBackModal, setConfirmFetchBackModal] = useState(null);
  const [copyToast, setCopyToast] = useState(null);
  const [typingUsername, setTypingUsername] = useState(null);
  const [highlightMsgId, setHighlightMsgId] = useState(null);

  // ── Private circles: join requests ────────────────────────────────────
  // Owner/Admin: the pending requests (Requests tab). Everyone else: the
  // Request to Join / Requested / Cancel button on the Info tab.
  const [joinRequests, setJoinRequests] = useState([]);
  const [requestBusy, setRequestBusy] = useState(false);
  const [decidingRequestId, setDecidingRequestId] = useState(null);

  // ── Ownership transfer ────────────────────────────────────────────────
  // transfer: the pending one, if you're its owner (isSender) or recipient
  // (isRecipient). The Owner picks a member in the picker, then confirms.
  const [transfer, setTransfer] = useState(null);
  const [showTransferPicker, setShowTransferPicker] = useState(false);
  const [transferMembers, setTransferMembers] = useState([]);
  const [transferSearch, setTransferSearch] = useState('');
  const [transferConfirm, setTransferConfirm] = useState(null);
  const [transferBusy, setTransferBusy] = useState(false);

  // ── Frozen circle (owner deleted their account): read-only ────────────
  // Read-only: frozen (the owner deleted their account) or disabled (the
  // owner archived it). isFrozen gates every write; isOwnerGone only the
  // frozen-specific bits (leaving for good, reactivation by transfer).
  const isOwnerGone = isCommunityFrozen(community);
  const isDisabled = !!community?.disabled;
  const isFrozen = isOwnerGone || isDisabled;
  const readOnlyMessage = isOwnerGone ? COMMUNITY_READ_ONLY_MESSAGE : COMMUNITY_DISABLED_MESSAGE;
  const showToast = (text) => {
    setCopyToast(text);
    setTimeout(() => setCopyToast(null), 2500);
  };
  // Switches the open circle to read-only in place, without a reload (live
  // community_frozen event, or a write the server refused).
  // reason 'disabled': the owner disabled it; otherwise the owner is gone.
  const markFrozen = (reason) => {
    setCommunity(prev => (prev ? (reason === 'disabled' ? { ...prev, disabled: true } : { ...prev, status: 'frozen', frozen: true }) : prev));
    setReplyingTo(null);
    setNewMsg('');
    setShowAnnForm(false);
    setShowPollForm(false);
  };
  // True (and handled) if the server refused a write because the circle is
  // frozen.
  const handleReadOnlyError = (err) => {
    if (!isCommunityReadOnlyError(err)) return false;
    const reason = err?.body?.reason;
    markFrozen(reason);
    showToast(reason === 'disabled' ? COMMUNITY_DISABLED_MESSAGE : COMMUNITY_READ_ONLY_MESSAGE);
    return true;
  };

  const { notifyTyping, stopTyping } = useTypingSignal(
    (isTyping) => {
      const socket = getSocket();
      if (!socket || !numericId) return;
      socket.emit('community_typing', { communityId: numericId, isTyping });
    },
    id
  );

  const {
    reactionPickerMsgId,
    setReactionPickerMsgId,
    highlightedMsgReaction,
    setHighlightedMsgReaction,
    handleMessageTap,
    startMessageLongPress,
    cancelMessageLongPress,
    handleBubbleTouchMove,
    handleBubbleTouchEnd,
    submitMessageReaction,
  } = useMessageInteractions({
    currentUserId: user?.id,
    onReply: (msg) => {
      if (isFrozen) return; // no composer in a read-only circle
      setReplyingTo(msg);
      composerInputRef.current?.focus();
    },
    onOpenActionMenu: (msg, { isOwn, top, left }) => setActionMenuMessage({ msg, isOwn, top, left }),
    onReact: (messageId, reaction) => {
      if (isFrozen) {
        showToast(readOnlyMessage);
        return;
      }
      const socket = getSocket();
      if (socket) {
        socket.emit('react_to_community_message', { messageId, communityId: numericId, reaction });
      }
    },
    onMediaTap: (msg) => {
      const mediaMessages = messages.filter(m => m.media_url && (m.message_type === 'image' || m.message_type === 'video'));
      const idx = mediaMessages.findIndex(m => m.id === msg.id);
      if (idx !== -1) setMediaViewer({ index: idx, urls: mediaMessages.map(m => m.media_url) });
    },
  });

  const scrollToMessage = (msgId) => {
    const el = messageRefsMap.current[msgId];
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setHighlightMsgId(msgId);
      setTimeout(() => setHighlightMsgId(null), 1500);
    }
  };

  // Used to decide whether a member's full profile can be shown from inside
  // the PawCircle -- only pets you're actually matched with unlock past the
  // half-profile preview.
  useEffect(() => {
    api.get('/matches').then(res => setMyMatches(res?.matches || [])).catch(() => {});
  }, []);

  useEffect(() => {
    loadCommunityDetails();
  }, [id]);

  // The route param (`id`) is now either the numeric id or the readable
  // slug (see db/sql/2026-10-13_community_slug.sql) -- every REST call
  // below still just passes it straight through (the server's :id param
  // resolver handles either), but Socket.IO room names and every live-event
  // payload the server sends are always the real numeric id, so socket
  // code needs that, not the raw route param. Available only once
  // loadCommunityDetails's fetch above resolves it.
  const numericId = community?.id ?? null;

  // Socket.IO event registrations
  useEffect(() => {
    if (!numericId) return;
    const socket = getSocket();
    if (!socket) return;

    socket.emit('join_community_chat', { communityId: numericId });

    // After a reconnect (dropped wifi, backgrounded tab, server restart) the
    // server has forgotten this socket's rooms: join the circle's live room
    // again, or live messages stop until the page is reopened. 'connect' also
    // fires on every reconnect.
    const onReconnect = () => socket.emit('join_community_chat', { communityId: numericId });
    socket.on('connect', onReconnect);

    const onMessage = (msg) => {
      if (msg.community_id === numericId) {
        setMessages(prev => {
          const exists = prev.some(m => m.id === msg.id);
          if (exists) return prev;
          return [...prev, msg];
        });
        if (msg.message_type === 'file') {
          setFiles(prev => [...prev, msg]);
        }
        setTimeout(() => scrollChatToBottom(), 100);
      }
    };

    // Member rows store the pet's name/avatar denormalized (pet_name,
    // pet_avatar) rather than a live reference -- match on user_id since
    // that's the actual relational key on a community_members row (there's
    // no pet_id on the member row itself).
    const onProfileUpdated = ({ pet: updatedPet }) => {
      if (!updatedPet || updatedPet.user_id == null) return;
      setMembers(prev => prev.map(m => (
        m.user_id === updatedPet.user_id
          ? { ...m, pet_name: updatedPet.name, pet_avatar: updatedPet.avatar_url, is_premium: updatedPet.is_premium }
          : m
      )));
    };

    const onTyping = ({ communityId, userId: typingUserId, username, isTyping }) => {
      if (typingUserId === user?.id) return;
      if (communityId === numericId) {
        setTypingUsername(isTyping ? username : null);
      }
    };

    const onReactionUpdated = ({ messageId, reactions }) => {
      setMessageReactions(prev => ({ ...prev, [messageId]: reactions }));
    };

    const onMsgUpdated = (updated) => {
      if (updated.community_id === numericId) {
        setMessages(prev => prev.map(m => m.id === updated.id ? updated : m));
      }
    };

    // The owner deleted their account while this circle is open.
    const onCommunityFrozen = ({ communityId }) => {
      if (communityId !== numericId) return;
      markFrozen();
      showToast(COMMUNITY_READ_ONLY_MESSAGE);
    };

    // A socket write (reaction, fetch back) the server refused.
    const onCommunityError = (payload) => {
      if (!isCommunityReadOnlyError(payload)) return;
      if (payload.communityId != null && payload.communityId !== numericId) return;
      markFrozen(payload.reason);
      showToast(payload.reason === 'disabled' ? COMMUNITY_DISABLED_MESSAGE : COMMUNITY_READ_ONLY_MESSAGE);
    };

    // The owner disabled / re-enabled the circle while it's open.
    const onCommunityDisabled = ({ communityId }) => {
      if (communityId !== numericId) return;
      markFrozen('disabled');
      showToast(COMMUNITY_DISABLED_MESSAGE);
    };
    const onCommunityEnabled = ({ communityId }) => {
      if (communityId !== numericId) return;
      setCommunity(prev => (prev ? { ...prev, disabled: false } : prev));
      showToast('🐾 This PawCircle is active again.');
    };
    // Someone created a poll.
    const onPollCreated = ({ communityId, poll }) => {
      if (communityId !== numericId || !poll) return;
      setPolls(prev => (prev.some(p => p.id === poll.id) ? prev : [poll, ...prev]));
    };
    socket.on('community_disabled', onCommunityDisabled);
    socket.on('community_enabled', onCommunityEnabled);
    socket.on('community_poll_created', onPollCreated);

    socket.on('community_message_received', onMessage);
    socket.on('profile_updated', onProfileUpdated);
    socket.on('community_user_typing', onTyping);
    socket.on('community_message_reaction_updated', onReactionUpdated);
    socket.on('community_message_updated', onMsgUpdated);
    socket.on('community_frozen', onCommunityFrozen);
    socket.on('community_error', onCommunityError);

    // Private circle: your request was answered (you're in -> load the circle
    // and its live room), or, for the Owner/Admins, the Requests list changed.
    const onJoinRequestUpdated = ({ communityId, status }) => {
      if (communityId !== numericId) return;
      if (status === 'accepted') {
        showToast("🐾 You're in! Welcome to the pack.");
        loadCommunityDetails().then(() => socket.emit('join_community_chat', { communityId: numericId }));
      } else {
        showToast('Your request to join was declined.');
        loadCommunityDetails();
      }
    };
    const onJoinRequestsChanged = ({ communityId }) => {
      if (communityId === numericId) loadJoinRequests();
    };
    socket.on('community_join_request_updated', onJoinRequestUpdated);
    socket.on('community_join_requests_changed', onJoinRequestsChanged);

    // Ownership transfer: started / cancelled / answered / expired (the two
    // sides), and the circle's owner changed (everyone with the page open).
    const onTransferUpdated = ({ communityId }) => {
      if (communityId === numericId) loadTransfer();
    };
    const onOwnershipChanged = ({ communityId, ownerId }) => {
      if (communityId !== numericId) return;
      if (ownerId === user?.id) showToast("🐾 You're now the owner of this PawCircle!");
      loadCommunityDetails();
    };
    socket.on('community_transfer_updated', onTransferUpdated);
    socket.on('community_ownership_changed', onOwnershipChanged);

    return () => {
      socket.off('connect', onReconnect);
      socket.off('community_transfer_updated', onTransferUpdated);
      socket.off('community_ownership_changed', onOwnershipChanged);
      socket.off('community_join_request_updated', onJoinRequestUpdated);
      socket.off('community_join_requests_changed', onJoinRequestsChanged);
      socket.off('community_disabled', onCommunityDisabled);
      socket.off('community_enabled', onCommunityEnabled);
      socket.off('community_poll_created', onPollCreated);
      socket.off('community_frozen', onCommunityFrozen);
      socket.off('community_error', onCommunityError);
      socket.off('community_message_received', onMessage);
      socket.off('profile_updated', onProfileUpdated);
      socket.off('community_user_typing', onTyping);
      socket.off('community_message_reaction_updated', onReactionUpdated);
      socket.off('community_message_updated', onMsgUpdated);
      socket.emit('leave_community_chat', { communityId: numericId });
    };
  }, [numericId, getSocket, user?.id]);

  // Both of these used to live further down, after this component's
  // `if (loading) return` / `if (!community) return` early returns -- on
  // the very first render (community still null, nothing fetched yet),
  // the function body returns before ever reaching their `const`
  // declaration, so that render's closure captures them in a permanent
  // temporal-dead-zone. loadCommunityDetails and the socket handlers
  // below call them from an effect built on that same early-returning
  // render, which threw "Cannot access before initialization" on every
  // single open of a PawCircle -- caught by loadCommunityDetails' catch
  // block, which then wiped the community it had just successfully
  // fetched and showed "PawCircle Unavailable" instead. Declaring them
  // up here, ahead of both early returns, means every render reaches
  // them regardless of which branch it takes.
  const loadTransfer = async (circleId = id) => {
    try {
      const res = await api.get(`/communities/${circleId}/ownership-transfer`);
      setTransfer(res.transfer || null);
    } catch {
      setTransfer(null);
    }
  };

  const loadJoinRequests = async (circleId = id) => {
    try {
      const res = await api.get(`/communities/${circleId}/join-requests`);
      setJoinRequests(res.requests || []);
    } catch {
      setJoinRequests([]);
    }
  };

  const loadCommunityDetails = async () => {
    setLoading(true);
    setNoLongerAvailable(false);
    try {
      // The server's :id param resolver (routes/communities.js) accepts
      // either the numeric id or the slug directly -- no need to parse id
      // here (it used to be force-coerced to a number with a `|| 1`
      // fallback, which silently mangled a slug into garbage and, worse,
      // defaulted to community #1 for anything that didn't parse).
      const res = await api.get(`/communities/${id}`);
      if (!res.community) {
        setCommunity(null);
        setLoading(false);
        return;
      }
      setCommunity(res.community);

      // Upgrade the address bar to the readable slug URL (/community/kitty-club
      // instead of /community/312) once it's known -- covers every way this
      // page can be reached (a numeric link, an older bookmark, or already
      // being on the slug URL, in which case this is a no-op). replace: true
      // so this doesn't add a junk back-button entry. Same pattern as
      // ProfilePage's username upgrade.
      if (res.community.slug && id !== res.community.slug) {
        navigate(`/community/${res.community.slug}`, { replace: true, state: location.state });
      }

      // A private circle you're not in: only its public info, nothing else
      // to load (the server refuses the rest anyway).
      if (res.community.locked) {
        setActiveSubTab('details');
        setAnnouncements([]);
        setMessages([]);
        setPhotos([]);
        setPolls([]);
        setMembers([]);
        setFiles([]);
        setJoinRequests([]);
        setTransfer(null);
        return;
      }

      // Check if opened via unique invite link (?invite=true)
      const query = new URLSearchParams(location.search);
      const isInvite = query.get('invite') === 'true';

      const managesCircle = ['Owner', 'Admin'].includes(res.community.userRole);
      if (location.state?.openRequests && managesCircle && res.community.is_private) {
        setActiveSubTab('requests');
      } else if (location.state?.announcementId || location.state?.eventId || location.state?.openAnnouncements) {
        setActiveSubTab('announcements');
      } else if (isInvite) {
        if (res.community.joinStatus === 'Joined') {
          setActiveSubTab('chat');
        } else {
          setActiveSubTab('details');
        }
      } else if (res.community.joinStatus !== 'Joined') {
        setActiveSubTab('details');
      } else {
        setActiveSubTab('chat');
      }

      // These content endpoints now correctly 403 for non-members (server-side
      // membership check). A non-member is still allowed to see this page's
      // public info (already set via setCommunity above) -- so each call is
      // individually swallowed here rather than left to reject the whole
      // Promise.all, which would otherwise hit the catch block below and
      // wipe community back to null even though the public fetch succeeded.
      // highlightId ensures a notification's specific announcement is
      // included even if it's aged out of the default window -- without
      // it, clicking an older announcement notification landed on this
      // tab without the announcement it was actually about ever appearing.
      const highlightId = location.state?.announcementId;
      const announcementsUrl = highlightId
        ? `/communities/${id}/announcements?highlightId=${highlightId}`
        : `/communities/${id}/announcements`;
      const [annRes, msgRes, photoRes, pollRes, memRes] = await Promise.all([
        api.get(announcementsUrl).catch(() => ({})),
        api.get(`/communities/${id}/messages`).catch(() => ({})),
        api.get(`/communities/${id}/photos`).catch(() => ({})),
        api.get(`/communities/${id}/polls`).catch(() => ({})),
        api.get(`/communities/${id}/members`).catch(() => ({}))
      ]);

      setAnnouncements(annRes.announcements || []);
      setMessages(msgRes.messages || []);
      setPhotos(photoRes.photos || []);
      setPolls(pollRes.polls || []);
      setMembers(memRes.members || []);
      if (res.community.is_private && managesCircle) loadJoinRequests(id);
      else setJoinRequests([]);
      loadTransfer(id);

      // Reactions are persisted server-side (community_message_reactions)
      // and come back embedded on each message -- same pattern as 1:1 chat.
      setMessageReactions(prev => {
        const next = { ...prev };
        (msgRes.messages || []).forEach(m => {
          if (m.reactions && Object.keys(m.reactions).length > 0) {
            next[m.id] = m.reactions;
          } else {
            delete next[m.id];
          }
        });
        return next;
      });

      const fileMessages = (msgRes.messages || []).filter(m => m.message_type === 'file');
      setFiles(fileMessages);

      setTimeout(() => scrollChatToBottom(false), 100);
    } catch (err) {
      if (err?.code === 'COMMUNITY_UNAVAILABLE') setNoLongerAvailable(true);
      else console.error(err);
      setCommunity(null);
    } finally {
      setLoading(false);
    }
  };

  const handleSendMessage = async (e) => {
    e.preventDefault();
    if (!newMsg.trim()) return;
    stopTyping();
    try {
      const payload = { content: newMsg };
      if (replyingTo) payload.reply_to_id = replyingTo.id;
      const res = await api.post(`/communities/${id}/messages`, payload);
      // Show it immediately -- don't wait on the socket echo (join-room timing
      // can lag right after mount, which used to mean the sender's own message
      // only appeared after leaving and re-entering the community).
      if (res && res.message) {
        setMessages(prev => prev.some(m => m.id === res.message.id) ? prev : [...prev, res.message]);
        scrollChatToBottom();
      }
      setNewMsg('');
      setReplyingTo(null);
    } catch (err) {
      if (!handleReadOnlyError(err)) notifyActionError(err);
    }
  };

  const handleConfirmFetchBackCommunity = (messageId) => {
    if (!messageId) return;
    setConfirmFetchBackModal(null);
    if (isFrozen) {
      showToast(readOnlyMessage);
      return;
    }

    setMessages(prev => prev.map(m => m.id === messageId ? {
      ...m,
      content: '🐾 This message was fetched back.',
      message_type: 'system',
      media_url: null
    } : m));

    const socket = getSocket();
    if (socket) {
      socket.emit('fetch_back_community_message', { messageId });
    }
  };

  const handleMediaUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('media', file);

    try {
      const res = await api.post(`/communities/${id}/messages`, formData);
      // The REST call already persisted the message and broadcast it to the
      // room over sockets server-side -- appending locally here (instead of
      // re-emitting another 'send_community_message' and reloading the whole
      // page) avoids both a duplicate message row and the full-page reload
      // that used to reset scroll position on every upload.
      if (res && res.message) {
        setMessages(prev => prev.some(m => m.id === res.message.id) ? prev : [...prev, res.message]);
        if (res.message.message_type === 'file') {
          setFiles(prev => [...prev, res.message]);
        }
        scrollChatToBottom();
      }
    } catch (err) {
      if (handleReadOnlyError(err)) {
        // Frozen circle: handled (read-only banner + toast).
      } else if (isQuotaExceededError(err)) {
        setUpsell(quotaUpsellCopy(err));
      } else {
        console.error(err);
      }
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handlePostAnnouncement = async (e) => {
    e.preventDefault();
    if (!annTitle.trim() || !annContent.trim()) return;

    // If marked as an event, require a chosen location
    if (isEventAnnouncement && !selectedEventLocation) {
      alert('Please search and select the event location, or turn off "Nearby Event".');
      return;
    }

    try {
      const res = await api.post(`/communities/${id}/announcements`, {
        title: annTitle,
        content: annContent,
        is_event: isEventAnnouncement ? 1 : 0,
        latitude: isEventAnnouncement ? selectedEventLocation.lat : null,
        longitude: isEventAnnouncement ? selectedEventLocation.lng : null,
        location_name: isEventAnnouncement ? selectedEventLocation.display_name : null,
      });
      setAnnouncements(prev => [res.announcement, ...prev].slice(0, 3));
      setAnnTitle('');
      setAnnContent('');
      setIsEventAnnouncement(false);
      setEventLocationQuery('');
      setEventLocationResults([]);
      setSelectedEventLocation(null);
      setShowAnnForm(false);

      // Auto-insert system message notify
      await api.post(`/communities/${id}/messages`, {
        content: `📣 Announcement Pinned: ${annTitle}`,
        message_type: 'system'
      });
    } catch (err) {
      if (!handleReadOnlyError(err)) notifyActionError(err);
    }
  };

  const handleEventLocationSearch = async (query) => {
    setEventLocationQuery(query);
    setSelectedEventLocation(null);
    if (!query.trim() || query.trim().length < 3) {
      setEventLocationResults([]);
      return;
    }
    setEventLocationSearching(true);
    try {
      const res = await api.get(`/profile/places-autocomplete?q=${encodeURIComponent(query)}`);
      setEventLocationResults(res.results || []);
    } catch (err) {
      console.error('Places autocomplete failed:', err);
      setEventLocationResults([]);
    } finally {
      setEventLocationSearching(false);
    }
  };

  const handleSelectEventLocation = async (prediction) => {
    setEventLocationResults([]);
    setEventLocationQuery(prediction.display_name);
    try {
      const res = await api.get(`/profile/place-details?place_id=${encodeURIComponent(prediction.place_id)}`);
      if (res && res.lat != null && res.lng != null) {
        setSelectedEventLocation({ display_name: res.display_name || prediction.display_name, lat: res.lat, lng: res.lng });
      } else {
        alert('Could not get exact location for that place. Please try another result.');
      }
    } catch (err) {
      console.error('Place details lookup failed:', err);
      alert('Could not get exact location for that place. Please try another result.');
    }
  };

  const addPollOption = () => setPollOptions(p => [...p, '']);
  const updatePollOption = (idx, val) => {
    const next = [...pollOptions];
    next[idx] = val;
    setPollOptions(next);
  };

  const handleCreatePoll = async (e) => {
    e.preventDefault();
    const opts = pollOptions.filter(o => o.trim());
    if (!pollQuestion.trim() || opts.length < 2) return;

    try {
      // The server posts the "New Pack Poll" line in the chat itself.
      const res = await api.post(`/communities/${id}/polls`, {
        question: pollQuestion,
        options: opts,
      });
      setPolls(prev => (prev.some(p => p.id === res.poll.id) ? prev : [res.poll, ...prev]));
      setPollQuestion('');
      setPollOptions(['', '']);
      setShowPollForm(false);
    } catch (err) {
      if (!handleReadOnlyError(err)) showToast(err.message || 'Could not create the poll.');
    }
  };

  const handleVote = async (pollId, optIdx) => {
    try {
      const res = await api.post(`/communities/${id}/polls/${pollId}/vote`, {
        optionIndex: optIdx
      });
      setPolls(prev => prev.map(p => p.id === pollId ? res.poll : p));
    } catch (err) {
      if (!handleReadOnlyError(err)) notifyActionError(err);
    }
  };

  const handleUpdateRole = async (targetUserId, newRole) => {
    try {
      await api.post(`/communities/${id}/members/${targetUserId}/role`, { role: newRole });
      const memRes = await api.get(`/communities/${id}/members`);
      setMembers(memRes.members || []);
      const detailRes = await api.get(`/communities/${id}`);
      setCommunity(detailRes.community);
    } catch (err) {
      if (!handleReadOnlyError(err)) alert('Role assignment permission denied!');
    }
  };

  const renderCommunityBadges = (comm) => {
    const list = [];
    if (comm.is_private) {
      list.push(
        <span key="p" className="material-symbols-outlined text-[14px] text-zinc-400" title="Private PawCircle">
          lock
        </span>
      );
    }
    if (comm.verified) {
      list.push(
        <span key="v" className="material-symbols-outlined text-[14px] text-sky-500" title="Verified Community">
          verified
        </span>
      );
    }
    if ((comm.member_count || 0) >= 100) {
      list.push(
        <span key="t" className="material-symbols-outlined text-[14px] text-yellow-500" title="Top PawCircle">
          military_tech
        </span>
      );
    }
    const nameLower = (comm.name || '').toLowerCase();
    if (nameLower.includes('golden') || nameLower.includes('retriever')) {
      list.push(<span key="b" className="text-xs" title="Golden Retriever Club">🐶</span>);
    } else if (nameLower.includes('cat') || nameLower.includes('persian') || nameLower.includes('rescue')) {
      list.push(<span key="c" className="text-xs" title="Cat rescue / Breed">🐱</span>);
    }

    if (list.length === 0) return null;
    return <div className="flex items-center gap-1 ml-1">{list}</div>;
  };

  if (loading) {
    return (
      <div className="bg-surface min-h-screen pt-24 lg:pt-8 px-4 lg:px-8 text-center animate-pulse max-w-lg mx-auto">
        <div className="h-16 bg-zinc-100 dark:bg-zinc-800 rounded-2xl mb-8" />
        <div className="h-[400px] bg-zinc-50 dark:bg-zinc-800 rounded-[2.5rem]" />
      </div>
    );
  }

  if (!community) {
    return (
      <div className="bg-surface min-h-screen pt-24 px-6 text-center max-w-md mx-auto flex flex-col items-center justify-center space-y-4">
        <div className="w-16 h-16 rounded-full bg-rose-50 dark:bg-rose-950/40 text-rose-500 flex items-center justify-center text-3xl shadow-sm">
          🐾
        </div>
        <h2 className="text-lg font-extrabold text-on-surface">PawCircle Unavailable</h2>
        <p className="text-xs text-zinc-500">
          {noLongerAvailable ? 'This PawCircle is no longer available.' : 'This PawCircle could not be found or has been moved.'}
        </p>
        <button
          onClick={() => navigate('/chat?tab=pawcircle')}
          className="px-6 py-3 bg-primary text-white font-extrabold text-xs rounded-full shadow-md active:scale-95 transition-all"
        >
          Explore PawCircles
        </button>
      </div>
    );
  }

  const isMember = community.joinStatus === 'Joined';
  const isOwner = community.userRole === 'Owner';
  const isAdmin = community.userRole === 'Admin';
  const canManage = isOwner || isAdmin;

  const openTransferPicker = async () => {
    setShowOptionsMenu(false);
    setTransferSearch('');
    setShowTransferPicker(true);
    try {
      const res = await api.get(`/communities/${id}/members?limit=200`);
      setTransferMembers(res.members || []);
    } catch {
      setTransferMembers(members);
    }
  };

  const handleStartTransfer = async () => {
    if (!transferConfirm || transferBusy) return;
    setTransferBusy(true);
    try {
      await api.post(`/communities/${id}/ownership-transfer`, { toUserId: transferConfirm.user_id });
      showToast(`Transfer request sent to @${transferConfirm.username}.`);
      setTransferConfirm(null);
      setShowTransferPicker(false);
      loadTransfer();
    } catch (err) {
      if (!handleReadOnlyError(err)) showToast(err.message || 'Could not start the transfer. Please try again.');
    } finally {
      setTransferBusy(false);
    }
  };

  const handleCancelTransfer = async () => {
    if (transferBusy) return;
    setTransferBusy(true);
    try {
      await api.delete(`/communities/${id}/ownership-transfer`);
      showToast('Ownership transfer cancelled.');
    } catch (err) {
      showToast(err.message || 'Could not cancel the transfer.');
    } finally {
      setTransferBusy(false);
      loadTransfer();
    }
  };

  // The recipient answers.
  const handleRespondTransfer = async (action) => {
    if (!transfer || transferBusy) return;
    setTransferBusy(true);
    try {
      await api.post(`/communities/${id}/ownership-transfer/${transfer.id}/${action}`);
      if (action === 'accept') {
        showToast(`🐾 You're now the owner of '${community.name}'!`);
        setTransfer(null);
        loadCommunityDetails();
      } else {
        showToast('Ownership transfer declined.');
        setTransfer(null);
      }
    } catch (err) {
      // e.g. OWNER_LIMIT_REACHED: the server's message says what to do.
      showToast(err.message || 'Something went wrong. Please try again.');
      if (['TRANSFER_NOT_PENDING', 'TRANSFER_EXPIRED', 'TRANSFER_NOT_FOUND', 'NOT_A_MEMBER', 'TRANSFER_STALE'].includes(err?.code)) loadTransfer();
    } finally {
      setTransferBusy(false);
    }
  };

  const handleRequestJoin = async () => {
    if (requestBusy) return;
    setRequestBusy(true);
    try {
      const res = await api.post(`/communities/${id}/join-request`);
      setCommunity(prev => (prev ? { ...prev, joinStatus: 'Requested', requestExpiresAt: res.request?.expiresAt || null, requestCooldownUntil: null } : prev));
      showToast('🐾 Request sent! The PawCircle admins will review it.');
    } catch (err) {
      if (isPremiumGateError(err)) {
        setUpsell({ title: 'PawCircle Limit Reached', message: err.message });
      } else if (['REQUEST_COOLDOWN', 'ALREADY_MEMBER', 'NOT_PRIVATE'].includes(err?.code)) {
        showToast(err.message);
        loadCommunityDetails();
      } else if (!handleReadOnlyError(err)) {
        showToast(err.message || 'Could not send your request. Please try again.');
      }
    } finally {
      setRequestBusy(false);
    }
  };

  const handleCancelRequest = async () => {
    if (requestBusy) return;
    setRequestBusy(true);
    try {
      await api.delete(`/communities/${id}/join-request`);
      setCommunity(prev => (prev ? { ...prev, joinStatus: 'Request to Join', requestExpiresAt: null } : prev));
      showToast('Request cancelled.');
    } catch (err) {
      showToast(err.message || 'Could not cancel the request.');
      loadCommunityDetails();
    } finally {
      setRequestBusy(false);
    }
  };

  // Owner/Admin: accept or decline one request.
  const handleDecideRequest = async (request, decision) => {
    if (decidingRequestId) return;
    setDecidingRequestId(request.id);
    try {
      await api.post(`/communities/${id}/join-requests/${request.id}/${decision}`);
      setJoinRequests(prev => prev.filter(r => r.id !== request.id));
      const who = request.pet_name || request.username || 'They';
      showToast(decision === 'accept' ? `🐾 ${who} is in!` : 'Request declined.');
      if (decision === 'accept') {
        const [detailRes, memberRes] = await Promise.all([
          api.get(`/communities/${id}`).catch(() => null),
          api.get(`/communities/${id}/members`).catch(() => null),
        ]);
        if (detailRes?.community) setCommunity(detailRes.community);
        if (memberRes?.members) setMembers(memberRes.members);
      }
    } catch (err) {
      if (['REQUEST_NOT_PENDING', 'REQUEST_EXPIRED', 'REQUEST_NOT_FOUND'].includes(err?.code)) {
        showToast(err.message);
        loadJoinRequests();
      } else if (!handleReadOnlyError(err)) {
        // e.g. REQUESTER_LIMIT_REACHED: the server's message says what to do.
        showToast(err.message || 'Something went wrong. Please try again.');
      }
    } finally {
      setDecidingRequestId(null);
    }
  };

  // Info tab button for a private circle you're not in.
  const renderRequestAction = () => {
    if (community.joinStatus === 'Requested') {
      return (
        <div className="mt-6 space-y-2">
          <div className="w-full py-4 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-300 font-bold text-xs uppercase tracking-widest flex items-center justify-center gap-2">
            <span className="material-symbols-outlined text-sm">schedule</span>
            <span>Requested</span>
          </div>
          <button
            type="button"
            onClick={handleCancelRequest}
            disabled={requestBusy}
            className="w-full py-2 text-[11px] font-black uppercase tracking-widest text-rose-500 hover:underline disabled:opacity-50"
          >
            Cancel request
          </button>
        </div>
      );
    }
    const cooldownMs = community.requestCooldownUntil ? new Date(community.requestCooldownUntil).getTime() - Date.now() : 0;
    if (cooldownMs > 0) {
      return (
        <div className="w-full py-4 mt-6 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-300 font-bold text-[11px] text-center px-4">
          Your request was declined. You can ask again in {Math.ceil(cooldownMs / 3600000)} hour(s).
        </div>
      );
    }
    return (
      <button
        onClick={handleRequestJoin}
        disabled={requestBusy}
        className="w-full py-4 mt-6 rounded-full bg-gradient-to-r from-primary to-primary-fixed-dim text-white font-bold text-xs uppercase tracking-widest shadow-lg active:scale-95 transition-transform flex items-center justify-center gap-2 disabled:opacity-60"
      >
        <span className="material-symbols-outlined text-sm">lock</span>
        <span>Request to Join</span>
      </button>
    );
  };

  const handleJoin = async () => {
    try {
      const res = await api.post(`/communities/${id}/join`);
      setCommunity(res.community);
      // The live room only admits members, and the page's first attempt (on
      // mount, before joining) was refused -- ask again now.
      getSocket()?.emit('join_community_chat', { communityId: res.community.id });
      // Reload details
      loadCommunityDetails();
    } catch (err) {
      if (isPremiumGateError(err)) {
        setUpsell({ title: 'PawCircle Limit Reached', message: err.message });
      } else if (err?.code === 'APPROVAL_REQUIRED') {
        // The circle became private since this page loaded.
        showToast(err.message);
        loadCommunityDetails();
      } else if (!handleReadOnlyError(err)) {
        notifyActionError(err, "Couldn't join the PawCircle. Please try again.");
      }
    }
  };

  return (
    <div className="bg-surface text-on-surface min-h-screen pt-24 lg:pt-8 px-4 lg:px-8 text-left max-w-lg mx-auto pb-24 animate-slide-up">
      <PawClipDefs />
      {/* Unified header + tab bar card */}
      <div className="bg-white dark:bg-zinc-900 rounded-[2rem] border border-outline-variant/10 shadow-sm mb-6 sticky top-24 lg:top-8 z-40">
      <header className="flex items-center justify-between px-4 py-3">
        <button
          onClick={() => {
            if (activeSubTab !== 'chat' && isMember) {
              setActiveSubTab('chat');
            } else {
              navigate('/chat?tab=pawcircle');
            }
          }}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500 hover:text-primary transition-colors text-xs font-bold uppercase tracking-widest active:scale-95"
        >
          <span className="material-symbols-outlined text-sm">arrow_back</span>
          Back
        </button>
        <div className="text-center">
          <h2 className="text-sm font-extrabold tracking-widest uppercase text-on-surface flex items-center justify-center">
            {community.name}
            {renderCommunityBadges(community)}
          </h2>
          <p className="text-[9px] font-bold text-zinc-400 uppercase tracking-widest mt-0.5">
            {community.member_count} Members{community.locked ? ' • Private' : ` • ${community.activeMembersCount || 2} Active Today`}
          </p>
        </div>
        <div className="relative">
          <button
            onClick={() => setShowOptionsMenu(!showOptionsMenu)}
            className="w-8 h-8 rounded-full bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center text-zinc-500 hover:text-primary active:scale-95 transition-transform"
          >
            <span className="material-symbols-outlined text-sm">more_vert</span>
          </button>

          {showOptionsMenu && (
            <div className="absolute right-0 top-10 z-50 bg-white dark:bg-zinc-900 rounded-2xl shadow-xl border border-outline-variant/20 py-2 w-52 animate-scale-up text-left overflow-hidden">
              <button
                onClick={() => { setShowOptionsMenu(false); setActiveSubTab('details'); }}
                className="w-full px-4 py-2.5 text-xs font-bold text-on-surface hover:bg-zinc-50 dark:hover:bg-zinc-800 flex items-center gap-2.5 transition-colors cursor-pointer"
              >
                <span className="material-symbols-outlined text-sm text-zinc-400">info</span>
                <span>Info & Rules</span>
              </button>

              {isMember && (
                <button
                  onClick={() => { setShowOptionsMenu(false); setShowDeleteModal(true); }}
                  className="w-full px-4 py-2.5 text-xs font-bold text-on-surface hover:bg-zinc-50 dark:hover:bg-zinc-800 flex items-center gap-2.5 transition-colors cursor-pointer"
                >
                  <span className="material-symbols-outlined text-sm text-zinc-400">delete</span>
                  <span>Delete Group</span>
                </button>
              )}

              {isMember && (
                <button
                  onClick={() => { setShowOptionsMenu(false); setShowRetractModal(true); }}
                  className="w-full px-4 py-2.5 text-xs font-bold text-on-surface hover:bg-zinc-50 dark:hover:bg-zinc-800 flex items-center gap-2.5 transition-colors cursor-pointer"
                >
                  <span className="material-symbols-outlined text-sm text-zinc-400">logout</span>
                  <span>Retract</span>
                </button>
              )}

              <button
                onClick={() => { setShowOptionsMenu(false); setShowReportModal(true); }}
                className="w-full px-4 py-2.5 text-xs font-bold text-on-surface hover:bg-zinc-50 dark:hover:bg-zinc-800 flex items-center gap-2.5 transition-colors cursor-pointer"
              >
                <span className="material-symbols-outlined text-sm text-zinc-400">flag</span>
                <span>Report</span>
              </button>

              {isOwner && !isFrozen && (
                <button
                  onClick={openTransferPicker}
                  className="w-full px-4 py-2.5 text-xs font-bold text-on-surface hover:bg-zinc-50 dark:hover:bg-zinc-800 flex items-center gap-2.5 transition-colors cursor-pointer"
                >
                  <span className="material-symbols-outlined text-sm text-zinc-400">swap_horiz</span>
                  <span>Transfer Ownership</span>
                </button>
              )}

              {isOwner && isDisabled && !isOwnerGone && (
                <button
                  onClick={() => { setShowOptionsMenu(false); handleEnableCommunity(); }}
                  className="w-full px-4 py-2.5 text-xs font-bold text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950/40 flex items-center gap-2.5 border-t border-zinc-100 dark:border-zinc-800 mt-1 pt-2 transition-colors cursor-pointer"
                >
                  <span className="material-symbols-outlined text-sm">restart_alt</span>
                  <span>Re-enable PawCircle</span>
                </button>
              )}

              {/* Creator Only Option */}
              {!isFrozen && (isOwner || community.created_by === user.id) && (
                <button
                  onClick={() => { setShowOptionsMenu(false); setShowDisableModal(true); }}
                  className="w-full px-4 py-2.5 text-xs font-bold text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40 flex items-center gap-2.5 border-t border-zinc-100 dark:border-zinc-800 mt-1 pt-2 transition-colors cursor-pointer"
                >
                  <span className="material-symbols-outlined text-sm">block</span>
                  <span>Disable PawCircle</span>
                </button>
              )}
            </div>
          )}
        </div>
      </header>

      {/* Tab bar */}
      <div className="flex border-t border-zinc-100 dark:border-zinc-800 overflow-x-auto no-scrollbar px-3 py-2 gap-1.5">
        {[
          { id: 'chat', label: '💬 Chat', disabled: !isMember },
          { id: 'announcements', label: '📣 Pinned', disabled: !isMember },
          { id: 'media', label: '🖼 Media', disabled: !isMember },
          { id: 'files', label: '📁 Files', disabled: !isMember },
          { id: 'polls', label: '📊 Polls', disabled: !isMember },
          { id: 'members', label: '👥 Members', disabled: !isMember },
          ...(canManage && community.is_private
            ? [{ id: 'requests', label: `🙋 Requests${joinRequests.length ? ` (${joinRequests.length})` : ''}` }]
            : []),
          { id: 'details', label: 'ℹ Info' }
        ].map(tab => (
          <button
            key={tab.id}
            disabled={tab.disabled}
            onClick={() => setActiveSubTab(tab.id)}
            className={`px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all flex-shrink-0
              ${tab.disabled ? 'opacity-40 cursor-not-allowed' : ''}
              ${activeSubTab === tab.id ? 'bg-primary text-white shadow-sm shadow-primary/20' : 'text-zinc-400 hover:bg-zinc-50'}`}
          >
            {tab.label}
          </button>
        ))}
      </div>
      </div>

      {isFrozen && (
        <div role="note" className="mb-4 flex items-start gap-2.5 rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-zinc-100 dark:bg-zinc-800 px-4 py-3 text-xs font-bold text-zinc-500 dark:text-zinc-300">
          <span className="material-symbols-outlined text-base text-zinc-400 flex-shrink-0">lock</span>
          <span className="flex-1">{readOnlyMessage}</span>
          {isDisabled && !isOwnerGone && isOwner && (
            <button type="button" onClick={handleEnableCommunity} className="text-[10px] font-black uppercase tracking-wider text-emerald-600 hover:underline flex-shrink-0">
              Re-enable
            </button>
          )}
        </div>
      )}

      {transfer?.isSender && (
        <div role="note" className="mb-4 flex items-center gap-2.5 rounded-2xl border border-amber-200 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-950/30 px-4 py-3 text-xs font-bold text-amber-700 dark:text-amber-300">
          <span className="material-symbols-outlined text-base flex-shrink-0">swap_horiz</span>
          <span className="flex-1">
            Ownership transfer to @{transfer.toUsername} is pending until {new Date(transfer.expiresAt).toLocaleDateString([], { day: 'numeric', month: 'short' })}.
          </span>
          <button type="button" onClick={handleCancelTransfer} disabled={transferBusy} className="text-[10px] font-black uppercase tracking-wider text-rose-600 hover:underline disabled:opacity-50">
            Cancel
          </button>
        </div>
      )}
      {transfer?.isRecipient && (
        <div role="note" className="mb-4 rounded-2xl border border-primary/20 bg-primary/5 px-4 py-3 space-y-2.5">
          <p className="text-xs font-bold text-on-surface">
            @{transfer.fromUsername} wants to transfer ownership of '{community.name}' to you.
          </p>
          {isOwnerGone && (
            <p className="text-[10px] font-bold text-zinc-500">Accepting brings this read-only PawCircle back, with you as its owner.</p>
          )}
          <div className="flex gap-2">
            <button type="button" onClick={() => handleRespondTransfer('decline')} disabled={transferBusy}
              className="flex-1 py-2 rounded-xl bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 text-[11px] font-black uppercase tracking-wider disabled:opacity-50">
              Decline
            </button>
            <button type="button" onClick={() => handleRespondTransfer('accept')} disabled={transferBusy}
              className="flex-[2] py-2 rounded-xl bg-primary text-white text-[11px] font-black uppercase tracking-wider shadow-sm disabled:opacity-50">
              Accept
            </button>
          </div>
        </div>
      )}

      <div className={`bg-white dark:bg-zinc-900 rounded-[2.5rem] p-6 shadow-sm border border-outline-variant/10 ${activeSubTab === 'chat' ? 'h-[460px]' : ''}`}>
        {/* Chat tab (default view) */}
        {activeSubTab === 'chat' && isMember && (
          <div className="flex flex-col h-full justify-between">
            <div ref={chatScrollRef} className="flex-1 overflow-y-auto space-y-4 pr-1 no-scrollbar mb-4">
              {/* announcements inside chat stream */}
              {announcements.slice(0, 1).map(ann => (
                <div key={ann.id} className="bg-yellow-50 border border-yellow-100 rounded-2xl p-3 flex gap-2 items-start text-left shadow-sm">
                  <span className="material-symbols-outlined text-yellow-600 text-lg">campaign</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-[10px] font-black text-yellow-800 uppercase tracking-widest">Pinned Announcement</p>
                    <p className="text-[11px] font-bold text-yellow-900 mt-0.5 truncate">{ann.title}</p>
                    <p className="text-[10px] text-zinc-500 font-medium leading-relaxed mt-0.5 line-clamp-2">{ann.content}</p>
                  </div>
                </div>
              ))}

              {messages.map((msg, i) => {
                const isOwn = msg.sender_id === user.id;
                const isSystem = msg.message_type === 'system';

                if (isSystem) {
                  return (
                    <div key={msg.id || i} className="text-center my-3">
                      <span className="inline-block bg-zinc-100 dark:bg-zinc-800 text-[10px] font-black tracking-wider text-zinc-500 uppercase px-4 py-1.5 rounded-full border border-zinc-200/20">
                        {msg.content}
                      </span>
                    </div>
                  );
                }

                const replyPreview = msg.reply_to_id ? (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); scrollToMessage(msg.reply_to_id); }}
                    className={`flex items-start gap-2 px-3 py-2 rounded-xl text-[10px] mb-1 max-w-full cursor-pointer transition-all hover:opacity-80 active:scale-[0.98] border ${
                      isOwn
                        ? 'bg-white/15 border-white/20 text-white/80'
                        : 'bg-zinc-200/60 dark:bg-zinc-700/50 border-zinc-300/40 dark:border-zinc-600/40 text-zinc-500 dark:text-zinc-400'
                    }`}
                  >
                    <div className={`w-0.5 h-full min-h-[20px] rounded-full flex-shrink-0 ${isOwn ? 'bg-white/40' : 'bg-primary/40'}`} />
                    <div className="flex flex-col items-start text-left overflow-hidden">
                      <span className="font-extrabold text-[9px] uppercase tracking-wider">
                        {msg.reply_sender_id === user?.id ? 'You' : (msg.reply_sender_username || 'Pack member')}
                      </span>
                      <span className="truncate max-w-[180px] font-medium">
                        {msg.reply_message_type === 'voice' ? '🎤 Voice note' :
                         msg.reply_message_type === 'file' ? '📄 File' :
                         (msg.reply_content || '...')}
                      </span>
                    </div>
                  </button>
                ) : null;

                const reactionPills = messageReactions[msg.id] && Object.values(messageReactions[msg.id]).some(c => c > 0) && (
                  <div className={`absolute -bottom-2.5 ${isOwn ? '-left-2' : '-right-2'} flex items-center`}>
                    {Object.entries(messageReactions[msg.id]).filter(([, c]) => c > 0).map(([type, count], idx) => (
                      <span
                        key={type}
                        style={{ marginLeft: idx > 0 ? '-8px' : 0, zIndex: 10 - idx }}
                        className="w-5 h-5 rounded-full bg-white dark:bg-zinc-900 border border-outline-variant/15 shadow-md flex items-center justify-center text-[10px]"
                        title={`${REACTION_LABELS[type]}${count > 1 ? ` × ${count}` : ''}`}
                      >
                        {REACTION_EMOJIS[type]}
                      </span>
                    ))}
                  </div>
                );

                if (msg.message_type === 'voice') {
                  return (
                    <div key={msg.id || i} ref={el => { messageRefsMap.current[msg.id] = el; }} className={`flex gap-2 items-start ${isOwn ? 'justify-end ml-auto max-w-[80%]' : 'max-w-[80%]'} ${highlightMsgId === msg.id ? 'bg-primary/5 rounded-2xl' : ''}`}>
                      {!isOwn && (
                        msg.sniffed_out
                          ? <SniffedOutAvatar className="w-8 h-8 rounded-full shadow-sm mt-1" />
                          : <img className="w-8 h-8 rounded-full object-cover shadow-sm mt-1" src={avatarUrl(msg.sender_avatar) || publicAsset('/logo.png')} alt={msg.pet_name} loading="lazy" decoding="async" />
                      )}
                      <div className="relative">
                        {!isOwn && (
                          <span className="text-[9px] font-black text-zinc-400 uppercase tracking-widest ml-2 mb-0.5 block">{msg.sniffed_out ? <SniffedOutName /> : (msg.pet_name || msg.username)}</span>
                        )}
                        <div
                          onClick={(e) => handleMessageTap(msg, e)}
                          onTouchStart={() => startMessageLongPress(msg)}
                          onTouchMove={(e) => handleBubbleTouchMove(msg, e)}
                          onTouchEnd={() => handleBubbleTouchEnd(msg)}
                          onMouseDown={() => startMessageLongPress(msg)}
                          onMouseUp={() => cancelMessageLongPress(msg.id)}
                          onMouseLeave={() => cancelMessageLongPress(msg.id)}
                          className="cursor-pointer select-none"
                        >
                          {replyPreview}
                          {msg.media_url
                            ? <VoicePlayer audioUrl={msg.media_url} />
                            : <MediaUnavailable icon="mic_off" compact />}
                        </div>
                        {reactionPills}
                      </div>
                    </div>
                  );
                }

                return (
                  <div key={msg.id || i} ref={el => { messageRefsMap.current[msg.id] = el; }} className={`flex gap-2 items-start ${isOwn ? 'justify-end ml-auto max-w-[80%]' : 'max-w-[80%]'} ${highlightMsgId === msg.id ? 'bg-primary/5 rounded-2xl' : ''}`}>
                    {!isOwn && (
                      msg.sniffed_out
                          ? <SniffedOutAvatar className="w-8 h-8 rounded-full shadow-sm mt-1" />
                          : <img className="w-8 h-8 rounded-full object-cover shadow-sm mt-1" src={avatarUrl(msg.sender_avatar) || publicAsset('/logo.png')} alt={msg.pet_name} loading="lazy" decoding="async" />
                    )}
                    <div className="relative">
                      {!isOwn && (
                        <span className="text-[9px] font-black text-zinc-400 uppercase tracking-widest ml-2 mb-0.5 block">{msg.sniffed_out ? <SniffedOutName /> : (msg.pet_name || msg.username)}</span>
                      )}
                      <div
                        onClick={(e) => handleMessageTap(msg, e)}
                        onTouchStart={() => startMessageLongPress(msg)}
                        onTouchMove={(e) => handleBubbleTouchMove(msg, e)}
                        onTouchEnd={() => handleBubbleTouchEnd(msg)}
                        onMouseDown={() => startMessageLongPress(msg)}
                        onMouseUp={() => cancelMessageLongPress(msg.id)}
                        onMouseLeave={() => cancelMessageLongPress(msg.id)}
                        className={`px-4 py-2.5 text-xs leading-relaxed shadow-sm rounded-3xl cursor-pointer select-none transition-transform active:scale-[0.99]
                        ${isOwn ? 'bg-primary text-white rounded-tr-sm' : 'bg-zinc-50 dark:bg-zinc-800 text-on-surface border border-outline-variant/10 rounded-tl-sm'}`}>
                        {replyPreview}
                        {COMMUNITY_MEDIA_TYPES.includes(msg.message_type) && !msg.media_url ? (
                          <>
                            <MediaUnavailable compact icon={msg.message_type === 'file' ? 'description' : 'hide_image'} />
                            {msg.message_type !== 'file' && msg.content ? <div className="mt-1">{msg.content}</div> : null}
                          </>
                        ) : msg.media_url && ['image', 'video', 'text'].includes(msg.message_type) ? (
                          <>
                            {msg.message_type === 'video' || /\/video\/upload\/|\.(mp4|mov|webm)(\?|$)/i.test(msg.media_url) ? (
                              <video src={msg.media_url} controls playsInline preload="metadata" className="max-w-full max-h-64 rounded-2xl" />
                            ) : (
                              <img src={feedMediaUrl(msg.media_url) || msg.media_url} alt="Shared photo" loading="lazy" decoding="async" className="max-w-full max-h-64 rounded-2xl object-cover" />
                            )}
                            {msg.content ? <div className="mt-1">{msg.content}</div> : null}
                          </>
                        ) : msg.content}
                      </div>
                      {reactionPills}
                    </div>
                  </div>
                );
              })}
              <div ref={chatBottomRef} />
            </div>

            {typingUsername && (
              <div className="flex items-center gap-1.5 px-2 pb-1 text-[10px] font-bold text-primary uppercase tracking-widest">
                <span>{typingUsername} is typing</span>
                <TypingDots />
              </div>
            )}

            {replyingTo && (
              <div className="flex items-center justify-between gap-2 bg-primary-container/20 border border-primary/10 rounded-2xl px-3 py-2 mb-2 text-left">
                <div className="min-w-0 flex-1">
                  <p className="text-[9px] font-black uppercase tracking-wider text-primary">
                    🐾 Replying to {replyingTo.sender_id === user?.id ? 'your message' : (replyingTo.username || 'this message')}
                  </p>
                  <p className="text-[10px] text-on-surface-variant truncate">
                    {(replyingTo.message_type === 'voice' ? '🎤 Voice note' :
                      replyingTo.media_url && !replyingTo.content ? '🖼 Photo' :
                      (replyingTo.content || '')).substring(0, 60)}
                  </p>
                </div>
                <button type="button" onClick={() => setReplyingTo(null)} className="text-zinc-400 hover:text-on-surface flex-shrink-0">
                  <span className="material-symbols-outlined text-base">close</span>
                </button>
              </div>
            )}

            {/* Input area (none on a frozen, read-only circle) */}
            {!isFrozen && (
              <form onSubmit={handleSendMessage} className="flex gap-2 items-center bg-zinc-50 dark:bg-zinc-800 p-2 rounded-full border">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="text-zinc-400 hover:text-primary transition-colors ml-2"
                  title="Attach Document / Media"
                >
                  <span className="material-symbols-outlined text-lg">attach_file</span>
                </button>
                <input type="file" ref={fileInputRef} className="hidden" onChange={handleMediaUpload} />

                <input
                  ref={composerInputRef}
                  type="text"
                  placeholder="Send to the Pack..."
                  className="flex-1 bg-transparent border-none text-xs focus:ring-0 px-3 outline-none text-on-surface"
                  value={newMsg}
                  onChange={e => { setNewMsg(e.target.value); notifyTyping(); }}
                />
                <button type="submit" disabled={!newMsg.trim()} className="w-8 h-8 bg-primary rounded-full flex items-center justify-center text-white shadow-md transition-all active:scale-95 disabled:opacity-40">
                  <span className="material-symbols-outlined text-sm">send</span>
                </button>
              </form>
            )}
          </div>
        )}

        {/* Announcements */}
        {activeSubTab === 'announcements' && (
          <div className="space-y-4">
            {location.state?.isExpired && (
              <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200/60 dark:border-amber-900/40 rounded-2xl p-3.5 text-xs font-bold text-amber-800 dark:text-amber-200 flex items-center gap-2 mb-2 shadow-xs">
                <span className="text-base">⏳</span>
                <span>This event has already ended. Keep an eye on PawCircle for upcoming meetups! 🐾</span>
              </div>
            )}
            <div className="flex justify-between items-center mb-2">
              <h4 className="font-extrabold text-sm uppercase tracking-wider text-zinc-400">Pack Announcements</h4>
              {canManage && !isFrozen && (
                <button onClick={() => setShowAnnForm(!showAnnForm)} className="text-xs font-bold text-primary flex items-center gap-1">
                  <span className="material-symbols-outlined text-sm">add</span> Add Pinned
                </button>
              )}
            </div>

            {showAnnForm && !isFrozen && (
              <form onSubmit={handlePostAnnouncement} className="bg-zinc-50 dark:bg-zinc-800 rounded-3xl p-4 border border-outline-variant/10 space-y-3 mb-4">
                <input
                  type="text"
                  required
                  placeholder="Announcement Title"
                  className="w-full bg-white dark:bg-zinc-900 border-none rounded-xl py-2 px-4 text-xs font-bold text-on-surface"
                  value={annTitle}
                  onChange={e => setAnnTitle(e.target.value)}
                />
                <textarea
                  required
                  rows={2}
                  placeholder="Content body..."
                  className="w-full bg-white dark:bg-zinc-900 border-none rounded-xl py-2 px-4 text-xs resize-none text-on-surface"
                  value={annContent}
                  onChange={e => setAnnContent(e.target.value)}
                />

                {/* 📍 Nearby Event toggle */}
                <label className="flex items-center gap-2 cursor-pointer select-none px-1">
                  <input
                    type="checkbox"
                    checked={isEventAnnouncement}
                    onChange={e => {
                      setIsEventAnnouncement(e.target.checked);
                      if (!e.target.checked) {
                        setEventLocationQuery('');
                        setEventLocationResults([]);
                        setSelectedEventLocation(null);
                      }
                    }}
                    className="accent-primary w-4 h-4"
                  />
                  <span className="text-[11px] font-bold text-on-surface">📍 Make this a Nearby Event</span>
                </label>
                <p className="text-[9px] text-zinc-400 font-medium px-1 -mt-1">
                  Pet parents within 20km of the event location who aren't in this PawCircle will be notified.
                </p>

                {/* Location search (only when event toggle is on) */}
                {isEventAnnouncement && (
                  <div className="space-y-2">
                    <div className="relative">
                      <input
                        type="text"
                        placeholder="Search event location (e.g. Cubbon Park, Bangalore)"
                        className="w-full bg-white dark:bg-zinc-900 border border-primary/20 rounded-xl py-2 px-4 text-xs text-on-surface"
                        value={eventLocationQuery}
                        onChange={e => handleEventLocationSearch(e.target.value)}
                      />
                      {eventLocationSearching && (
                        <span className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                      )}
                    </div>

                    {/* Selected location confirmation */}
                    {selectedEventLocation && (
                      <div className="flex items-center gap-2 bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 rounded-xl px-3 py-2">
                        <span className="material-symbols-outlined text-emerald-500 text-sm">check_circle</span>
                        <span className="text-[10px] font-bold text-emerald-700 dark:text-emerald-300 truncate flex-1">{selectedEventLocation.display_name}</span>
                        <button
                          type="button"
                          onClick={() => { setSelectedEventLocation(null); setEventLocationQuery(''); setEventLocationResults([]); }}
                          className="text-emerald-500 hover:text-red-500"
                        >
                          <span className="material-symbols-outlined text-sm">close</span>
                        </button>
                      </div>
                    )}

                    {/* Search results dropdown */}
                    {!selectedEventLocation && eventLocationResults.length > 0 && (
                      <div className="bg-white dark:bg-zinc-900 border border-outline-variant/15 rounded-xl overflow-hidden max-h-40 overflow-y-auto no-scrollbar">
                        {eventLocationResults.map((r, idx) => (
                          <button
                            key={idx}
                            type="button"
                            onClick={() => handleSelectEventLocation(r)}
                            className="w-full text-left px-3 py-2 text-[10px] font-medium text-on-surface hover:bg-zinc-50 dark:hover:bg-zinc-800 border-b border-outline-variant/5 last:border-0 flex items-center gap-2"
                          >
                            <span className="material-symbols-outlined text-primary text-sm">location_on</span>
                            <span className="truncate">{r.display_name}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                <div className="flex justify-end gap-2">
                  <button type="button" onClick={() => setShowAnnForm(false)} className="px-3 py-1.5 bg-zinc-200 text-[10px] font-bold rounded-lg uppercase">Cancel</button>
                  <button type="submit" className="px-3 py-1.5 bg-primary text-white text-[10px] font-bold rounded-lg uppercase">Post Pinned</button>
                </div>
              </form>
            )}
            {announcements.length === 0 ? (
              <p className="text-xs text-zinc-400 italic text-center py-8">No pinned announcements yet.</p>
            ) : (
              <div className="space-y-3">
                {announcements.map(ann => (
                  <div key={ann.id} id={`announcement-${ann.id}`} className={`bg-yellow-50/50 border rounded-3xl p-4 relative shadow-sm ${String(ann.id) === String(location.state?.announcementId) ? 'border-yellow-500 ring-2 ring-yellow-400' : 'border-yellow-200/60'}`}>
                    <div className="flex items-center gap-2 mb-2">
                      {ann.sniffed_out
                        ? <SniffedOutAvatar className="w-6 h-6 rounded-full" />
                        : <img className="w-6 h-6 rounded-full object-cover" src={avatarUrl(ann.sender_avatar) || publicAsset('/logo.png')} alt={ann.username} loading="lazy" decoding="async" />}
                      <span className="text-[10px] font-black text-yellow-800 uppercase tracking-widest">{ann.sniffed_out ? <SniffedOutName /> : (ann.full_name || ann.username)}</span>
                      <span className="text-[8px] text-zinc-300 ml-auto">{new Date(ann.created_at).toLocaleDateString()}</span>
                    </div>
                    <h5 className="font-extrabold text-xs text-yellow-900 mb-1">{ann.title}</h5>
                    <p className="text-[11px] leading-relaxed text-zinc-600 font-medium">{ann.content}</p>
                    {(ann.location_name || (ann.latitude != null && ann.longitude != null)) && (
                      <div className="mt-2 flex items-start gap-1.5 text-[10px] text-yellow-900">
                        <span className="material-symbols-outlined text-sm text-primary">location_on</span>
                        <div className="min-w-0 flex-1">
                          <p className="font-bold break-words">{ann.location_name || 'Event location'}</p>
                          {ann.latitude != null && ann.longitude != null && (
                            <a
                              href={`https://www.google.com/maps/search/?api=1&query=${ann.latitude},${ann.longitude}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-0.5 font-extrabold text-primary hover:underline"
                            >
                              Open in Maps
                              <span className="material-symbols-outlined text-xs">open_in_new</span>
                            </a>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Media */}
        {activeSubTab === 'media' && (
          <div className="space-y-4">
            <h4 className="font-extrabold text-sm uppercase tracking-wider text-zinc-400 mb-2">Shared Photos & Videos</h4>
            {photos.length === 0 ? (
              <p className="text-xs text-zinc-400 italic text-center py-8">No shared media yet.</p>
            ) : (
              <div className="grid grid-cols-3 gap-2">
                {photos.map(p => (
                  <div key={p.id} className="aspect-square bg-zinc-100 rounded-xl overflow-hidden shadow-sm relative group cursor-pointer hover:scale-98 transition-transform">
                    {p.media_url
                      ? <img src={thumbnailUrl(p.media_url)} alt="Shared" loading="lazy" decoding="async" className="w-full h-full object-cover" />
                      : <MediaUnavailable compact label="Unavailable" className="w-full h-full justify-center rounded-xl" />}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Files */}
        {activeSubTab === 'files' && (
          <div className="space-y-4">
            <h4 className="font-extrabold text-sm uppercase tracking-wider text-zinc-400 mb-2">Shared Documents</h4>
            {files.length === 0 ? (
              <p className="text-xs text-zinc-400 italic text-center py-8">No files shared yet.</p>
            ) : (
              <div className="space-y-2">
                {files.map(f => !f.media_url ? (
                  <div key={f.id} className="p-2 bg-white dark:bg-zinc-950 border rounded-2xl">
                    <MediaUnavailable icon="description" label={`${f.content || 'Document'}: no longer available`} className="w-full" />
                  </div>
                ) : (
                  <a key={f.id} href={safeLinkUrl(f.media_url)} target="_blank" rel="noreferrer" className="flex items-center gap-3 p-3 bg-white border rounded-2xl hover:bg-zinc-50">
                    <span className="material-symbols-outlined text-primary text-xl">description</span>
                    <div className="text-left flex-1 min-w-0">
                      <p className="text-xs font-bold text-on-surface truncate">{f.content || 'Document'}</p>
                      <p className="text-[9px] text-zinc-400">Shared by {f.pet_name}</p>
                    </div>
                    <span className="material-symbols-outlined text-zinc-400 text-sm">download</span>
                  </a>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Polls */}
        {activeSubTab === 'polls' && (
          <div className="space-y-4">
            <div className="flex justify-between items-center mb-2">
              <h4 className="font-extrabold text-sm uppercase tracking-wider text-zinc-400">🐾 Pack Polls</h4>
              {!isFrozen && (
                <button onClick={() => setShowPollForm(!showPollForm)} className="text-xs font-bold text-primary flex items-center gap-0.5">
                  <span className="material-symbols-outlined text-sm">add</span> Create Poll
                </button>
              )}
            </div>

            {showPollForm && !isFrozen && (
              <form onSubmit={handleCreatePoll} className="bg-zinc-50 dark:bg-zinc-800 rounded-3xl p-4 border space-y-3 mb-4 text-left">
                <input
                  type="text"
                  required
                  placeholder="Ask a question..."
                  className="w-full bg-white dark:bg-zinc-950 border-none rounded-xl py-2 px-4 text-xs font-bold text-on-surface"
                  value={pollQuestion}
                  onChange={e => setPollQuestion(e.target.value)}
                />
                {pollOptions.map((opt, i) => (
                  <input
                    key={i}
                    type="text"
                    required
                    placeholder={`Option ${i + 1}`}
                    className="w-full bg-white dark:bg-zinc-955 border-none rounded-xl py-1.5 px-4 text-xs text-on-surface"
                    value={opt}
                    onChange={e => updatePollOption(i, e.target.value)}
                  />
                ))}
                <button type="button" onClick={addPollOption} className="text-[10px] font-bold text-primary flex items-center gap-0.5">
                  <span className="material-symbols-outlined text-xs">add</span> Add Option
                </button>
                <div className="flex justify-end gap-2 pt-2">
                  <button type="button" onClick={() => setShowPollForm(false)} className="px-3 py-1.5 bg-zinc-200 text-[10px] font-bold rounded-lg uppercase">Cancel</button>
                  <button type="submit" className="px-3 py-1.5 bg-primary text-white text-[10px] font-bold rounded-lg uppercase">Create Poll</button>
                </div>
              </form>
            )}

            {polls.length === 0 ? (
              <p className="text-xs text-zinc-400 italic text-center py-8">No pack polls active.</p>
            ) : (
              <div className="space-y-4">
                {polls.map(poll => {
                  const totalVotes = Object.values(poll.votes || {}).reduce((acc, curr) => acc + (curr?.length || 0), 0);
                  return (
                    <div key={poll.id} className="bg-white dark:bg-zinc-950 border rounded-3xl p-4 shadow-sm text-left">
                      <h5 className="font-extrabold text-xs text-on-surface mb-2">{poll.question}</h5>
                      {poll.options.map((opt, optIdx) => {
                        const optionVotesList = poll.votes?.[optIdx] || [];
                        const optCount = optionVotesList.length;
                        const percent = totalVotes > 0 ? Math.round((optCount / totalVotes) * 100) : 0;
                        const voted = optionVotesList.includes(user.id);

                        return (
                          <button
                            key={optIdx}
                            onClick={isFrozen ? undefined : () => handleVote(poll.id, optIdx)}
                            disabled={isFrozen}
                            className={`w-full block relative rounded-xl p-3 border mb-2 text-left transition-colors overflow-hidden group select-none ${isFrozen ? 'cursor-default' : 'hover:bg-zinc-50'}`}
                          >
                            <div className="absolute inset-0 bg-primary/5 transition-all" style={{ width: `${percent}%` }} />
                            <div className="relative flex justify-between items-center text-[11px] font-bold">
                              <span className={voted ? 'text-primary font-black' : 'text-zinc-600'}>{opt}</span>
                              <span className="text-zinc-400">{percent}% ({optCount})</span>
                            </div>
                          </button>
                        );
                      })}
                      <p className="text-[9px] font-bold text-zinc-400 uppercase tracking-widest mt-3">
                        Total Votes: {totalVotes} • {poll.creator_sniffed_out ? `Asked by ${SNIFFED_OUT_NAME}` : poll.creator_name ? `Asked by @${poll.creator_name}` : 'Pack Poll'}
                      </p>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Members */}
        {activeSubTab === 'members' && (
          <div className="space-y-4">
            <h4 className="font-extrabold text-sm uppercase tracking-wider text-zinc-400 mb-2">Pack Members</h4>
            <div className="space-y-2">
              {members.map(member => {
                const roleColors = { Owner: 'bg-yellow-100 text-yellow-800 border-yellow-200', Admin: 'bg-sky-100 text-sky-800 border-sky-200', Moderator: 'bg-purple-100 text-purple-800 border-purple-200', Member: 'bg-zinc-100 text-zinc-500 border-zinc-200' };
                return (
                  <div key={member.id} className="flex items-center justify-between p-3 bg-white dark:bg-zinc-950 border rounded-2xl">
                    {member.sniffed_out ? (
                    <div className="flex items-center gap-3 text-left cursor-default select-none">
                      <SniffedOutAvatar className="w-10 h-10 rounded-full" />
                      <div>
                        <h5 className="font-bold text-xs text-on-surface">
                          <SniffedOutName />{member.role === 'Owner' ? ' (Owner)' : ''}
                        </h5>
                        <p className="text-[9px] text-zinc-400">Account deleted</p>
                      </div>
                    </div>
                    ) : (
                    <button
                      type="button"
                      onClick={() => setPreviewMember(member)}
                      className="flex items-center gap-3 text-left active:scale-[0.98] transition-transform"
                    >
                      <img className="w-10 h-10 rounded-full object-cover" src={avatarUrl(member.pet_avatar) || publicAsset('/logo.png')} alt={member.pet_name} loading="lazy" decoding="async" />
                      <div>
                        <h5 className="font-bold text-xs text-on-surface flex items-center gap-1.5">
                          <span>{member.pet_name || member.username}</span>
                          <PremiumBadge pet={member} size="text-sm" />
                        </h5>
                        <p className="text-[9px] text-zinc-400">@{member.username}</p>
                      </div>
                    </button>
                    )}
                    <div className="flex items-center gap-2">
                      {!member.sniffed_out && (
                        <span className={`text-[8px] font-black uppercase tracking-widest px-2.5 py-1 rounded-full border ${roleColors[member.role] || roleColors.Member}`}>
                          {member.role}
                        </span>
                      )}
                      {canManage && !isFrozen && !member.sniffed_out && member.user_id !== user.id && member.role !== 'Owner' && (
                        <select
                          className="bg-zinc-50 border border-zinc-200 rounded-lg text-[9px] font-bold p-1 text-on-surface"
                          value={member.role}
                          onChange={(e) => handleUpdateRole(member.user_id, e.target.value)}
                        >
                          {isOwner && <option value="Admin">Make Admin</option>}
                          <option value="Moderator">Make Moderator</option>
                          <option value="Member">Make Member</option>
                        </select>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Requests to join (Owner/Admin of a private circle) */}
        {activeSubTab === 'requests' && canManage && community.is_private && (
          <div className="space-y-3 text-left">
            <div>
              <h4 className="font-extrabold text-sm text-on-surface">Requests to join</h4>
              <p className="text-[10px] text-zinc-400 font-bold leading-snug">
                This PawCircle is private: new members join only when an Owner or Admin accepts. Requests expire after 7 days.
              </p>
            </div>
            {joinRequests.length === 0 ? (
              <div className="text-center py-8 rounded-2xl border border-dashed border-zinc-200 dark:border-zinc-700 text-zinc-400">
                <span className="material-symbols-outlined text-2xl">how_to_reg</span>
                <p className="text-xs font-bold mt-1">No pending requests</p>
              </div>
            ) : joinRequests.map(request => (
              <div key={request.id} className="flex items-center gap-3 p-3 rounded-2xl bg-zinc-50 dark:bg-zinc-800">
                <img
                  className="w-10 h-10 rounded-full object-cover flex-shrink-0"
                  src={avatarUrl(request.pet_avatar) || publicAsset('/logo.png')}
                  alt={request.pet_name || request.username}
                  loading="lazy"
                  decoding="async"
                />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-extrabold text-on-surface truncate">{request.pet_name || request.full_name || request.username}</p>
                  <p className="text-[10px] text-zinc-400 truncate">
                    @{request.username} · {new Date(request.created_at).toLocaleDateString([], { day: 'numeric', month: 'short' })}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => handleDecideRequest(request, 'decline')}
                  disabled={!!decidingRequestId || isFrozen}
                  className="px-3 py-2 rounded-xl bg-rose-50 text-rose-600 dark:bg-rose-950/30 dark:text-rose-300 text-[10px] font-black uppercase tracking-wider disabled:opacity-50"
                >
                  Decline
                </button>
                <button
                  type="button"
                  onClick={() => handleDecideRequest(request, 'accept')}
                  disabled={!!decidingRequestId || isFrozen}
                  className="px-3 py-2 rounded-xl bg-primary text-white text-[10px] font-black uppercase tracking-wider shadow-sm disabled:opacity-50"
                >
                  {decidingRequestId === request.id ? '...' : 'Accept'}
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Info / details profile */}
        {activeSubTab === 'details' && (
          <div className="space-y-5 text-left">
            <div className="flex flex-col items-center pb-4 border-b">
              <img
                className="w-24 h-24 object-cover shadow-md mb-3 animate-pulse-glow hover-lift-lg"
                style={{ clipPath: PAW_CLIP_STYLE }}
                src={thumbnailUrl(community.cover_image) || publicAsset('/logo.png')}
                alt={community.name}
                loading="lazy"
                decoding="async"
              />
              <h4 className="font-black text-xl text-on-surface text-center flex items-center">
                {community.name}
                {renderCommunityBadges(community)}
              </h4>
              {community.locked ? (
                <p className="text-[10px] font-black text-zinc-500 uppercase tracking-widest mt-1 flex items-center gap-1">
                  <span className="material-symbols-outlined text-xs">lock</span> Private PawCircle
                </p>
              ) : (
                <p className="text-[10px] font-black text-primary uppercase tracking-widest mt-1">Category: {community.category}</p>
              )}
            </div>

            <div>
              <h5 className="text-[10px] font-black text-zinc-400 uppercase tracking-widest pl-1 mb-1">About</h5>
              <p className="text-xs bg-zinc-50/50 p-4 rounded-2xl border text-zinc-600 leading-relaxed font-medium">
                {community.description || 'A community of pet owners.'}
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="bg-zinc-50/50 p-3 rounded-2xl border text-center">
                <p className="text-lg font-black text-on-surface">{community.member_count}</p>
                <p className="text-[9px] font-bold text-zinc-400 uppercase tracking-wider">Members</p>
              </div>
              {community.locked ? (
                <div className="bg-zinc-50/50 p-3 rounded-2xl border text-center">
                  <span className="material-symbols-outlined text-lg text-zinc-400">lock</span>
                  <p className="text-[9px] font-bold text-zinc-400 uppercase tracking-wider">Members only</p>
                </div>
              ) : (
                <div className="bg-zinc-50/50 p-3 rounded-2xl border text-center">
                  <p className="text-xs font-black text-on-surface mt-1.5">{community.city}</p>
                  <p className="text-[9px] font-bold text-zinc-400 uppercase tracking-wider">City</p>
                </div>
              )}
            </div>

            {community.locked ? (
              <p className="text-[11px] bg-zinc-50/50 p-4 rounded-2xl border text-zinc-500 leading-relaxed font-medium">
                This PawCircle is private. Its chat, photos, polls, events, announcements and members are visible once an admin accepts your request to join.
              </p>
            ) : (
            <div>
              <h5 className="text-[10px] font-black text-zinc-400 uppercase tracking-widest pl-1 mb-1">Pack Rules</h5>
              <p className="text-[11px] bg-zinc-50/50 p-4 rounded-2xl border text-zinc-500 leading-relaxed font-medium whitespace-pre-line">
                {community.rules}
              </p>
            </div>
            )}

            {!community.locked && (
            <div className="flex justify-between items-center text-[10px] text-zinc-400 uppercase font-black pl-1 pt-3 border-t border-outline-variant/10 mt-4">
              <span>Created {community.created_at ? new Date(community.created_at).toLocaleDateString() : 'Recently'}</span>
              {!isFrozen && (
                <button
                  type="button"
                  onClick={handleCopyInviteLink}
                  className="flex items-center gap-1.5 text-primary hover:text-primary-fixed-dim font-black text-[11px] uppercase tracking-wider transition-all active:scale-95 cursor-pointer hover:underline z-10"
                >
                  <span className="material-symbols-outlined text-sm">link</span>
                  <span>Invite Companions</span>
                </button>
              )}
            </div>
            )}

            {!isMember && !isFrozen && (community.is_private ? renderRequestAction() : (
              <button
                onClick={handleJoin}
                className="w-full py-4 mt-6 rounded-full bg-gradient-to-r from-primary to-primary-fixed-dim text-white font-bold text-xs uppercase tracking-widest shadow-lg active:scale-95 transition-transform flex items-center justify-center gap-2"
              >
                <span>🐾 Join the Pack</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <Portal>
      {/* Delete Group Confirmation Modal */}
      {showDeleteModal && (
        <div className="fixed inset-0 z-[250] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in">
          <div className="bg-white dark:bg-zinc-900 rounded-[2rem] p-6 max-w-sm w-full shadow-2xl border border-outline-variant/20 text-center space-y-4 animate-scale-up">
            <div className="w-14 h-14 bg-rose-100 dark:bg-rose-950/50 text-rose-500 rounded-full flex items-center justify-center mx-auto text-2xl shadow-inner">
              <span className="material-symbols-outlined">delete</span>
            </div>
            <div>
              <h3 className="font-extrabold text-base text-on-surface">{isOwnerGone ? 'Remove from your list?' : 'Delete Group?'}</h3>
              <p className="text-xs text-zinc-500 font-medium leading-relaxed mt-1">
                {isOwnerGone
                  ? "This PawCircle is read-only, so removing it means leaving it for good. You can't join it again."
                  : 'This will clear this PawCircle conversation and remove it from your list. You will remain a member, and future messages will automatically restore the PawCircle.'}
              </p>
            </div>
            <div className="flex gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowDeleteModal(false)}
                className="flex-1 py-3 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 font-extrabold text-xs rounded-xl hover:bg-zinc-200 transition-colors uppercase tracking-wider cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDeleteGroup}
                disabled={deletingGroup}
                className="flex-1 py-3 bg-rose-600 hover:bg-rose-700 text-white font-extrabold text-xs rounded-xl transition-all shadow-md active:scale-95 uppercase tracking-wider disabled:opacity-50 cursor-pointer"
              >
                {deletingGroup ? 'Deleting...' : 'Delete Group'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Retract Confirmation Modal */}
      {showRetractModal && (() => {
        const isSoleOwner = isOwner && (community.member_count || 0) <= 1;
        return (
        <div className="fixed inset-0 z-[250] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in">
          <div className="bg-white dark:bg-zinc-900 rounded-[2rem] p-6 max-w-sm w-full shadow-2xl border border-outline-variant/20 text-center space-y-4 animate-scale-up">
            <div className={`w-14 h-14 rounded-full flex items-center justify-center mx-auto text-2xl shadow-inner ${isSoleOwner ? 'bg-rose-100 dark:bg-rose-950/50 text-rose-500' : 'bg-amber-100 dark:bg-amber-950/50 text-amber-500'}`}>
              <span className="material-symbols-outlined">{isSoleOwner ? 'delete_forever' : 'logout'}</span>
            </div>
            <div>
              <h3 className="font-extrabold text-base text-on-surface">
                {isSoleOwner ? 'This will delete your PawCircle' : 'Retract from PawCircle?'}
              </h3>
              <p className="text-xs text-zinc-500 font-medium leading-relaxed mt-1">
                {isSoleOwner
                  ? `Since you're the owner and no other members are in "${community.name}", retracting will permanently delete this PawCircle - its chat, media, and announcements can't be recovered.`
                  : isOwnerGone
                    ? "You'll leave this read-only PawCircle for good. Its owner deleted their account, so it can't be joined again."
                    : 'You will leave this PawCircle completely and be removed from members. You can search and join again later.'}
              </p>
            </div>
            <div className="flex gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowRetractModal(false)}
                className="flex-1 py-3 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 font-extrabold text-xs rounded-xl hover:bg-zinc-200 transition-colors uppercase tracking-wider cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleRetractCommunity}
                disabled={retracting}
                className={`flex-1 py-3 text-white font-extrabold text-xs rounded-xl transition-all shadow-md active:scale-95 uppercase tracking-wider disabled:opacity-50 cursor-pointer ${isSoleOwner ? 'bg-rose-600 hover:bg-rose-700' : 'bg-amber-600 hover:bg-amber-700'}`}
              >
                {retracting ? (isSoleOwner ? 'Deleting...' : 'Retracting...') : (isSoleOwner ? 'Delete Circle' : 'Retract')}
              </button>
            </div>
          </div>
        </div>
        );
      })()}

      {/* Report PawCircle Modal */}
      {showReportModal && (
        <div className="fixed inset-0 z-[250] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in">
          <div className="bg-white dark:bg-zinc-900 rounded-[2rem] p-6 max-w-sm w-full shadow-2xl border border-outline-variant/20 text-left space-y-4 animate-scale-up">
            <div className="flex justify-between items-center pb-2 border-b border-zinc-100 dark:border-zinc-800">
              <h3 className="font-extrabold text-sm text-on-surface flex items-center gap-1.5">
                <span className="material-symbols-outlined text-rose-500 text-lg">flag</span>
                Report PawCircle
              </h3>
              <button
                type="button"
                onClick={() => setShowReportModal(false)}
                className="w-7 h-7 rounded-full bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center text-zinc-400 hover:text-zinc-600 cursor-pointer"
              >
                <span className="material-symbols-outlined text-sm">close</span>
              </button>
            </div>
            <form onSubmit={handleReportCommunity} className="space-y-3">
              <div>
                <label className="block text-[10px] font-black uppercase tracking-widest text-zinc-400 mb-1">Reason</label>
                <select
                  value={reportReason}
                  onChange={e => setReportReason(e.target.value)}
                  className="w-full bg-zinc-50 dark:bg-zinc-800 border-none rounded-xl py-2.5 px-3 text-xs font-bold text-on-surface"
                >
                  <option value="Inappropriate Content">Inappropriate Content</option>
                  <option value="Spam or Scam">Spam or Scam</option>
                  <option value="Harassment">Harassment</option>
                  <option value="Offensive Language">Offensive Language</option>
                  <option value="Other">Other</option>
                </select>
              </div>
              <div>
                <label className="block text-[10px] font-black uppercase tracking-widest text-zinc-400 mb-1">Details (Optional)</label>
                <textarea
                  rows={3}
                  value={reportDetails}
                  onChange={e => setReportDetails(e.target.value)}
                  placeholder="Describe why you are reporting this community..."
                  className="w-full bg-zinc-50 dark:bg-zinc-800 border-none rounded-xl p-3 text-xs text-on-surface resize-none placeholder:text-zinc-400"
                />
              </div>
              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowReportModal(false)}
                  className="flex-1 py-2.5 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 font-extrabold text-xs rounded-xl hover:bg-zinc-200 transition-colors uppercase tracking-wider cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submittingReport}
                  className="flex-1 py-2.5 bg-rose-600 hover:bg-rose-700 text-white font-extrabold text-xs rounded-xl transition-all shadow-md active:scale-95 uppercase tracking-wider disabled:opacity-50 cursor-pointer"
                >
                  {submittingReport ? 'Submitting...' : 'Submit Report'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Transfer Ownership: pick a member */}
      {showTransferPicker && (
        <div className="fixed inset-0 z-[250] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in" onClick={() => setShowTransferPicker(false)}>
          <div className="bg-white dark:bg-zinc-900 rounded-[2rem] p-5 max-w-sm w-full shadow-2xl border border-outline-variant/20 space-y-3 animate-scale-up flex flex-col max-h-[80vh]" onClick={(e) => e.stopPropagation()}>
            <div>
              <h3 className="font-extrabold text-base text-on-surface">Transfer Ownership</h3>
              <p className="text-[11px] text-zinc-500 font-medium mt-0.5">Choose the member who'll become the owner. They have 5 days to accept.</p>
            </div>
            {transfer?.isSender && (
              <div className="flex items-center gap-2 rounded-xl bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-[11px] font-bold text-amber-700 dark:text-amber-300">
                <span className="flex-1">Pending: @{transfer.toUsername}. Picking someone else cancels it.</span>
                <button type="button" onClick={handleCancelTransfer} disabled={transferBusy} className="text-[10px] font-black uppercase text-rose-600 hover:underline disabled:opacity-50">Cancel</button>
              </div>
            )}
            <input
              type="search"
              value={transferSearch}
              onChange={(e) => setTransferSearch(e.target.value)}
              placeholder="Search members"
              className="w-full bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl py-2.5 px-3 text-xs text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
            <div className="overflow-y-auto space-y-1.5 flex-1 min-h-[6rem]">
              {(() => {
                const q = transferSearch.trim().toLowerCase();
                const candidates = transferMembers.filter(m => !m.sniffed_out && m.user_id !== user.id
                  && (!q || [m.username, m.pet_name, m.full_name].some(v => (v || '').toLowerCase().includes(q))));
                if (!candidates.length) {
                  return <p className="text-[11px] text-zinc-400 font-bold text-center py-6">{q ? 'No member matches your search.' : 'No other members yet.'}</p>;
                }
                return candidates.map(m => (
                  <button
                    key={m.user_id}
                    type="button"
                    onClick={() => setTransferConfirm(m)}
                    className="w-full flex items-center gap-3 p-2.5 rounded-xl hover:bg-zinc-50 dark:hover:bg-zinc-800 text-left"
                  >
                    <img className="w-9 h-9 rounded-full object-cover flex-shrink-0" src={avatarUrl(m.pet_avatar) || publicAsset('/logo.png')} alt={m.pet_name || m.username} loading="lazy" decoding="async" />
                    <span className="flex-1 min-w-0">
                      <span className="block text-xs font-extrabold text-on-surface truncate">{m.pet_name || m.full_name || m.username}</span>
                      <span className="block text-[10px] text-zinc-400 truncate">@{m.username} · {m.role}</span>
                    </span>
                    {transfer?.isSender && transfer.toUserId === m.user_id && (
                      <span className="text-[9px] font-black uppercase text-amber-600">Pending</span>
                    )}
                  </button>
                ));
              })()}
            </div>
            <button type="button" onClick={() => setShowTransferPicker(false)} className="w-full py-2.5 text-zinc-400 font-bold text-xs hover:text-zinc-600">Close</button>
          </div>
        </div>
      )}

      {/* Transfer Ownership: confirm */}
      {transferConfirm && (
        <div className="fixed inset-0 z-[260] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in">
          <div className="bg-white dark:bg-zinc-900 rounded-[2rem] p-6 max-w-sm w-full shadow-2xl border border-outline-variant/20 text-center space-y-4 animate-scale-up">
            <div className="w-14 h-14 bg-amber-100 dark:bg-amber-950/50 text-amber-600 rounded-full flex items-center justify-center mx-auto text-2xl shadow-inner">
              <span className="material-symbols-outlined">swap_horiz</span>
            </div>
            <p className="text-xs text-zinc-600 dark:text-zinc-300 font-medium leading-relaxed">
              Are you sure you want to transfer ownership of '{community.name}' to '{transferConfirm.username}'? You're the current admin of this PawCircle. After the transfer, you'll be a regular member.
            </p>
            <div className="flex gap-2 pt-2">
              <button
                type="button"
                onClick={() => setTransferConfirm(null)}
                className="flex-1 py-3 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 font-extrabold text-xs rounded-xl hover:bg-zinc-200 transition-colors uppercase tracking-wider cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleStartTransfer}
                disabled={transferBusy}
                className="flex-1 py-3 bg-primary text-white font-extrabold text-xs rounded-xl transition-all shadow-md active:scale-95 uppercase tracking-wider disabled:opacity-50 cursor-pointer"
              >
                {transferBusy ? 'Sending...' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Disable PawCircle Modal (Creator Only) */}
      {showDisableModal && (
        <div className="fixed inset-0 z-[250] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in">
          <div className="bg-white dark:bg-zinc-900 rounded-[2rem] p-6 max-w-sm w-full shadow-2xl border border-outline-variant/20 text-center space-y-4 animate-scale-up">
            <div className="w-14 h-14 bg-rose-100 dark:bg-rose-950/50 text-rose-500 rounded-full flex items-center justify-center mx-auto text-2xl shadow-inner">
              <span className="material-symbols-outlined">block</span>
            </div>
            <div>
              <h3 className="font-extrabold text-base text-on-surface">Disable PawCircle?</h3>
              <p className="text-xs text-zinc-500 font-medium leading-relaxed mt-1">
                Disabling archives this PawCircle: it becomes read-only for every member and disappears from search. Pending join requests and ownership transfers are cancelled. You can re-enable it any time.
              </p>
            </div>
            <div className="flex gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowDisableModal(false)}
                className="flex-1 py-3 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 font-extrabold text-xs rounded-xl hover:bg-zinc-200 transition-colors uppercase tracking-wider cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDisableCommunity}
                disabled={disablingCommunity}
                className="flex-1 py-3 bg-rose-600 hover:bg-rose-700 text-white font-extrabold text-xs rounded-xl transition-all shadow-md active:scale-95 uppercase tracking-wider disabled:opacity-50 cursor-pointer"
              >
                {disablingCommunity ? 'Disabling...' : 'Disable PawCircle'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Copy Link Toast Confirmation */}
      {inviteToast && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-[220] bg-zinc-900/90 text-white dark:bg-white/90 dark:text-zinc-900 px-5 py-2.5 rounded-full text-xs font-black shadow-xl animate-bounce flex items-center gap-2 pointer-events-none border border-white/20">
          <span className="text-primary text-sm">🐾</span>
          <span>{inviteToast}</span>
        </div>
      )}

      {copyToast && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-[220] bg-zinc-900/90 text-white dark:bg-white/90 dark:text-zinc-900 px-4 py-2 rounded-full text-xs font-extrabold shadow-lg animate-bounce pointer-events-none">
          <span>{copyToast}</span>
        </div>
      )}

      {mediaViewer && (
        <MediaViewerModal
          urls={mediaViewer.urls}
          index={mediaViewer.index}
          onIndexChange={(index) => setMediaViewer(prev => ({ ...prev, index }))}
          onClose={() => setMediaViewer(null)}
        />
      )}

      {/* Double-tap action menu: Copy + Fetch Back (same pattern as 1:1 chat) */}
      {actionMenuMessage && (
        <div
          className="fixed inset-0 z-[150] bg-black/10 backdrop-blur-[1px]"
          onClick={() => setActionMenuMessage(null)}
        >
          <div
            className="absolute bg-white dark:bg-zinc-900 border border-outline-variant/15 rounded-2xl shadow-xl p-1.5 min-w-[140px] animate-scale-up text-left select-none space-y-0.5"
            style={{
              top: `${Math.max(65, actionMenuMessage.top)}px`,
              left: `${Math.max(16, Math.min(window.innerWidth - 160, actionMenuMessage.left))}px`
            }}
            onClick={e => e.stopPropagation()}
          >
            <button
              onClick={() => {
                const textToCopy = actionMenuMessage.msg.content || '';
                navigator.clipboard?.writeText(textToCopy);
                setActionMenuMessage(null);
                setCopyToast('✅ Copied to clipboard');
                setTimeout(() => setCopyToast(null), 2000);
              }}
              className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-extrabold text-on-surface hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
            >
              <span className="material-symbols-outlined text-sm">content_copy</span>
              Copy
            </button>

            {actionMenuMessage.isOwn && !isFrozen && (
              <button
                onClick={() => {
                  const msgToFetch = actionMenuMessage.msg;
                  setActionMenuMessage(null);
                  setConfirmFetchBackModal(msgToFetch);
                }}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-extrabold text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors"
              >
                <span className="text-sm">🐾</span>
                Fetch Back
              </button>
            )}
          </div>
        </div>
      )}

      {/* Long-Press Message Reaction Picker (same visual pattern as 1:1 chat) */}
      {reactionPickerMsgId && !isFrozen && (
        <div
          className="fixed inset-0 z-[300] bg-black/35 backdrop-blur-[2px] flex items-center justify-center animate-fade-in"
          onClick={() => { setReactionPickerMsgId(null); setHighlightedMsgReaction(null); }}
        >
          <div
            className="bg-white/90 dark:bg-zinc-900/90 backdrop-blur-md rounded-full px-6 py-4 shadow-2xl flex items-end gap-3.5 border border-outline-variant/10 animate-reaction-picker"
            onClick={(e) => e.stopPropagation()}
          >
            {Object.entries(REACTION_EMOJIS).map(([type, emoji]) => {
              const isHighlighted = highlightedMsgReaction === type;
              return (
                <button
                  key={type}
                  data-msg-reaction={type}
                  onMouseEnter={() => setHighlightedMsgReaction(type)}
                  onMouseLeave={() => setHighlightedMsgReaction(null)}
                  onClick={() => submitMessageReaction(reactionPickerMsgId, type)}
                  className={`flex flex-col items-center gap-1 cursor-pointer transition-all duration-200 origin-bottom select-none outline-none ${
                    isHighlighted ? 'scale-135 -translate-y-3.5' : 'hover:scale-110'
                  }`}
                  title={REACTION_LABELS[type]}
                >
                  <span className={`text-3xl transition-all ${
                    isHighlighted ? 'drop-shadow-[0_0_10px_rgba(244,167,185,0.7)]' : ''
                  }`}>
                    {emoji}
                  </span>
                  <span className={`text-[9px] font-black uppercase tracking-wider text-primary transition-all duration-150 h-3 ${
                    isHighlighted ? 'opacity-100 scale-100' : 'opacity-0 scale-75'
                  }`}>
                    {REACTION_LABELS[type]}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Fetch Back confirmation (delete-for-sender) */}
      {confirmFetchBackModal && (
        <div
          className="fixed inset-0 z-[200] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 select-none animate-fade-in"
          onClick={() => setConfirmFetchBackModal(null)}
        >
          <div
            className="bg-white dark:bg-zinc-900 border border-outline-variant/10 rounded-[2.2rem] p-6 max-w-xs w-full shadow-2xl text-center space-y-4 animate-scale-up"
            onClick={e => e.stopPropagation()}
          >
            <div className="w-12 h-12 rounded-full bg-rose-50 text-red-500 flex items-center justify-center mx-auto text-xl font-bold">
              <span className="text-2xl">🐾</span>
            </div>
            <div>
              <h3 className="font-extrabold text-sm text-on-surface">Fetch back this message?</h3>
              <p className="text-xs text-zinc-400 font-medium mt-1">This will remove it for everyone in the PawCircle.</p>
            </div>
            <div className="flex gap-3 pt-2">
              <button
                onClick={() => setConfirmFetchBackModal(null)}
                className="flex-1 py-3 bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 text-zinc-700 dark:text-zinc-300 font-extrabold text-xs uppercase tracking-wider rounded-full transition-all active:scale-95"
              >
                Cancel
              </button>
              <button
                onClick={() => handleConfirmFetchBackCommunity(confirmFetchBackModal.id)}
                className="flex-1 py-3 bg-red-500 hover:bg-red-600 text-white font-extrabold text-xs uppercase tracking-wider rounded-full shadow-md transition-all active:scale-95"
              >
                Fetch Back
              </button>
            </div>
          </div>
        </div>
      )}
      </Portal>

      {/* Member Profile -- full profile modal once you've connected on Meet */}
      {previewMember && (previewMember.user_id === user?.id || myMatches.some(m => m.id === previewMember.pet_id)) && (
        <Portal>
        <div
          className="fixed inset-0 z-[260] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in"
          onClick={() => setPreviewMember(null)}
        >
          <div
            className="bg-white dark:bg-zinc-900 rounded-[2.5rem] p-6 max-w-sm w-full shadow-2xl border border-outline-variant/20 text-center space-y-4 animate-scale-up relative"
            onClick={e => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setPreviewMember(null)}
              className="absolute top-4 right-4 w-8 h-8 rounded-full bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center text-zinc-400 hover:text-zinc-600 z-10"
            >
              <span className="material-symbols-outlined text-base">close</span>
            </button>

            <img
              src={thumbnailUrl(previewMember.pet_avatar) || publicAsset('/logo.png')}
              alt={previewMember.pet_name}
              loading="eager"
              decoding="async"
              className="w-24 h-24 rounded-full object-cover border-4 border-white dark:border-zinc-800 shadow-xl mx-auto animate-pulse-glow"
            />

            <div>
              <h3 className="font-extrabold text-lg text-on-surface flex items-center justify-center gap-1.5">
                <span>{previewMember.pet_name || previewMember.username}</span>
                <PremiumBadge pet={previewMember} size="text-base" />
              </h3>
              <p className="text-xs text-zinc-400 font-bold">@{previewMember.username}</p>
              <span className="inline-block mt-2 text-[8px] font-black uppercase tracking-widest px-2.5 py-1 rounded-full border bg-zinc-100 dark:bg-zinc-800 text-zinc-500 border-zinc-200 dark:border-zinc-700">
                {previewMember.role} of {community.name}
              </span>
            </div>

            {previewMember.breed_name && (
              <p className="text-[11px] font-bold text-zinc-500 uppercase tracking-wide">🐶 {previewMember.breed_name}</p>
            )}
            {previewMember.bio && (
              <p className="text-xs text-zinc-500 leading-relaxed italic px-2">"{previewMember.bio}"</p>
            )}
            <button
              type="button"
              onClick={() => { setPreviewMember(null); if (previewMember.pet_id) navigate(`/profile/${previewMember.pet_id}`); }}
              disabled={!previewMember.pet_id}
              className="w-full py-3 bg-gradient-to-r from-primary to-primary-fixed-dim text-white font-extrabold text-xs rounded-full shadow-md active:scale-95 transition-transform uppercase tracking-wider disabled:opacity-50"
            >
              View Full Profile
            </button>
          </div>
        </div>
        </Portal>
      )}

      {/* Not connected yet -- swipeable "sniff" card (same translucent glass +
          drag-to-swipe experience as Meet) instead of a locked preview.
          Opening it notifies the member's owner that this pack member
          sniffed their profile; swiping/tapping right or left sends a real
          Meet connect/skip, same as the Meet deck. */}
      {previewMember && !(previewMember.user_id === user?.id || myMatches.some(m => m.id === previewMember.pet_id)) && (
        <Portal>
          <MemberSniffCard
            member={previewMember}
            communityId={id}
            onClose={() => setPreviewMember(null)}
            onConnected={(m) => setInviteToast(`🐾 Sniff request sent to ${m.pet_name || 'them'}!`)}
            onSkipped={() => setInviteToast('Swiped back.')}
          />
        </Portal>
      )}

      {upsell && (
        <UpsellModal title={upsell.title} message={upsell.message} onClose={() => setUpsell(null)} />
      )}
    </div>
  );
}
