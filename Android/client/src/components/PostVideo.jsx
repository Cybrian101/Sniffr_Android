import { useState } from 'react';
import { videoPosterUrl } from '../utils/media';

// Video block used everywhere a post's video plays (feed, gallery, shared
// post links, notification post view, chat preview cards). Fixes two things
// a bare <video> left broken: (1) it rendered fully blank/black until the
// browser finished loading a frame -- no cue it was even a video, and (2) an
// unconstrained box (or object-contain with no reserved aspect ratio) let
// its rendered size collapse to the browser's ~300x150 default before
// metadata arrived, then jump once it did -- which is what read as "empty
// space around the video". A fixed-aspect frame with object-cover keeps the
// frame fully filled (no letterbox bars, no layout jump) on any screen size,
// and the template placeholder covers the loading window instead of blank.
export default function PostVideo({ src, className = '', controls = true, fill = false }) {
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  return (
    <div className={`relative overflow-hidden bg-zinc-900 ${fill ? 'w-full h-full' : 'w-full aspect-video'} ${className}`}>
      {(!ready || failed) && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-gradient-to-br from-zinc-800 to-zinc-900 pointer-events-none">
          <span className="material-symbols-outlined text-white/70 text-3xl" style={{ fontVariationSettings: "'FILL' 1" }}>
            {failed ? 'videocam_off' : 'movie'}
          </span>
          {!fill && (
            <span className="text-[10px] font-bold uppercase tracking-widest text-white/50">
              {failed ? 'Video unavailable' : 'Loading video…'}
            </span>
          )}
        </div>
      )}
      {!failed && (
        <video
          src={src}
          poster={videoPosterUrl(src)}
          controls={controls}
          preload="metadata"
          playsInline
          className={`w-full h-full object-cover transition-opacity duration-300 ${ready ? 'opacity-100' : 'opacity-0'}`}
          onLoadedData={() => setReady(true)}
          onError={() => setFailed(true)}
        />
      )}
    </div>
  );
}
