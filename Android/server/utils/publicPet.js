// A pet as other users may see it. pets.latitude/longitude are the owner's
// exact GPS position (often their home), kept up to date live while they
// use Meet -- they must never leave the server except to the owner
// themselves (/auth/me, GET /api/profile, their own profile page). Distance
// is computed on the server for discovery, nearby, Spotlight and live
// updates, so no other screen needs the coordinates.
export const PRIVATE_PET_FIELDS = ['latitude', 'longitude', 'last_updated_location_timestamp'];

export function toPublicPet(pet) {
  if (!pet || typeof pet !== 'object') return pet;
  const copy = { ...pet };
  for (const field of PRIVATE_PET_FIELDS) delete copy[field];
  return copy;
}

export const toPublicPets = (pets) => (Array.isArray(pets) ? pets.map(toPublicPet) : pets);
