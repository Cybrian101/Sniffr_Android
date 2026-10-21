// Shared paw-print clip-path used to render PawCircle community avatars in
// the shape of a paw (one pad + four toes) instead of a plain circle/square.
// `clipPathUnits="objectBoundingBox"` normalizes the path to 0-1 so it works
// at any element size -- render <PawClipDefs /> once per page, then apply
// `className={PAW_CLIP_CLASS}` (or `style={{ clipPath: PAW_CLIP_STYLE }}`)
// to any image/div that should take the paw silhouette.
export const PAW_CLIP_STYLE = 'url(#paw-shape-clip)';

export function PawClipDefs() {
  return (
    <svg width="0" height="0" className="absolute" aria-hidden="true" focusable="false">
      <defs>
        <clipPath id="paw-shape-clip" clipPathUnits="objectBoundingBox">
          {/* Main pad */}
          <path d="M0.20,0.68 A0.30,0.24 0 1 0 0.80,0.68 A0.30,0.24 0 1 0 0.20,0.68 Z" />
          {/* Four toes */}
          <path d="M0.08,0.36 A0.12,0.12 0 1 0 0.32,0.36 A0.12,0.12 0 1 0 0.08,0.36 Z" />
          <path d="M0.28,0.16 A0.11,0.11 0 1 0 0.50,0.16 A0.11,0.11 0 1 0 0.28,0.16 Z" />
          <path d="M0.50,0.16 A0.11,0.11 0 1 0 0.72,0.16 A0.11,0.11 0 1 0 0.50,0.16 Z" />
          <path d="M0.68,0.36 A0.12,0.12 0 1 0 0.92,0.36 A0.12,0.12 0 1 0 0.68,0.36 Z" />
        </clipPath>
      </defs>
    </svg>
  );
}
