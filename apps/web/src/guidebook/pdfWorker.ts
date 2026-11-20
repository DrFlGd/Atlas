/**
 * pdf.js's worker, which reads PDF files apart from the page, as a module
 * worker of the app's own: Vite bundles it into a `.js` file next to the
 * app's other scripts, served from the app itself as the rules of the
 * desktop app's web view ask (`script-src 'self'`).
 */
import 'pdfjs-dist/build/pdf.worker.min.mjs';
