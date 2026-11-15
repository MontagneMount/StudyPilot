import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { AppError } from '../utils/errors.js';

/**
 * Computes SHA-256 hash of a file so we don't re-embed unchanged PDFs.
 */
export async function computeFileHash(filePath) {
  const buffer = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Extracts text per page from a PDF file using pdfjs-dist.
 * Returns Array<{ page: number, text: string }>.
 */
export async function extractPagesFromPdf(filePath) {
  const buffer = await fs.readFile(filePath);
  const uint8Array = new Uint8Array(buffer);

  try {
    const loadingTask = pdfjsLib.getDocument({
      data: uint8Array,
      useSystemFonts: true,
      disableFontFace: true,
      verbosity: 0,
    });

    const pdfDocument = await loadingTask.promise;
    const numPages = pdfDocument.numPages;
    const pages = [];

    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      const page = await pdfDocument.getPage(pageNum);
      const textContent = await page.getTextContent();
      const pageText = textContent.items
        .map((item) => ('str' in item ? item.str : ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();

      pages.push({
        page: pageNum,
        text: pageText,
      });
    }

    await loadingTask.destroy();
    return pages;
  } catch (err) {
    throw new AppError(
      `Failed to parse PDF pages: ${err?.message || 'Corrupted or unsupported PDF file.'}`,
      400,
      'PDF_PARSE_ERROR'
    );
  }
}

/**
 * Splits extracted pages into overlapping chunks (~500-800 tokens, approximated at ~450 words per chunk
 * with ~80 words overlap). Keeps metadata { page, chunkIndex, content }.
 */
export function chunkPages(
  pages,
  { maxTokens = 600, overlapTokens = 100 } = {}
) {
  // 1 word is roughly 1.3 tokens; convert token targets to word counts
  const wordsPerChunk = Math.max(20, Math.round(maxTokens * 0.75));
  const overlapWords = Math.max(0, Math.min(wordsPerChunk - 5, Math.round(overlapTokens * 0.75)));
  const step = Math.max(1, wordsPerChunk - overlapWords);

  const chunks = [];
  let globalChunkIndex = 0;

  for (const { page, text } of pages) {
    const cleaned = (text || '').replace(/\s+/g, ' ').trim();
    if (!cleaned) {
      continue;
    }

    const words = cleaned.split(' ');
    if (words.length <= wordsPerChunk) {
      chunks.push({
        page,
        chunkIndex: globalChunkIndex++,
        content: cleaned,
      });
      continue;
    }

    for (let start = 0; start < words.length; start += step) {
      const slice = words.slice(start, start + wordsPerChunk);
      if (slice.length === 0) break;

      chunks.push({
        page,
        chunkIndex: globalChunkIndex++,
        content: slice.join(' '),
      });

      if (start + wordsPerChunk >= words.length) {
        break;
      }
    }
  }

  return chunks;
}
