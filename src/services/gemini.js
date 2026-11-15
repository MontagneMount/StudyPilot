import { GoogleGenAI } from '@google/genai';
import { AppError, withRetry } from '../utils/errors.js';

const DEFAULT_MODEL = 'gemini-3.8-flash';
const DEFAULT_EMBEDDING_MODEL = 'gemini-embedding-001';

/**
 * JSON Schema for M3 Structured Output Quiz Generation:
 * { questions: [{ question, options[4], answerIndex, explanation, topic, sourcePage }] }
 */
export const QUIZ_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: 'The multiple-choice question text.',
          },
          options: {
            type: 'array',
            items: { type: 'string' },
            minItems: 4,
            maxItems: 4,
            description: 'Exactly 4 answer choices.',
          },
          answerIndex: {
            type: 'integer',
            description: 'Zero-based index (0, 1, 2, or 3) of the correct option.',
          },
          explanation: {
            type: 'string',
            description: 'Explanation of why the correct option is right and others are wrong.',
          },
          topic: {
            type: 'string',
            description: 'Short topic or concept name tested by this question.',
          },
          sourcePage: {
            type: 'integer',
            description: 'Page number in the course document where the concept appears.',
          },
        },
        required: ['question', 'options', 'answerIndex', 'explanation', 'topic', 'sourcePage'],
      },
    },
  },
  required: ['questions'],
};

export function getModelName() {
  return process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL;
}

export function getEmbeddingModelName() {
  return process.env.GEMINI_EMBEDDING_MODEL?.trim() || DEFAULT_EMBEDDING_MODEL;
}

export function getGeminiClient() {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey || apiKey === 'your_gemini_api_key_here') {
    throw new AppError(
      'Missing or invalid GEMINI_API_KEY. Please configure it in your .env file.',
      500,
      'MISSING_API_KEY'
    );
  }
  return new GoogleGenAI({ apiKey });
}

/**
 * Generates embedding vectors for an array of text strings using gemini-embedding-001.
 * Returns Array<number[]>.
 */
export async function embedTexts(texts) {
  if (!Array.isArray(texts) || texts.length === 0) {
    return [];
  }

  const ai = getGeminiClient();
  const model = getEmbeddingModelName();
  const BATCH_SIZE = 50;
  const allEmbeddings = [];

  try {
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      const response = await withRetry(() =>
        ai.models.embedContent({
          model,
          contents: batch,
        })
      );

      const embeddings = response?.embeddings;
      if (!Array.isArray(embeddings) || embeddings.length !== batch.length) {
        throw new AppError(
          'Gemini Embedding API returned an unexpected embedding count.',
          502,
          'GEMINI_EMBEDDING_ERROR'
        );
      }

      for (const item of embeddings) {
        if (!Array.isArray(item?.values) || item.values.length === 0) {
          throw new AppError('Gemini Embedding API returned an empty vector.', 502, 'GEMINI_EMBEDDING_ERROR');
        }
        allEmbeddings.push(item.values);
      }
    }

    return allEmbeddings;
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError(
      `Failed to generate embeddings: ${error.message || 'Unknown Gemini embedding error'}`,
      502,
      'GEMINI_EMBEDDING_ERROR'
    );
  }
}

/**
 * Generates an embedding vector for a single search query.
 */
export async function embedQuery(queryText) {
  const vectors = await embedTexts([queryText]);
  return vectors[0];
}

/**
 * M2 RAG: Sends retrieved top-k chunks and the user's question to Gemini with a strict citation prompt.
 */
export async function askQuestionWithRag({ question, chunks }) {
  const ai = getGeminiClient();
  const model = getModelName();

  const contextBlocks = chunks
    .map(
      (chunk, idx) =>
        `--- Context Chunk #${idx + 1} (Document: "${chunk.filename}", Page: [p.${chunk.page}]) ---\n${chunk.content}`
    )
    .join('\n\n');

  const systemInstruction =
    'You are StudyPilot, an AI teaching assistant for university courses. ' +
    'Answer only from the context; if not found, say so; cite pages like [p.12]. ' +
    'When multiple documents are present, you may also mention the document name alongside the page citation [p.12].';

  const userPrompt = `Course Material Context:\n\n${contextBlocks}\n\nStudent Question: ${question}`;

  try {
    const interaction = await withRetry(() =>
      ai.interactions.create({
        model,
        system_instruction: systemInstruction,
        input: userPrompt,
      })
    );

    const answer = interaction?.output_text?.trim();
    if (!answer) {
      throw new AppError('Gemini returned an empty response.', 502, 'GEMINI_EMPTY_RESPONSE');
    }

    return {
      answer,
      model,
      interactionId: interaction.id || null,
    };
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError(
      `Gemini API error: ${error.message || 'Failed to generate an answer.'}`,
      502,
      'GEMINI_ASK_ERROR'
    );
  }
}

/**
 * M3 Quiz Generation: Uses Gemini Structured Output (JSON Schema) to generate multiple-choice questions
 * from course material chunks.
 */
export async function generateQuizFromChunks({
  chunks,
  count = 3,
  topicFocus = '',
}) {
  const ai = getGeminiClient();
  const model = getModelName();

  const sampledChunks = chunks.slice(0, 12);
  const contextBlocks = sampledChunks
    .map(
      (chunk, idx) =>
        `--- Source #${idx + 1} (Document: "${chunk.filename}", Page: ${chunk.page}) ---\n${chunk.content}`
    )
    .join('\n\n');

  const topicInstruction = topicFocus?.trim()
    ? `Focus the questions on the topic: "${topicFocus.trim()}".`
    : 'Cover key concepts across the provided course material.';

  const prompt =
    `Generate ${count} university-level multiple-choice questions based strictly on the following course material.\n` +
    `${topicInstruction}\n` +
    `Each question must have exactly 4 options, a valid answerIndex (0 to 3), a clear explanation, a concise topic label, and the integer sourcePage where the concept is taught.\n\n` +
    `Course Material:\n${contextBlocks}`;

  try {
    const interaction = await withRetry(() =>
      ai.interactions.create({
        model,
        system_instruction:
          'You are StudyPilot, an AI professor generating rigorous multiple-choice quiz questions from lecture slides.',
        input: prompt,
        response_format: {
          type: 'text',
          mime_type: 'application/json',
          schema: QUIZ_RESPONSE_SCHEMA,
        },
      })
    );

    const rawText = interaction?.output_text?.trim();
    if (!rawText) {
      throw new AppError('Gemini returned an empty quiz response.', 502, 'GEMINI_EMPTY_QUIZ');
    }

    const parsed = JSON.parse(rawText);
    const list = Array.isArray(parsed) ? parsed : parsed?.questions;

    if (!Array.isArray(list) || list.length === 0) {
      throw new AppError('Gemini did not return a valid questions array.', 502, 'GEMINI_INVALID_QUIZ');
    }

    return list;
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError(
      `Failed to generate quiz: ${error.message || 'Unknown Gemini error'}`,
      502,
      'GEMINI_QUIZ_ERROR'
    );
  }
}

/**
 * Legacy M1 helper: Uploads a local PDF file to the Gemini Files API.
 */
export async function uploadPdfToGemini(filePath, mimeType = 'application/pdf') {
  const ai = getGeminiClient();

  try {
    const uploadedFile = await withRetry(() =>
      ai.files.upload({
        file: filePath,
        config: {
          mime_type: mimeType,
        },
      })
    );

    if (!uploadedFile?.uri) {
      throw new AppError('Gemini Files API did not return a valid file URI.', 502, 'GEMINI_UPLOAD_ERROR');
    }

    return {
      uri: uploadedFile.uri,
      name: uploadedFile.name || null,
      mimeType: uploadedFile.mimeType || uploadedFile.mime_type || mimeType,
    };
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError(
      `Failed to upload PDF to Gemini: ${error.message || 'Unknown Gemini error'}`,
      502,
      'GEMINI_UPLOAD_ERROR'
    );
  }
}

/**
 * Legacy M1 helper: Sends a question along with the uploaded PDF reference to Gemini.
 */
export async function askQuestionAboutPdf({ fileRecord, question }) {
  const ai = getGeminiClient();
  const model = getModelName();

  const documentPart = fileRecord.geminiUri
    ? {
        type: 'document',
        uri: fileRecord.geminiUri,
        mime_type: fileRecord.mimeType || 'application/pdf',
      }
    : {
        type: 'document',
        data: fileRecord.inlineBase64,
        mime_type: fileRecord.mimeType || 'application/pdf',
      };

  try {
    const interaction = await withRetry(() =>
      ai.interactions.create({
        model,
        system_instruction:
          'You are StudyPilot, an AI teaching assistant for university courses. ' +
          'Answer the student\'s question accurately and clearly using the provided PDF course material. ' +
          'Whenever possible, cite the page number or slide number like [p.5]. ' +
          'If the information is not present in the document, state clearly that it cannot be found in the uploaded material.',
        input: [
          documentPart,
          {
            type: 'text',
            text: question,
          },
        ],
      })
    );

    const answer = interaction?.output_text?.trim();
    if (!answer) {
      throw new AppError('Gemini returned an empty response.', 502, 'GEMINI_EMPTY_RESPONSE');
    }

    return {
      answer,
      model,
      interactionId: interaction.id || null,
    };
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError(
      `Gemini API error: ${error.message || 'Failed to generate an answer.'}`,
      502,
      'GEMINI_ASK_ERROR'
    );
  }
}
