// One-line preview of a chat message for the conversation list. Special
// messages store data (a meetup is JSON, a shared post or pet card a
// reference), so they get a friendly label instead of their raw content.

const LABELS = {
  meetup: 'Meetup invitation',
  image: 'Photo',
  video: 'Video',
  voice: 'Voice message',
  file: 'File',
  shared_post: 'Shared a post',
  pet_profile: 'Shared a pet profile',
};

// Older rows / unknown types: a meetup's JSON still gets its label.
function looksLikeMeetup(content) {
  if (typeof content !== 'string' || !content.trim().startsWith('{')) return false;
  try {
    const data = JSON.parse(content);
    return !!(data && (data.location || data.date_time));
  } catch {
    return false;
  }
}

export function messagePreview(content, type) {
  if (type && LABELS[type]) return LABELS[type];
  if (looksLikeMeetup(content)) return LABELS.meetup;
  return content || '';
}
