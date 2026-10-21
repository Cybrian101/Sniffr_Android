// Placeholder for media (or a shared post / profile card) whose content was
// removed, e.g. because its owner deleted their account. Not interactive.
export default function MediaUnavailable({ label = 'No longer available', icon = 'hide_image', compact = false, className = '' }) {
  return (
    <div
      role="note"
      className={`inline-flex items-center gap-2 rounded-2xl border border-dashed border-zinc-300 dark:border-zinc-700 bg-zinc-100 dark:bg-zinc-800 text-zinc-400 dark:text-zinc-500 font-bold select-none cursor-default ${compact ? 'px-3 py-2 text-[10px]' : 'px-4 py-3 text-xs'} ${className}`}
    >
      <span className={`material-symbols-outlined ${compact ? 'text-[14px]' : 'text-[18px]'}`}>{icon}</span>
      <span>{label}</span>
    </div>
  );
}
