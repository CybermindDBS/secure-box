import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { canThumbnail, extOf, formatBytes, kindOf, typeLabel, viewerFor, TEXT_SNIFF_LIMIT } from '../../core/filetypes.js';
import { looksLikeText } from '../../core/readers.js';
import { toast } from '../../session/bridge.js';
import { driveFresh, ensureDrive } from '../../session/cloud.js';
import { KIND_ICON, copyGone, deleteEntries, download, fetchBytes, fetchRange, fileForSharing, files, folderPath, isMissingCopy, missingCopyText, moveEntries, noteCopy, releaseUrls, renameEntry, sourceUrl } from '../../session/files.js';
import { formatDate } from '../../session/io.js';
import { pref, setPref } from '../../session/prefs.js';
import { canEditText, textStyle } from '../../core/textfile.js';
import { closeViewer, dropFromViewer, leaveEditing, requestCloseViewer, requestStepViewer, startEditing, toggleViewerInfo, viewerStore } from '../../session/viewer.js';
import { runTask } from '../../workers/pool.js';
import { Icon, Spinner } from '../common/Icon.jsx';
import { Menu, MenuItem } from '../common/Menu.jsx';
import { useNarrow, useSession, useStore } from '../hooks.js';
import { run } from '../run.js';
import { DocumentView } from './DocumentView.jsx';
import { TextEditor } from './TextEditor.jsx';
import { PdfView } from './PdfView.jsx';

const SWIPE_DISTANCE = 60; // px a finger must travel sideways to change file
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
// iPhones show only a PDF's first page inside a page, Android Chrome none: PDF.js there.
const nativePdf = () => navigator.pdfViewerEnabled !== false && !isIOS();
const canShareFiles = () => typeof navigator.share === 'function' && typeof navigator.canShare === 'function';

// ---------------------------------------------------------------------------
// Photos: fit, zoom, rotate, pan; on touch, pinch, double-tap and swipe
// ---------------------------------------------------------------------------
function ImageStage({ file, url, control, onSwipe, onMissing }) {
  const wrapRef = useRef(null);
  const imgRef = useRef(null);
  const view = useRef({ zoom: 1, rotate: 0, fit: true, fitZoom: 1, touchZoomAt: -Infinity });
  const [label, setLabel] = useState('Fit');

  const apply = useCallback(() => {
    const img = imgRef.current;
    const wrap = wrapRef.current;
    if (!img || !wrap) return;
    const v = view.current;
    const turned = v.rotate % 180 !== 0;
    wrap.classList.toggle('is-fit', v.fit);
    if (v.fit) {
      img.style.removeProperty('width');
      img.style.setProperty('--max-w', turned ? `${wrap.clientHeight - 32}px` : '100%');
      img.style.setProperty('--max-h', turned ? `${wrap.clientWidth - 32}px` : '100%');
      if (img.clientWidth && img.naturalWidth) v.fitZoom = img.clientWidth / img.naturalWidth;
    } else img.style.width = `${Math.round(img.naturalWidth * v.zoom)}px`;
    img.style.transform = `rotate(${v.rotate}deg)`;
    setLabel(v.fit ? 'Fit' : `${Math.round(v.zoom * 100)}%`);
  }, []);

  const currentZoom = () => (view.current.fit ? imgRef.current.clientWidth / (imgRef.current.naturalWidth || 1) : view.current.zoom);
  const zoomAt = (zoom, x, y, anchor = null) => {
    const img = imgRef.current;
    const wrap = wrapRef.current;
    const before = img.getBoundingClientRect();
    const fx = anchor ? anchor.fx : (x - before.left) / (before.width || 1);
    const fy = anchor ? anchor.fy : (y - before.top) / (before.height || 1);
    view.current.fit = false;
    view.current.zoom = Math.min(8, Math.max(view.current.fitZoom * 0.5, zoom));
    apply();
    const after = img.getBoundingClientRect();
    wrap.scrollLeft += after.left + fx * after.width - x;
    wrap.scrollTop += after.top + fy * after.height - y;
  };
  const fit = () => {
    view.current.fit = true;
    view.current.zoom = 1;
    apply();
  };

  // The bar's zoom buttons and the keyboard drive this photo.
  useLayoutEffect(() => {
    control.current = {
      zoomBy(factor) {
        view.current.zoom = Math.min(8, Math.max(0.05, currentZoom() * factor));
        view.current.fit = false;
        apply();
      },
      toggleFit() {
        view.current.fit = !view.current.fit;
        view.current.zoom = 1;
        apply();
      },
      fit,
      rotate() {
        view.current.rotate = (view.current.rotate + 90) % 360;
        apply();
      },
      label: () => label,
    };
    return () => {
      control.current = null;
    };
  });

  useEffect(() => {
    const onResize = () => view.current.fit && apply();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [apply]);

  // Touch: pinch to zoom, double-tap to zoom in or back to fit, drag to pan a zoomed photo, swipe a
  // fitted photo left/right for the next/previous file. Mouse: drag to pan, Ctrl+wheel to zoom.
  useEffect(() => {
    const wrap = wrapRef.current;
    const points = new Map();
    let gesture = null;
    let lastTap = null;
    const drag = (id, x, y, t, touch) => ({ type: 'drag', id, x, y, t, touch, left: wrap.scrollLeft, top: wrap.scrollTop, moved: false, swipe: false, noSwipe: false });
    const pinchState = () => {
      const [a, b] = points.values();
      return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) || 1 };
    };
    const springBack = (img) => {
      img.style.transition = 'translate 0.2s ease-out, transform 0.2s';
      img.style.removeProperty('translate');
      setTimeout(() => img.style.removeProperty('transition'), 250);
    };
    const down = (event) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      try {
        wrap.setPointerCapture(event.pointerId);
      } catch {
        /* the pointer is already gone */
      }
      points.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (points.size === 2) {
        imgRef.current.style.removeProperty('translate');
        lastTap = null;
        const m = pinchState();
        const r = imgRef.current.getBoundingClientRect();
        gesture = { type: 'pinch', d: m.d, zoom: currentZoom(), fx: (m.x - r.left) / (r.width || 1), fy: (m.y - r.top) / (r.height || 1) };
      } else if (points.size === 1) gesture = drag(event.pointerId, event.clientX, event.clientY, event.timeStamp, event.pointerType !== 'mouse');
    };
    const move = (event) => {
      const point = points.get(event.pointerId);
      if (!point || !gesture) return;
      point.x = event.clientX;
      point.y = event.clientY;
      if (gesture.type === 'pinch') {
        if (points.size < 2) return;
        const m = pinchState();
        zoomAt(gesture.zoom * (m.d / gesture.d), m.x, m.y, gesture);
        return;
      }
      if (event.pointerId !== gesture.id) return;
      const dx = event.clientX - gesture.x;
      const dy = event.clientY - gesture.y;
      if (!gesture.moved && Math.hypot(dx, dy) > 8) gesture.moved = true;
      if (!view.current.fit) {
        wrap.scrollLeft = gesture.left - dx;
        wrap.scrollTop = gesture.top - dy;
      } else if (gesture.touch && gesture.moved && !gesture.noSwipe && (gesture.swipe || Math.abs(dx) > Math.abs(dy))) {
        gesture.swipe = true;
        imgRef.current.style.translate = `${dx}px 0`;
      }
    };
    const tapped = (event) => {
      if (lastTap && event.timeStamp - lastTap.t < 320 && Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) < 30) {
        lastTap = null;
        view.current.touchZoomAt = performance.now();
        if (view.current.fit) zoomAt(view.current.fitZoom * 2.5, event.clientX, event.clientY);
        else fit();
      } else lastTap = { t: event.timeStamp, x: event.clientX, y: event.clientY };
    };
    const finish = (event) => {
      if (!points.delete(event.pointerId) || !gesture) return;
      if (gesture.type === 'pinch') {
        if (points.size === 1) {
          const [[id, p]] = points;
          gesture = { ...drag(id, p.x, p.y, event.timeStamp, true), moved: true, noSwipe: true };
        } else if (!points.size) gesture = null;
        if (!view.current.fit && view.current.zoom <= view.current.fitZoom * 1.02) fit();
        return;
      }
      if (event.pointerId !== gesture.id) return;
      const g = gesture;
      gesture = null;
      if (g.swipe) {
        const dx = event.clientX - g.x;
        const flick = Math.abs(dx) > 30 && Math.abs(dx) / Math.max(1, event.timeStamp - g.t) > 0.5;
        if (event.type === 'pointerup' && (Math.abs(dx) > SWIPE_DISTANCE || flick) && onSwipe(dx < 0 ? 1 : -1)) return;
        springBack(imgRef.current);
        return;
      }
      if (g.touch && !g.moved && event.type === 'pointerup') tapped(event);
    };
    const wheel = (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      control.current?.zoomBy(event.deltaY < 0 ? 1.15 : 1 / 1.15);
    };
    wrap.addEventListener('pointerdown', down);
    wrap.addEventListener('pointermove', move);
    wrap.addEventListener('pointerup', finish);
    wrap.addEventListener('pointercancel', finish);
    wrap.addEventListener('wheel', wheel, { passive: false });
    return () => {
      wrap.removeEventListener('pointerdown', down);
      wrap.removeEventListener('pointermove', move);
      wrap.removeEventListener('pointerup', finish);
      wrap.removeEventListener('pointercancel', finish);
      wrap.removeEventListener('wheel', wheel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  return (
    <div ref={wrapRef} className="viewer-image is-fit">
      <img
        ref={imgRef}
        src={url}
        alt={file.name}
        draggable="false"
        decoding="async"
        onLoad={apply}
        onError={async (e) => {
          // Its encrypted copy went missing since the vault opened: say so, not a broken picture.
          if ((await readProblem(e.currentTarget.currentSrc || url)).missing) onMissing();
        }}
        onDoubleClick={() => {
          // Touch double-taps are handled above; skip the dblclick some browsers add.
          if (performance.now() - view.current.touchZoomAt < 700) return;
          control.current?.toggleFit();
        }}
      />
      <span hidden>{label}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// What the stage shows for each kind of file
// ---------------------------------------------------------------------------
function Message({ file, title, text, children }) {
  const kind = kindOf(file);
  return (
    <div className="viewer-message">
      <span className={`file-art kind-${kind} art-xl`}>
        <Icon name={KIND_ICON[kind]} size={44} />
      </span>
      <p className="empty-title">{title}</p>
      {text ? <p>{text}</p> : null}
      <div className="viewer-message-actions">{children}</div>
    </div>
  );
}

/**
 * The file's encrypted copy isn't where the vault is (deleted outside Secure Box, say): put it
 * back and try again, or take the file off the vault's list.
 */
function MissingCopy({ file, onRetry }) {
  return (
    <Message file={file} title="This file’s encrypted copy is missing" text={missingCopyText()}>
      <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>
        <Icon name="refresh" size={16} />
        <span>Try again</span>
      </button>
      <button type="button" className="btn btn-danger btn-sm" onClick={() => run(() => deleteEntries([], [file.id]))}>
        <Icon name="trash" size={16} />
        <span>Remove from vault</span>
      </button>
    </Message>
  );
}

/** "Open in another app" on phones: the decrypted file, handed to an app that can play it (#5). */
function ShareButton({ file, primary = false }) {
  const [ready, setReady] = useState(null);
  const [busy, setBusy] = useState(false);
  if (!canShareFiles() || file.size > 300 * 1024 * 1024) return null;
  const share = async () => {
    if (ready) {
      await navigator.share({ files: [ready], title: file.name }).catch((err) => err.name === 'AbortError' || toast(err.message, 'error'));
      return;
    }
    setBusy(true);
    try {
      const prepared = await fileForSharing(file);
      if (!navigator.canShare({ files: [prepared] })) throw new Error('This browser can’t hand this kind of file to another app.');
      // Decrypting took a moment: sharing needs a fresh tap.
      setReady(prepared);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" className={`btn ${primary ? 'btn-primary' : 'btn-ghost'} btn-sm${busy ? ' is-busy' : ''}`} disabled={busy} onClick={() => run(share)}>
      <span className="btn-spinner" aria-hidden="true" />
      <Icon name="openWith" size={16} />
      <span>{ready ? 'Ready: open in another app' : 'Open in another app'}</span>
    </button>
  );
}

const DownloadButton = ({ file, primary = true }) => (
  <button type="button" className={`btn ${primary ? 'btn-primary' : 'btn-ghost'} btn-sm`} onClick={() => run(download, file)}>
    <Icon name="download" size={16} />
    <span>Download</span>
  </button>
);

/**
 * Why the first byte of a streamed file can't be read: { text } ('' if it can), and `missing`
 * when its encrypted copy isn't where the vault is.
 */
async function readProblem(src) {
  if (!src || src.startsWith('blob:')) return { text: '' };
  try {
    const res = await fetch(src, { headers: { Range: 'bytes=0-0' }, cache: 'no-store' });
    const text = await res.text();
    return res.ok ? { text: '' } : { text: text.slice(0, 300) || `The file couldn’t be read (${res.status}).`, missing: res.status === 404 };
  } catch (err) {
    return { text: err?.message || 'The file couldn’t be read.' };
  }
}

// Containers whose sound is often in a format browsers don't play (AC-3, DTS…).
const ODD_SOUND = new Set(['mkv', 'avi', 'mov', 'wmv', 'ts', 'm2ts', 'mpg', 'mpeg']);

function MediaStage({ file, url, tag, onMissing }) {
  const ref = useRef(null);
  const [problem, setProblem] = useState(null); // { title, text }
  const [silent, setSilent] = useState(false);
  useEffect(() => {
    const media = ref.current;
    if (!media) return undefined;
    let timer = 0;
    const onError = async () => {
      const { text: read, missing } = await readProblem(media.currentSrc || media.src);
      if (missing) return onMissing();
      const ext = extOf(file.name);
      setProblem(
        read || !driveFresh(30_000)
          ? { title: 'Can’t play this file', text: read || 'Your sign-in expired. Reconnect, then open it again.' }
          : { title: `Can’t play this ${tag}`, text: `This browser doesn’t play ${ext ? `.${ext}` : 'this kind of'} ${tag} files. Download it${canShareFiles() ? ', or open it in another app,' : ''} to play it there.` },
      );
    };
    // Plays, but no sound comes out: the sound may be in a format the browser can't play.
    const onPlaying = () => {
      clearTimeout(timer);
      if (tag !== 'video' || !ODD_SOUND.has(extOf(file.name))) return;
      timer = setTimeout(() => {
        if (!media.paused && media.webkitAudioDecodedByteCount === 0) setSilent(true);
      }, 3000);
    };
    media.addEventListener('error', onError);
    media.addEventListener('playing', onPlaying);
    return () => {
      clearTimeout(timer);
      media.removeEventListener('error', onError);
      media.removeEventListener('playing', onPlaying);
      media.pause();
      media.removeAttribute('src');
      media.load();
    };
  }, [file, url, tag]);
  if (problem) {
    return (
      <Message file={file} title={problem.title} text={problem.text}>
        <DownloadButton file={file} />
        <ShareButton file={file} />
      </Message>
    );
  }
  if (tag === 'audio') {
    return (
      <div className="viewer-audio">
        <span className="file-art kind-audio art-xl">
          <Icon name="audio" size={52} />
        </span>
        <p className="viewer-audio-name">{file.name}</p>
        {/* biome-ignore lint/a11y/useMediaCaption: the user's own recordings have no captions */}
        <audio ref={ref} src={url} controls autoPlay preload="metadata" />
      </div>
    );
  }
  return (
    <div className="viewer-video">
      {/* biome-ignore lint/a11y/useMediaCaption: the user's own videos have no captions */}
      <video ref={ref} src={url} controls autoPlay playsInline preload="metadata" />
      {silent ? (
        <p className="viewer-hint" role="status">
          No sound? This video’s sound may be in a format this browser doesn’t play. Download it{canShareFiles() ? ' or open it in another app' : ''} to hear it.
        </p>
      ) : null}
    </div>
  );
}

function DocStage({ file, kind, note, onMissing }) {
  const [doc, setDoc] = useState(null);
  const [mono, setMono] = useState(pref('textMono') || kind === 'code');
  const textual = kind === 'text' || kind === 'code';
  const editable = textual && canEditText(file);
  const bytesHere = useRef(null); // the decrypted text, kept for Edit
  useEffect(() => {
    let alive = true;
    (async () => {
      const bytes = await fetchBytes(file);
      if (editable && alive) bytesHere.current = bytes;
      // Parsing a big document is work: it happens off the page, in a worker (#21).
      const parsed = await runTask('parseDocument', { kind, buffer: bytes, mono });
      if (alive) setDoc(parsed);
    })().catch((err) => alive && (isMissingCopy(err) ? onMissing() : setDoc({ error: err?.message || String(err) })));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, kind]);
  if (!doc) {
    return (
      <div className="viewer-loading">
        <Spinner />
        <span>Decrypting…</span>
      </div>
    );
  }
  if (doc.error) {
    return (
      <Message file={file} title="Can’t show this file" text={doc.error}>
        <DownloadButton file={file} />
      </Message>
    );
  }
  const office = ['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'rtf', 'epub'].includes(kind);
  return (
    <div className="viewer-doc">
      {textual ? (
        <div className="doc-toolbar">
          {note ? <span className="doc-toolbar-note">{note}</span> : null}
          {editable && bytesHere.current ? (
            <button type="button" className="btn btn-ghost btn-sm" title="Edit this text here: it stays encrypted, and nothing is saved to disk" onClick={() => startEditing(file, textStyle(bytesHere.current))}>
              <Icon name="edit" size={16} />
              <span>Edit</span>
            </button>
          ) : null}
          <label className="switch switch-sm" title="Fixed-width font">
            <input
              type="checkbox"
              checked={mono}
              onChange={(e) => {
                setMono(e.target.checked);
                setPref('textMono', e.target.checked);
              }}
            />
            <span className="switch-track" aria-hidden="true" />
            <span className="switch-label">Monospace</span>
          </label>
        </div>
      ) : null}
      <div className="viewer-doc-body">
        <DocumentView doc={doc} mono={mono} />
      </div>
      {office ? <p className="viewer-doc-note">Reader view — download for the original layout and images.</p> : null}
    </div>
  );
}

function PdfStage({ file, url, onMissing }) {
  const [bytes, setBytes] = useState(null);
  const [error, setError] = useState('');
  const native = nativePdf();
  useEffect(() => {
    if (native) return undefined;
    let alive = true;
    fetchBytes(file)
      .then((b) => alive && setBytes(b))
      .catch((err) => alive && (isMissingCopy(err) ? onMissing() : setError(err.message)));
    return () => {
      alive = false;
    };
  }, [file, native]);
  if (native) return <iframe className="viewer-pdf" title={file.name} src={url} />;
  if (error) {
    return (
      <Message file={file} title="Can’t show this PDF" text={error}>
        <DownloadButton file={file} />
      </Message>
    );
  }
  if (!bytes) {
    return (
      <div className="viewer-loading">
        <Spinner />
        <span>Decrypting…</span>
      </div>
    );
  }
  return <PdfView bytes={bytes} name={file.name} />;
}

/** Chooses what to show, after decrypting the start of the file if its type is unknown. */
function Stage({ file, control, onSwipe }) {
  const [what, setWhat] = useState({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0); // Try again: the file is looked for anew
  // Its encrypted copy isn't where the vault is (deleted outside Secure Box, say).
  const onMissing = useCallback(() => {
    noteCopy(file, false);
    setWhat({ kind: 'missing' });
  }, [file]);
  useEffect(() => {
    let alive = true;
    setWhat({ kind: 'loading' });
    (async () => {
      await ensureDrive();
      if (await copyGone(file)) {
        if (alive) setWhat({ kind: 'missing' });
        return;
      }
      const kind = viewerFor(file);
      if (kind === 'image' || kind === 'video' || kind === 'audio' || kind === 'pdf') {
        const url = await sourceUrl(file);
        if (alive) setWhat({ kind, url });
      } else if (kind) {
        if (alive) setWhat({ kind: 'doc', doc: kind });
      } else if (file.size <= TEXT_SNIFF_LIMIT && (file.size === 0 || looksLikeText(await fetchRange(file, 0, Math.min(file.size, 65536) - 1)))) {
        if (alive) setWhat({ kind: 'doc', doc: 'code', note: 'Unknown file type — shown as plain text.' });
      } else if (alive) setWhat({ kind: 'none' });
    })().catch((err) => {
      if (!alive || err?.code === 'cancelled') return;
      if (isMissingCopy(err)) onMissing();
      else setWhat({ kind: 'failed', error: err });
    });
    return () => {
      alive = false;
      releaseUrls();
    };
  }, [file, attempt, onMissing]);
  switch (what.kind) {
    case 'loading':
      return (
        <div className="viewer-loading">
          <Spinner />
          <span>Decrypting…</span>
        </div>
      );
    case 'missing':
      return <MissingCopy file={file} onRetry={() => setAttempt((n) => n + 1)} />;
    case 'image':
      return <ImageStage file={file} url={what.url} control={control} onSwipe={onSwipe} onMissing={onMissing} />;
    case 'video':
    case 'audio':
      return <MediaStage file={file} url={what.url} tag={what.kind} onMissing={onMissing} />;
    case 'pdf':
      return <PdfStage file={file} url={what.url} onMissing={onMissing} />;
    case 'doc':
      return <DocStage file={file} kind={what.doc} note={what.note} onMissing={onMissing} />;
    case 'failed':
      return !driveFresh(30_000) ? (
        <Message file={file} title="Your sign-in expired" text="Reconnect to keep viewing your files.">
          <button type="button" className="btn btn-primary btn-sm" onClick={() => run(async () => ensureDrive().then(() => setWhat({ kind: 'loading' })))}>
            <Icon name="refresh" size={16} />
            <span>Reconnect</span>
          </button>
        </Message>
      ) : (
        <Message file={file} title="Can’t show this file" text={what.error?.message || 'Something went wrong while decrypting it.'}>
          <DownloadButton file={file} />
        </Message>
      );
    default:
      return (
        <Message file={file} title="No preview for this file type" text={`${typeLabel(file)} · ${formatBytes(file.size)}`}>
          <DownloadButton file={file} />
          <ShareButton file={file} />
        </Message>
      );
  }
}

function Info({ file }) {
  const row = (label, value) => (
    <div className="info-row">
      <span className="info-label">{label}</span>
      <span className="info-value">{value}</span>
    </div>
  );
  return (
    <aside className="viewer-info">
      <h3>Details</h3>
      {row('Name', file.name)}
      {row('Kind', typeLabel(file))}
      {row('Size', formatBytes(file.size))}
      {row('Location', folderPath(file))}
      {row('Added', formatDate(file.created))}
      {row('Modified', formatDate(file.updated))}
      <div className="info-secure">
        <Icon name="shield" size={16} />
        <p>
          Encrypted in this browser with its own AES-256-GCM key{canThumbnail(file) && file.thumbBytes ? ' (thumbnail included)' : ''}. Where it’s stored, it’s an unnamed encrypted blob; it’s decrypted while it streams and never saved
          to disk.
        </p>
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
export function Viewer() {
  const { ids, index, info, editing } = useStore(viewerStore);
  const vault = useSession((s) => s.vault);
  const missing = useStore(files.store, (v) => v.missing);
  const narrow = useNarrow();
  const ref = useRef(null);
  const control = useRef(null);
  const [zoomLabel, setZoomLabel] = useState('Fit');
  const id = ids[index];
  const live = id ? vault?.files.find((f) => f.id === id) : null;
  // A text file being edited stays open even if it's deleted elsewhere meanwhile: saving then keeps the text.
  const editingThis = Boolean(editing && editing.id === id);
  const file = live || (editingThis ? editing.base : null);
  const open = index >= 0;

  useEffect(() => {
    const dialog = ref.current;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  // Deleted or moved away in another window or device while open: on to the next, or close (#20).
  useEffect(() => {
    if (open && id && vault && !live && !editingThis) {
      toast('That file was deleted or moved.');
      dropFromViewer(id);
    }
  }, [open, id, vault, live, editingThis]);

  const go = useCallback(
    (step) => {
      const next = index + step;
      if (next < 0 || next >= ids.length) return false;
      requestStepViewer(step);
      return true;
    },
    [index, ids.length],
  );

  // Swipe left/right on documents and messages to change file (photos do their own).
  const swipe = useRef(null);
  const onKeyDown = (event) => {
    if (event.target.closest('input, textarea, select')) return;
    const c = control.current;
    if (event.key === 'ArrowLeft') go(-1);
    else if (event.key === 'ArrowRight') go(1);
    else if (c && (event.key === '+' || event.key === '=')) c.zoomBy(1.25);
    else if (c && event.key === '-') c.zoomBy(0.8);
    else if (c && event.key === '0') c.fit();
    else if (c && event.key.toLowerCase() === 'r') c.rotate();
    else return;
    event.preventDefault();
    if (c) requestAnimationFrame(() => setZoomLabel(c.label()));
  };

  const act = (fn) => () => run(fn);
  const actions = file
    ? {
        download: act(() => download(file)),
        rename: act(() => renameEntry(file, false)),
        move: act(() => moveEntries([], [file.id])),
        remove: act(async () => {
          if (await leaveEditing()) await deleteEntries([], [file.id]);
        }),
      }
    : {};
  const kind = file ? kindOf(file) : 'other';
  // A file whose encrypted copy is missing has nothing to download or zoom into.
  const gone = Boolean(file && missing.has(file.blob));
  const isImage = file && viewerFor(file) === 'image' && !gone;

  return (
    <dialog
      ref={ref}
      className="viewer"
      aria-labelledby="viewer-name"
      onCancel={(event) => {
        event.preventDefault();
        // Esc while editing leaves the editor (asking first if there are unsaved changes); then it closes the viewer.
        if (viewerStore.get().editing) leaveEditing();
        else closeViewer();
      }}
      onKeyDown={onKeyDown}
    >
      {open && file ? (
        <>
          <header className="viewer-bar">
            <div className="viewer-title">
              <span className={`file-art kind-${kind} art-sm`}>
                <Icon name={KIND_ICON[kind]} size={16} />
              </span>
              <div className="viewer-heading">
                <h2 id="viewer-name" title={file.name}>
                  {file.name}
                </h2>
                <p>
                  {typeLabel(file)} · {formatBytes(file.size)}
                  {ids.length > 1 ? ` · ${index + 1} of ${ids.length}` : ''}
                </p>
              </div>
            </div>
            <div className="viewer-actions">
              {isImage && !narrow ? (
                <div className="viewer-zoom">
                  <button type="button" className="icon-btn" aria-label="Zoom out" title="Zoom out (−)" onClick={() => { control.current?.zoomBy(0.8); setZoomLabel(control.current?.label()); }}>
                    <Icon name="zoomOut" />
                  </button>
                  <button type="button" className="zoom-label" title="Fit / actual size (0)" onClick={() => { control.current?.toggleFit(); setZoomLabel(control.current?.label()); }}>
                    {zoomLabel}
                  </button>
                  <button type="button" className="icon-btn" aria-label="Zoom in" title="Zoom in (+)" onClick={() => { control.current?.zoomBy(1.25); setZoomLabel(control.current?.label()); }}>
                    <Icon name="zoomIn" />
                  </button>
                  <button type="button" className="icon-btn" aria-label="Rotate" title="Rotate (R)" onClick={() => control.current?.rotate()}>
                    <Icon name="rotate" />
                  </button>
                </div>
              ) : null}
              {gone ? null : (
                <button type="button" className="icon-btn" aria-label="Download" title="Download" onClick={actions.download}>
                  <Icon name="download" />
                </button>
              )}
              {narrow ? (
                <>
                  <button type="button" className="icon-btn icon-btn-danger" aria-label="Delete" title="Delete" onClick={actions.remove}>
                    <Icon name="trash" />
                  </button>
                  <Menu
                    label="More"
                    className="viewer-more-menu"
                    button={(props) => (
                      <button {...props} type="button" className="icon-btn" aria-label="More" title="More">
                        <Icon name="more" />
                      </button>
                    )}
                  >
                    {isImage ? (
                      <MenuItem icon={<Icon name="rotate" />} onSelect={() => control.current?.rotate()}>
                        Rotate
                      </MenuItem>
                    ) : null}
                    <MenuItem icon={<Icon name="edit" />} onSelect={actions.rename}>
                      Rename
                    </MenuItem>
                    <MenuItem icon={<Icon name="move" />} onSelect={actions.move}>
                      Move
                    </MenuItem>
                    <MenuItem icon={<Icon name="info" />} onSelect={toggleViewerInfo}>
                      {info ? 'Hide details' : 'Details'}
                    </MenuItem>
                  </Menu>
                </>
              ) : (
                <>
                  <button type="button" className="icon-btn" aria-label="Rename" title="Rename" onClick={actions.rename}>
                    <Icon name="edit" />
                  </button>
                  <button type="button" className="icon-btn" aria-label="Move" title="Move" onClick={actions.move}>
                    <Icon name="move" />
                  </button>
                  <button type="button" className="icon-btn icon-btn-danger" aria-label="Delete" title="Delete" onClick={actions.remove}>
                    <Icon name="trash" />
                  </button>
                  <button type="button" className={`icon-btn${info ? ' is-on' : ''}`} aria-label="Details" aria-pressed={info} title="Details" onClick={toggleViewerInfo}>
                    <Icon name="info" />
                  </button>
                </>
              )}
              <button type="button" className="icon-btn viewer-close" aria-label="Close" title="Close (Esc)" onClick={() => requestCloseViewer()}>
                <Icon name="x" />
              </button>
            </div>
          </header>
          <div className="viewer-body">
            {index > 0 && !editingThis ? (
              <button type="button" className="viewer-nav viewer-prev" aria-label="Previous" title="Previous (←)" onClick={() => go(-1)}>
                <Icon name="chevronLeft" size={24} />
              </button>
            ) : null}
            <div
              className="viewer-stage"
              onPointerDown={(event) => {
                swipe.current = null;
                if (event.pointerType !== 'touch' || !event.isPrimary || (window.visualViewport?.scale ?? 1) > 1.01) return;
                if (event.target.closest('.viewer-image, video, audio, iframe, button, a, input, label, select, textarea, canvas')) return;
                swipe.current = { id: event.pointerId, x: event.clientX, y: event.clientY, t: event.timeStamp };
              }}
              onPointerUp={(event) => {
                const start = swipe.current;
                swipe.current = null;
                if (!start || event.pointerId !== start.id || event.timeStamp - start.t > 800) return;
                const dx = event.clientX - start.x;
                const dy = event.clientY - start.y;
                if (Math.abs(dx) < SWIPE_DISTANCE || Math.abs(dx) < Math.abs(dy) * 1.5) return;
                if (String(window.getSelection?.() || '').trim()) return; // they were selecting text
                go(dx < 0 ? 1 : -1);
              }}
            >
              {editingThis ? <TextEditor file={file} deleted={!live} /> : <Stage key={file.id} file={file} control={control} onSwipe={go} />}
            </div>
            {index < ids.length - 1 && !editingThis ? (
              <button type="button" className="viewer-nav viewer-next" aria-label="Next" title="Next (→)" onClick={() => go(1)}>
                <Icon name="chevronRight" size={24} />
              </button>
            ) : null}
            {info ? <Info file={file} /> : null}
          </div>
        </>
      ) : null}
    </dialog>
  );
}

