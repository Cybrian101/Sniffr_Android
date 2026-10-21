import { safeLinkUrl } from '../utils/media';

const isVideoUrl = (url) => /\.(mp4|webm|mov)(\?|$)/i.test(url || '');

// Fullscreen photo/video viewer shared by 1:1 chat and PawCircle chat --
// tapping an image/video bubble opens this instead of leaving the media
// stuck at its small inline size. `urls` is every media message in the
// open conversation (so prev/next can page through them); `index` is
// which one was tapped.
export default function MediaViewerModal({ urls, index, onIndexChange, onClose }) {
  if (!urls || !urls.length) return null;
  const url = urls[index];

  return (
    <div className="fixed inset-0 z-[250] bg-black/95 flex flex-col justify-between p-4" onClick={onClose}>
      <div className="flex justify-between items-center text-white p-2">
        <span className="text-xs font-bold">{index + 1} / {urls.length}</span>
        <div className="flex gap-4">
          <a href={safeLinkUrl(url)} download target="_blank" rel="noreferrer" className="text-white hover:text-primary flex items-center gap-1 text-xs" onClick={e => e.stopPropagation()}>
            <span className="material-symbols-outlined">download</span> Download
          </a>
          <button onClick={onClose} className="text-white hover:text-red-500">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>
      </div>

      <div className="flex-1 flex items-center justify-between" onClick={e => e.stopPropagation()}>
        <button
          disabled={index === 0}
          onClick={() => onIndexChange(index - 1)}
          className="w-12 h-12 rounded-full bg-white/10 text-white flex items-center justify-center disabled:opacity-30"
        >
          <span className="material-symbols-outlined">chevron_left</span>
        </button>

        <div className="max-w-[85vw] max-h-[70vh] flex items-center justify-center overflow-hidden">
          {isVideoUrl(url) ? (
            <video src={url} controls autoPlay className="max-w-full max-h-full rounded-lg" />
          ) : (
            <img src={url} alt="Fullscreen media" className="max-w-full max-h-full rounded-lg object-contain transition-transform" />
          )}
        </div>

        <button
          disabled={index === urls.length - 1}
          onClick={() => onIndexChange(index + 1)}
          className="w-12 h-12 rounded-full bg-white/10 text-white flex items-center justify-center disabled:opacity-30"
        >
          <span className="material-symbols-outlined">chevron_right</span>
        </button>
      </div>
      <div />
    </div>
  );
}
