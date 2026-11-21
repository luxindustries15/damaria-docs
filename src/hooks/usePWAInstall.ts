import { useEffect, useState } from 'react';

export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

declare global {
  interface Window {
    __damariaDeferredInstallPrompt?: BeforeInstallPromptEvent | null;
    __damariaAppInstalled?: boolean;
  }
}

export function usePWAInstall() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(() =>
    typeof window !== 'undefined' ? window.__damariaDeferredInstallPrompt ?? null : null
  );
  const [isInstalled, setIsInstalled] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return (
      Boolean(window.__damariaAppInstalled) ||
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as unknown as { standalone?: boolean }).standalone === true
    );
  });
  const [isIOS, setIsIOS] = useState(false);
  const [isEmbeddedIframe, setIsEmbeddedIframe] = useState(false);

  useEffect(() => {
    const checkStandalone = () =>
      Boolean(window.__damariaAppInstalled) ||
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as unknown as { standalone?: boolean }).standalone === true;

    const syncFromGlobal = () => {
      setDeferredPrompt(window.__damariaDeferredInstallPrompt ?? null);
      setIsInstalled(checkStandalone());
    };

    syncFromGlobal();

    try {
      setIsEmbeddedIframe(window.self !== window.top);
    } catch {
      setIsEmbeddedIframe(true);
    }

    const ua = window.navigator.userAgent.toLowerCase();
    setIsIOS(/iphone|ipad|ipod/.test(ua));

    const mediaQuery = window.matchMedia('(display-mode: standalone)');

    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      window.__damariaDeferredInstallPrompt = e as BeforeInstallPromptEvent;
      syncFromGlobal();
    };

    const handleAppInstalled = () => {
      window.__damariaDeferredInstallPrompt = null;
      window.__damariaAppInstalled = true;
      syncFromGlobal();
    };

    window.addEventListener('damaria-pwa-state', syncFromGlobal);
    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);
    mediaQuery.addEventListener('change', syncFromGlobal);

    return () => {
      window.removeEventListener('damaria-pwa-state', syncFromGlobal);
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', handleAppInstalled);
      mediaQuery.removeEventListener('change', syncFromGlobal);
    };
  }, []);

  const install = async (): Promise<'accepted' | 'dismissed' | 'unavailable'> => {
    const promptEvent = deferredPrompt || window.__damariaDeferredInstallPrompt || null;
    if (!promptEvent) return 'unavailable';
    try {
      await promptEvent.prompt();
      const { outcome } = await promptEvent.userChoice;
      window.__damariaDeferredInstallPrompt = null;
      setDeferredPrompt(null);
      if (outcome === 'accepted') {
        window.__damariaAppInstalled = true;
        setIsInstalled(true);
        return 'accepted';
      }
      return 'dismissed';
    } catch {
      return 'unavailable';
    }
  };

  return {
    isInstallable: Boolean(deferredPrompt),
    isInstalled,
    isIOS,
    isEmbeddedIframe,
    install,
  };
}
