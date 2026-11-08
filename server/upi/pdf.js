/**
 * Password-protected PDF -> text lines, in pure JS via pdf.js. No system
 * binaries, no external service. Used to read bank statement PDFs with the
 * password typed for that import.
 *
 * We reconstruct visual lines from the positioned text items (pdf.js hands back
 * fragments with x/y coordinates, not lines) so a tabular statement parses
 * predictably: group by y, order by x.
 */
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
// Legacy build runs in Node without a browser DOM.
const pdfjsPath = 'pdfjs-dist/legacy/build/pdf.mjs';

let pdfjs = null;
async function getPdfjs() {
  if (!pdfjs) pdfjs = await import(pdfjsPath);
  return pdfjs;
}

/**
 * Returns { pages: string[][] } — one array of line-strings per page — plus a
 * flat `lines` array across all pages. Throws a clear error when the password
 * is wrong or missing.
 */
export async function extractTextLines(buffer, password) {
  const lib = await getPdfjs();
  const data = new Uint8Array(buffer);

  let doc;
  try {
    doc = await lib.getDocument({
      data,
      password: password || undefined,
      // Security + headless hardening: never eval, don't fetch remote fonts.
      isEvalSupported: false,
      useSystemFonts: false,
      disableFontFace: true,
      verbosity: 0,
    }).promise;
  } catch (err) {
    if (err?.name === 'PasswordException') {
      throw new Error(
        password
          ? 'The statement password was rejected by the PDF.'
          : 'This PDF is password-protected — enter its password to import it.',
      );
    }
    throw new Error(`Could not open the PDF: ${err?.message || err}`);
  }

  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    pages.push(itemsToLines(content.items));
  }
  await doc.cleanup?.();

  return { pages, lines: pages.flat() };
}

/**
 * Groups positioned text fragments into visual lines. Items on the same row
 * (close y) are joined left-to-right; rows are ordered top-to-bottom. A small
 * y-tolerance absorbs sub-pixel baseline jitter within a row.
 */
function itemsToLines(items, yTolerance = 3) {
  const frags = items
    .filter((it) => typeof it.str === 'string' && it.str.length)
    .map((it) => ({ x: it.transform[4], y: it.transform[5], str: it.str }));

  const rows = [];
  for (const f of frags) {
    let row = rows.find((r) => Math.abs(r.y - f.y) <= yTolerance);
    if (!row) { row = { y: f.y, items: [] }; rows.push(row); }
    row.items.push(f);
  }

  rows.sort((a, b) => b.y - a.y); // top of page first (PDF y grows upward)
  return rows.map((r) =>
    r.items.sort((a, b) => a.x - b.x).map((i) => i.str).join(' ').replace(/\s+/g, ' ').trim(),
  ).filter(Boolean);
}

/**
 * Whether a PDF needs a password, without reading its text: 'locked', 'open',
 * or 'broken' when it can't be opened at all.
 */
export async function probePdf(buffer) {
  const lib = await getPdfjs();
  try {
    const doc = await lib.getDocument({
      data: new Uint8Array(buffer),
      isEvalSupported: false,
      useSystemFonts: false,
      disableFontFace: true,
      verbosity: 0,
    }).promise;
    await doc.destroy?.();
    return 'open';
  } catch (err) {
    return err?.name === 'PasswordException' ? 'locked' : 'broken';
  }
}
