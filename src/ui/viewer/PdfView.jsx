import { useEffect, useRef, useState } from 'react';
import { Spinner } from '../common/Icon.jsx';

/**
 * PDFs where the browser can't show them inside a page (Chrome on Android; an iPhone shows only
 * the first page): drawn page by page with PDF.js, loaded only then (#5). Its worker is started
 * through the page's Trusted Types policy, and it never evaluates code.
 */
export function PdfView({ bytes, name }) {
  const host = useRef(null);
  const [status, setStatus] = useState('Opening…');
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    let doc = null;
    let observer = null;
    (async () => {
      const { openPdf } = await import('./pdf.js');
      doc = await openPdf(bytes);
      if (cancelled) return;
      setStatus('');
      const width = () => Math.min(host.current.clientWidth - 24, 1100);
      // Pages are drawn as they come into view.
      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting || entry.target.dataset.drawn) continue;
            entry.target.dataset.drawn = '1';
            drawPage(Number(entry.target.dataset.page), entry.target).catch((err) => console.warn('PDF page:', err));
          }
        },
        { root: host.current, rootMargin: '600px 0px' },
      );
      const first = await doc.getPage(1);
      const base = first.getViewport({ scale: 1 });
      for (let n = 1; n <= doc.numPages; n++) {
        const page = document.createElement('div');
        page.className = 'pdf-page';
        page.dataset.page = String(n);
        page.style.aspectRatio = `${base.width} / ${base.height}`;
        page.style.width = `${width()}px`;
        host.current.append(page);
        observer.observe(page);
      }
      async function drawPage(n, holder) {
        const page = await doc.getPage(n);
        const viewport = page.getViewport({ scale: 1 });
        const scale = (width() / viewport.width) * Math.min(2, window.devicePixelRatio || 1);
        const scaled = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(scaled.width);
        canvas.height = Math.floor(scaled.height);
        canvas.setAttribute('aria-label', `Page ${n}`);
        holder.style.aspectRatio = `${viewport.width} / ${viewport.height}`;
        holder.replaceChildren(canvas);
        await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport: scaled }).promise;
      }
    })().catch((err) => {
      if (!cancelled) {
        setStatus('');
        setError(err?.message || String(err));
      }
    });
    return () => {
      cancelled = true;
      observer?.disconnect();
      doc?.destroy?.();
    };
  }, [bytes]);
  if (error) return <p className="viewer-doc-note">This PDF couldn’t be shown here: {error}</p>;
  return (
    <div className="pdf-view" ref={host} aria-label={name}>
      {status ? (
        <div className="viewer-loading">
          <Spinner />
          <span>{status}</span>
        </div>
      ) : null}
    </div>
  );
}
