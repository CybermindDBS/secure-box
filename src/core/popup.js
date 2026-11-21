/**
 * Watches a sign-in pop-up and calls `onClosed` once it was closed without finishing (#7).
 *
 * A page on another site can isolate itself from the window that opened it, and then the browser
 * reports the pop-up as closed while it's still open. So a closed pop-up only counts once this
 * window has the focus back (closing a pop-up hands the focus back), and a sign-in that is just
 * returning gets a moment to arrive first. Returns a function that stops watching.
 */
export function watchPopup(popup, onClosed, { grace = 2000, every = 400 } = {}) {
  let closedSince = 0;
  const timer = setInterval(() => {
    let closed = false;
    try {
      closed = popup.closed;
    } catch {
      closed = false;
    }
    if (!closed || !document.hasFocus()) {
      closedSince = 0;
      return;
    }
    closedSince ||= Date.now();
    if (Date.now() - closedSince >= grace) {
      clearInterval(timer);
      onClosed();
    }
  }, every);
  return () => clearInterval(timer);
}
