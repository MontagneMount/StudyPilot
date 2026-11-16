import { AppError, withRetry } from '../utils/errors.js';
import {
  DEFAULT_COURSE_ID,
  listDocumentsByCourse,
  getChunksForRetrieval,
  listQuizQuestionsByCourse,
  getWeakTopicsByCourse,
} from '../db/index.js';
import { getGeminiClient, getModelName, generateQuizFromChunks } from './gemini.js';
import { generateAndStoreQuiz } from './quiz.js';

/**
 * M5 Function Calling Tool Declarations for the Study Planner Agent.
 */
export const STUDY_PLANNER_TOOLS = [
  {
    type: 'function',
    name: 'getWeakTopics',
    description:
      'Returns the student\'s weak topics in the active course ranked by quiz error rate descending.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    type: 'function',
    name: 'getCourseOutline',
    description:
      'Returns the uploaded course documents, page counts, and key topics/chapters covered in the course.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    type: 'function',
    name: 'createStudyPlan',
    description:
      'Builds a structured day-by-day study schedule based on days until the exam, available hours per day, weak topics, and course outline.',
    parameters: {
      type: 'object',
      properties: {
        days: {
          type: 'integer',
          description: 'Number of days until the exam (e.g. 7).',
        },
        hoursPerDay: {
          type: 'number',
          description: 'Number of study hours available each day (e.g. 2).',
        },
      },
      required: ['days', 'hoursPerDay'],
    },
  },
  {
    type: 'function',
    name: 'generateQuiz',
    description:
      'Generates practice multiple-choice quiz questions for a specific weak or target topic.',
    parameters: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: 'The topic name to generate quiz questions for.',
        },
      },
      required: ['topic'],
    },
  },
];

/**
 * Tool 1: getWeakTopics()
 */
export function executeGetWeakTopics(courseId = DEFAULT_COURSE_ID) {
  const weakTopics = getWeakTopicsByCourse(courseId);
  return {
    courseId,
    weakTopics,
  };
}

/**
 * Tool 2: getCourseOutline()
 */
export function executeGetCourseOutline(courseId = DEFAULT_COURSE_ID) {
  const documents = listDocumentsByCourse(courseId);
  const chunks = getChunksForRetrieval({ courseId });
  const quizQuestions = listQuizQuestionsByCourse(courseId);

  const knownTopics = Array.from(new Set(quizQuestions.map((q) => q.topic)));

  const outline = documents.map((doc) => {
    const docChunks = chunks.filter((c) => c.documentId === doc.id);
    const sampleHeadings = docChunks.slice(0, 5).map((c) => ({
      citation: c.citationLabel || `p.${c.page}`,
      preview: c.content.slice(0, 120),
    }));
    return {
      documentId: doc.id,
      filename: doc.filename,
      type: doc.type,
      pages: doc.pages,
      chunkCount: docChunks.length,
      sampleSections: sampleHeadings,
    };
  });

  return {
    courseId,
    documentCount: documents.length,
    knownTopics,
    outline,
  };
}

/**
 * Tool 3: createStudyPlan(days, hoursPerDay)
 */
export function executeCreateStudyPlan({
  courseId = DEFAULT_COURSE_ID,
  days = 7,
  hoursPerDay = 2,
}) {
  const numDays = Math.max(1, Math.min(60, Math.round(Number(days) || 7)));
  const dailyHours = Math.max(0.5, Math.min(16, Number(hoursPerDay) || 2));

  const weakTopics = getWeakTopicsByCourse(courseId);
  const documents = listDocumentsByCourse(courseId);
  const chunks = getChunksForRetrieval({ courseId });

  // Build ordered priority topics: weak topics (highest error rate first), then document sections
  const priorityPool = [];

  for (const wt of weakTopics) {
    priorityPool.push({
      topic: wt.topic,
      reason: `Weak topic (${wt.errorRate}% error rate across ${wt.totalAttempts} attempt(s))`,
      priority: wt.errorRate >= 50 ? 'High' : 'Medium',
    });
  }

  for (const doc of documents) {
    const docChunks = chunks.filter((c) => c.documentId === doc.id);
    const citations = docChunks.slice(0, 3).map((c) => `[${c.citationLabel || 'p.' + c.page}]`);
    priorityPool.push({
      topic: `${doc.filename} (${citations.join(', ') || 'Core Chapters'})`,
      reason: 'Core course material review',
      priority: priorityPool.length === 0 ? 'High' : 'Normal',
    });
  }

  if (priorityPool.length === 0) {
    priorityPool.push({
      topic: 'General Course Review & Fundamentals',
      reason: 'Foundational preparation',
      priority: 'Normal',
    });
  }

  const schedule = [];
  for (let d = 1; d <= numDays; d++) {
    const isFinalDay = d === numDays && numDays > 1;
    const item = priorityPool[(d - 1) % priorityPool.length];

    if (isFinalDay) {
      schedule.push({
        day: d,
        focusTopic: 'Comprehensive Final Review & Mock Quiz',
        priority: 'High',
        hours: dailyHours,
        reason: 'Final consolidation before exam',
        tasks: [
          `Review summary notes for top weak topics (${ (dailyHours * 0.5).toFixed(1) }h)`,
          `Complete a full timed practice quiz and review explanations (${ (dailyHours * 0.5).toFixed(1) }h)`,
        ],
      });
    } else {
      schedule.push({
        day: d,
        focusTopic: item.topic,
        priority: item.priority,
        hours: dailyHours,
        reason: item.reason,
        tasks: [
          `Study lecture slides/transcripts on "${item.topic}" (${ (dailyHours * 0.6).toFixed(1) }h)`,
          `Solve practice quiz questions and review mistakes (${ (dailyHours * 0.4).toFixed(1) }h)`,
        ],
      });
    }
  }

  return {
    courseId,
    days: numDays,
    hoursPerDay: dailyHours,
    totalHours: Number((numDays * dailyHours).toFixed(1)),
    weakTopicsConsidered: weakTopics.map((w) => ({
      topic: w.topic,
      errorRate: w.errorRate,
    })),
    schedule,
  };
}

/**
 * Tool 4: generateQuiz(topic)
 */
export async function executeGenerateQuizTool({
  courseId = DEFAULT_COURSE_ID,
  topic = 'General',
  generateQuestions = generateQuizFromChunks,
}) {
  const questions = await generateAndStoreQuiz({
    courseId,
    count: 2,
    topicFocus: topic,
    generateQuestions,
  });

  return {
    topic,
    generatedCount: questions.length,
    questions: questions.map((q) => ({
      id: q.id,
      topic: q.topic,
      question: q.question,
      sourcePage: q.sourcePage,
    })),
  };
}

/**
 * Executes a single tool call by name and returns its structured result.
 */
export async function executePlannerToolCall(
  { name, args = {} },
  { courseId = DEFAULT_COURSE_ID, generateQuestions } = {}
) {
  switch (name) {
    case 'getWeakTopics':
      return executeGetWeakTopics(courseId);
    case 'getCourseOutline':
      return executeGetCourseOutline(courseId);
    case 'createStudyPlan':
      return executeCreateStudyPlan({
        courseId,
        days: args.days,
        hoursPerDay: args.hoursPerDay,
      });
    case 'generateQuiz':
      return await executeGenerateQuizTool({
        courseId,
        topic: args.topic,
        generateQuestions,
      });
    default:
      throw new AppError(`Unknown planner tool: ${name}`, 400, 'UNKNOWN_TOOL');
  }
}

/**
 * M5 Agent Loop: Runs the Study Planner Agent with Gemini Function Calling.
 */
export async function runStudyPlannerAgent({
  courseId = DEFAULT_COURSE_ID,
  prompt,
  generateQuestions = generateQuizFromChunks,
  runModelTurn = null,
}) {
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    throw new AppError('Please provide a study planner request (e.g. "I have an exam in 7 days, 2 hours a day").', 400, 'EMPTY_PLAN_PROMPT');
  }

  const systemInstruction =
    'You are StudyPilot Agent, an autonomous AI study planner for university students. ' +
    'When a student asks for a study plan or exam preparation schedule:\n' +
    '1. First call `getWeakTopics` and `getCourseOutline` to inspect their weak points and course materials.\n' +
    '2. Call `createStudyPlan` with the number of days and hoursPerDay requested by the student.\n' +
    '3. If the student asks to also generate a quiz or if there is a critical weak topic they need practice on, you may call `generateQuiz`.\n' +
    '4. Finally, present a clear, encouraging day-by-day study plan tailored to their weak topics.';

  const callModel =
    runModelTurn ||
    (async ({ input, previousInteractionId }) => {
      const ai = getGeminiClient();
      const model = getModelName();
      return withRetry(() =>
        ai.interactions.create({
          model,
          ...(previousInteractionId ? { previous_interaction_id: previousInteractionId } : {}),
          system_instruction: systemInstruction,
          tools: STUDY_PLANNER_TOOLS,
          input,
        })
      );
    });

  const toolCalls = [];
  let createdPlan = null;
  const generatedQuizzes = [];

  let currentInput = prompt.trim();
  let previousInteractionId = null;
  let finalOutputText = '';
  const MAX_TURNS = 6;

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const interaction = await callModel({
        input: currentInput,
        previousInteractionId,
        tools: STUDY_PLANNER_TOOLS,
        systemInstruction,
      });

      previousInteractionId = interaction.id || null;
      const steps = Array.isArray(interaction.steps) ? interaction.steps : [];
      const functionCallSteps = steps.filter((s) => s.type === 'function_call');

      if (functionCallSteps.length === 0) {
        finalOutputText = (interaction.output_text || '').trim();
        break;
      }

      const functionResultInputs = [];

      for (const callStep of functionCallSteps) {
        const toolName = callStep.name;
        const toolArgs = callStep.arguments || {};
        const callId = callStep.id || `call_${turn}_${toolName}`;

        const toolResult = await executePlannerToolCall(
          { name: toolName, args: toolArgs },
          { courseId, generateQuestions }
        );

        if (toolName === 'createStudyPlan') {
          createdPlan = toolResult;
        } else if (toolName === 'generateQuiz') {
          generatedQuizzes.push(toolResult);
        }

        toolCalls.push({
          id: callId,
          name: toolName,
          arguments: toolArgs,
          result: toolResult,
        });

        functionResultInputs.push({
          type: 'function_result',
          name: toolName,
          call_id: callId,
          result: JSON.stringify(toolResult),
        });
      }

      currentInput = functionResultInputs;
    }

    // Fallback if model finished tool calls without a trailing text turn
    if (!finalOutputText && createdPlan) {
      finalOutputText =
        `Here is your personalized ${createdPlan.days}-day study plan (${createdPlan.hoursPerDay} hours/day, ${createdPlan.totalHours} total hours) ` +
        `prioritizing your weak topics.`;
    }

    return {
      courseId,
      reply: finalOutputText || 'Study plan generated.',
      plan: createdPlan,
      toolCalls,
      generatedQuizzes,
    };
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError(
      `Study Planner Agent error: ${error.message || 'Failed to create study plan.'}`,
      502,
      'PLANNER_AGENT_ERROR'
    );
  }
}
