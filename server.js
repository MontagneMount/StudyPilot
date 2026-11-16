import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDb } from './src/db/index.js';
import { createDocumentsRouter } from './src/routes/documents.js';
import { createChatRouter } from './src/routes/chat.js';
import { createQuizRouter } from './src/routes/quiz.js';
import { createPlanRouter } from './src/routes/plan.js';
import { AppError } from './src/utils/errors.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createApp({
  dbPath,
  extractPages,
  embedChunks,
  embedSearchQuery,
  askRag,
  generateQuestions,
  transcribeAudio,
  describeVisualPages,
  describeImage,
  runPlannerModelTurn,
} = {}) {
  initDb(dbPath);

  const app = express();

  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(path.join(__dirname, 'public')));

  app.use(
    '/api',
    createDocumentsRouter({
      extractPages,
      embedChunks,
      transcribeAudio,
      describeVisualPages,
      describeImage,
    })
  );
  app.use('/api', createChatRouter({ embedSearchQuery, askRag }));
  app.use('/api', createQuizRouter({ generateQuestions }));
  app.use('/api', createPlanRouter({ generateQuestions, runModelTurn: runPlannerModelTurn }));

  // 404 handler for unknown /api routes
  app.use('/api/*', (req, res, next) => {
    next(new AppError(`API route not found: ${req.method} ${req.originalUrl}`, 404, 'NOT_FOUND'));
  });

  // Centralized error handler
  app.use((err, req, res, _next) => {
    const statusCode = err instanceof AppError ? err.statusCode : 500;
    const code = err instanceof AppError ? err.code : 'INTERNAL_ERROR';
    const message =
      err instanceof AppError ? err.message : err?.message || 'An unexpected server error occurred.';

    if (statusCode >= 500 && process.env.NODE_ENV !== 'test') {
      console.error(`[Error ${code}]`, err);
    }

    res.status(statusCode).json({
      error: message,
      code,
    });
  });

  return app;
}

// Start server only when executed directly
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const port = Number(process.env.PORT) || 3000;
  const app = createApp();
  app.listen(port, () => {
    console.log(`StudyPilot M5 server running at http://localhost:${port}`);
  });
}
