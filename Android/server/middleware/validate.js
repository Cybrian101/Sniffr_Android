const validators = {
  email: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? null : 'Invalid email format',
  // Kept in sync with the real policy enforced inline in routes/auth.js
  // (validatePassword) -- this module isn't currently wired into any
  // route, but a weaker rule here was a landmine for whoever wires it in
  // next. See AUDIT_REPORT.md.
  password: (v) => {
    if (!v || v.length < 8 || v.length > 20) return 'Password must be 8-20 characters';
    if (!/[A-Z]/.test(v)) return 'Password must contain an uppercase letter';
    if (!/[a-z]/.test(v)) return 'Password must contain a lowercase letter';
    if (!/[0-9]/.test(v)) return 'Password must contain a number';
    if (!/[^a-zA-Z0-9]/.test(v)) return 'Password must contain a special character';
    return null;
  },
  username: (v) => {
    if (!v || v.length < 2) return 'Username must be at least 2 characters';
    if (!/^[a-zA-Z0-9_]+$/.test(v)) return 'Username can only contain letters, numbers, and underscores';
    return null;
  },

  required: (v) => (!v || (typeof v === 'string' && !v.trim())) ? 'This field is required' : null,
  maxLength: (max) => (v) => v && v.length > max ? `Must be ${max} characters or less` : null,
  numeric: (v) => v !== undefined && v !== null && isNaN(Number(v)) ? 'Must be a number' : null,
  latitude: (v) => v !== undefined && (v < -90 || v > 90) ? 'Invalid latitude' : null,
  longitude: (v) => v !== undefined && (v < -180 || v > 180) ? 'Invalid longitude' : null,
};

export function validate(rules) {
  return (req, res, next) => {
    const errors = [];
    for (const [field, fieldRules] of Object.entries(rules)) {
      const value = req.body[field] ?? req.query[field] ?? req.params[field];
      for (const rule of fieldRules) {
        const fn = typeof rule === 'string' ? validators[rule] : rule;
        const error = fn(value);
        if (error) {
          errors.push({ field, message: error });
          break;
        }
      }
    }
    if (errors.length) return res.status(400).json({ error: 'VALIDATION_ERROR', errors });
    next();
  };
}

export { validators };
