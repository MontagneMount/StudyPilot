import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_COURSE_ID = 'default-course';
export const DEFAULT_COURSE_NAME = 'Default Course';

let dbInstance = null;

/**
 * Initializes and returns the SQLite database instance.
 * Pass ":memory:" in tests or set process.env.DB_PATH to customize storage.
 */
export function initDb(customPath) {
  const dbPath = customPath || process.env.DB_PATH || path.resolve('data', 'studypilot.sqlite');

  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');

  db.exec(`
    CREATE TABLE IF NOT EXISTS courses (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      course_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      file_hash TEXT,
      type TEXT NOT NULL DEFAULT 'pdf',
      pages INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      page INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      citation_label TEXT,
      content TEXT NOT NULL,
      embedding TEXT NOT NULL,
      FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS quiz_questions (
      id TEXT PRIMARY KEY,
      course_id TEXT NOT NULL,
      document_id TEXT,
      topic TEXT NOT NULL,
      question TEXT NOT NULL,
      options TEXT NOT NULL,
      answer_index INTEGER NOT NULL,
      explanation TEXT NOT NULL,
      source_page INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS quiz_attempts (
      id TEXT PRIMARY KEY,
      question_id TEXT NOT NULL,
      user_answer INTEGER NOT NULL,
      is_correct INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (question_id) REFERENCES quiz_questions(id) ON DELETE CASCADE
    );
  `);

  // Backward-compatible migration if chunks table was created in M2 without citation_label
  try {
    db.exec('ALTER TABLE chunks ADD COLUMN citation_label TEXT;');
  } catch {
    // Column already exists
  }

  // Ensure default course exists
  const existingDefault = db
    .prepare('SELECT id FROM courses WHERE id = ?')
    .get(DEFAULT_COURSE_ID);
  if (!existingDefault) {
    db.prepare('INSERT INTO courses (id, name, created_at) VALUES (?, ?, ?)').run(
      DEFAULT_COURSE_ID,
      DEFAULT_COURSE_NAME,
      new Date().toISOString()
    );
  }

  dbInstance = db;
  return db;
}

export function getDb() {
  if (!dbInstance) {
    return initDb();
  }
  return dbInstance;
}

export function resetDbForTests() {
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch {
      // Ignore close errors
    }
  }
  return initDb(':memory:');
}

export function listCourses() {
  const db = getDb();
  return db.prepare('SELECT id, name, created_at FROM courses ORDER BY created_at ASC').all();
}

export function createCourse(name) {
  const db = getDb();
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  db.prepare('INSERT INTO courses (id, name, created_at) VALUES (?, ?, ?)').run(
    id,
    name.trim(),
    createdAt
  );
  return { id, name: name.trim(), created_at: createdAt };
}

export function getCourseById(courseId) {
  const db = getDb();
  return db.prepare('SELECT id, name, created_at FROM courses WHERE id = ?').get(courseId) || null;
}

export function findDocumentByHash(courseId, fileHash) {
  if (!fileHash) return null;
  const db = getDb();
  return (
    db
      .prepare(
        'SELECT id, course_id, filename, file_hash, type, pages, created_at FROM documents WHERE course_id = ? AND file_hash = ?'
      )
      .get(courseId, fileHash) || null
  );
}

export function saveDocumentWithChunks({
  courseId = DEFAULT_COURSE_ID,
  filename,
  fileHash = null,
  type = 'pdf',
  pages = 1,
  chunks = [],
}) {
  const db = getDb();
  const documentId = crypto.randomUUID();
  const createdAt = new Date().toISOString();

  db.exec('BEGIN');
  try {
    db.prepare(
      `INSERT INTO documents (id, course_id, filename, file_hash, type, pages, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(documentId, courseId, filename, fileHash, type, pages, createdAt);

    const insertChunk = db.prepare(
      `INSERT INTO chunks (id, document_id, page, chunk_index, citation_label, content, embedding)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );

    for (const chunk of chunks) {
      const label = chunk.citationLabel || `p.${chunk.page}`;
      insertChunk.run(
        crypto.randomUUID(),
        documentId,
        chunk.page,
        chunk.chunkIndex,
        label,
        chunk.content,
        JSON.stringify(chunk.embedding)
      );
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return {
    id: documentId,
    course_id: courseId,
    filename,
    file_hash: fileHash,
    type,
    pages,
    chunkCount: chunks.length,
    created_at: createdAt,
  };
}

export function getDocumentById(documentId) {
  const db = getDb();
  return (
    db
      .prepare(
        'SELECT id, course_id, filename, file_hash, type, pages, created_at FROM documents WHERE id = ?'
      )
      .get(documentId) || null
  );
}

export function listDocumentsByCourse(courseId = DEFAULT_COURSE_ID) {
  const db = getDb();
  return db
    .prepare(
      `SELECT d.id, d.course_id, d.filename, d.type, d.pages, d.created_at,
              COUNT(c.id) AS chunk_count
       FROM documents d
       LEFT JOIN chunks c ON c.document_id = d.id
       WHERE d.course_id = ?
       GROUP BY d.id
       ORDER BY d.created_at DESC`
    )
    .all(courseId);
}

export function getChunksForRetrieval({ courseId, documentId } = {}) {
  const db = getDb();
  let rows;
  if (documentId) {
    rows = db
      .prepare(
        `SELECT c.id, c.document_id, d.filename, d.type AS doc_type, c.page, c.chunk_index, c.citation_label, c.content, c.embedding
         FROM chunks c
         JOIN documents d ON d.id = c.document_id
         WHERE c.document_id = ?
         ORDER BY c.page ASC, c.chunk_index ASC`
      )
      .all(documentId);
  } else {
    rows = db
      .prepare(
        `SELECT c.id, c.document_id, d.filename, d.type AS doc_type, c.page, c.chunk_index, c.citation_label, c.content, c.embedding
         FROM chunks c
         JOIN documents d ON d.id = c.document_id
         WHERE d.course_id = ?
         ORDER BY d.created_at ASC, c.page ASC, c.chunk_index ASC`
      )
      .all(courseId || DEFAULT_COURSE_ID);
  }

  return rows.map((row) => ({
    id: row.id,
    documentId: row.document_id,
    filename: row.filename,
    docType: row.doc_type || 'pdf',
    page: row.page,
    chunkIndex: row.chunk_index,
    citationLabel: row.citation_label || `p.${row.page}`,
    content: row.content,
    embedding: JSON.parse(row.embedding),
  }));
}

/**
 * M3: Saves generated multiple-choice questions to quiz_questions.
 */
export function saveQuizQuestions({
  courseId = DEFAULT_COURSE_ID,
  documentId = null,
  questions = [],
}) {
  const db = getDb();
  const createdAt = new Date().toISOString();
  const saved = [];

  db.exec('BEGIN');
  try {
    const insertStmt = db.prepare(
      `INSERT INTO quiz_questions
       (id, course_id, document_id, topic, question, options, answer_index, explanation, source_page, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    for (const q of questions) {
      const id = crypto.randomUUID();
      insertStmt.run(
        id,
        courseId,
        documentId,
        q.topic,
        q.question,
        JSON.stringify(q.options),
        q.answerIndex,
        q.explanation,
        q.sourcePage,
        createdAt
      );
      saved.push({
        id,
        courseId,
        documentId,
        topic: q.topic,
        question: q.question,
        options: q.options,
        answerIndex: q.answerIndex,
        explanation: q.explanation,
        sourcePage: q.sourcePage,
        createdAt,
      });
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return saved;
}

export function getQuizQuestionById(questionId) {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT id, course_id, document_id, topic, question, options, answer_index, explanation, source_page, created_at
       FROM quiz_questions
       WHERE id = ?`
    )
    .get(questionId);

  if (!row) return null;

  return {
    id: row.id,
    courseId: row.course_id,
    documentId: row.document_id,
    topic: row.topic,
    question: row.question,
    options: JSON.parse(row.options),
    answerIndex: row.answer_index,
    explanation: row.explanation,
    sourcePage: row.source_page,
    createdAt: row.created_at,
  };
}

export function listQuizQuestionsByCourse(courseId = DEFAULT_COURSE_ID) {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, course_id, document_id, topic, question, options, answer_index, explanation, source_page, created_at
       FROM quiz_questions
       WHERE course_id = ?
       ORDER BY created_at DESC`
    )
    .all(courseId);

  return rows.map((row) => ({
    id: row.id,
    courseId: row.course_id,
    documentId: row.document_id,
    topic: row.topic,
    question: row.question,
    options: JSON.parse(row.options),
    answerIndex: row.answer_index,
    explanation: row.explanation,
    sourcePage: row.source_page,
    createdAt: row.created_at,
  }));
}

export function recordQuizAttempt({ questionId, userAnswer, isCorrect }) {
  const db = getDb();
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();

  db.prepare(
    `INSERT INTO quiz_attempts (id, question_id, user_answer, is_correct, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(id, questionId, userAnswer, isCorrect ? 1 : 0, createdAt);

  return {
    id,
    questionId,
    userAnswer,
    isCorrect: Boolean(isCorrect),
    createdAt,
  };
}

/**
 * M3: Computes accuracy and error rate per topic for a course, ranked by error rate descending.
 */
export function getWeakTopicsByCourse(courseId = DEFAULT_COURSE_ID) {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT
         q.topic AS topic,
         COUNT(a.id) AS total_attempts,
         SUM(CASE WHEN a.is_correct = 1 THEN 1 ELSE 0 END) AS correct_attempts,
         SUM(CASE WHEN a.is_correct = 0 THEN 1 ELSE 0 END) AS wrong_attempts
       FROM quiz_attempts a
       JOIN quiz_questions q ON q.id = a.question_id
       WHERE q.course_id = ?
       GROUP BY q.topic`
    )
    .all(courseId);

  const stats = rows.map((r) => {
    const totalAttempts = Number(r.total_attempts) || 0;
    const correctAttempts = Number(r.correct_attempts) || 0;
    const wrongAttempts = Number(r.wrong_attempts) || 0;
    const accuracy = totalAttempts > 0 ? Number(((correctAttempts / totalAttempts) * 100).toFixed(1)) : 0;
    const errorRate = totalAttempts > 0 ? Number(((wrongAttempts / totalAttempts) * 100).toFixed(1)) : 0;

    return {
      topic: r.topic,
      totalAttempts,
      correctAttempts,
      wrongAttempts,
      accuracy,
      errorRate,
    };
  });

  // Sort by highest error rate first, then by total attempts descending
  stats.sort((a, b) => b.errorRate - a.errorRate || b.totalAttempts - a.totalAttempts);
  return stats;
}
