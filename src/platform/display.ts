/** Fullscreen, orientation, safe areas, touch detection, haptics. */

export function isTouchDevice(): boolean {
  return typeof window !== 'undefined' && (window.matchMedia?.('(pointer: coarse)').matches || navigator.maxTouchPoints > 0);
}

export function isIOS(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export function isStandalone(): boolean {
  return window.matchMedia?.('(display-mode: standalone)').matches || window.matchMedia?.('(display-mode: fullscreen)').matches || (navigator as { standalone?: boolean }).standalone === true;
}

export function isPortrait(): boolean {
  return window.innerHeight > window.innerWidth;
}

export function fullscreenSupported(): boolean {
  return !!document.documentElement.requestFullscreen;
}

export function isFullscreen(): boolean {
  return !!document.fullscreenElement;
}

/** Enter fullscreen and lock landscape where supported (Android Chrome). Must run in a user gesture. */
export async function enterFullscreen(): Promise<void> {
  try {
    if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
      await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    }
    const o = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
    await o?.lock?.('landscape').catch(() => {});
  } catch {
    // Not allowed (iOS Safari, iframes): fine, the app still works.
  }
}

export async function exitFullscreen(): Promise<void> {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
  } catch {
    /* ignore */
  }
}

/** Safe-area insets in px, read from CSS env() via a probe element. */
export function safeAreaInsets(): { top: number; right: number; bottom: number; left: number } {
  let probe = document.getElementById('safe-area-probe');
  if (!probe) {
    probe = document.createElement('div');
    probe.id = 'safe-area-probe';
    probe.style.cssText =
      'position:fixed;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
    document.body.append(probe);
  }
  const cs = getComputedStyle(probe);
  return { top: parseFloat(cs.paddingTop) || 0, right: parseFloat(cs.paddingRight) || 0, bottom: parseFloat(cs.paddingBottom) || 0, left: parseFloat(cs.paddingLeft) || 0 };
}

export function vibrate(ms: number | number[]): void {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* unsupported */
  }
}

/**
 * Stop the browser from treating flying as page gestures: scrolling,
 * pinch-zoom, double-tap zoom, pull-to-refresh, long-press menus, text selection.
 * Scrollable panels (tuning drawer, dialogs) keep working.
 */
export function suppressBrowserGestures(): void {
  const scrollable = (t: EventTarget | null) => t instanceof Element && !!t.closest('.tune-body, .modal-box');
  document.addEventListener('touchmove', (e) => { if (!scrollable(e.target)) e.preventDefault(); }, { passive: false });
  document.addEventListener('touchstart', (e) => { if (e.touches.length > 1 && !scrollable(e.target)) e.preventDefault(); }, { passive: false });
  for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(ev, (e) => e.preventDefault());
  document.addEventListener('contextmenu', (e) => { if (!(e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement)) e.preventDefault(); });
  document.addEventListener('dblclick', (e) => e.preventDefault());
}
