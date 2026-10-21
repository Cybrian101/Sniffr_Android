// Names nobody may take, because the app itself uses them -- "SniffedOut" is
// what deleted accounts and pets are shown as, so a real user or pet with
// that name could pass itself off as (or be mistaken for) a tombstone.
// Compared case-insensitively with everything but letters and digits removed,
// so "sniffed_out", "Sniffed.Out", "@SniffedOut" and "Sniffed Out" all match.
const RESERVED = new Set(['sniffedout']);

export const RESERVED_NAME_MESSAGE = '"SniffedOut" is reserved by Sniffr. Please choose a different name.';

export function isReservedName(value) {
  if (value === undefined || value === null) return false;
  return RESERVED.has(String(value).toLowerCase().replace(/[^a-z0-9]/g, ''));
}
