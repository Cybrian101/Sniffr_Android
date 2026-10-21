import { useRef, useState } from 'react';

const DEFAULT_EXCLUDED_TYPES = ['meetup', 'pet_profile', 'shared_post', 'system'];

// Shared message-bubble gesture handling for both 1:1 chat and PawCircle
// chat: single tap (after a 300ms window, so it doesn't fire on a double
// tap) starts a reply, double tap (within 300ms) opens the copy/fetch-back
// action menu, and a 500ms press-and-hold opens the reaction picker.
// Extracted verbatim from ChatPage.jsx's original inline implementation so
// both chats share one copy of this timing-sensitive logic.
export default function useMessageInteractions({
  currentUserId,
  onReply,
  onOpenActionMenu,
  onReact,
  onMediaTap,
  excludedTypes = DEFAULT_EXCLUDED_TYPES,
}) {
  const [reactionPickerMsgId, setReactionPickerMsgId] = useState(null);
  const [highlightedMsgReaction, setHighlightedMsgReaction] = useState(null);

  const lastTapTimeRef = useRef({});
  const singleTapTimerRef = useRef({});
  const msgLongPressTimerRef = useRef({});
  const msgLongPressTriggeredRef = useRef({});

  const handleMessageTap = (msg, e) => {
    if (excludedTypes.includes(msg.message_type)) return;

    const msgId = msg.id;

    // A long-press that just opened the reaction picker also fires a
    // trailing click/tap on release -- swallow that one click so it
    // doesn't also open the action menu or start a reply.
    if (msgLongPressTriggeredRef.current[msgId]) {
      msgLongPressTriggeredRef.current[msgId] = false;
      return;
    }

    const now = Date.now();
    const lastTap = lastTapTimeRef.current[msgId] || 0;
    const isOwn = msg.sender_id === currentUserId;

    if (singleTapTimerRef.current[msgId]) {
      clearTimeout(singleTapTimerRef.current[msgId]);
      singleTapTimerRef.current[msgId] = null;
    }

    if (now - lastTap < 300) {
      e.preventDefault();
      e.stopPropagation();
      lastTapTimeRef.current[msgId] = 0;

      const rect = e.currentTarget.getBoundingClientRect();
      onOpenActionMenu?.(msg, {
        isOwn,
        top: Math.max(65, rect.top - 50),
        left: isOwn ? Math.max(16, rect.right - 155) : Math.max(16, rect.left)
      });
    } else {
      lastTapTimeRef.current[msgId] = now;

      const isTextMsg = (!msg.message_type || msg.message_type === 'text') && !msg.media_url;
      // A real image/video attachment (not a voice note, file, or a
      // message whose media has since been removed) -- single tap opens
      // it full-screen instead of starting a reply.
      const isMediaMsg = (msg.message_type === 'image' || msg.message_type === 'video') && !!msg.media_url;
      if (isTextMsg) {
        singleTapTimerRef.current[msgId] = setTimeout(() => {
          singleTapTimerRef.current[msgId] = null;
          onReply?.(msg);
        }, 300);
      } else if (isMediaMsg) {
        singleTapTimerRef.current[msgId] = setTimeout(() => {
          singleTapTimerRef.current[msgId] = null;
          onMediaTap?.(msg);
        }, 300);
      }
    }
  };

  const startMessageLongPress = (msg) => {
    if (excludedTypes.includes(msg.message_type)) return;

    msgLongPressTriggeredRef.current[msg.id] = false;
    msgLongPressTimerRef.current[msg.id] = setTimeout(() => {
      msgLongPressTriggeredRef.current[msg.id] = true;
      if (navigator.vibrate) navigator.vibrate(15);
      setReactionPickerMsgId(msg.id);
    }, 500);
  };

  const cancelMessageLongPress = (msgId) => {
    if (msgLongPressTimerRef.current[msgId]) {
      clearTimeout(msgLongPressTimerRef.current[msgId]);
      msgLongPressTimerRef.current[msgId] = null;
    }
  };

  const handleBubbleTouchMove = (msg, e) => {
    if (reactionPickerMsgId === msg.id) {
      const touch = e.touches[0];
      const elem = document.elementFromPoint(touch.clientX, touch.clientY);
      const reactType = elem?.closest('[data-msg-reaction]')?.getAttribute('data-msg-reaction');
      setHighlightedMsgReaction(reactType || null);
      e.preventDefault();
      return;
    }
    // Any movement before the long-press timer fires means the user is
    // scrolling the message list, not holding still -- cancel it.
    cancelMessageLongPress(msg.id);
  };

  const handleBubbleTouchEnd = (msg) => {
    cancelMessageLongPress(msg.id);

    if (reactionPickerMsgId === msg.id) {
      if (highlightedMsgReaction) {
        submitMessageReaction(msg.id, highlightedMsgReaction);
      } else {
        setReactionPickerMsgId(null);
      }
      setHighlightedMsgReaction(null);
    }
  };

  const submitMessageReaction = (messageId, reaction) => {
    onReact?.(messageId, reaction);
    setReactionPickerMsgId(null);
    setHighlightedMsgReaction(null);
  };

  return {
    reactionPickerMsgId,
    setReactionPickerMsgId,
    highlightedMsgReaction,
    setHighlightedMsgReaction,
    handleMessageTap,
    startMessageLongPress,
    cancelMessageLongPress,
    handleBubbleTouchMove,
    handleBubbleTouchEnd,
    submitMessageReaction,
  };
}
