import { useState, useEffect, useRef, useCallback } from 'react';
import api from '../services/api';
import Portal from './Portal';
import { notifyActionError } from '../utils/appToast';

// ─── Pawsitive level labels ───────────────────────────────────
export function getPawsitiveLabel(score) {
  if (score <= 15) return { label: 'Needs Slow Introductions', emoji: '🌱', color: 'text-rose-400',   bg: 'bg-rose-50',   accent: '#fb7185' };
  if (score <= 30) return { label: 'Prefers Personal Space',   emoji: '🌙', color: 'text-purple-400', bg: 'bg-purple-50', accent: '#c084fc' };
  if (score <= 45) return { label: 'Shy at First',             emoji: '🌸', color: 'text-pink-400',   bg: 'bg-pink-50',   accent: '#f472b6' };
  if (score <= 60) return { label: 'Calm & Gentle',            emoji: '🌿', color: 'text-emerald-500',bg: 'bg-emerald-50',accent: '#10b981' };
  if (score <= 75) return { label: 'Friendly & Playful',       emoji: '🎾', color: 'text-amber-500',  bg: 'bg-amber-50',  accent: '#f59e0b' };
  if (score <= 90) return { label: 'High-Energy Socialite',    emoji: '⚡', color: 'text-orange-500', bg: 'bg-orange-50', accent: '#f97316' };
  return              { label: 'Extremely Social',             emoji: '🌟', color: 'text-sky-500',    bg: 'bg-sky-50',    accent: '#0ea5e9' };
}

// ─── Custom Slider — mouse + touch, no pointer-event conflicts ──
function PawSlider({ value, onChange }) {
  const trackRef   = useRef(null);
  const isDragging = useRef(false);

  // Given a clientX, compute 0–100 score from track bounds
  const clientXToScore = useCallback((clientX) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return value;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return Math.round(ratio * 100);
  }, [value]);

  // ── Mouse events ──────────────────────────────────────────
  const onMouseDown = useCallback((e) => {
    e.preventDefault();
    isDragging.current = true;
    onChange(clientXToScore(e.clientX));

    const onMove = (ev) => {
      if (!isDragging.current) return;
      onChange(clientXToScore(ev.clientX));
    };
    const onUp = () => {
      isDragging.current = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [clientXToScore, onChange]);

  // ── Touch events ──────────────────────────────────────────
  const onTouchStart = useCallback((e) => {
    isDragging.current = true;
    onChange(clientXToScore(e.touches[0].clientX));
  }, [clientXToScore, onChange]);

  const onTouchMove = useCallback((e) => {
    if (!isDragging.current) return;
    e.preventDefault();
    onChange(clientXToScore(e.touches[0].clientX));
  }, [clientXToScore, onChange]);

  const onTouchEnd = useCallback(() => {
    isDragging.current = false;
  }, []);

  const pct = value; // 0–100

  return (
    <div className="relative select-none py-3" style={{ touchAction: 'none' }}>
      {/* Track container — captures all pointer events */}
      <div
        ref={trackRef}
        className="relative w-full h-5 flex items-center cursor-pointer"
        onMouseDown={onMouseDown}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        role="slider"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') onChange(Math.max(0, value - 1));
          if (e.key === 'ArrowRight' || e.key === 'ArrowUp')  onChange(Math.min(100, value + 1));
        }}
      >
        {/* Background rail */}
        <div className="absolute inset-y-0 my-auto w-full h-3 bg-zinc-200 rounded-full overflow-hidden">
          {/* Filled portion */}
          <div
            className="h-full rounded-full transition-none"
            style={{
              width: `${pct}%`,
              background: 'linear-gradient(to right, #F4A7B9, #a8d8ea, #38bdf8)',
            }}
          />
        </div>

        {/* Thumb */}
        <div
          className="absolute w-7 h-7 rounded-full shadow-lg border-4 border-white flex items-center justify-center transition-transform duration-75"
          style={{
            left: `calc(${pct}% - 14px)`,
            background: 'linear-gradient(135deg, #F4A7B9, #a8d8ea)',
            boxShadow: '0 4px 12px rgba(244,167,185,0.5)',
          }}
        >
          <span
            className="material-symbols-outlined text-white text-[11px]"
            style={{ fontVariationSettings: "'FILL' 1" }}
          >
            pets
          </span>
        </div>
      </div>

      {/* Tick marks — pointer-events-none so they don't block dragging */}
      <div className="flex justify-between mt-1 pointer-events-none">
        {[0, 25, 50, 75, 100].map(m => (
          <div key={m} className="flex flex-col items-center gap-0.5">
            <div className={`w-0.5 h-1.5 rounded-full ${value >= m ? 'bg-primary' : 'bg-zinc-300'}`} />
            <span className="text-[9px] font-bold text-zinc-400">{m}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Vibe cards — pointer-events-none safe ────────────────────
const VIBES = [
  { range: [0,  15], label: 'Needs Slow Intro', emoji: '🌱' },
  { range: [16, 30], label: 'Personal Space',   emoji: '🌙' },
  { range: [31, 45], label: 'Shy at First',      emoji: '🌸' },
  { range: [46, 60], label: 'Calm & Gentle',     emoji: '🌿' },
  { range: [61, 75], label: 'Friendly & Playful',emoji: '🎾' },
  { range: [76, 90], label: 'High-Energy',        emoji: '⚡' },
  { range: [91,100], label: 'Extremely Social',  emoji: '🌟' },
];

export default function PawsitiveModal({ currentScore = 50, onClose, onSaved }) {
  const [score, setSc]   = useState(currentScore);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved]   = useState(false);
  const containerRef = useRef(null);

  const { label, emoji, color, bg } = getPawsitiveLabel(score);

  // Scroll container into view on mobile so modal is fully visible
  useEffect(() => {
    containerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.patch('/profile/pawsitive', { score });
      setSaved(true);
      setTimeout(() => {
        onSaved?.(score);
        onClose();
      }, 900);
    } catch (err) {
      notifyActionError(err, "Couldn't save the score. Please try again.");
      setSaving(false);
    }
  };

  const activeVibe = VIBES.find(v => score >= v.range[0] && score <= v.range[1]);

  return (
    <Portal trapFocus>
    {/* Backdrop -- z-[300] so it is above everything; NO overflow-hidden (allows thumb to render) */}
    <div
      className="fixed inset-0 z-[300] flex items-end lg:items-center justify-center pb-[env(safe-area-inset-bottom)] lg:pb-0"
      style={{ background: 'rgba(0,0,0,0.55)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {/* Sheet — NO overflow-hidden, use overflow-y-auto instead */}
      <div
        ref={containerRef}
        className="bg-white w-full max-w-lg rounded-t-[2.5rem] lg:rounded-[2.5rem] shadow-2xl overflow-y-auto max-h-[95dvh]"
        style={{ animation: 'slideUpModal 0.35s cubic-bezier(0.32,0.72,0,1)' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Inline keyframes */}
        <style>{`
          @keyframes slideUpModal {
            from { transform: translateY(60px); opacity: 0; }
            to   { transform: translateY(0);    opacity: 1; }
          }
        `}</style>

        {/* Top gradient bar */}
        <div className="h-1.5 w-full bg-gradient-to-r from-primary via-secondary to-sky-400 rounded-t-[2.5rem] lg:rounded-t-[2.5rem]" />

        {/* Drag pill (mobile) */}
        <div className="flex justify-center pt-3 lg:hidden">
          <div className="w-10 h-1 bg-zinc-200 rounded-full" />
        </div>

        <div className="px-6 sm:px-8 pt-5 pb-10">
          {/* Header */}
          <div className="text-center mb-6">
            <div className="w-14 h-14 bg-primary-container rounded-[1.2rem] flex items-center justify-center mx-auto mb-3 shadow-sm">
              <span
                className="material-symbols-outlined text-primary text-2xl"
                style={{ fontVariationSettings: "'FILL' 1" }}
              >
                pets
              </span>
            </div>
            <h2 className="text-xl font-extrabold tracking-tight text-on-surface">
              Social Vibe Check
            </h2>
            <p className="text-on-surface-variant text-sm mt-1 font-medium">
              How does your pet feel around other fur friends?
            </p>
          </div>

          {/* Live level card — updates instantly as slider moves */}
          <div
            className={`${bg} rounded-2xl p-4 mb-6 text-center transition-colors duration-200`}
          >
            <span className="text-4xl mb-1 block">{emoji}</span>
            <p className={`font-extrabold text-lg tracking-tight ${color} transition-colors duration-200`}>
              {label}
            </p>
            <p className="text-on-surface-variant text-xs mt-0.5 font-medium uppercase tracking-widest">
              Score: <span className="font-black">{score}</span> / 100
            </p>
          </div>

          {/* Progress bar */}
          <div className="mb-1">
            <div className="flex justify-between text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/50 mb-2">
              <span>Introvert</span>
              <span>Social Butterfly</span>
            </div>
            <div className="w-full h-2.5 bg-zinc-200 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-none"
                style={{
                  width: `${score}%`,
                  background: 'linear-gradient(to right, #F4A7B9, #a8d8ea, #38bdf8)',
                }}
              />
            </div>
          </div>

          {/* ── CUSTOM SLIDER — fully interactable ───────── */}
          <PawSlider value={score} onChange={setSc} />

          {/* Vibe cards grid */}
          <div className="grid grid-cols-2 gap-2 mb-6 mt-2">
            {VIBES.map(({ range, label: l, emoji: e }) => {
              const isActive = score >= range[0] && score <= range[1];
              return (
                <div
                  key={range[0]}
                  className={`flex items-center gap-2 p-2.5 rounded-xl text-xs font-medium transition-all duration-200 ${
                    isActive
                      ? 'bg-primary-container text-on-primary-container font-bold scale-[1.03] shadow-sm'
                      : 'bg-surface-container-low text-on-surface-variant/70'
                  }`}
                >
                  <span className="text-base">{e}</span>
                  <div>
                    <p className="font-bold text-[10px] uppercase tracking-wide leading-tight">{l}</p>
                    <p className="text-[9px] opacity-50">{range[0]}–{range[1]}</p>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Action buttons */}
          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="flex-1 py-3.5 rounded-2xl border-2 border-outline-variant/20 text-on-surface-variant font-bold hover:bg-surface-container-low transition-all active:scale-95 text-sm"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving || saved}
              className="flex-[2] py-3.5 rounded-2xl bg-gradient-to-br from-primary to-primary-fixed-dim text-white font-bold shadow-lg shadow-primary/20 hover:shadow-primary/40 active:scale-95 transition-all disabled:opacity-70 flex items-center justify-center gap-2 text-sm"
            >
              {saved ? (
                <>
                  <span className="material-symbols-outlined text-sm" style={{ fontVariationSettings: "'FILL' 1" }}>check_circle</span>
                  Saved!
                </>
              ) : saving ? (
                <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              ) : (
                <>
                  <span className="material-symbols-outlined text-sm" style={{ fontVariationSettings: "'FILL' 1" }}>pets</span>
                  Save My Vibe
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
    </Portal>
  );
}
