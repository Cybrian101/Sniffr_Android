import { useState, useRef, useCallback } from 'react';

/**
 * usePullToRefresh — reusable hook for Sniffr-branded pull-to-refresh.
 * Returns touch handlers, pull state, and a PawTrailIndicator component.
 *
 * @param {Function} onRefresh - async function to call when pull threshold is met
 * @returns {{ pullDistance, refreshing, handlers, PawTrailIndicator }}
 */
export default function usePullToRefresh(onRefresh) {
  const [pullDistance, setPullDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const touchStartY = useRef(0);

  const handleTouchStart = useCallback((e) => {
    if (window.scrollY === 0) {
      touchStartY.current = e.touches[0].pageY;
    }
  }, []);

  const handleTouchMove = useCallback((e) => {
    if (refreshing || window.scrollY > 0) return;
    const diff = e.touches[0].pageY - touchStartY.current;
    if (diff > 0 && touchStartY.current > 0) {
      const dist = Math.min(80, Math.pow(diff, 0.75) * 1.8);
      setPullDistance(dist);
    }
  }, [refreshing]);

  const handleTouchEnd = useCallback(async () => {
    if (refreshing) return;
    if (pullDistance > 45) {
      setRefreshing(true);
      setPullDistance(50);
      try {
        await onRefresh();
      } catch (e) {
        console.error('Pull-to-refresh error:', e);
      } finally {
        setRefreshing(false);
        setPullDistance(0);
      }
    } else {
      setPullDistance(0);
    }
    touchStartY.current = 0;
  }, [pullDistance, refreshing, onRefresh]);

  const handlers = {
    onTouchStart: handleTouchStart,
    onTouchMove: handleTouchMove,
    onTouchEnd: handleTouchEnd,
  };

  // Paw-trail refresh indicator component
  const PawTrailIndicator = () => {
    if (pullDistance <= 0 && !refreshing) return null;
    return (
      <div
        className="fixed top-20 left-0 right-0 z-40 flex justify-center items-center transition-all duration-200"
        style={{
          height: refreshing ? '50px' : `${pullDistance}px`,
          opacity: Math.min(1, refreshing ? 1 : pullDistance / 45),
        }}
      >
        <div className="bg-white/90 backdrop-blur-sm shadow-md rounded-full px-5 py-2 flex items-center gap-1 border border-[#F4A7B9]/20">
          <span className="paw-trail-dot animate-bounce" style={{ animationPlayState: refreshing ? 'running' : 'paused' }}>🐾</span>
          <span className="paw-trail-dot animate-bounce delay-75" style={{ animationPlayState: refreshing ? 'running' : 'paused' }}>🐾</span>
          <span className="paw-trail-dot animate-bounce delay-150" style={{ animationPlayState: refreshing ? 'running' : 'paused' }}>🐾</span>
        </div>
      </div>
    );
  };

  return { pullDistance, refreshing, handlers, PawTrailIndicator };
}
