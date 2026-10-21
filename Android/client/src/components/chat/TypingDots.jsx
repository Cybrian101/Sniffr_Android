// Three dots that pop in one-by-one (500ms apart) and loop, used by both
// 1:1 chat and PawCircle chat to show "the other side is typing".
export default function TypingDots({ className = '' }) {
  return (
    <span className={`inline-flex items-center gap-0.5 ${className}`} aria-label="Typing">
      <span className="typing-seq-dot" style={{ animationDelay: '0ms' }} />
      <span className="typing-seq-dot" style={{ animationDelay: '500ms' }} />
      <span className="typing-seq-dot" style={{ animationDelay: '1000ms' }} />
    </span>
  );
}
