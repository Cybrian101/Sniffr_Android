import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import api from '../services/api';
import { avatarUrl } from '../utils/media';

import { publicAsset } from '../utils/publicPath';
export default function ShareSheetModal({ post, onClose }) {
  const [shareSearchQuery, setShareSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [selectedRecipient, setSelectedRecipient] = useState(null);
  const [conversations, setConversations] = useState([]);
  const [suggestedProfiles, setSuggestedProfiles] = useState([]);
  const [isBoopping, setIsBoopping] = useState(false);
  const [toastFeedback, setToastFeedback] = useState(null);

  useEffect(() => {
    if (!post) return;
    Promise.all([
      api.get('/chat/conversations'),
      api.get('/chat/nearby')
    ]).then(([convRes, nearbyRes]) => {
      setConversations(convRes?.conversations || []);
      setSuggestedProfiles(nearbyRes?.pets || []);
    }).catch(console.error);
  }, [post]);

  if (!post) return null;

  const runSearch = async (q) => {
    if (!q.trim()) { setSearchResults([]); return; }
    try {
      const d = await api.get(`/chat/search?q=${encodeURIComponent(q)}`);
      setSearchResults(d.pets || []);
    } catch (e) { console.error(e); }
  };

  const selectRecipient = (pet) => {
    const targetId = pet.id || pet.partner_pet_id;
    if (selectedRecipient && (selectedRecipient.id === targetId)) {
      setSelectedRecipient(null);
    } else {
      setSelectedRecipient({
        id: targetId,
        name: pet.name || pet.partner_name,
        avatar: pet.avatar_url || pet.partner_avatar,
        username: pet.pet_username || pet.partner_username
      });
    }
  };

  const handleShare = async () => {
    if (!selectedRecipient) return;
    setIsBoopping(true);
    setToastFeedback(null);
    try {
      const res = await api.post('/chat/share', {
        postId: post.id,
        recipientPetId: selectedRecipient.id
      });

      if (res && res.success) {
        setToastFeedback('Post sent successfully.');
        setTimeout(() => {
          onClose();
        }, 1200);
      } else {
        setToastFeedback('Unable to send the post. Please try again.');
      }
    } catch (e) {
      console.error('Share error:', e);
      setToastFeedback('Unable to send the post. Please try again.');
    } finally {
      setIsBoopping(false);
    }
  };

  const ProfileRow = ({ p }) => {
    const targetId = p.id || p.partner_pet_id;
    const isSel = selectedRecipient && (selectedRecipient.id === targetId);
    const name = p.name || p.partner_name;
    const username = p.pet_username || p.partner_username;
    const avatar = p.avatar_url || p.partner_avatar || publicAsset('/logo.png');
    return (
      <button
        type="button"
        onClick={() => selectRecipient(p)}
        className={`w-full flex items-center justify-between p-2.5 rounded-2xl transition-all ${
          isSel ? 'bg-primary/10 border border-primary/20' : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/50'
        }`}
      >
        <div className="flex items-center gap-3">
          <img src={avatarUrl(avatar)} alt={name} loading="lazy" decoding="async" className="w-10 h-10 rounded-full object-cover shadow-sm" />
          <div className="text-left">
            <h5 className="font-bold text-xs text-on-surface">{name}</h5>
            {username && <p className="text-[10px] text-zinc-400 font-bold">@{username}</p>}
          </div>
        </div>
        <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-all ${
          isSel ? 'bg-primary border-primary text-white' : 'border-zinc-300'
        }`}>
          {isSel && <span className="material-symbols-outlined text-xs">check</span>}
        </div>
      </button>
    );
  };

  return createPortal(
    <div
      style={{
        position: 'fixed',
        top: 0, left: 0, right: 0, bottom: 0,
        zIndex: 99998,
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
        backgroundColor: 'rgba(0,0,0,0.4)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        padding: '16px',
        paddingBottom: 'calc(16px + env(safe-area-inset-bottom))',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          backgroundColor: '#ffffff',
          width: '100%',
          maxWidth: '28rem',
          maxHeight: '80dvh',
          minHeight: '40dvh',
          borderRadius: '2.5rem',
          boxShadow: '0 -8px 40px rgba(0,0,0,0.15)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          padding: '24px',
          border: '1px solid rgba(0,0,0,0.05)',
          position: 'relative',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex justify-between items-center pb-2 border-b border-zinc-100 flex-shrink-0">
          <h3 className="font-extrabold text-on-surface text-lg">Share Post</h3>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-zinc-50 flex items-center justify-center text-zinc-400 hover:text-zinc-600 transition-colors"
          >
            <span className="material-symbols-outlined text-base">close</span>
          </button>
        </div>

        {/* Feedback Toast */}
        {toastFeedback && (
          <div className={`mt-2 py-2 px-3 rounded-xl text-xs font-bold text-center animate-fade-in flex items-center justify-center gap-1 ${
            toastFeedback === 'Post sent successfully.' ? 'bg-emerald-100 text-emerald-700 border border-emerald-200' : 'bg-rose-100 text-rose-700 border border-rose-200'
          }`}>
            {toastFeedback === 'Post sent successfully.' && <span className="material-symbols-outlined text-sm">check_circle</span>}
            {toastFeedback}
          </div>
        )}

        {/* Search Bar */}
        <div className="relative flex-shrink-0 mt-3">
          <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-zinc-400 text-lg">search</span>
          <input
            type="text"
            placeholder="Search pets or owners..."
            value={shareSearchQuery}
            onChange={(e) => {
              setShareSearchQuery(e.target.value);
              runSearch(e.target.value);
            }}
            className="w-full bg-zinc-50 border-none rounded-2xl text-xs pl-12 pr-4 py-3 placeholder:text-zinc-400 focus:ring-2 focus:ring-primary/20 text-on-surface"
          />
        </div>

        {/* Selected Recipient Chip */}
        {selectedRecipient && (
          <div className="flex flex-wrap gap-2 max-h-24 overflow-y-auto pb-1 flex-shrink-0 mt-3">
            <div className="flex items-center gap-1.5 bg-primary/10 rounded-full pl-1 pr-2.5 py-1">
              <img src={avatarUrl(selectedRecipient.avatar) || publicAsset('/logo.png')} alt={selectedRecipient.name} loading="lazy" decoding="async" className="w-6 h-6 rounded-full object-cover" />
              <span className="text-[10px] font-bold text-on-surface">{selectedRecipient.name}</span>
              <button
                type="button"
                onClick={() => setSelectedRecipient(null)}
                className="w-4 h-4 rounded-full bg-zinc-300 flex items-center justify-center hover:bg-zinc-400 transition-colors"
              >
                <span className="material-symbols-outlined text-[10px] text-white">close</span>
              </button>
            </div>
          </div>
        )}

        {/* Lists Area */}
        <div className="flex-1 overflow-y-auto min-h-0 space-y-4 pr-1 py-2 no-scrollbar mt-2">
          {!shareSearchQuery.trim() ? (
            <>
              {/* Recently Messaged */}
              <div className="space-y-2">
                <h4 className="text-[10px] font-bold uppercase tracking-wider text-zinc-400 px-1">Recently Messaged</h4>
                {conversations.length > 0 ? (
                  <div className="space-y-1.5">
                    {conversations.map(conv => (
                      <ProfileRow
                        key={conv.partner_pet_id}
                        p={{
                          id: conv.partner_pet_id,
                          name: conv.partner_name,
                          avatar_url: conv.partner_avatar,
                          pet_username: conv.partner_username,
                          user_id: conv.partner_user_id
                        }}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="text-[11px] text-zinc-400 font-bold text-center py-3">Recently messaged profiles will appear here.</p>
                )}
              </div>

              {/* Suggested Profiles */}
              <div className="space-y-2">
                <h4 className="text-[10px] font-bold uppercase tracking-wider text-zinc-400 px-1">Suggested Profiles</h4>
                {suggestedProfiles.length > 0 ? (
                  <div className="space-y-1.5">
                    {suggestedProfiles.map(p => (
                      <ProfileRow key={p.id} p={p} />
                    ))}
                  </div>
                ) : (
                  <p className="text-[11px] text-zinc-400 font-bold text-center py-3">No suggested profiles yet.</p>
                )}
              </div>
            </>
          ) : (
            /* Search Results */
            <div className="space-y-2">
              <h4 className="text-[10px] font-bold uppercase tracking-wider text-zinc-400 px-1">Search Results</h4>
              {searchResults.length === 0 ? (
                <p className="text-xs text-zinc-400 text-center py-4">No wagging tails found</p>
              ) : (
                <div className="space-y-1.5">
                  {searchResults.map(p => (
                    <ProfileRow key={p.id} p={p} />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Send Button */}
        <div className="pt-2 flex-shrink-0">
          <button
            type="button"
            onClick={handleShare}
            disabled={!selectedRecipient || isBoopping}
            className="w-full py-3.5 bg-gradient-to-r from-primary to-primary-fixed-dim text-white font-bold text-sm rounded-full shadow-lg hover:shadow-xl active:scale-[0.98] transition-all disabled:opacity-50 disabled:pointer-events-none flex items-center justify-center gap-2"
          >
            {isBoopping ? 'Sending...' : 'Send'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
