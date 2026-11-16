import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import { resetDbForTests } from '../src/db/index.js';
import {
  STUDY_PLANNER_TOOLS,
  executeCreateStudyPlan,
} from '../src/services/planner.js';

describe('StudyPilot M5 Unit Tests (Study Planner Tools & Declarations)', () => {
  beforeEach(() => {
    resetDbForTests();
  });

  it('declares all 4 required function calling tools: getWeakTopics, getCourseOutline, createStudyPlan, generateQuiz', () => {
    const names = STUDY_PLANNER_TOOLS.map((t) => t.name);
    assert.deepEqual(names, [
      'getWeakTopics',
      'getCourseOutline',
      'createStudyPlan',
      'generateQuiz',
    ]);
    for (const tool of STUDY_PLANNER_TOOLS) {
      assert.equal(tool.type, 'function');
    }
  });

  it('creates a day-by-day study plan matching requested days and hoursPerDay', () => {
    const plan = executeCreateStudyPlan({
      days: 7,
      hoursPerDay: 2,
    });
    assert.equal(plan.days, 7);
    assert.equal(plan.hoursPerDay, 2);
    assert.equal(plan.totalHours, 14);
    assert.equal(plan.schedule.length, 7);
    assert.equal(plan.schedule[0].day, 1);
    assert.equal(plan.schedule[6].day, 7);
    assert.match(plan.schedule[6].focusTopic, /Final Review/i);
  });
});

describe('StudyPilot M5 Agent Integration Tests (Multi-Turn Function Calling Study Planner)', () => {
  let server;
  let baseUrl;
  let modelTurns = [];

  const mockExtractPages = async () => [
    { page: 1, text: 'Backpropagation computes gradients via the chain rule.' },
    { page: 10, text: 'Transformers use multi-head self-attention and positional encoding.' },
  ];

  const mockEmbedChunks = async (texts) => texts.map(() => [0.5, 0.5, 0.5]);

  const mockGenerateQuestions = async ({ count = 2, topicFocus = '' }) => [
    {
      question: `Practice question on ${topicFocus || 'Transformers'}?`,
      options: ['Option A', 'Option B', 'Option C', 'Option D'],
      answerIndex: 1,
      explanation: 'Option B is correct according to Lecture 2.',
      topic: topicFocus || 'Transformers',
      sourcePage: 10,
    },
    {
      question: 'Which rule is used in Backpropagation?',
      options: ['Chain Rule', 'Product Rule', 'Quotient Rule', 'Power Rule'],
      answerIndex: 0,
      explanation: 'Chain rule computes layer-wise gradients.',
      topic: 'Backpropagation',
      sourcePage: 1,
    },
  ].slice(0, count);

  // Simulates a realistic 3-turn Gemini Function Calling trajectory:
  // Turn 0: Model inspects weak topics and course outline -> calls getWeakTopics() & getCourseOutline()
  // Turn 1: Model receives tool results -> calls createStudyPlan(days=7, hoursPerDay=2) & generateQuiz(topic="Transformers")
  // Turn 2: Model receives plan & quiz results -> outputs final day-by-day summary
  const mockRunPlannerModelTurn = async ({ input, previousInteractionId }) => {
    modelTurns.push({ input, previousInteractionId });
    const turnIndex = modelTurns.length - 1;

    if (turnIndex === 0) {
      return {
        id: 'interaction-turn-1',
        steps: [
          {
            type: 'function_call',
            id: 'call_weak_1',
            name: 'getWeakTopics',
            arguments: {},
          },
          {
            type: 'function_call',
            id: 'call_outline_1',
            name: 'getCourseOutline',
            arguments: {},
          },
        ],
      };
    }

    if (turnIndex === 1) {
      return {
        id: 'interaction-turn-2',
        steps: [
          {
            type: 'function_call',
            id: 'call_plan_1',
            name: 'createStudyPlan',
            arguments: { days: 7, hoursPerDay: 2 },
          },
          {
            type: 'function_call',
            id: 'call_quiz_1',
            name: 'generateQuiz',
            arguments: { topic: 'Transformers' },
          },
        ],
      };
    }

    return {
      id: 'interaction-turn-3',
      steps: [],
      output_text:
        'Based on your weak topic in Transformers (100% error rate), here is your 7-day study plan at 2 hours per day.',
    };
  };

  const app = createApp({
    dbPath: ':memory:',
    extractPages: mockExtractPages,
    embedChunks: mockEmbedChunks,
    generateQuestions: mockGenerateQuestions,
    runPlannerModelTurn: mockRunPlannerModelTurn,
  });

  beforeEach(() => {
    resetDbForTests();
    modelTurns = [];
  });

  it('orchestrates getWeakTopics, getCourseOutline, createStudyPlan, and generateQuiz for "I have an exam in 7 days, 2 hours a day"', async () => {
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });

    // 1. Upload course material
    {
      const form = new FormData();
      form.append(
        'file',
        new Blob(['%PDF-1.7\nDL_SLIDES\n%%EOF'], { type: 'application/pdf' }),
        'NeuralNetworks_Slides.pdf'
      );
      const res = await fetch(`${baseUrl}/api/upload`, { method: 'POST', body: form });
      assert.equal(res.status, 200);
    }

    // 2. Generate initial quiz and record a wrong attempt on "Transformers" so it becomes the #1 weak topic
    {
      const genRes = await fetch(`${baseUrl}/api/quiz/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count: 2 }),
      });
      const genBody = await genRes.json();
      const transformersQ = genBody.questions.find((q) => q.topic === 'Transformers');

      await fetch(`${baseUrl}/api/quiz/attempt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          questionId: transformersQ.id,
          userAnswer: 0, // wrong answer (correct is 1)
        }),
      });
    }

    // 3. Call POST /api/plan with "I have an exam in 7 days, 2 hours a day"
    {
      const res = await fetch(`${baseUrl}/api/plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: 'I have an exam in 7 days, 2 hours a day',
        }),
      });
      const body = await res.json();
      assert.equal(res.status, 200);

      // Verify all 4 tools were invoked across the agent turns
      assert.equal(body.toolCalls.length, 4);
      assert.deepEqual(
        body.toolCalls.map((tc) => tc.name),
        ['getWeakTopics', 'getCourseOutline', 'createStudyPlan', 'generateQuiz']
      );

      // Verify function_result payloads were sent back to the model with matching call_id
      assert.equal(modelTurns.length, 3);
      assert.equal(modelTurns[1].previousInteractionId, 'interaction-turn-1');
      assert.equal(modelTurns[1].input[0].type, 'function_result');
      assert.equal(modelTurns[1].input[0].call_id, 'call_weak_1');

      // Verify the 7-day plan prioritizes "Transformers" on Day 1
      assert.ok(body.plan);
      assert.equal(body.plan.days, 7);
      assert.equal(body.plan.hoursPerDay, 2);
      assert.equal(body.plan.totalHours, 14);
      assert.equal(body.plan.schedule.length, 7);
      assert.equal(body.plan.schedule[0].day, 1);
      assert.equal(body.plan.schedule[0].focusTopic, 'Transformers');
      assert.equal(body.plan.schedule[0].priority, 'High');

      // Verify targeted practice quiz was generated
      assert.equal(body.generatedQuizzes.length, 1);
      assert.equal(body.generatedQuizzes[0].topic, 'Transformers');
      assert.match(body.reply, /7-day study plan/i);
    }
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
