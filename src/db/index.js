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
      content TEXT NOT NULL,
      embedding TEXT NOT NULL,
      FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
    );
  `);

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
      `INSERT INTO chunks (id, document_id, page, chunk_index, content, embedding)
       VALUES (?, ?, ?, ?, ?, ?)`
    );

    for (const chunk of chunks) {
      insertChunk.run(
        crypto.randomUUID(),
        documentId,
        chunk.page,
        chunk.chunkIndex,
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
        `SELECT c.id, c.document_id, d.filename, c.page, c.chunk_index, c.content, c.embedding
         FROM chunks c
         JOIN documents d ON d.id = c.document_id
         WHERE c.document_id = ?
         ORDER BY c.page ASC, c.chunk_index ASC`
      )
      .all(documentId);
  } else {
    rows = db
      .prepare(
        `SELECT c.id, c.document_id, d.filename, c.page, c.chunk_index, c.content, c.embedding
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
    page: row.page,
    chunkIndex: row.chunk_index,
    content: row.content,
    embedding: JSON.parse(row.embedding),
  }));
}
