import { useAuth } from '../context/AuthContext';
import { useNavigate } from 'react-router-dom';
import Portal from './Portal';

import { publicAsset } from '../utils/publicPath';
export default function SwitchPetModal({ isOpen, onClose }) {
  const { pet: activePet, allPets, switchPet } = useAuth();
  const navigate = useNavigate();

  if (!isOpen) return null;

  const handleSelectPet = (petId) => {
    if (petId === activePet?.id) {
      onClose();
      return;
    }
    onClose();
    switchPet(petId);
  };

  const handleAddNewPet = () => {
    onClose();
    navigate('/pet-selection');
  };

  const handleManageProfiles = () => {
    alert("Manage Pet Profiles (renaming, reordering, profile settings) is coming soon!");
  };

  const primaryPetId = allPets?.[0]?.id;

  return (
    <Portal trapFocus>
    <div
      className="fixed inset-0 z-[200] bg-black/60 backdrop-blur-sm flex items-end justify-center sm:items-center pt-0 px-0 pb-[env(safe-area-inset-bottom)] sm:p-4 select-none animate-fade-in"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-zinc-900 border border-outline-variant/10 w-full max-w-sm sm:max-w-md rounded-t-[2.5rem] sm:rounded-[2.5rem] p-6 shadow-2xl space-y-5 animate-slide-up text-left max-h-[85dvh] overflow-y-auto no-scrollbar"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex justify-between items-center pb-2 border-b border-zinc-100 dark:border-zinc-800">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-xl">pets</span>
            <h3 className="font-extrabold text-base text-on-surface">Choose Pet Profile</h3>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-400 hover:text-on-surface flex items-center justify-center transition-colors"
          >
            <span className="material-symbols-outlined text-sm">close</span>
          </button>
        </div>

        {/* Pet Profiles List */}
        <div className="space-y-3">
          {allPets.map((p) => {
            const isActive = p.id === activePet?.id;
            const isPrimary = p.id === primaryPetId;
            const petEmoji = p.type === 'cat' ? '🐱' : '🐶';

            return (
              <div
                key={p.id}
                onClick={() => handleSelectPet(p.id)}
                className={`flex items-center justify-between p-3.5 rounded-2xl cursor-pointer transition-all duration-200 border ${
                  isActive
                    ? 'bg-primary/10 border-primary/30 shadow-xs'
                    : 'bg-zinc-50 dark:bg-zinc-800/50 border-zinc-200/50 dark:border-zinc-700/50 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                }`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="relative flex-shrink-0">
                    <img
                      src={p.avatar_url || publicAsset('/logo.png')}
                      alt={p.name}
                      className="w-12 h-12 rounded-full object-cover border-2 border-white dark:border-zinc-700 shadow-sm"
                    />
                    <span className="absolute -bottom-1 -right-1 text-xs">{petEmoji}</span>
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="font-extrabold text-sm text-on-surface truncate">
                        {p.name}
                      </span>
                      {isActive && (
                        <span className="material-symbols-outlined text-primary text-xs">check_circle</span>
                      )}
                      {isPrimary && (
                        <span className="bg-amber-100 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300 text-[9px] font-extrabold px-2 py-0.5 rounded-full flex items-center gap-0.5 shadow-2xs">
                          <span className="material-symbols-outlined text-[10px]">military_tech</span> Primary Pet
                        </span>
                      )}
                    </div>
                    {p.pet_username && (
                      <p className="text-[11px] font-bold text-primary truncate">
                        {p.pet_username.startsWith('@') ? p.pet_username : `@${p.pet_username}`}
                      </p>
                    )}
                    <p className="text-[10px] font-medium text-zinc-400 dark:text-zinc-500 truncate">
                      {p.breed_name || p.type || 'Furry Friend'}
                    </p>
                  </div>
                </div>

                <div className="flex-shrink-0 ml-2">
                  <span className={`material-symbols-outlined text-lg ${isActive ? 'text-primary' : 'text-zinc-300'}`}>
                    {isActive ? 'radio_button_checked' : 'radio_button_unchecked'}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        <div className="border-t border-zinc-100 dark:border-zinc-800 pt-3 space-y-2">
          {/* Add New Pet Button or Max Reached Label */}
          {allPets.length < 5 ? (
            <button
              onClick={handleAddNewPet}
              className="w-full py-3.5 px-4 bg-primary/10 hover:bg-primary/20 text-primary font-extrabold text-xs rounded-2xl transition-all flex items-center justify-center gap-2 active:scale-95 shadow-2xs"
            >
              <span className="material-symbols-outlined text-sm">add</span> Add New Pet
            </button>
          ) : (
            <div className="py-3 px-4 bg-amber-50 dark:bg-amber-950/30 border border-amber-200/50 dark:border-amber-900/30 rounded-2xl text-center">
              <p className="text-xs font-extrabold text-amber-700 dark:text-amber-400">
                Maximum of 5 pet profiles reached.
              </p>
            </div>
          )}

          {/* Manage Pet Profiles Placeholder */}
          <button
            onClick={handleManageProfiles}
            className="w-full py-3 px-4 bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-600 dark:text-zinc-300 font-extrabold text-xs rounded-2xl transition-all flex items-center justify-center gap-2 active:scale-95"
          >
            <span className="material-symbols-outlined text-sm">settings</span> Manage Pet Profiles
          </button>
        </div>
      </div>
    </div>
    </Portal>
  );
}
