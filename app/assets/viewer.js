/** Full-screen viewer: images, video & audio players, PDFs and document readers. */
import { TEXT_SNIFF_LIMIT, canThumbnail, extOf, formatBytes, kindOf, typeLabel, viewerFor } from './filetypes.js';
import { looksLikeText, renderDocument } from './readers.js';
import { $, formatDate, h, icon, toast } from './ui.js';

const MONO_KEY = 'unibox.textMono';
const monoPref = (kind) => {
  try {
    const saved = localStorage.getItem(`${MONO_KEY}.${kind}`);
    return saved === null ? kind === 'code' : saved === '1';
  } catch {
    return kind === 'code';
  }
};

const SWIPE_DISTANCE = 60; // px a finger must travel sideways to change file

const KIND_ICON = { image: 'image', video: 'video', audio: 'audio', pdf: 'file', doc: 'note', sheet: 'sheet', slides: 'slides', code: 'code', text: 'note', archive: 'archive', other: 'file' };

export function createViewer(ctx) {
  const dialog = $('#viewer');
  const stage = $('#viewer-stage');
  let ids = [];
  let index = 0;
  let token = 0;
  let image = null; // { img, zoom, rotate, fit }

  const current = () => ctx.file(ids[index]);

  function stopMedia() {
    for (const media of stage.querySelectorAll('video, audio')) {
      media.pause();
      media.removeAttribute('src');
      media.load();
    }
    stage.replaceChildren();
    image = null;
    ctx.releaseUrls();
  }

  function message(title, text, ...actions) {
    const file = current();
    const kind = kindOf(file);
    return h('div', { class: 'viewer-message' },
      h('span', { class: `file-art kind-${kind} art-xl` }, icon(KIND_ICON[kind], 44)),
      h('p', { class: 'empty-title', text: title }),
      text ? h('p', { text }) : null,
      h('div', { class: 'viewer-message-actions' }, actions));
  }

  const downloadButton = ({ primary = true } = {}) =>
    h('button', { type: 'button', class: `btn ${primary ? 'btn-primary' : 'btn-ghost'} btn-sm`, onclick: () => ctx.download(current()).catch((e) => toast(e.message, 'error')) }, icon('download', 16), h('span', { text: 'Download' }));

  function failed(err) {
    if (!ctx.driveFresh(30_000)) {
      return message('Your sign-in expired', 'Reconnect to keep viewing your files.',
        h('button', { type: 'button', class: 'btn btn-primary btn-sm', onclick: () => ctx.ensureDrive().then(show).catch(() => {}) }, icon('refresh', 16), h('span', { text: 'Reconnect' })));
    }
    return message('Can’t show this file', err?.message || 'Something went wrong while decrypting it.', downloadButton());
  }

  // ---------------------------------------------------------------------------
  // Images: fit / zoom / rotate / pan
  // ---------------------------------------------------------------------------
  function applyImage() {
    if (!image) return;
    const { img, wrap } = image;
    const turned = image.rotate % 180 !== 0;
    wrap.classList.toggle('is-fit', image.fit);
    if (image.fit) {
      img.style.removeProperty('width');
      img.style.setProperty('--max-w', turned ? `${stage.clientHeight - 32}px` : '100%');
      img.style.setProperty('--max-h', turned ? `${stage.clientWidth - 32}px` : '100%');
      // Remember the fitted scale: pinching below it snaps back to fit.
      if (img.clientWidth && img.naturalWidth) image.fitZoom = img.clientWidth / img.naturalWidth;
    } else img.style.width = `${Math.round(img.naturalWidth * image.zoom)}px`;
    img.style.transform = `rotate(${image.rotate}deg)`;
    $('#viewer-zoom-label').textContent = image.fit ? 'Fit' : `${Math.round(image.zoom * 100)}%`;
  }

  const currentZoom = () => (image.fit ? image.img.clientWidth / (image.img.naturalWidth || 1) : image.zoom);

  function fitImage() {
    image.fit = true;
    image.zoom = 1;
    applyImage();
  }

  function zoomBy(factor) {
    if (!image) return;
    image.zoom = Math.min(8, Math.max(0.05, currentZoom() * factor));
    image.fit = false;
    applyImage();
  }

  /**
   * Zooms to `zoom` (1 = actual size) keeping the part of the photo under (x, y) in place.
   * With `anchor`, one photo point follows a moving pinch midpoint, so two fingers also pan.
   */
  function zoomAt(zoom, x, y, anchor = null) {
    const { img, wrap } = image;
    const before = img.getBoundingClientRect();
    const fx = anchor ? anchor.fx : (x - before.left) / (before.width || 1);
    const fy = anchor ? anchor.fy : (y - before.top) / (before.height || 1);
    image.fit = false;
    image.zoom = Math.min(8, Math.max(image.fitZoom * 0.5, zoom));
    applyImage();
    const after = img.getBoundingClientRect();
    wrap.scrollLeft += after.left + fx * after.width - x;
    wrap.scrollTop += after.top + fy * after.height - y;
  }

  function springBack(img) {
    img.style.transition = 'translate 0.2s ease-out, transform 0.2s';
    img.style.removeProperty('translate');
    setTimeout(() => img.style.removeProperty('transition'), 250);
  }

  const canGo = (step) => index + step >= 0 && index + step < ids.length;

  /**
   * Photo gestures. Touch: pinch to zoom, double-tap to zoom in or back to fit, drag to pan a
   * zoomed photo, swipe a fitted photo left/right for the next/previous file. Mouse: drag to pan.
   */
  function trackImageGestures(wrap) {
    const points = new Map(); // pointerId -> { x, y }
    let gesture = null;
    let lastTap = null;
    const mine = () => image?.wrap === wrap;
    const drag = (id, x, y, t, touch) => ({ type: 'drag', id, x, y, t, touch, left: wrap.scrollLeft, top: wrap.scrollTop, moved: false, swipe: false, noSwipe: false });
    const pinchState = () => {
      const [a, b] = points.values();
      return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) || 1 };
    };

    wrap.addEventListener('pointerdown', (event) => {
      if (!mine() || (event.pointerType === 'mouse' && event.button !== 0)) return;
      try {
        wrap.setPointerCapture(event.pointerId);
      } catch {
        /* the pointer is already gone */
      }
      points.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (points.size === 2) {
        image.img.style.removeProperty('translate');
        lastTap = null;
        const m = pinchState();
        const r = image.img.getBoundingClientRect();
        gesture = { type: 'pinch', d: m.d, zoom: currentZoom(), fx: (m.x - r.left) / (r.width || 1), fy: (m.y - r.top) / (r.height || 1) };
      } else if (points.size === 1) {
        gesture = drag(event.pointerId, event.clientX, event.clientY, event.timeStamp, event.pointerType !== 'mouse');
      }
    });

    wrap.addEventListener('pointermove', (event) => {
      const point = points.get(event.pointerId);
      if (!point || !gesture || !mine()) return;
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
      if (!image.fit) {
        wrap.scrollLeft = gesture.left - dx;
        wrap.scrollTop = gesture.top - dy;
      } else if (gesture.touch && gesture.moved && !gesture.noSwipe && (gesture.swipe || Math.abs(dx) > Math.abs(dy))) {
        gesture.swipe = true;
        image.img.style.translate = `${dx}px 0`;
      }
    });

    const tapped = (event) => {
      if (lastTap && event.timeStamp - lastTap.t < 320 && Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) < 30) {
        lastTap = null;
        image.touchZoomAt = performance.now();
        if (image.fit) zoomAt(image.fitZoom * 2.5, event.clientX, event.clientY);
        else fitImage();
      } else lastTap = { t: event.timeStamp, x: event.clientX, y: event.clientY };
    };

    const finish = (event) => {
      if (!points.delete(event.pointerId) || !gesture || !mine()) return;
      if (gesture.type === 'pinch') {
        if (points.size === 1) {
          // One finger is still down: carry on panning with it, but never as a swipe or tap.
          const [[id, p]] = points;
          gesture = { ...drag(id, p.x, p.y, event.timeStamp, true), moved: true, noSwipe: true };
        } else if (!points.size) gesture = null;
        if (!image.fit && image.zoom <= image.fitZoom * 1.02) fitImage();
        return;
      }
      if (event.pointerId !== gesture.id) return;
      const g = gesture;
      gesture = null;
      if (g.swipe) {
        const dx = event.clientX - g.x;
        const step = dx < 0 ? 1 : -1;
        const flick = Math.abs(dx) > 30 && Math.abs(dx) / Math.max(1, event.timeStamp - g.t) > 0.5;
        if (event.type === 'pointerup' && (Math.abs(dx) > SWIPE_DISTANCE || flick) && canGo(step)) go(step);
        else springBack(image.img);
        return;
      }
      if (g.touch && !g.moved && event.type === 'pointerup') tapped(event);
    };
    wrap.addEventListener('pointerup', finish);
    wrap.addEventListener('pointercancel', finish);
  }

  async function showImage(file, my) {
    const img = h('img', { alt: file.name, draggable: 'false', decoding: 'async' });
    const wrap = h('div', { class: 'viewer-image is-fit' }, img);
    image = { img, wrap, zoom: 1, rotate: 0, fit: true, fitZoom: 1, touchZoomAt: -Infinity };
    img.addEventListener('dblclick', () => {
      // Touch double-taps are handled in trackImageGestures; skip the dblclick some browsers add.
      if (performance.now() - image.touchZoomAt < 700) return;
      image.fit = !image.fit;
      image.zoom = 1;
      applyImage();
    });
    wrap.addEventListener('wheel', (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      zoomBy(event.deltaY < 0 ? 1.15 : 1 / 1.15);
    }, { passive: false });
    trackImageGestures(wrap);
    const loaded = new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error(`This browser can’t display .${extOf(file.name) || 'this'} images.`));
    });
    img.src = await ctx.sourceUrl(file);
    await loaded;
    if (my !== token) return;
    stage.replaceChildren(wrap);
    $('#viewer-zoom').hidden = false;
    applyImage();
  }

  // ---------------------------------------------------------------------------
  // Media
  // ---------------------------------------------------------------------------
  /** Why the first byte of a streamed file can't be read, or '' if it can. */
  async function readProblem(src) {
    if (!src || src.startsWith('blob:')) return ''; // already decrypted in this page
    try {
      const res = await fetch(src, { headers: { Range: 'bytes=0-0' }, cache: 'no-store' });
      const text = await res.text();
      return res.ok ? '' : text.slice(0, 300) || `The file couldn’t be read (${res.status}).`;
    } catch (err) {
      return err?.message || 'The file couldn’t be read.';
    }
  }

  async function showMedia(file, my, tag) {
    const media = h(tag, { controls: true, autoplay: true, playsinline: true, preload: 'metadata' });
    media.addEventListener('error', async () => {
      if (my !== token) return;
      // A file that couldn't be read fails just like one the browser can't play: read its
      // first byte to tell which.
      const problem = await readProblem(media.currentSrc || media.src);
      if (my !== token) return;
      const ext = extOf(file.name);
      stage.replaceChildren(
        problem || !ctx.driveFresh(30_000)
          ? failed(problem ? new Error(problem) : undefined)
          : message(`Can’t play this ${tag}`, `This browser doesn’t support ${ext ? `.${ext}` : 'this'} ${tag} files. Download it to play it in another app.`, downloadButton()),
      );
    });
    media.src = await ctx.sourceUrl(file);
    if (my !== token) return;
    if (tag === 'audio') {
      stage.replaceChildren(
        h('div', { class: 'viewer-audio' },
          h('span', { class: 'file-art kind-audio art-xl' }, icon('audio', 52)),
          h('p', { class: 'viewer-audio-name', text: file.name }),
          media),
      );
    } else stage.replaceChildren(h('div', { class: 'viewer-video' }, media));
  }

  // ---------------------------------------------------------------------------
  // Show the current file
  // ---------------------------------------------------------------------------
  async function show() {
    const file = current();
    if (!file) return close();
    const my = ++token;
    stopMedia();
    $('#viewer-zoom').hidden = true;
    $('#viewer-name').textContent = file.name;
    $('#viewer-meta').textContent = `${typeLabel(file)} · ${formatBytes(file.size)}${ids.length > 1 ? ` · ${index + 1} of ${ids.length}` : ''}`;
    $('#viewer-kind').replaceChildren(h('span', { class: `file-art kind-${kindOf(file)} art-sm` }, icon(KIND_ICON[kindOf(file)], 16)));
    dialog.querySelector('[data-action="viewer-prev"]').hidden = index <= 0;
    dialog.querySelector('[data-action="viewer-next"]').hidden = index >= ids.length - 1;
    renderInfo(file);
    stage.replaceChildren(h('div', { class: 'viewer-loading' }, h('span', { class: 'spinner' }), h('span', { text: 'Decrypting…' })));
    const kind = viewerFor(file);
    try {
      await ctx.ensureDrive();
      if (my !== token) return;
      if (kind === 'image') await showImage(file, my);
      else if (kind === 'video') await showMedia(file, my, 'video');
      else if (kind === 'audio') await showMedia(file, my, 'audio');
      else if (kind === 'pdf') await showPdf(file, my);
      else if (kind) {
        await showDocument(file, my, kind);
      } else if (file.size <= TEXT_SNIFF_LIMIT && (file.size === 0 || looksLikeText(await ctx.fetchRange(file, 0, Math.min(file.size, 65536) - 1)))) {
        if (my === token) await showDocument(file, my, 'code', 'Unknown file type — shown as plain text.');
      } else {
        stage.replaceChildren(message('No preview for this file type', `${typeLabel(file)} · ${formatBytes(file.size)}`, downloadButton()));
      }
    } catch (err) {
      if (my === token && err?.code !== 'cancelled') stage.replaceChildren(failed(err));
    }
  }

  async function showPdf(file, my) {
    const url = await ctx.sourceUrl(file);
    if (my !== token) return;
    // Chrome on Android (and some other mobile browsers) can't show a PDF inside a page.
    if (navigator.pdfViewerEnabled === false) {
      stage.replaceChildren(message('Open this PDF to read it', 'This browser can’t show PDFs inside Secure Box. Open it in a new tab, or download it.',
        h('button', { type: 'button', class: 'btn btn-primary btn-sm', onclick: () => window.open(url, '_blank', 'noopener') }, icon('external', 16), h('span', { text: 'Open' })),
        downloadButton({ primary: false })));
      return;
    }
    stage.replaceChildren(h('iframe', { class: 'viewer-pdf', title: file.name, src: url }));
  }

  async function showDocument(file, my, kind, note = '') {
    const bytes = await ctx.fetchBytes(file);
    if (my !== token) return;
    const textual = kind === 'text' || kind === 'code';
    let mono = textual && monoPref(kind);
    const holder = h('div', { class: 'viewer-doc-body' });
    const draw = async () => holder.replaceChildren(await renderDocument(kind, bytes, { mono }));
    await draw();
    if (my !== token) return;
    let toolbar = null;
    if (textual) {
      const input = h('input', { type: 'checkbox', checked: mono || null });
      input.addEventListener('change', () => {
        mono = input.checked;
        try {
          localStorage.setItem(`${MONO_KEY}.${kind}`, mono ? '1' : '0');
        } catch {
          /* ignore */
        }
        holder.querySelector('.doc-plain')?.classList.toggle('is-mono', mono);
      });
      toolbar = h('div', { class: 'doc-toolbar' },
        note ? h('span', { class: 'doc-toolbar-note', text: note }) : null,
        h('label', { class: 'switch switch-sm', title: 'Fixed-width font' }, input, h('span', { class: 'switch-track', 'aria-hidden': 'true' }), h('span', { class: 'switch-label', text: 'Monospace' })));
    }
    const office = ['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'rtf'].includes(kind);
    stage.replaceChildren(h('div', { class: 'viewer-doc' }, toolbar, holder,
      office ? h('p', { class: 'viewer-doc-note', text: 'Reader view — download for the original layout and images.' }) : null));
  }

  function renderInfo(file) {
    const row = (label, value) => h('div', { class: 'info-row' }, h('span', { class: 'info-label', text: label }), h('span', { class: 'info-value', text: value }));
    $('#viewer-info').replaceChildren(
      h('h3', { text: 'Details' }),
      row('Name', file.name),
      row('Kind', typeLabel(file)),
      row('Size', formatBytes(file.size)),
      row('Location', ctx.folderPath(file)),
      row('Added', formatDate(file.created)),
      row('Modified', formatDate(file.updated)),
      h('div', { class: 'info-secure' },
        icon('shield', 16),
        h('p', { text: `Encrypted in this browser with its own AES-256-GCM key${canThumbnail(file) && file.thumbBytes ? ' (thumbnail included)' : ''}. Your cloud drive stores only an unnamed encrypted blob; it is decrypted while it streams and never saved to disk.` })),
    );
  }

  function open(id, list) {
    ids = list.length ? list : [id];
    index = Math.max(0, ids.indexOf(id));
    if (!dialog.open) dialog.showModal();
    show();
  }

  function close() {
    token++;
    stopMedia();
    if (dialog.open) dialog.close();
  }

  function go(step) {
    const next = index + step;
    if (next < 0 || next >= ids.length) return;
    index = next;
    show();
  }

  dialog.addEventListener('close', () => {
    token++;
    stopMedia();
  });
  dialog.addEventListener('keydown', (event) => {
    if (event.target.closest('input, textarea, select')) return;
    if (event.key === 'ArrowLeft') go(-1);
    else if (event.key === 'ArrowRight') go(1);
    else if (image && (event.key === '+' || event.key === '=')) zoomBy(1.25);
    else if (image && event.key === '-') zoomBy(0.8);
    else if (image && event.key === '0') {
      image.fit = true;
      applyImage();
    } else if (image && event.key.toLowerCase() === 'r') {
      image.rotate = (image.rotate + 90) % 360;
      applyImage();
    } else return;
    event.preventDefault();
  });
  window.addEventListener('resize', () => image?.fit && applyImage());

  // Swipe left/right on documents, players' surroundings and messages to change file. Photos
  // handle their own swipes; controls, media, PDFs and text selection are left alone.
  let swipe = null;
  const pageZoomed = () => (window.visualViewport?.scale ?? 1) > 1.01;
  stage.addEventListener('pointerdown', (event) => {
    swipe = null;
    if (event.pointerType !== 'touch' || !event.isPrimary || pageZoomed()) return;
    if (event.target.closest('.viewer-image, video, audio, iframe, button, a, input, label, select, textarea')) return;
    swipe = { id: event.pointerId, x: event.clientX, y: event.clientY, t: event.timeStamp };
  });
  stage.addEventListener('pointerup', (event) => {
    const start = swipe;
    swipe = null;
    if (!start || event.pointerId !== start.id || event.timeStamp - start.t > 800) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.abs(dx) < SWIPE_DISTANCE || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    if (String(window.getSelection?.() || '').trim()) return; // they were selecting text
    go(dx < 0 ? 1 : -1);
  });
  stage.addEventListener('pointercancel', () => {
    swipe = null;
  });
  // While the page itself is pinch-zoomed, let the browser pan freely instead.
  window.visualViewport?.addEventListener('resize', () => dialog.classList.toggle('is-page-zoomed', pageZoomed()));

  const afterChange = (fn) => async () => {
    const file = current();
    await fn(file);
    if (!ctx.file(file.id)) {
      ids.splice(index, 1);
      if (!ids.length) return close();
      index = Math.min(index, ids.length - 1);
    }
    show();
  };

  return {
    open,
    actions: {
      'viewer-close': () => close(),
      'viewer-prev': () => go(-1),
      'viewer-next': () => go(1),
      'viewer-download': () => ctx.download(current()),
      'viewer-info': () => {
        const panel = $('#viewer-info');
        panel.hidden = !panel.hidden;
        if (image?.fit) applyImage();
      },
      'viewer-rename': afterChange((file) => ctx.rename(file)),
      'viewer-move': afterChange((file) => ctx.move(file)),
      'viewer-delete': afterChange((file) => ctx.remove(file)),
      'zoom-in': () => zoomBy(1.25),
      'zoom-out': () => zoomBy(0.8),
      'zoom-fit': () => {
        if (!image) return;
        image.fit = !image.fit;
        image.zoom = 1;
        applyImage();
      },
      rotate: () => {
        if (!image) return;
        image.rotate = (image.rotate + 90) % 360;
        applyImage();
      },
    },
  };
}
