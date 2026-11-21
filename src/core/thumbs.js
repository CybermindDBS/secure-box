/**
 * Small JPEG thumbnails for images and videos, made locally before upload. They are stored
 * encrypted inside the file's own blob, so Google can't tell which files are photos.
 */
const MAX_SIDE = 480;

async function encode(source, width, height) {
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = canvas.getContext('2d');
  ctx.drawImage(source, 0, 0, w, h);
  const blob = canvas.convertToBlob
    ? await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 })
    : await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8));
  return new Uint8Array(await blob.arrayBuffer());
}

/** A photo's thumbnail: works in a worker too (createImageBitmap + OffscreenCanvas). */
export async function imageThumbnail(file) {
  const bitmap = await createImageBitmap(file);
  try {
    return await encode(bitmap, bitmap.width, bitmap.height);
  } finally {
    bitmap.close?.();
  }
}

function videoThumbnail(file) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    const url = URL.createObjectURL(file);
    const done = (fn, value) => {
      clearTimeout(timer);
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
      fn(value);
    };
    const timer = setTimeout(() => done(reject, new Error('timeout')), 10000);
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.addEventListener('loadedmetadata', () => {
      video.currentTime = Math.min(1, (video.duration || 0) * 0.1);
    });
    video.addEventListener('seeked', () => encode(video, video.videoWidth, video.videoHeight).then((v) => done(resolve, v), (e) => done(reject, e)));
    video.addEventListener('error', () => done(reject, new Error('unsupported video')));
    video.src = url;
  });
}

/** Returns JPEG bytes, or null when this browser can't decode the file. */
export async function makeThumbnail(file, type) {
  try {
    const bytes = type.startsWith('video/') ? await videoThumbnail(file) : await imageThumbnail(file);
    return bytes.length && bytes.length < 512 * 1024 ? bytes : null;
  } catch {
    return null;
  }
}
