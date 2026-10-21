// Optional build-time opt-in for deploying this same SPA build under a URL
// sub-path (e.g. https://www.sniffrweb.com/web/) instead of a domain root
// (https://sniffr-web.vercel.app/). Unset by default -- every existing
// deployment (Vercel root, Capacitor APK) gets APP_BASENAME = '' and behaves
// exactly as before. Set VITE_APP_BASENAME=/web (no trailing slash) only on
// the deployment that's actually mounted at /web/.
export const APP_BASENAME = import.meta.env.VITE_APP_BASENAME || '';

// Files under client/public/ (logo.png, paw-*.png, ...) are referenced by
// root-relative src="/logo.png" strings in JSX. Unlike bundled JS/CSS
// (resolved via Vite's `base` against the importing module's own URL), the
// browser resolves a literal "/logo.png" against the CURRENT document
// location -- so on a nested client-side route it still means "domain root",
// not "wherever this SPA is mounted". This must be prefixed explicitly.
export function publicAsset(path) {
  const withSlash = path.startsWith('/') ? path : `/${path}`;
  return `${APP_BASENAME}${withSlash}`;
}
