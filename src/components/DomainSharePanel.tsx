import { useState } from 'react';
import { Check, ChevronDown, ChevronUp, Copy, Globe, Link2 } from 'lucide-react';

interface DomainSharePanelProps {
  publicDomain?: string;
  liveAppUrl?: string;
  compact?: boolean;
}

export function DomainSharePanel({
  publicDomain = 'https://damariadocs.com',
  liveAppUrl,
  compact = false,
}: DomainSharePanelProps) {
  const [copiedTarget, setCopiedTarget] = useState<'domain' | 'live' | 'host' | null>(null);
  const [showDnsGuide, setShowDnsGuide] = useState(false);

  const fallbackOrigin = typeof window !== 'undefined' ? window.location.origin : '';
  const activeUrl = (liveAppUrl && liveAppUrl.startsWith('http') ? liveAppUrl : fallbackOrigin) || '';

  let activeHostname = '';
  try {
    if (activeUrl) {
      activeHostname = new URL(activeUrl).hostname;
    }
  } catch {
    activeHostname = '';
  }

  async function copyText(text: string, key: 'domain' | 'live' | 'host') {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const input = document.createElement('input');
      input.value = text;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      document.body.removeChild(input);
    }
    setCopiedTarget(key);
    setTimeout(() => setCopiedTarget((prev) => (prev === key ? null : prev)), 2200);
  }

  return (
    <div className="glass-panel-subtle rounded-2xl p-4 sm:p-5 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-start gap-3 min-w-0">
          <div className="w-9 h-9 rounded-xl bg-sky-500/15 text-sky-300 flex items-center justify-center shrink-0 mt-0.5">
            <Globe className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-xs font-semibold text-white">Platform Share Links</p>
              <span className="text-xs text-slate-400">·</span>
              <span className="text-xs font-mono text-sky-300 truncate">{publicDomain}</span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              {compact
                ? 'Share this address with teachers and staff, or copy the direct live link while DNS is being connected.'
                : 'Copy your branded Damaria Docs address or the live working link for immediate document uploads.'}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => copyText(publicDomain, 'domain')}
            className="px-3.5 py-2 rounded-xl text-xs font-semibold bg-sky-500 hover:bg-sky-400 text-slate-950 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
          >
            {copiedTarget === 'domain' ? (
              <>
                <Check className="w-3.5 h-3.5" />
                Copied damariadocs.com
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" />
                Copy damariadocs.com
              </>
            )}
          </button>

          {activeUrl && (
            <button
              type="button"
              onClick={() => copyText(activeUrl, 'live')}
              className="px-3.5 py-2 rounded-xl text-xs font-medium bg-white/10 hover:bg-white/15 text-slate-100 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
            >
              {copiedTarget === 'live' ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                  Live Link Copied
                </>
              ) : (
                <>
                  <Link2 className="w-3.5 h-3.5" />
                  Copy Live Link
                </>
              )}
            </button>
          )}

          <button
            type="button"
            onClick={() => setShowDnsGuide((v) => !v)}
            className="px-3 py-2 rounded-xl text-xs font-medium text-slate-300 hover:text-white bg-white/[0.04] hover:bg-white/[0.09] border border-white/10 transition-colors inline-flex items-center gap-1 whitespace-nowrap shrink-0"
          >
            Domain Setup
            {showDnsGuide ? (
              <ChevronUp className="w-3.5 h-3.5" />
            ) : (
              <ChevronDown className="w-3.5 h-3.5" />
            )}
          </button>
        </div>
      </div>

      {showDnsGuide && (
        <div className="border-t border-white/10 pt-3.5 text-xs text-slate-300 space-y-2.5">
          <p className="text-slate-200 font-medium">
            To make <span className="font-mono text-sky-300">damariadocs.com</span> open this
            platform directly in any browser:
          </p>
          <ol className="list-decimal pl-5 space-y-1.5 text-slate-300 leading-relaxed">
            <li>
              Register <span className="font-mono text-white">damariadocs.com</span> with your
              domain registrar (such as Cloudflare, Namecheap, or Squarespace Domains).
            </li>
            <li>
              Deploy or share your app so it has a public Cloud Run host, then add a Custom Domain
              Mapping in Google Cloud Run (or point a proxied CNAME / redirect in Cloudflare) to{' '}
              {activeHostname ? (
                <button
                  type="button"
                  onClick={() => copyText(activeHostname, 'host')}
                  className="font-mono text-sky-300 hover:text-sky-200 underline decoration-dotted inline-flex items-center gap-1"
                >
                  {activeHostname}
                  {copiedTarget === 'host' && (
                    <span className="text-emerald-300 no-underline">(Copied)</span>
                  )}
                </button>
              ) : (
                <span className="font-mono text-white">your Cloud Run service URL</span>
              )}
              .
            </li>
            <li>
              Until DNS propagation finishes, anyone can upload PDF or Word files immediately using
              the <span className="font-medium text-white">Copy Live Link</span> button above.
            </li>
          </ol>
        </div>
      )}
    </div>
  );
}
