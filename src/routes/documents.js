import express from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../utils/errors.js';
import { computeFileHash, extractPagesFromPdf, chunkPages } from '../services/ingest.js';
import { embedTexts } from '../services/gemini.js';
import {
  DEFAULT_COURSE_ID,
  listCourses,
  createCourse,
  getCourseById,
  findDocumentByHash,
  saveDocumentWithChunks,
  listDocumentsByCourse,
  getChunksForRetrieval,
} from '../db/index.js';

const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB
const UPLOADS_DIR = path.resolve('uploads');

const upload = multer({
  dest: UPLOADS_DIR,
  limits: {
    fileSize: MAX_FILE_SIZE_BYTES,
  },
});

/**
 * Checks whether the file starts with the "%PDF-" magic header.
 */
async function hasPdfMagicHeader(filePath) {
  let fileHandle;
  try {
    fileHandle = await fs.open(filePath, 'r');
    const buffer = Buffer.alloc(5);
    const { bytesRead } = await fileHandle.read(buffer, 0, 5, 0);
    if (bytesRead < 5) return false;
    return buffer.toString('ascii') === '%PDF-';
  } catch {
    return false;
  } finally {
    await fileHandle?.close();
  }
}

async function safeUnlink(filePath) {
  if (!filePath) return;
  try {
    await fs.unlink(filePath);
  } catch {
    // Ignore cleanup errors if file was already removed
  }
}

export function createDocumentsRouter({
  extractPages = extractPagesFromPdf,
  embedChunks = embedTexts,
} = {}) {
  const router = express.Router();

  // List all courses
  router.get('/courses', (req, res) => {
    const courses = listCourses();
    res.status(200).json({ courses });
  });

  // Create a new course
  router.post('/courses', (req, res, next) => {
    try {
      const { name } = req.body || {};
      if (!name || typeof name !== 'string' || !name.trim()) {
        throw new AppError('Course name is required.', 400, 'INVALID_COURSE_NAME');
      }
      const course = createCourse(name);
      res.status(201).json({ course });
    } catch (err) {
      next(err);
    }
  });

  // List documents in a course
  router.get('/documents', (req, res) => {
    const courseId = (req.query.courseId || DEFAULT_COURSE_ID).toString().trim();
    const documents = listDocumentsByCourse(courseId);
    res.status(200).json({ courseId, documents });
  });

  // Upload and ingest a PDF into chunks + embeddings
  router.post(
    '/upload',
    (req, res, next) => {
      upload.single('file')(req, res, (err) => {
        if (!err) return next();
        if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
          return next(
            new AppError('File is too large. Maximum allowed size is 20MB.', 413, 'FILE_TOO_LARGE')
          );
        }
        return next(new AppError(`Upload error: ${err.message}`, 400, 'UPLOAD_ERROR'));
      });
    },
    async (req, res, next) => {
      const tempPath = req.file?.path;
      try {
        if (!req.file) {
          throw new AppError('No file uploaded. Please select a PDF file.', 400, 'NO_FILE');
        }

        const originalName = req.file.originalname || 'document.pdf';
        const isPdfExt = originalName.toLowerCase().endsWith('.pdf');
        const isPdfMime = req.file.mimetype === 'application/pdf';
        const isPdfHeader = await hasPdfMagicHeader(tempPath);

        if (!isPdfExt || !isPdfMime || !isPdfHeader) {
          throw new AppError(
            'Invalid file type. Only valid PDF (.pdf) files are allowed.',
            400,
            'INVALID_FILE_TYPE'
          );
        }

        const courseId = (req.body?.courseId || DEFAULT_COURSE_ID).toString().trim();
        const course = getCourseById(courseId);
        if (!course) {
          throw new AppError(`Course not found: ${courseId}`, 404, 'COURSE_NOT_FOUND');
        }

        // Check file hash to avoid re-embedding unchanged files
        const fileHash = await computeFileHash(tempPath);
        const existingDoc = findDocumentByHash(courseId, fileHash);
        if (existingDoc) {
          const existingChunks = getChunksForRetrieval({ documentId: existingDoc.id });
          return res.status(200).json({
            fileId: existingDoc.id,
            documentId: existingDoc.id,
            courseId: existingDoc.course_id,
            filename: existingDoc.filename,
            size: req.file.size,
            pages: existingDoc.pages,
            chunkCount: existingChunks.length,
            cached: true,
          });
        }

        const pages = await extractPages(tempPath);
        const rawChunks = chunkPages(pages);

        if (rawChunks.length === 0) {
          throw new AppError(
            'No extractable text found in this PDF. It may be an image-only scan.',
            400,
            'EMPTY_PDF_TEXT'
          );
        }

        const embeddings = await embedChunks(rawChunks.map((c) => c.content));
        const chunksWithVectors = rawChunks.map((chunk, idx) => ({
          ...chunk,
          embedding: embeddings[idx],
        }));

        const saved = saveDocumentWithChunks({
          courseId,
          filename: originalName,
          fileHash,
          type: 'pdf',
          pages: pages.length,
          chunks: chunksWithVectors,
        });

        res.status(200).json({
          fileId: saved.id,
          documentId: saved.id,
          courseId: saved.course_id,
          filename: saved.filename,
          size: req.file.size,
          pages: saved.pages,
          chunkCount: saved.chunkCount,
          cached: false,
        });
      } catch (error) {
        next(error);
      } finally {
        await safeUnlink(tempPath);
      }
    }
  );

  return router;
}
