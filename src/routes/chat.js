import express from 'express';
import { AppError } from '../utils/errors.js';
import {
  DEFAULT_COURSE_ID,
  getDocumentById,
  listDocumentsByCourse,
} from '../db/index.js';
import { retrieveTopChunks } from '../services/retrieval.js';
import { embedQuery, askQuestionWithRag } from '../services/gemini.js';

export function createChatRouter({
  embedSearchQuery = embedQuery,
  askRag = askQuestionWithRag,
} = {}) {
  const router = express.Router();

  router.post('/ask', async (req, res, next) => {
    try {
      const {
        fileId,
        documentId,
        courseId = DEFAULT_COURSE_ID,
        question,
        topK = 4,
      } = req.body || {};

      if (!question || typeof question !== 'string' || !question.trim()) {
        throw new AppError('Question cannot be empty.', 400, 'EMPTY_QUESTION');
      }

      const targetDocId = (documentId || fileId || '').toString().trim() || null;
      const targetCourseId = (courseId || DEFAULT_COURSE_ID).toString().trim();

      // Require either a specific documentId/fileId OR course scope with at least one document
      if (targetDocId) {
        const doc = getDocumentById(targetDocId);
        if (!doc) {
          throw new AppError(
            'Uploaded PDF was not found. Please upload the PDF again.',
            404,
            'FILE_NOT_FOUND'
          );
        }
      } else {
        const courseDocs = listDocumentsByCourse(targetCourseId);
        if (courseDocs.length === 0) {
          throw new AppError(
            'No documents found in this course. Please upload at least one PDF before asking a question.',
            400,
            'NO_DOCUMENTS_IN_COURSE'
          );
        }
      }

      const queryEmbedding = await embedSearchQuery(question.trim());
      const k = Math.max(1, Math.min(10, Number(topK) || 4));

      const topChunks = retrieveTopChunks({
        courseId: targetCourseId,
        documentId: targetDocId,
        queryEmbedding,
        topK: k,
      });

      if (topChunks.length === 0) {
        throw new AppError(
          'No indexed chunks found for retrieval.',
          404,
          'NO_CHUNKS_FOUND'
        );
      }

      const ragResult = await askRag({
        question: question.trim(),
        chunks: topChunks,
      });

      const citations = topChunks.map((chunk) => ({
        chunkId: chunk.id,
        documentId: chunk.documentId,
        filename: chunk.filename,
        page: chunk.page,
        chunkIndex: chunk.chunkIndex,
        content: chunk.content,
        score: Number(chunk.score.toFixed(4)),
      }));

      res.status(200).json({
        courseId: targetCourseId,
        documentId: targetDocId,
        fileId: targetDocId,
        answer: ragResult.answer,
        model: ragResult.model,
        citations,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
