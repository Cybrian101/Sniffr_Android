import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

export default function PetSelectionPage() {
  const [selected, setSelected] = useState(null);
  const navigate = useNavigate();

  return (
    <div className="bg-background text-on-surface font-body min-h-screen relative overflow-hidden flex flex-col selection:bg-primary-container">
      {/* Signature Texture (Watermarks) */}
      <span className="material-symbols-outlined absolute opacity-5 text-primary pointer-events-none text-[12rem] -top-10 -right-10 rotate-12">pets</span>
      <span className="material-symbols-outlined absolute opacity-5 text-primary pointer-events-none text-[8rem] bottom-20 -left-10 -rotate-12">potted_plant</span>
      
      {/* Main Content */}
      <main className="flex-grow flex flex-col px-8 pt-16 pb-12 z-10 max-w-md mx-auto w-full">
        {/* Header Section */}
        <header className="mb-12">
          <div className="flex items-center gap-2 mb-6">
            <div className="w-10 h-10 bg-primary-container rounded-full flex items-center justify-center shadow-sm">
              <span className="material-symbols-outlined text-primary" style={{ fontVariationSettings: "'FILL' 1" }}>pets</span>
            </div>
            <span className="text-primary font-extrabold tracking-tighter text-2xl">Sniffr</span>
          </div>
          <h1 className="text-4xl font-extrabold tracking-tight text-on-surface leading-tight mb-4">
            Who's joining <br/>the <span className="text-primary">pack?</span>
          </h1>
          <p className="text-on-surface-variant text-lg leading-relaxed max-w-[280px]">
            Tell us about your furry best friend to start matching.
          </p>
        </header>

        {/* Selection Bento Grid/Layout */}
        <div className="flex flex-col gap-6">
          {/* Dog Selection Card */}
          <button 
            onClick={() => setSelected('dog')}
            className={`relative w-full h-48 bg-secondary-container rounded-xl overflow-hidden flex items-center text-left transition-all active:scale-[0.98] group ${selected === 'dog' ? 'ring-4 ring-secondary/50' : ''}`}
          >
            <div className="absolute inset-0 bg-gradient-to-r from-secondary-fixed/50 to-transparent opacity-0 group-hover:opacity-100 transition-opacity"></div>
            <div className="flex-grow pl-8 z-10">
              <span className="text-xs uppercase tracking-[0.05em] text-on-secondary-container font-bold opacity-70">paw</span>
              <h2 className="text-2xl font-bold text-on-secondary-container mt-1">I have a Dog</h2>
              <p className="text-on-secondary-container/80 text-sm mt-1">Wags and zoomies await</p>
            </div>
            <div className="relative w-1/2 h-full">
              <div className="absolute inset-y-4 right-4 left-0 rounded-[42%_58%_70%_30%/45%_45%_55%_55%] bg-surface-container-lowest overflow-hidden shadow-sm">
                <img alt="Dog portrait" className="w-full h-full object-cover" src="https://lh3.googleusercontent.com/aida-public/AB6AXuAoTp48Iw3rZeoclltMC_jgIHLkOQ4oVVTI4FfGonVumphAeeW_13CmVRW_hoxoRS9lv_joOd0jxxYnOwl17dirhNQELi_nPzMiYgOacrFlPxMftLJmqYskOscrE5RALO8-i9V_ddQI9y0nv2YlX3XeCn_sDDlsqsM2QFk0Q0j4pjlcPTX8Ao9-v5toIqIfjz_P43ycQ_SNfek1HgsAHwtSoLpqxRnwVboqgiIr33kOYK0C7cb3a06xaAOV60VEcR3x7VA8qDuCg3g" />
              </div>
            </div>
          </button>

          {/* Cat Selection Card */}
          <button 
            onClick={() => setSelected('cat')}
            className={`relative w-full h-48 bg-tertiary-container rounded-xl overflow-hidden flex items-center text-left transition-all active:scale-[0.98] group ${selected === 'cat' ? 'ring-4 ring-tertiary/50' : ''}`}
          >
            <div className="absolute inset-0 bg-gradient-to-r from-tertiary-fixed/50 to-transparent opacity-0 group-hover:opacity-100 transition-opacity"></div>
            <div className="flex-grow pl-8 z-10">
              <span className="text-xs uppercase tracking-[0.05em] text-on-tertiary-container font-bold opacity-70">claw</span>
              <h2 className="text-2xl font-bold text-on-tertiary-container mt-1">I have a Cat</h2>
              <p className="text-on-tertiary-container/80 text-sm mt-1">Purrs and playful pounces</p>
            </div>
            <div className="relative w-1/2 h-full">
              <div className="absolute inset-y-4 right-4 left-0 rounded-[60%_40%_30%_70%/60%_30%_70%_40%] bg-surface-container-lowest overflow-hidden shadow-sm">
                <img alt="Cat portrait" className="w-full h-full object-cover" src="https://lh3.googleusercontent.com/aida-public/AB6AXuC2DkKyqigK-gKYer64dtEKVV9nfYsyS3y_x1J1fzT-1pfZlkNryQp05nCagcDNVF1vOmn_6uAtVH9Jg_b1nEdO4PNd4vK0hITGWOLBSOVwjXWVeQWwu6S6I3YHTTaRdj_DGBJeYcnNiqA4ty4kp77Imso8x_EsEnoXc5xTDbow6cQmq2mgYu5xv1NaB0YQOwhlHdKcYuc_uPK2foUvK4VgQhNPQnxfPwlPhgixYNQL8OyJMGzqgp6aH9N4Em2n21Onl2VfkDLfuMs" />
              </div>
            </div>
          </button>
        </div>

        {/* Fun Fact Section */}
        <div className="mt-auto pt-10">
          <div className="bg-surface-container-low p-6 rounded-lg relative overflow-hidden">
            <div className="absolute top-0 right-0 p-4 opacity-10">
              <span className="material-symbols-outlined text-4xl">lightbulb</span>
            </div>
            <h3 className="text-tertiary font-bold text-sm uppercase tracking-widest mb-2">Did you know?</h3>
            <p className="text-on-surface-variant text-sm italic leading-relaxed">
              Spending time with pets increases <strong>oxytocin</strong>
            </p>
          </div>
        </div>

        {/* Footer Action */}
        <footer className="mt-8 flex flex-col items-center">
          <button
            disabled={!selected}
            onClick={() => navigate('/create-profile', { replace: true, state: { petType: selected } })}
            className={`w-full py-5 bg-gradient-to-br from-primary to-primary-fixed-dim text-on-primary rounded-xl font-bold text-lg shadow-[0_20px_40px_-10px_rgba(244,167,185,0.4)] active:scale-[0.98] transition-transform flex items-center justify-center gap-2 ${!selected ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            Continue
            <span className="material-symbols-outlined">arrow_forward</span>
          </button>
          <button
            onClick={() => navigate('/home', { replace: true })}
            className="mt-6 text-on-surface-variant font-semibold text-sm hover:opacity-70 transition-opacity"
          >
            I'll do this later
          </button>
        </footer>
      </main>

      {/* Visual Polish: Soft Grain Overlay */}
      <div className="fixed inset-0 pointer-events-none opacity-[0.02] bg-[url('https://www.transparenttextures.com/patterns/felt.png')]"></div>
    </div>
  );
}
