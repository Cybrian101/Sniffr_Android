/**
 * Centralized Permission Management Service for Sniffr
 * Handles feature-driven permission checks, system prompts,
 * status persistence in localStorage, and feature capability access.
 */

const STORAGE_KEY = 'sniffr_permissions_status';

export const CAPABILITIES = {
  LOCATION: 'location',
  PHOTOS: 'photos',
  CAMERA: 'camera',
  MICROPHONE: 'microphone',
  NOTIFICATIONS: 'notifications',
};

export const CAPABILITY_CONFIG = {
  location: {
    title: 'Location Access Required',
    icon: 'location_on',
    color: 'bg-emerald-500/10 text-emerald-600',
    description: 'Sniffr needs location access to calculate distance to playmates, display nearby PawCircle communities, and reverse-geocode your area.',
    featureLabels: {
      gps: 'Use Current GPS Location',
      profile: 'Edit Profile Location',
      meet: 'Nearby Playmate Recommendations',
      events: 'Nearby PawCircle Meetups & Events',
    }
  },
  photos: {
    title: 'Photos & Media Access',
    icon: 'photo_library',
    color: 'bg-indigo-500/10 text-indigo-600',
    description: 'Sniffr needs media library access to let you select photos for your pet profile, Memories, and chat attachments.',
    featureLabels: {
      memory: 'Upload a Memory',
      avatar: 'Change Profile Picture',
      gallery: 'Upload Gallery Photos',
      chat: 'Attach Media in Chat',
    }
  },
  camera: {
    title: 'Camera Access Required',
    icon: 'photo_camera',
    color: 'bg-rose-500/10 text-rose-600',
    description: 'Sniffr needs camera access so you can take real-time pet photos, capture new Memories, and enable video during calls.',
    featureLabels: {
      capture: 'Capture Memory Photo',
      avatar: 'Take Profile Picture',
      videoCall: 'Video Call Camera',
    }
  },
  microphone: {
    title: 'Microphone Access Required',
    icon: 'mic',
    color: 'bg-amber-500/10 text-amber-600',
    description: 'Sniffr needs microphone access to enable crystal-clear audio calls and send voice notes to your playmates.',
    featureLabels: {
      audioCall: 'Start Audio Call',
      videoCall: 'Video Call Audio',
      voiceNote: 'Record Voice Notes',
    }
  },
  notifications: {
    title: 'Notification Access',
    icon: 'notifications_active',
    color: 'bg-primary/10 text-primary',
    description: 'Enable notifications to get instant alerts for chat messages, playdate requests, PawCircle announcements, and matches.',
    featureLabels: {
      chat: 'Chat & Direct Messages',
      announcements: 'PawCircle Announcements',
      matches: 'Playmate Matches & Licks',
      events: 'Nearby Meetup Reminders',
    }
  }
};

export function getStoredPermissions() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

export function savePermissionStatus(capability, status) {
  try {
    const existing = getStoredPermissions();
    existing[capability] = { status, timestamp: Date.now() };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(existing));
  } catch (e) {
    console.error('Failed to save permission status:', e);
  }
}

/**
 * Checks system-level or stored permission status for a capability.
 * Returns 'granted' | 'denied' | 'prompt'
 */
export async function getCapabilityStatus(capability) {
  const stored = getStoredPermissions()[capability];

  if (capability === 'location') {
    if (navigator.permissions && navigator.permissions.query) {
      try {
        const res = await navigator.permissions.query({ name: 'geolocation' });
        savePermissionStatus('location', res.state);
        return res.state;
      } catch (e) {}
    }
  } else if (capability === 'notifications') {
    if ('Notification' in window) {
      const state = Notification.permission === 'default' ? 'prompt' : Notification.permission;
      savePermissionStatus('notifications', state);
      return state;
    }
  } else if (capability === 'camera' || capability === 'microphone') {
    if (navigator.permissions && navigator.permissions.query) {
      try {
        const name = capability === 'camera' ? 'camera' : 'microphone';
        const res = await navigator.permissions.query({ name });
        savePermissionStatus(capability, res.state);
        return res.state;
      } catch (e) {}
    }
  }

  return stored?.status || 'prompt';
}

/**
 * Executes system browser permission request for a capability.
 */
export async function requestSystemPermission(capability) {
  try {
    if (capability === 'location') {
      return new Promise((resolve) => {
        if (!navigator.geolocation) {
          savePermissionStatus('location', 'denied');
          return resolve('denied');
        }
        navigator.geolocation.getCurrentPosition(
          () => {
            savePermissionStatus('location', 'granted');
            resolve('granted');
          },
          (err) => {
            const state = err.code === 1 ? 'denied' : 'prompt';
            savePermissionStatus('location', state);
            resolve(state);
          },
          { timeout: 10000, maximumAge: 60000 }
        );
      });
    }

    if (capability === 'notifications') {
      if ('Notification' in window) {
        const result = await Notification.requestPermission();
        const state = result === 'default' ? 'prompt' : result;
        savePermissionStatus('notifications', state);
        return state;
      }
      return 'denied';
    }

    if (capability === 'camera' || capability === 'microphone') {
      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        try {
          const constraints = capability === 'camera' ? { video: true } : { audio: true };
          const stream = await navigator.mediaDevices.getUserMedia(constraints);
          stream.getTracks().forEach(t => t.stop());
          savePermissionStatus(capability, 'granted');
          return 'granted';
        } catch (e) {
          savePermissionStatus(capability, 'denied');
          return 'denied';
        }
      }
    }

    if (capability === 'photos') {
      savePermissionStatus('photos', 'granted');
      return 'granted';
    }
  } catch (err) {
    savePermissionStatus(capability, 'denied');
    return 'denied';
  }

  savePermissionStatus(capability, 'granted');
  return 'granted';
}
