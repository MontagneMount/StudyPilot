import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { AppError } from '../utils/errors.js';

export const IMAGE_HEAVY_WORD_THRESHOLD = 30;

/**
 * Computes SHA-256 hash of a file so we don't re-embed unchanged files.
 */
export async function computeFileHash(filePath) {
  const buffer = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Extracts text per page from a PDF file using pdfjs-dist.
 * Also flags pages with sparse selectable text (< 30 words) as `isImageHeavy: true`
 * so M4 multimodal vision can inspect charts/diagrams on those slides.
 * Returns Array<{ page: number, text: string, wordCount: number, isImageHeavy: boolean }>.
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

      const wordCount = pageText ? pageText.split(' ').length : 0;

      pages.push({
        page: pageNum,
        text: pageText,
        wordCount,
        isImageHeavy: wordCount < IMAGE_HEAVY_WORD_THRESHOLD,
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
 * M4 Multimodal: When a PDF has image-heavy pages (charts, diagrams, sparse text),
 * calls Gemini Vision to extract visual descriptions for those pages and merges them into page text.
 */
export async function enrichImageHeavyPages(
  filePath,
  pages,
  { describeVisualPages } = {}
) {
  if (typeof describeVisualPages !== 'function') {
    return pages;
  }

  const imageHeavyPages = pages
    .filter((p) => {
      const wc =
        typeof p.wordCount === 'number'
          ? p.wordCount
          : p.text
          ? p.text.trim().split(/\s+/).length
          : 0;
      return p.isImageHeavy === true || wc < IMAGE_HEAVY_WORD_THRESHOLD;
    })
    .map((p) => p.page);

  if (imageHeavyPages.length === 0) {
    return pages;
  }

  try {
    const visualDescriptions = await describeVisualPages(filePath, imageHeavyPages);
    if (!Array.isArray(visualDescriptions) || visualDescriptions.length === 0) {
      return pages;
    }

    const descByPage = new Map();
    for (const item of visualDescriptions) {
      if (item?.page && item?.visualDescription) {
        descByPage.set(Number(item.page), String(item.visualDescription).trim());
      }
    }

    return pages.map((p) => {
      const visualText = descByPage.get(Number(p.page));
      if (!visualText) return p;

      const combinedText = p.text
        ? `${p.text}\n[Slide Visual / Chart Analysis]: ${visualText}`
        : `[Slide Visual / Chart Analysis]: ${visualText}`;

      return {
        ...p,
        text: combinedText,
        visualEnriched: true,
      };
    });
  } catch {
    // Gracefully fall back to extracted text if vision enrichment fails
    return pages;
  }
}

/**
 * Splits extracted pages into overlapping chunks (~500-800 tokens, approximated at ~450 words per chunk
 * with ~80 words overlap). Keeps metadata { page, chunkIndex, citationLabel, content }.
 */
export function chunkPages(
  pages,
  { maxTokens = 600, overlapTokens = 100 } = {}
) {
  const wordsPerChunk = Math.max(20, Math.round(maxTokens * 0.75));
  const overlapWords = Math.max(0, Math.min(wordsPerChunk - 5, Math.round(overlapTokens * 0.75)));
  const step = Math.max(1, wordsPerChunk - overlapWords);

  const chunks = [];
  let globalChunkIndex = 0;

  for (const { page, text, citationLabel } of pages) {
    const cleaned = (text || '').replace(/\s+/g, ' ').trim();
    if (!cleaned) {
      continue;
    }

    const label = citationLabel || `p.${page}`;
    const words = cleaned.split(' ');
    if (words.length <= wordsPerChunk) {
      chunks.push({
        page,
        chunkIndex: globalChunkIndex++,
        citationLabel: label,
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
        citationLabel: label,
        content: slice.join(' '),
      });

      if (start + wordsPerChunk >= words.length) {
        break;
      }
    }
  }

  return chunks;
}

/**
 * M4 Audio Transcript Chunking: Converts timestamped segments [{ timestamp: "01:20", text: "..." }]
 * into indexed chunks where citations use the timestamp label (e.g. "01:20").
 */
export function chunkAudioTranscript(segments = []) {
  const chunks = [];
  let chunkIndex = 0;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const text = String(seg?.text || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;

    const rawTs = String(seg?.timestamp || '00:00').trim().replace(/^\[|\]$/g, '');
    const normalizedTs = /^\d{1,2}:\d{2}(:\d{2})?$/.test(rawTs) ? rawTs : `00:${String(i * 30).padStart(2, '0')}`;

    chunks.push({
      page: chunkIndex + 1,
      chunkIndex,
      citationLabel: normalizedTs,
      content: `[Audio Timestamp ${normalizedTs}] ${text}`,
    });
    chunkIndex += 1;
  }

  return chunks;
}
