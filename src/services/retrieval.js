import { getChunksForRetrieval } from '../db/index.js';

const STOP_WORDS = new Set([
  'the', 'is', 'at', 'which', 'on', 'in', 'a', 'an', 'and', 'or', 'of', 'to', 'for',
  'with', 'by', 'from', 'what', 'how', 'why', 'when', 'where', 'does', 'do', 'are', 'be',
]);

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

function tokenizeKeywords(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token));
}

/**
 * M6 Hybrid Search: Computes normalized lexical / BM25-style keyword overlap score in [0, 1]
 * between a query string and a chunk's content.
 */
export function lexicalSimilarity(queryText, chunkContent) {
  if (!queryText || !chunkContent) return 0;
  const queryTokens = tokenizeKeywords(queryText);
  if (queryTokens.length === 0) return 0;

  const contentLower = chunkContent.toLowerCase();
  const contentTokenSet = new Set(tokenizeKeywords(chunkContent));

  let matchedCount = 0;
  for (const qToken of queryTokens) {
    if (contentTokenSet.has(qToken) || contentLower.includes(qToken)) {
      matchedCount += 1;
    }
  }

  return matchedCount / queryTokens.length;
}

/**
 * Searches stored chunks in the course (or specific document) and returns top-k most similar chunks.
 * Supports both pure vector search (`mode: 'vector'`) and hybrid vector + lexical search (`mode: 'hybrid'`).
 */
export function retrieveTopChunks({
  courseId,
  documentId = null,
  queryEmbedding,
  queryText = '',
  topK = 4,
  mode = 'hybrid',
  alpha = 0.7,
}) {
  const candidates = getChunksForRetrieval({ courseId, documentId });
  if (candidates.length === 0) {
    return [];
  }

  const useHybrid = mode === 'hybrid' && Boolean(queryText?.trim());

  const scored = candidates.map((chunk) => {
    const vecScore = cosineSimilarity(queryEmbedding, chunk.embedding);
    const lexScore = useHybrid ? lexicalSimilarity(queryText, chunk.content) : 0;
    const combinedScore = useHybrid ? alpha * vecScore + (1 - alpha) * lexScore : vecScore;

    return {
      id: chunk.id,
      documentId: chunk.documentId,
      filename: chunk.filename,
      docType: chunk.docType || 'pdf',
      page: chunk.page,
      chunkIndex: chunk.chunkIndex,
      citationLabel: chunk.citationLabel || `p.${chunk.page}`,
      content: chunk.content,
      vectorScore: vecScore,
      lexicalScore: lexScore,
      score: combinedScore,
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}
