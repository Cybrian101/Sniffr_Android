// Shared badge dropped in next to a pet's name wherever it appears (Profile,
// Meet, Feed, Spotlight, Chat, PawCircle, comments, notifications). Reads
// `pet.is_premium`, which PetRepository.attachCompletionStats() now attaches
// to every pet object the backend returns -- one centralized computation,
// many render call sites, never a re-derived plan check on the frontend.
export default function PremiumBadge({ pet, size = 'text-sm', className = '' }) {
  if (!pet?.is_premium) return null;
  return (
    <span
      className={`inline-flex items-center justify-center text-amber-500 flex-shrink-0 ${className}`}
      title="Sniffr Premium"
    >
      <span className={`material-symbols-outlined ${size}`} style={{ fontVariationSettings: "'FILL' 1" }}>
        workspace_premium
      </span>
    </span>
  );
}
