/**
 * Work that's heavy for JavaScript itself (not the encryption, which the browser already does
 * off the page): reading documents for the viewer, photo thumbnails, packing a folder or a backup
 * into one ZIP. Run in a worker by pool.js, or here on the page where workers aren't available.
 */
import { zipFolder } from '../core/localbox.js';
import { parseDocument } from '../core/readers.js';
import { imageThumbnail } from '../core/thumbs.js';

export const TASKS = {
  parseDocument: ({ kind, buffer, mono }) => parseDocument(kind, buffer, { mono }),
  thumbnail: async ({ file }) => {
    const bytes = await imageThumbnail(file);
    return bytes.length && bytes.length < 512 * 1024 ? bytes : null;
  },
  zipFolder: ({ items }, onProgress) => zipFolder(items, { onProgress }),
};
