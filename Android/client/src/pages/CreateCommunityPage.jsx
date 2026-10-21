import { useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';
import UpsellModal from '../components/UpsellModal';
import { isPremiumGateError } from '../utils/premiumErrors';

export default function CreateCommunityPage() {
  const { pet } = useAuth();
  const navigate = useNavigate();

  const [valName, setValName] = useState('');
  const [valStatus, setValStatus] = useState(null); // 'checking' | 'available' | 'taken'
  const valTimeout = useRef(null);
  const [upsell, setUpsell] = useState(null); // { title, message } -- premium upsell modal

  const [createForm, setCreateForm] = useState({
    name: '',
    description: '',
    category: 'Dog Breeds',
    breed: '',
    pet_type: 'Dog',
    city: pet?.city || 'Chennai',
    cover_image: '/communities/dogs.jpg',
    is_private: false,
    rules: '1. Be kind and respectful.\n2. Keep vaccinations updated.\n3. No spam.'
  });

  const handleNameChange = (name) => {
    setCreateForm(prev => ({ ...prev, name }));
    setValName(name);

    if (!name.trim()) {
      setValStatus(null);
      return;
    }

    setValStatus('checking');
    clearTimeout(valTimeout.current);
    valTimeout.current = setTimeout(async () => {
      try {
        const res = await api.get(`/communities/validate?name=${encodeURIComponent(name)}`);
        setValStatus(res.available ? 'available' : 'taken');
      } catch {
        setValStatus('taken');
      }
    }, 450);
  };

  const handleCreateSubmit = async (e) => {
    e.preventDefault();
    if (valStatus !== 'available') return;
    try {
      const res = await api.post('/communities', createForm);
      if (res && res.community) {
        navigate(`/community/${res.community.slug || res.community.id}`);
      }
    } catch (err) {
      if (isPremiumGateError(err)) {
        setUpsell({ title: 'PawCircle Creation Limit Reached', message: err.message });
      } else {
        console.error(err);
      }
    }
  };

  return (
    <div className="bg-surface text-on-surface min-h-screen pt-24 lg:pt-8 px-4 lg:px-8 text-left max-w-xl mx-auto pb-24">
      {/* Standard Navigation Header */}
      <header className="flex items-center justify-between py-4 border-b border-outline-variant/10 mb-8">
        <button
          onClick={() => navigate('/chat?tab=pawcircle')}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500 hover:text-primary transition-colors text-xs font-bold uppercase tracking-widest active:scale-95"
        >
          <span className="material-symbols-outlined text-sm">arrow_back</span>
          Back
        </button>
        <h2 className="text-base font-extrabold tracking-widest uppercase text-on-surface">Start Your Circle</h2>
        <div className="w-16" /> {/* spacer to balance back button */}
      </header>

      <form onSubmit={handleCreateSubmit} className="space-y-6 bg-white dark:bg-zinc-900 rounded-[2.5rem] p-6 shadow-sm border border-outline-variant/10">
        <div className="space-y-2">
          <label className="block text-[10px] font-black uppercase tracking-widest text-on-surface-variant ml-3">Community Name</label>
          <input
            type="text"
            required
            placeholder="e.g. Adyar Beagle Walkers"
            className="w-full bg-zinc-50 dark:bg-zinc-800 border-none rounded-2xl py-3.5 px-5 text-xs font-bold text-on-surface"
            value={createForm.name}
            onChange={e => handleNameChange(e.target.value)}
          />
          {valStatus === 'checking' && <p className="text-[10px] text-zinc-400 ml-3">Verifying name availability...</p>}
          {valStatus === 'available' && <p className="text-[10px] text-emerald-500 font-bold ml-3 flex items-center gap-1"><span className="material-symbols-outlined text-xs">check_circle</span> Community name available.</p>}
          {valStatus === 'taken' && <p className="text-[10px] text-red-500 font-bold ml-3 flex items-center gap-1"><span className="material-symbols-outlined text-xs">cancel</span> This community name is already taken.</p>}
        </div>

        <div className="space-y-2">
          <label className="block text-[10px] font-black uppercase tracking-widest text-on-surface-variant ml-3">Description / Bio</label>
          <textarea
            required
            rows={3}
            placeholder="Tell other pet lovers what this circle is about..."
            className="w-full bg-zinc-50 dark:bg-zinc-800 border-none rounded-2xl py-3.5 px-5 text-xs resize-none text-on-surface"
            value={createForm.description}
            onChange={e => setCreateForm(p => ({ ...p, description: e.target.value }))}
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <label className="block text-[10px] font-black uppercase tracking-widest text-on-surface-variant ml-3">Category</label>
            <select
              className="w-full bg-zinc-50 dark:bg-zinc-800 border-none rounded-2xl py-3.5 px-4 text-xs font-bold text-on-surface"
              value={createForm.category}
              onChange={e => setCreateForm(p => ({ ...p, category: e.target.value }))}
            >
              <option value="Dog Breeds">Dog Breeds</option>
              <option value="Cat Breeds">Cat Breeds</option>
              <option value="Activities">Activities</option>
              <option value="Pet Types">Pet Types</option>
            </select>
          </div>
          <div className="space-y-2">
            <label className="block text-[10px] font-black uppercase tracking-widest text-on-surface-variant ml-3">City</label>
            <input
              type="text"
              required
              className="w-full bg-zinc-50 dark:bg-zinc-800 border-none rounded-2xl py-3.5 px-5 text-xs font-bold text-on-surface"
              value={createForm.city}
              onChange={e => setCreateForm(p => ({ ...p, city: e.target.value }))}
            />
          </div>
        </div>

        <div className="space-y-2">
          <label className="block text-[10px] font-black uppercase tracking-widest text-on-surface-variant ml-3">Rules</label>
          <textarea
            rows={4}
            className="w-full bg-zinc-50 dark:bg-zinc-800 border-none rounded-2xl py-3.5 px-5 text-xs resize-none text-on-surface"
            value={createForm.rules}
            onChange={e => setCreateForm(p => ({ ...p, rules: e.target.value }))}
          />
        </div>

        <button
          type="button"
          role="switch"
          aria-checked={createForm.is_private}
          onClick={() => setCreateForm(p => ({ ...p, is_private: !p.is_private }))}
          className="w-full flex items-center gap-3 bg-zinc-50 dark:bg-zinc-800 rounded-2xl py-3.5 px-5 text-left"
        >
          <span className="material-symbols-outlined text-lg text-primary">{createForm.is_private ? 'lock' : 'public'}</span>
          <span className="flex-1 min-w-0">
            <span className="block text-xs font-extrabold text-on-surface">{createForm.is_private ? 'Private circle' : 'Public circle'}</span>
            <span className="block text-[10px] text-zinc-500 leading-snug">
              {createForm.is_private
                ? 'Anyone can find it, but only members see inside. You approve every request to join.'
                : 'Anyone can find it and join right away.'}
            </span>
          </span>
          <span className={`w-10 h-6 rounded-full p-0.5 flex-shrink-0 transition-colors ${createForm.is_private ? 'bg-primary' : 'bg-zinc-300 dark:bg-zinc-600'}`}>
            <span className={`block w-5 h-5 rounded-full bg-white shadow transition-transform ${createForm.is_private ? 'translate-x-4' : ''}`} />
          </span>
        </button>

        <button
          type="submit"
          disabled={valStatus !== 'available'}
          className="w-full py-4 rounded-full bg-gradient-to-r from-primary to-primary-fixed-dim text-white font-bold text-xs uppercase tracking-widest shadow-lg active:scale-95 transition-transform disabled:opacity-50"
        >
          Create Pack
        </button>
      </form>

      {upsell && (
        <UpsellModal title={upsell.title} message={upsell.message} onClose={() => setUpsell(null)} />
      )}
    </div>
  );
}
