const stores = new Map();

export function rateLimiter({ windowMs = 60000, max = 60 } = {}) {
  return (req, res, next) => {
    // Keyed per route, not per router mount point -- `req.baseUrl` alone
    // (e.g. '/api/auth') put every sub-route (login, signup, 2FA, refresh,
    // logout, /me) in one shared bucket, so hammering /login could lock a
    // user out of /signup or /logout too. See AUDIT_REPORT.md.
    const key = `${req.ip}_${req.method}_${req.baseUrl}${req.path}`;
    const now = Date.now();
    let record = stores.get(key);
    if (!record || now - record.start > windowMs) {
      record = { start: now, count: 0 };
      stores.set(key, record);
    }
    record.count++;
    if (record.count > max) {
      const retryAfter = Math.ceil((record.start + windowMs - now) / 1000);
      res.set('Retry-After', retryAfter);
      return res.status(429).json({ error: 'RATE_LIMIT', message: 'Too many requests', retryAfter });
    }
    next();
  };
}

// Cleanup old entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, record] of stores) {
    if (now - record.start > 120000) stores.delete(key);
  }
}, 60000);

// Counts only FAILURES per key (e.g. account lookups that matched nothing)
// over a long window; successful requests are never recorded. rateLimiter()
// above can't do this: it counts every request and its entries are pruned
// after two minutes. In memory, like rateLimiter: a server restart resets it.
export function failureCounter({ windowMs, max }) {
  const failures = new Map(); // key -> failure timestamps (oldest first)
  const recent = key => {
    const now = Date.now();
    const list = (failures.get(key) || []).filter(t => now - t < windowMs);
    if (list.length) failures.set(key, list); else failures.delete(key);
    return list;
  };
  setInterval(() => { for (const key of [...failures.keys()]) recent(key); }, 10 * 60 * 1000).unref();
  return {
    // Seconds until the key may try again; 0 when it isn't blocked.
    retryAfterSeconds(key) {
      const list = recent(key);
      return list.length >= max ? Math.max(1, Math.ceil((list[0] + windowMs - Date.now()) / 1000)) : 0;
    },
    record(key) {
      const list = recent(key);
      list.push(Date.now());
      failures.set(key, list);
    },
  };
}
