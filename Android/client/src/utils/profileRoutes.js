function normalizePathSegment(segment) {
  try {
    return decodeURIComponent(segment).replace(/^@+/, '').toLowerCase();
  } catch {
    return segment.replace(/^@+/, '').toLowerCase();
  }
}

export function isOwnProfilePath(pathname, pet) {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === '/profile') return true;

  const segments = path.split('/').filter(Boolean);
  const ownUsername = pet?.pet_username
    ? normalizePathSegment(pet.pet_username)
    : '';

  if (segments.length === 1) {
    return !!ownUsername && normalizePathSegment(segments[0]) === ownUsername;
  }

  if (segments.length === 2 && segments[0] === 'profile' && pet) {
    const profileId = normalizePathSegment(segments[1]);
    return profileId === String(pet.id).toLowerCase() ||
      (!!ownUsername && profileId === ownUsername);
  }

  return false;
}
