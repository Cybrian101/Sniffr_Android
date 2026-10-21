// Every socket event handler runs client-controlled input. Registered as a
// Socket.IO middleware (io.use) BEFORE the setup*Socket handlers attach, it
// wraps socket.on for that socket so that no handler can take the process
// down:
//   - the payload of a client event is always an object: null, undefined, a
//     primitive or an array becomes {} (so `({ conversationId }) =>` can't
//     throw while destructuring); an ack callback sent without a payload
//     keeps its place as the second argument;
//   - a synchronous throw is caught, and a rejected promise from an async
//     handler is caught (an unhandled rejection exits Node >= 15).
// Failures are logged with the event name and user id only -- never the
// payload, which can hold message text.
const RESERVED_EVENTS = new Set(['disconnect', 'disconnecting', 'error', 'newListener', 'removeListener']);

function logFailure(socket, event, err) {
  console.error(`[socket] "${event}" handler failed (user #${socket.user?.id ?? '?'}):`, err?.message || err);
}

export function normalizeArgs(args) {
  const [first, ...rest] = args;
  if (typeof first === 'function') return [{}, first, ...rest];
  if (first === null || typeof first !== 'object' || Array.isArray(first)) return [{}, ...rest];
  return args;
}

export function guardSocketHandlers(socket, next) {
  const originalOn = socket.on.bind(socket);
  socket.on = (event, handler) => {
    if (typeof handler !== 'function') return originalOn(event, handler);
    const reserved = RESERVED_EVENTS.has(event);
    return originalOn(event, (...args) => {
      try {
        const result = handler(...(reserved ? args : normalizeArgs(args)));
        if (result && typeof result.then === 'function') result.catch(err => logFailure(socket, event, err));
        return result;
      } catch (err) {
        logFailure(socket, event, err);
        return undefined;
      }
    });
  };
  next();
}

// Positive integer id from client input, or null.
export function toId(value) {
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return Number.isInteger(n) && n > 0 ? n : null;
}
