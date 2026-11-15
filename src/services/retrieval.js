import { getChunksForRetrieval } from '../db/index.js';

/**
 * Computes cosine similarity between two numeric vectors.
 */
export function cosineSimilarity(vecA, vecB) {
  if (!Array.isArray(vecA) || !Array.isArray(vecB) || vecA.length === 0 || vecA.length !== vecB.length) {
    return 0;
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < vecA.length; i++) {
    const a = vecA[i];
    const b = vecB[i];
    dotProduct += a * b;
    normA += a * a;
    normB += b * b;
  }

  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Searches stored chunks in the course (or specific document) and returns top-k most similar chunks.
 */
export function retrieveTopChunks({
  courseId,
  documentId = null,
  queryEmbedding,
  topK = 4,
}) {
  const candidates = getChunksForRetrieval({ courseId, documentId });
  if (candidates.length === 0) {
    return [];
  }

  const scored = candidates.map((chunk) => ({
    id: chunk.id,
    documentId: chunk.documentId,
    filename: chunk.filename,
    page: chunk.page,
    chunkIndex: chunk.chunkIndex,
    content: chunk.content,
    score: cosineSimilarity(queryEmbedding, chunk.embedding),
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}
