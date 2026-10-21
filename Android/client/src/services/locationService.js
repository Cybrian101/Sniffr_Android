/**
 * Location Service for Sniffr
 * Provides consistent GPS location fetching, reverse geocoding, and stored location sync across all features.
 */

/**
 * Reverse geocodes lat/lng into { country, state, city, area }
 * Uses OpenStreetMap Nominatim reverse geocoding with timeout handling.
 */
export async function reverseGeocode(lat, lng) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);

    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`,
      {
        headers: { 'Accept-Language': 'en' },
        signal: controller.signal
      }
    );
    clearTimeout(timeoutId);

    if (!res.ok) throw new Error('Geocoding service unavailable');
    const data = await res.json();
    const addr = data.address || {};

    const country = addr.country || (addr.country_code ? addr.country_code.toUpperCase() : '');
    const state = addr.state || addr.region || addr.state_district || addr.province || '';
    const city = addr.city || addr.town || addr.village || addr.municipality || addr.county || addr.suburb || '';
    const area = addr.suburb || addr.neighbourhood || addr.quarter || addr.residential || addr.road || addr.district || addr.city_district || '';

    return { country, state, city, area };
  } catch (err) {
    console.warn('Reverse geocoding fallback triggered:', err);
    return { country: '', state: '', city: '', area: '' };
  }
}

/**
 * Requests device GPS location with high precision and reverse geocodes into location fields.
 * Returns { latitude, longitude, country, state, city, area }
 */
export async function getCurrentGPSLocation() {
  if (!navigator.geolocation) {
    throw new Error('LOCATION_UNSUPPORTED');
  }

  const pos = await new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      resolve,
      reject,
      {
        enableHighAccuracy: true,
        timeout: 12000,
        maximumAge: 30000
      }
    );
  });

  const { latitude, longitude } = pos.coords;
  const geocoded = await reverseGeocode(latitude, longitude);

  const locationData = {
    latitude,
    longitude,
    country: geocoded.country || '',
    state: geocoded.state || '',
    city: geocoded.city || '',
    area: geocoded.area || '',
    timestamp: Date.now()
  };

  try {
    localStorage.setItem('sniffr_user_gps_location', JSON.stringify(locationData));
  } catch (e) {
    /* ignore storage errors */
  }

  return locationData;
}

/**
 * Gets stored location data if available.
 */
export function getStoredLocation() {
  try {
    const data = localStorage.getItem('sniffr_user_gps_location');
    return data ? JSON.parse(data) : null;
  } catch (e) {
    return null;
  }
}

function haversineDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const WATCH_MIN_INTERVAL_MS = 20000; // re-geocode at most this often even if the user keeps moving
const WATCH_MIN_DISTANCE_M = 75; // ...or sooner, once they've moved far enough for it to matter

/**
 * Continuously tracks the device's GPS position (via watchPosition) and
 * calls onUpdate with fresh { latitude, longitude, country, state, city,
 * area, timestamp } data as the user moves -- no manual refresh needed.
 * Reverse-geocoding is throttled by both time and distance so a stream of
 * raw GPS fixes doesn't turn into a stream of Nominatim requests (their
 * usage policy caps this around 1 req/sec, and nothing changes on-screen
 * for a few metres of GPS jitter anyway). Returns a function that stops
 * the watch -- always call it on unmount / when tracking should end.
 */
export function watchLiveLocation(onUpdate, onError) {
  if (!navigator.geolocation) {
    onError?.(new Error('LOCATION_UNSUPPORTED'));
    return () => {};
  }

  let lastGeocodedAt = 0;
  let lastCoords = null;
  let geocoding = false;

  const watchId = navigator.geolocation.watchPosition(
    async (pos) => {
      const { latitude, longitude } = pos.coords;
      const now = Date.now();
      const moved = !lastCoords || haversineDistanceMeters(lastCoords.latitude, lastCoords.longitude, latitude, longitude) >= WATCH_MIN_DISTANCE_M;
      const dueForRefresh = now - lastGeocodedAt >= WATCH_MIN_INTERVAL_MS;
      if (geocoding || (!moved && !dueForRefresh)) return;

      lastCoords = { latitude, longitude };
      lastGeocodedAt = now;
      geocoding = true;

      try {
        const geocoded = await reverseGeocode(latitude, longitude);
        const locationData = {
          latitude,
          longitude,
          country: geocoded.country || '',
          state: geocoded.state || '',
          city: geocoded.city || '',
          area: geocoded.area || '',
          timestamp: now,
        };
        try {
          localStorage.setItem('sniffr_user_gps_location', JSON.stringify(locationData));
        } catch (e) { /* ignore storage errors */ }
        onUpdate(locationData);
      } catch (err) {
        onError?.(err);
      } finally {
        geocoding = false;
      }
    },
    (err) => onError?.(err),
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 }
  );

  return () => navigator.geolocation.clearWatch(watchId);
}
