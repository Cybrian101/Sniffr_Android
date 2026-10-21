import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../services/api';

import { publicAsset } from '../utils/publicPath';
import { notifyActionError } from '../utils/appToast';
const SWIPE_THRESHOLD = 100;

// Swipeable "sniff" card for a not-yet-connected PawCircle member -- same
// translucent glass card + drag-to-swipe interaction as the Meet page's
// swipe deck, just scoped to a single pet and opened from inside a
// community instead of the Meet queue. Dragging the card right/left sends a
// real Meet connect/skip (same endpoints Meet uses); the button row below
// is a separate, non-draggable control surface -- paw opens the full
// profile, X just closes the card with no side effect.
export default function MemberSniffCard({ member, communityId, onClose, onConnected, onSkipped }) {
  const navigate = useNavigate();
  const [swipeX, setSwipeX] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [swipeDirection, setSwipeDirection] = useState(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [showHint, setShowHint] = useState(true);
  const dragStartRef = useRef({ x: 0 });
  const notifiedRef = useRef(false);

  // Opening the card is the "sniff" -- notify the owner once, the same way
  // a real profile view would, just with community-flavored copy (handled
  // server-side when communityId is present).
  useEffect(() => {
    if (member?.pet_id && !member.sniffed_out && !notifiedRef.current) {
      notifiedRef.current = true;
      api.post(`/profile/${member.pet_id}/view`, { communityId }).catch(() => {});
    }
  }, [member?.pet_id, communityId]);

  const handleDragStart = (clientX) => {
    if (isProcessing) return;
    setShowHint(false);
    setIsDragging(true);
    dragStartRef.current = { x: clientX };
  };
  const handleDragMove = (clientX) => {
    if (!isDragging) return;
    setSwipeX(clientX - dragStartRef.current.x);
  };
  const handleDragEnd = () => {
    if (!isDragging) return;
    setIsDragging(false);
    if (Math.abs(swipeX) >= SWIPE_THRESHOLD) {
      if (swipeX > 0) handleConnect();
      else handleSkip();
    } else {
      setSwipeX(0);
    }
  };

  const onTouchStart = (e) => handleDragStart(e.touches[0].clientX);
  const onTouchMove = (e) => handleDragMove(e.touches[0].clientX);
  const onTouchEnd = () => handleDragEnd();
  const onMouseDown = (e) => { e.preventDefault(); handleDragStart(e.clientX); };

  useEffect(() => {
    if (!isDragging) return;
    const onMove = (e) => handleDragMove(e.clientX);
    const onUp = () => handleDragEnd();
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDragging, swipeX]);

  const handleConnect = async () => {
    if (isProcessing || !member?.pet_id || member.sniffed_out) return;
    setIsProcessing(true);
    setSwipeDirection('right');
    try {
      await api.post(`/matches/like/${member.pet_id}`);
      onConnected?.(member);
    } catch (e) {
      notifyActionError(e, "Couldn't send your sniff. Please try again.");
    }
    setTimeout(() => onClose?.(), 350);
  };

  const handleSkip = async () => {
    if (isProcessing || !member?.pet_id || member.sniffed_out) return;
    setIsProcessing(true);
    setSwipeDirection('left');
    try {
      await api.post(`/matches/decline/${member.pet_id}`);
      onSkipped?.(member);
    } catch (e) {
      notifyActionError(e, "Couldn't skip this pet. Please try again.");
    }
    setTimeout(() => onClose?.(), 300);
  };

  const handleViewProfile = () => {
    if (!member?.pet_id || member.sniffed_out) return;
    onClose?.();
    navigate(`/profile/${member.pet_id}`);
  };

  // A member who deleted their account has no card to show (CommunityPage
  // doesn't open one either; this is the backstop).
  if (member?.sniffed_out) return null;

  const cardTransform = (() => {
    if (swipeDirection === 'right') return 'translateX(130%) rotate(22deg)';
    if (swipeDirection === 'left') return 'translateX(-130%) rotate(-22deg)';
    const rotation = swipeX * 0.08;
    return `translateX(${swipeX}px) rotate(${rotation}deg)`;
  })();
  const swipeProgress = Math.min(Math.abs(swipeX) / SWIPE_THRESHOLD, 1);
  const isSwipingRight = swipeX > 0;
  const isSwipingLeft = swipeX < 0;

  return (
    <div
      className="fixed inset-0 z-[260] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in"
      onClick={onClose}
    >
      <div className="relative w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
        {isDragging && swipeProgress > 0.2 && (
          <>
            {isSwipingRight && (
              <div className="absolute top-4 left-4 z-30 px-4 py-2 bg-emerald-500/90 text-white rounded-xl font-black text-sm rotate-[-12deg] shadow-lg" style={{ opacity: swipeProgress }}>
                Connect!
              </div>
            )}
            {isSwipingLeft && (
              <div className="absolute top-4 right-4 z-30 px-4 py-2 bg-rose-400/90 text-white rounded-xl font-black text-sm rotate-[12deg] shadow-lg" style={{ opacity: swipeProgress }}>
                Skip
              </div>
            )}
          </>
        )}

        {/* Draggable surface -- ONLY the visual card + its swipe gesture live
            here. Buttons are deliberately kept out of this element so a tap
            on them is never intercepted as a drag start. */}
        <div
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
          onMouseDown={onMouseDown}
          className="select-none touch-pan-y relative"
          style={{
            transform: cardTransform,
            transition: isDragging ? 'none' : 'transform 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
            cursor: isDragging ? 'grabbing' : 'grab',
          }}
        >
          <div className="glass rounded-[2rem] border border-white/40 shadow-2xl overflow-hidden relative animate-scale-up">
            <div className="p-6 pb-5 text-center">
              <img
                src={member.pet_avatar || publicAsset('/logo.png')}
                alt={member.pet_name}
                className="w-28 h-28 rounded-2xl object-cover border-4 border-white/70 shadow-xl mx-auto mb-3"
                draggable={false}
              />
              <h3 className="font-extrabold text-lg text-on-surface">{member.pet_name || member.username}</h3>
              <p className="text-xs font-bold text-zinc-500">@{member.username}</p>
              {member.breed_name && (
                <p className="text-[11px] font-bold text-primary uppercase tracking-wide mt-1 flex items-center justify-center gap-1"><span className="material-symbols-outlined text-xs">pets</span>{member.breed_name}</p>
              )}
              {member.bio && (
                <p className="text-xs text-zinc-600 dark:text-zinc-300 italic mt-2 leading-relaxed">"{member.bio}"</p>
              )}

              <div className="mt-4 bg-white/50 dark:bg-white/10 border border-white/60 dark:border-white/10 rounded-2xl p-3.5">
                <p className="text-xs font-bold text-on-surface leading-relaxed">
                  A little sniff never hurts 👃👀
                  <br />
                  Check out their profile. Feeling the vibe? Connect. Not feeling it? Swipe back.
                </p>
              </div>
            </div>
          </div>

          {/* Swipe hint -- teaches the drag gesture; dismissed the instant a drag starts */}
          {showHint && !isDragging && (
            <div className="absolute inset-0 z-20 rounded-[2rem] bg-black/35 backdrop-blur-[1px] flex flex-col items-center justify-center gap-3 pointer-events-none animate-fade-in">
              <div className="w-full flex items-center justify-between px-8">
                <div className="flex flex-col items-center gap-1">
                  <span className="material-symbols-outlined text-rose-300 text-3xl animate-swipe-hint-arrow-left">chevron_left</span>
                  <span className="text-[9px] font-black uppercase tracking-widest text-white/90">Skip</span>
                </div>
                <div className="flex flex-col items-center gap-1">
                  <span className="material-symbols-outlined text-emerald-300 text-3xl animate-swipe-hint-arrow-right">chevron_right</span>
                  <span className="text-[9px] font-black uppercase tracking-widest text-white/90">Meet</span>
                </div>
              </div>
              <div className="flex items-center gap-2 bg-white/15 border border-white/25 px-3.5 py-1.5 rounded-full animate-pulse-glow">
                <span className="material-symbols-outlined text-white text-lg animate-swipe-hint-hand" style={{ fontVariationSettings: "'FILL' 1" }}>swipe</span>
                <span className="text-[10px] font-extrabold text-white tracking-wide">Swipe right to Meet, left to Skip</span>
              </div>
            </div>
          )}
        </div>

        {/* Button row -- a separate control surface below the swipeable card,
            outside the drag-capture area so taps always register. */}
        <div className="flex justify-center items-center gap-5 mt-5">
          <button
            type="button"
            onClick={onClose}
            disabled={isProcessing}
            title="Leave"
            className="w-14 h-14 rounded-full bg-white/90 dark:bg-zinc-800/90 border-2 border-rose-200 dark:border-rose-900/40 shadow-md flex items-center justify-center active:scale-90 transition-all disabled:opacity-50"
          >
            <span className="material-symbols-outlined text-rose-400 text-2xl">close</span>
          </button>
          <button
            type="button"
            onClick={handleViewProfile}
            disabled={isProcessing || !member?.pet_id}
            title="View Full Profile"
            className="w-16 h-16 rounded-full bg-gradient-to-br from-primary to-primary-fixed-dim shadow-lg flex items-center justify-center active:scale-90 transition-all disabled:opacity-50"
          >
            <span className="material-symbols-outlined text-white text-3xl" style={{ fontVariationSettings: "'FILL' 1" }}>pets</span>
          </button>
        </div>
      </div>
    </div>
  );
}
