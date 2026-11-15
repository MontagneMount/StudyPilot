import { AppError } from '../utils/errors.js';
import {
  DEFAULT_COURSE_ID,
  getChunksForRetrieval,
  saveQuizQuestions,
  getQuizQuestionById,
  listQuizQuestionsByCourse,
  recordQuizAttempt,
  getWeakTopicsByCourse,
} from '../db/index.js';
import { generateQuizFromChunks } from './gemini.js';

/**
 * Validates and normalizes raw structured output questions from Gemini.
 */
export function normalizeQuizQuestions(rawQuestions) {
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
    throw new AppError('Quiz generator returned no questions.', 502, 'INVALID_QUIZ_OUTPUT');
  }

  return rawQuestions.map((item, idx) => {
    const question = String(item?.question || '').trim();
    const options = Array.isArray(item?.options)
      ? item.options.slice(0, 4).map((o) => String(o).trim())
      : [];
    const answerIndex = Number(item?.answerIndex);
    const explanation = String(item?.explanation || '').trim();
    const topic = String(item?.topic || 'General').trim();
    const sourcePage = Math.max(1, Number.parseInt(item?.sourcePage, 10) || 1);

    if (!question || options.length !== 4 || !Number.isInteger(answerIndex) || answerIndex < 0 || answerIndex > 3) {
      throw new AppError(
        `Generated question #${idx + 1} failed schema validation.`,
        502,
        'INVALID_QUIZ_SCHEMA'
      );
    }

    return {
      question,
      options,
      answerIndex,
      explanation: explanation || 'Refer to the cited source page.',
      topic,
      sourcePage,
    };
  });
}

/**
 * Generates quiz questions for a course or specific document, stores them in SQLite, and returns them.
 */
export async function generateAndStoreQuiz({
  courseId = DEFAULT_COURSE_ID,
  documentId = null,
  count = 3,
  topicFocus = '',
  generateQuestions = generateQuizFromChunks,
}) {
  const chunks = getChunksForRetrieval({ courseId, documentId });
  if (chunks.length === 0) {
    throw new AppError(
      'No indexed course material found. Please upload a PDF before generating a quiz.',
      400,
      'NO_CHUNKS_FOR_QUIZ'
    );
  }

  const clampedCount = Math.max(1, Math.min(10, Number(count) || 3));
  const rawQuestions = await generateQuestions({
    chunks,
    count: clampedCount,
    topicFocus,
  });

  const normalized = normalizeQuizQuestions(rawQuestions);
  return saveQuizQuestions({
    courseId,
    documentId,
    questions: normalized,
  });
}

/**
 * Grades a user's answer for a quiz question, records the attempt, and returns feedback + updated topic stats.
 */
export function gradeQuizAttempt({ questionId, userAnswer }) {
  if (!questionId || typeof questionId !== 'string' || !questionId.trim()) {
    throw new AppError('Missing questionId.', 400, 'MISSING_QUESTION_ID');
  }

  const parsedAnswer = Number(userAnswer);
  if (!Number.isInteger(parsedAnswer) || parsedAnswer < 0 || parsedAnswer > 3) {
    throw new AppError(
      'Invalid userAnswer. Must be an integer option index between 0 and 3.',
      400,
      'INVALID_USER_ANSWER'
    );
  }

  const question = getQuizQuestionById(questionId.trim());
  if (!question) {
    throw new AppError('Quiz question not found.', 404, 'QUESTION_NOT_FOUND');
  }

  const isCorrect = parsedAnswer === question.answerIndex;
  const attempt = recordQuizAttempt({
    questionId: question.id,
    userAnswer: parsedAnswer,
    isCorrect,
  });

  const weakTopics = getWeakTopicsByCourse(question.courseId);

  return {
    attemptId: attempt.id,
    questionId: question.id,
    courseId: question.courseId,
    topic: question.topic,
    userAnswer: parsedAnswer,
    correctAnswerIndex: question.answerIndex,
    isCorrect,
    explanation: question.explanation,
    sourcePage: question.sourcePage,
    weakTopics,
  };
}

export function getCourseQuizData(courseId = DEFAULT_COURSE_ID) {
  return {
    courseId,
    questions: listQuizQuestionsByCourse(courseId),
    weakTopics: getWeakTopicsByCourse(courseId),
  };
}
