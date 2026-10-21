// An account can exist without a pet ("I'll do this later" during signup).
// Anything that acts as a pet (Meet, posting, liking, chatting, calls,
// PawCircles...) needs one: the server answers 403 NO_PET, and the app-wide
// NoPetPrompt asks the user to create their pet's profile.

export const NO_PET_EVENT = 'sniffr:no-pet';
export const NO_PET_MESSAGE = "Create your pet's profile first";

export const isNoPetError = err => err?.code === 'NO_PET';

// Opens the "create your pet's profile" prompt.
export function promptCreatePet() {
  window.dispatchEvent(new CustomEvent(NO_PET_EVENT));
}

// For a click handler that needs a pet: true (and the prompt opens) if
// there's none yet, so the caller can stop.
export function needsPet(pet) {
  if (pet) return false;
  promptCreatePet();
  return true;
}
