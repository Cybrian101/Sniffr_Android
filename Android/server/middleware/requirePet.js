import PetRepo from '../models/PetRepository.js';
import { sendServerError } from '../utils/errors.js';

// Actions that act AS a pet (sniffing, posting, liking, chatting, calls,
// PawCircles...) need one. An account can exist without a pet ("I'll do this
// later" during signup): those actions answer 403 NO_PET, and the app shows
// "Create your pet's profile first" with a button to create it. Reading
// (feed, lists, profiles) keeps working without a pet.
// Sets req.pet to the user's active pet. Runs after authenticateAccess.

export const NO_PET_BODY = { error: 'NO_PET', message: "Create your pet's profile first 🐾" };

export async function requirePet(req, res, next) {
  try {
    const pet = await PetRepo.getActivePet(req.user.id);
    if (!pet) return res.status(403).json(NO_PET_BODY);
    req.pet = pet;
    next();
  } catch (err) {
    sendServerError(res, err);
  }
}
