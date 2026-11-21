import { useState } from 'react';
import { ExternalLink, MonitorDown, X } from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';
import schoolLogo from '../assets/images/damaria_school_logo_rounded.png';

export function PWAInstallButton() {
  const { isInstallable, isInstalled, isIOS, isEmbeddedIframe, install } = usePWAInstall();
  const [showGuide, setShowGuide] = useState(false);

  // Hide completely once launched as an installed Desktop or Mobile app
  if (isInstalled) {
    return null;
  }

  async function handleClick() {
    if (isInstallable) {
      const accepted = await install();
      if (accepted) return;
    }
    setShowGuide(true);
  }

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        title="Install Damaria Docs as a Desktop App"
        className="px-3.5 py-2 rounded-xl text-xs font-medium bg-white/[0.08] hover:bg-white/[0.15] border border-white/15 text-slate-100 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
      >
        <MonitorDown className="w-3.5 h-3.5 text-sky-400" />
        <span className="hidden sm:inline">Install App</span>
        <span className="sm:hidden">App</span>
      </button>

      {showGuide && (
        <div
          className="no-print fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 backdrop-blur-sm p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="install-app-title"
        >
          <div className="glass-panel w-full max-w-md rounded-2xl p-6 space-y-4 shadow-2xl border border-white/15">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <img
                  src={schoolLogo}
                  alt="Damaria Docs"
                  referrerPolicy="no-referrer"
                  className="w-11 h-11 rounded-xl object-contain shrink-0"
                />
                <div>
                  <h2 id="install-app-title" className="text-base font-bold text-white">
                    Install Damaria Docs on Desktop
                  </h2>
                  <p className="text-xs text-slate-300 mt-0.5">
                    Runs in its own desktop window with an app icon and offline access.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowGuide(false)}
                aria-label="Close install dialog"
                className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {isIOS ? (
              <div className="rounded-xl bg-slate-950/60 border border-white/10 p-4 space-y-2 text-xs text-slate-200">
                <p className="font-semibold text-white">Install on iPhone or iPad:</p>
                <p>1. Tap the Share button in Safari.</p>
                <p>2. Tap Add to Home Screen, then tap Add.</p>
              </div>
            ) : isEmbeddedIframe ? (
              <div className="rounded-xl bg-slate-950/60 border border-white/10 p-4 space-y-3 text-xs text-slate-200">
                <p>
                  Desktop installation is blocked inside an embedded preview frame. Open Damaria
                  Docs in its own browser window first, then click{' '}
                  <span className="text-white font-semibold">Install App</span> or the install
                  button in the address bar.
                </p>
                {typeof window !== 'undefined' && (
                  <a
                    href={window.location.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="w-full px-4 py-2.5 rounded-xl text-xs font-semibold bg-sky-500 hover:bg-sky-400 text-slate-950 transition-colors inline-flex items-center justify-center gap-2"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    Open Full Window to Install
                  </a>
                )}
              </div>
            ) : (
              <div className="rounded-xl bg-slate-950/60 border border-white/10 p-4 space-y-2 text-xs text-slate-200">
                <p className="font-semibold text-white">Chrome or Edge (Windows / Mac / Linux):</p>
                <p>
                  1. Click the <span className="text-sky-300 font-medium">Install</span> icon on the
                  right side of your address bar.
                </p>
                <p>
                  2. Or open the browser menu (<span className="font-mono">⋮</span>) →{' '}
                  <span className="text-white font-medium">
                    Cast, save, and share → Install Damaria Docs
                  </span>
                  .
                </p>
                <p className="text-slate-400 pt-1">
                  On Mac Safari: click File → Add to Dock.
                </p>
              </div>
            )}

            <button
              type="button"
              onClick={() => setShowGuide(false)}
              className="w-full px-4 py-2 rounded-xl text-xs font-medium bg-white/10 hover:bg-white/15 text-slate-200 transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </>
  );
}
