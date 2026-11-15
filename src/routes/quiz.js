import express from 'express';
import { DEFAULT_COURSE_ID } from '../db/index.js';
import {
  generateAndStoreQuiz,
  gradeQuizAttempt,
  getCourseQuizData,
} from '../services/quiz.js';

export function createQuizRouter({ generateQuestions } = {}) {
  const router = express.Router();

  // Get existing quiz questions and weak-topic rankings for a course
  router.get('/quiz', (req, res) => {
    const courseId = (req.query.courseId || DEFAULT_COURSE_ID).toString().trim();
    const data = getCourseQuizData(courseId);
    res.status(200).json(data);
  });

  // Get weak topics ranked by error rate for a course
  router.get('/quiz/weak-topics', (req, res) => {
    const courseId = (req.query.courseId || DEFAULT_COURSE_ID).toString().trim();
    const { weakTopics } = getCourseQuizData(courseId);
    res.status(200).json({ courseId, weakTopics });
  });

  // Generate new multiple-choice questions using Gemini Structured Output
  router.post('/quiz/generate', async (req, res, next) => {
    try {
      const {
        courseId = DEFAULT_COURSE_ID,
        documentId = null,
        count = 3,
        topic = '',
      } = req.body || {};

      const targetCourseId = (courseId || DEFAULT_COURSE_ID).toString().trim();
      const targetDocId = documentId ? documentId.toString().trim() : null;

      const questions = await generateAndStoreQuiz({
        courseId: targetCourseId,
        documentId: targetDocId,
        count,
        topicFocus: topic,
        generateQuestions,
      });

      res.status(201).json({
        courseId: targetCourseId,
        documentId: targetDocId,
        questions,
      });
    } catch (error) {
      next(error);
    }
  });

  // Submit an answer for a quiz question and get grading + updated weak topics
  router.post('/quiz/attempt', (req, res, next) => {
    try {
      const { questionId, userAnswer } = req.body || {};
      const result = gradeQuizAttempt({ questionId, userAnswer });
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
