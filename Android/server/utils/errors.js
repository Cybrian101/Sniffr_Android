import config from '../config.js';

// Centralizes what an unexpected server error looks like in an API response.
// The real error is always logged server-side; the client only ever sees
// raw internals (table/column/constraint names, stack fragments) when
// NODE_ENV=development. Previously every route inlined `err.message`
// directly into the response in every environment -- see AUDIT_REPORT.md.
export function sendServerError(res, err, status = 500) {
  // L1: express.json() throws these as plain errors from body-parser --
  // without this they fell straight through to the generic 500 branch
  // below, even though a malformed request body is a client mistake (400),
  // not a server fault, and an oversized one has its own standard code
  // (413). body-parser marks both with `.type` and `.status`/`.statusCode`;
  // matched by type (not by `instanceof SyntaxError`, which oversized-body
  // errors aren't) so this can't misfire on an unrelated SyntaxError thrown
  // deeper in a route's own code.
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'INVALID_JSON', message: 'Request body is not valid JSON.' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large.' });
  }
  if (err.name === 'QuotaExceededError') {
    return res.status(413).json({
      error: 'QUOTA_EXCEEDED',
      message: 'Storage quota exceeded. Delete some media or upgrade your plan.',
      usedBytes: err.usedBytes,
      quotaBytes: err.quotaBytes,
    });
  }
  if (err.name === 'InvalidFileError') {
    return res.status(400).json({ error: 'INVALID_FILE', message: 'This file does not look like a valid file of its declared type.' });
  }
  console.error('[SERVER_ERROR]', err);
  const message = config.NODE_ENV === 'development'
    ? err.message
    : 'Something went wrong. Please try again.';
  return res.status(status).json({ error: 'SERVER_ERROR', message });
}
