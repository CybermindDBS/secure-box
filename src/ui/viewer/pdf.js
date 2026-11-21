/**
 * PDF.js, set up for this page's rules: its worker starts through the Trusted Types policy, it
 * never evaluates code, and its fonts and character maps come from Secure Box's own address.
 */
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { allowScript, trustedScriptUrl } from '../../core/trusted.js';

allowScript(workerUrl);
let port = null;

export async function openPdf(bytes) {
  port ??= new Worker(trustedScriptUrl(workerUrl), { type: 'module', name: 'pdf' });
  pdfjs.GlobalWorkerOptions.workerPort = port;
  const base = new URL('assets/pdfjs/', document.baseURI).href;
  return pdfjs.getDocument({
    data: new Uint8Array(bytes.slice(0)),
    isEvalSupported: false,
    enableXfa: false,
    useSystemFonts: true,
    standardFontDataUrl: `${base}standard_fonts/`,
    cMapUrl: `${base}cmaps/`,
    cMapPacked: true,
  }).promise;
}
