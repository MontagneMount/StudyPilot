import express from 'express';
import { DEFAULT_COURSE_ID } from '../db/index.js';
import { runStudyPlannerAgent } from '../services/planner.js';

export function createPlanRouter({
  generateQuestions,
  runModelTurn,
} = {}) {
  const router = express.Router();

  router.post('/plan', async (req, res, next) => {
    try {
      const { courseId = DEFAULT_COURSE_ID, prompt } = req.body || {};
      const targetCourseId = (courseId || DEFAULT_COURSE_ID).toString().trim();

      const result = await runStudyPlannerAgent({
        courseId: targetCourseId,
        prompt,
        generateQuestions,
        runModelTurn,
      });

      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
