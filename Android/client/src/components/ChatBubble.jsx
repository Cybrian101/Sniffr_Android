import { Check, CheckCheck } from 'lucide-react';

import { publicAsset } from '../utils/publicPath';
export default function ChatBubble({ message, isOwn, showAvatar, avatar }) {
  const time = new Date(message.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const statusIcon = isOwn && (
    message.status === 'seen' ? <CheckCheck size={14} color="var(--secondary)" /> :
    message.status === 'delivered' ? <CheckCheck size={14} color="var(--on-surface-lighter)" /> :
    <Check size={14} color="var(--on-surface-lighter)" />
  );

  return (
    <div className={`chat-bubble-wrap ${isOwn ? 'own' : 'other'}`}>
      {!isOwn && showAvatar && (
        <img src={avatar || publicAsset('/logo.png')} alt="" className="avatar avatar-sm" style={{ alignSelf: 'flex-end' }} loading="lazy" />
      )}
      <div className={`chat-bubble ${isOwn ? 'bubble-own' : 'bubble-other'}`}>
        {message.media_url && (
          message.message_type === 'video' ? (
            <video src={message.media_url} controls style={{ borderRadius: 'var(--radius-md)', maxWidth: 200, marginBottom: 4 }} />
          ) : (
            <img src={message.media_url} alt="" style={{ borderRadius: 'var(--radius-md)', maxWidth: 200, marginBottom: 4 }} loading="lazy" />
          )
        )}
        {message.content && <p>{message.content}</p>}
        <div className="bubble-meta">
          <span className="bubble-time">{time}</span>
          {statusIcon}
        </div>
      </div>

      <style>{`
        .chat-bubble-wrap {
          display: flex;
          gap: var(--space-sm);
          margin-bottom: var(--space-sm);
          max-width: 80%;
        }
        .chat-bubble-wrap.own {
          margin-left: auto;
          flex-direction: row-reverse;
        }
        .chat-bubble-wrap.other {
          margin-right: auto;
        }
        .chat-bubble {
          padding: var(--space-md) var(--space-base);
          border-radius: var(--radius-xl);
          font-size: var(--fs-sm);
          line-height: 1.5;
          max-width: 100%;
          word-wrap: break-word;
        }
        .bubble-own {
          background: var(--gradient-warm);
          color: var(--on-surface);
          border-bottom-right-radius: var(--space-xs);
        }
        .bubble-other {
          background: var(--surface-alt);
          color: var(--on-surface);
          border-bottom-left-radius: var(--space-xs);
        }
        .bubble-meta {
          display: flex;
          align-items: center;
          gap: 4px;
          justify-content: flex-end;
          margin-top: 4px;
        }
        .bubble-time {
          font-size: 10px;
          color: var(--on-surface-light);
        }
      `}</style>
    </div>
  );
}
