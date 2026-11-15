import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import { resetDbForTests } from '../src/db/index.js';
import { normalizeQuizQuestions } from '../src/services/quiz.js';
import { QUIZ_RESPONSE_SCHEMA } from '../src/services/gemini.js';

describe('StudyPilot M3 Unit Tests (Structured Output Schema & Validation)', () => {
  it('defines a valid JSON Schema for structured quiz output', () => {
    assert.equal(QUIZ_RESPONSE_SCHEMA.type, 'object');
    const itemSchema = QUIZ_RESPONSE_SCHEMA.properties.questions.items;
    assert.deepEqual(itemSchema.required, [
      'question',
      'options',
      'answerIndex',
      'explanation',
      'topic',
      'sourcePage',
    ]);
    assert.equal(itemSchema.properties.options.minItems, 4);
    assert.equal(itemSchema.properties.options.maxItems, 4);
  });

  it('normalizes valid structured questions and rejects invalid option counts or answerIndex', () => {
    const valid = normalizeQuizQuestions([
      {
        question: 'What is the time complexity of standard self-attention?',
        options: ['O(n)', 'O(n log n)', 'O(n^2)', 'O(1)'],
        answerIndex: 2,
        explanation: 'Self-attention computes pairwise scores across all n tokens.',
        topic: 'Transformers',
        sourcePage: 12,
      },
    ]);
    assert.equal(valid.length, 1);
    assert.equal(valid[0].answerIndex, 2);
    assert.equal(valid[0].sourcePage, 12);

    assert.throws(
      () =>
        normalizeQuizQuestions([
          {
            question: 'Broken question with only 2 options',
            options: ['Yes', 'No'],
            answerIndex: 0,
            explanation: 'Invalid',
            topic: 'Broken',
            sourcePage: 1,
          },
        ]),
      /failed schema validation/
    );
  });
});

describe('StudyPilot M3 Quiz Generation, Grading & Weak-Point Tracking API', () => {
  let server;
  let baseUrl;

  const mockExtractPages = async () => [
    { page: 2, text: 'Linear regression minimizes mean squared error.' },
    { page: 7, text: 'Backpropagation uses the chain rule to compute gradients.' },
    { page: 14, text: 'Transformers use multi-head self-attention mechanisms.' },
  ];

  const mockEmbedChunks = async (texts) => texts.map(() => [0.5, 0.5, 0.5]);

  const mockGenerateQuestions = async ({ count }) => {
    const samplePool = [
      {
        question: 'Which loss function is standard for linear regression?',
        options: ['Cross-Entropy', 'Mean Squared Error', 'Hinge Loss', 'KL Divergence'],
        answerIndex: 1,
        explanation: 'Linear regression minimizes Mean Squared Error (MSE).',
        topic: 'Linear Regression',
        sourcePage: 2,
      },
      {
        question: 'Which calculus rule powers backpropagation?',
        options: ['Product Rule', 'LHopital Rule', 'Chain Rule', 'Integration by Parts'],
        answerIndex: 2,
        explanation: 'Backpropagation applies the chain rule layer by layer.',
        topic: 'Backpropagation',
        sourcePage: 7,
      },
      {
        question: 'What is the core mechanism inside a Transformer block?',
        options: ['Max Pooling', 'Multi-Head Self-Attention', 'Recurrent Gate', 'Random Forest'],
        answerIndex: 1,
        explanation: 'Transformers rely on multi-head self-attention.',
        topic: 'Transformers',
        sourcePage: 14,
      },
    ];
    return samplePool.slice(0, count);
  };

  const app = createApp({
    dbPath: ':memory:',
    extractPages: mockExtractPages,
    embedChunks: mockEmbedChunks,
    generateQuestions: mockGenerateQuestions,
  });

  beforeEach(() => {
    resetDbForTests();
  });

  it('generates quizzes, records attempts, and ranks weak topics by error rate descending', async () => {
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });

    // 1. Generating quiz before uploading any PDF -> 400 NO_CHUNKS_FOR_QUIZ
    {
      const res = await fetch(`${baseUrl}/api/quiz/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count: 3 }),
      });
      const body = await res.json();
      assert.equal(res.status, 400);
      assert.equal(body.code, 'NO_CHUNKS_FOR_QUIZ');
    }

    // 2. Upload a course PDF
    {
      const form = new FormData();
      form.append(
        'file',
        new Blob(['%PDF-1.7\nCOURSE_CONTENT\n%%EOF'], { type: 'application/pdf' }),
        'DeepLearning_Ch1_3.pdf'
      );
      const uploadRes = await fetch(`${baseUrl}/api/upload`, {
        method: 'POST',
        body: form,
      });
      assert.equal(uploadRes.status, 200);
    }

    // 3. Generate 3 quiz questions via POST /api/quiz/generate
    let questions;
    {
      const res = await fetch(`${baseUrl}/api/quiz/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count: 3 }),
      });
      const body = await res.json();
      assert.equal(res.status, 201);
      assert.equal(body.questions.length, 3);
      questions = body.questions;
    }

    const qLinear = questions.find((q) => q.topic === 'Linear Regression');
    const qBackprop = questions.find((q) => q.topic === 'Backpropagation');
    const qTransformers = questions.find((q) => q.topic === 'Transformers');

    // 4. Submit attempts:
    // - Linear Regression: 1 correct (0% error rate)
    // - Backpropagation: 1 wrong, 1 correct (50% error rate)
    // - Transformers: 2 wrong (100% error rate)
    {
      // Linear Regression -> Correct (answerIndex = 1)
      const r1 = await fetch(`${baseUrl}/api/quiz/attempt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ questionId: qLinear.id, userAnswer: 1 }),
      });
      const b1 = await r1.json();
      assert.equal(r1.status, 200);
      assert.equal(b1.isCorrect, true);

      // Backpropagation -> 1st attempt Wrong (0), 2nd attempt Correct (2)
      await fetch(`${baseUrl}/api/quiz/attempt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ questionId: qBackprop.id, userAnswer: 0 }),
      });
      await fetch(`${baseUrl}/api/quiz/attempt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ questionId: qBackprop.id, userAnswer: 2 }),
      });

      // Transformers -> 2 Wrong attempts (0 and 3, correct is 1)
      await fetch(`${baseUrl}/api/quiz/attempt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ questionId: qTransformers.id, userAnswer: 0 }),
      });
      const rLast = await fetch(`${baseUrl}/api/quiz/attempt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ questionId: qTransformers.id, userAnswer: 3 }),
      });
      const bLast = await rLast.json();
      assert.equal(bLast.isCorrect, false);
      assert.equal(bLast.correctAnswerIndex, 1);
      assert.equal(bLast.sourcePage, 14);
    }

    // 5. Verify GET /api/quiz/weak-topics ranks topics by errorRate descending:
    //    1st: Transformers (100% error rate)
    //    2nd: Backpropagation (50% error rate)
    //    3rd: Linear Regression (0% error rate)
    {
      const res = await fetch(`${baseUrl}/api/quiz/weak-topics`);
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.weakTopics.length, 3);

      assert.equal(body.weakTopics[0].topic, 'Transformers');
      assert.equal(body.weakTopics[0].errorRate, 100);
      assert.equal(body.weakTopics[0].accuracy, 0);

      assert.equal(body.weakTopics[1].topic, 'Backpropagation');
      assert.equal(body.weakTopics[1].errorRate, 50);
      assert.equal(body.weakTopics[1].accuracy, 50);

      assert.equal(body.weakTopics[2].topic, 'Linear Regression');
      assert.equal(body.weakTopics[2].errorRate, 0);
      assert.equal(body.weakTopics[2].accuracy, 100);
    }

    // 6. Validate error handling for out-of-range option index
    {
      const badRes = await fetch(`${baseUrl}/api/quiz/attempt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ questionId: qLinear.id, userAnswer: 9 }),
      });
      const badBody = await badRes.json();
      assert.equal(badRes.status, 400);
      assert.equal(badBody.code, 'INVALID_USER_ANSWER');
    }
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
