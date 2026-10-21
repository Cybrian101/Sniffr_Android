import { publicAsset } from '../utils/publicPath';
import { SNIFFED_OUT_NAME } from '../utils/sniffedOut';

// Placeholder avatar for a SniffedOut (deleted) pet: the app logo, muted.
// Deliberately not interactive -- there is no profile behind it.
export function SniffedOutAvatar({ className = 'w-12 h-12 rounded-full' }) {
  return (
    <img
      src={publicAsset('/logo.png')}
      alt={SNIFFED_OUT_NAME}
      draggable={false}
      className={`${className} object-cover grayscale opacity-60 select-none cursor-default`}
    />
  );
}

// The name shown for a SniffedOut pet or pet parent. Never tappable.
export default function SniffedOutName({ className = '' }) {
  return (
    <span
      className={`cursor-default select-none ${className}`}
      title="This pet parent has left Sniffr"
    >
      {SNIFFED_OUT_NAME}
    </span>
  );
}
