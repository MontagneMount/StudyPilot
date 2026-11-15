import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../server.js';
import { resetDbForTests } from '../src/db/index.js';
import { chunkPages, extractPagesFromPdf } from '../src/services/ingest.js';
import { cosineSimilarity } from '../src/services/retrieval.js';

/**
 * Helper to build a minimal valid 2-page PDF buffer that pdfjs-dist can parse.
 */
function buildValidTwoPagePdfBuffer() {
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 612 792] /Contents 5 0 R >>\nendobj\n',
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
    '5 0 obj\n<< /Length 68 >>\nstream\nBT /F1 12 Tf 72 720 Td (Page one covers linear regression basics.) Tj ET\nendstream\nendobj\n',
    '6 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 612 792] /Contents 7 0 R >>\nendobj\n',
    '7 0 obj\n<< /Length 71 >>\nstream\nBT /F1 12 Tf 72 720 Td (Page two explains backpropagation formulas.) Tj ET\nendstream\nendobj\n',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf, 'ascii'));
    pdf += obj;
  }
  const xrefOffset = Buffer.byteLength(pdf, 'ascii');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'ascii');
}

describe('StudyPilot M2 Unit Tests (Chunking, PDF Parsing & Vector Math)', () => {
  it('computes cosine similarity accurately', () => {
    assert.equal(Number(cosineSimilarity([1, 0, 0], [1, 0, 0]).toFixed(4)), 1);
    assert.equal(Number(cosineSimilarity([1, 0, 0], [0, 1, 0]).toFixed(4)), 0);
    assert.equal(cosineSimilarity([], []), 0);
  });

  it('splits multi-page text into overlapping chunks with page and chunkIndex metadata', () => {
    const longPageText = Array.from({ length: 120 }, (_, i) => `word${i + 1}`).join(' ');
    const pages = [
      { page: 1, text: 'Short intro on page 1.' },
      { page: 2, text: longPageText },
    ];

    const chunks = chunkPages(pages, { maxTokens: 80, overlapTokens: 20 });
    assert.ok(chunks.length >= 3, 'Should produce at least 3 chunks across the 2 pages');
    assert.equal(chunks[0].page, 1);
    assert.equal(chunks[0].chunkIndex, 0);
    assert.equal(chunks[1].page, 2);
    assert.equal(chunks[1].chunkIndex, 1);
    assert.equal(chunks[2].page, 2);
    assert.equal(chunks[2].chunkIndex, 2);

    // Verify overlap between chunk 1 and chunk 2 on page 2
    const chunk1Words = new Set(chunks[1].content.split(' '));
    const chunk2Words = chunks[2].content.split(' ');
    const shared = chunk2Words.filter((w) => chunk1Words.has(w));
    assert.ok(shared.length > 0, 'Consecutive chunks on the same page should share overlapping words');
  });

  it('extracts per-page text from a real multi-page PDF via pdfjs-dist', async () => {
    const tmpFile = path.join(os.tmpdir(), `studypilot-test-${Date.now()}.pdf`);
    try {
      await fs.writeFile(tmpFile, buildValidTwoPagePdfBuffer());
      const pages = await extractPagesFromPdf(tmpFile);
      assert.equal(pages.length, 2);
      assert.equal(pages[0].page, 1);
      assert.match(pages[0].text, /linear regression basics/i);
      assert.equal(pages[1].page, 2);
      assert.match(pages[1].text, /backpropagation formulas/i);
    } finally {
      await fs.unlink(tmpFile).catch(() => {});
    }
  });
});

describe('StudyPilot M2 API & RAG Integration Tests', () => {
  let server;
  let baseUrl;
  let embedCallCount = 0;

  // Deterministic semantic mock embedding:
  // Dimension 0: syllabus / grading
  // Dimension 1: gradient descent / optimization
  // Dimension 2: transformers / attention
  function computeMockVector(text) {
    const lower = text.toLowerCase();
    const v0 = lower.includes('grading') || lower.includes('exam') ? 0.9 : 0.1;
    const v1 = lower.includes('gradient') || lower.includes('learning rate') ? 0.95 : 0.1;
    const v2 = lower.includes('transformer') || lower.includes('attention') ? 0.95 : 0.1;
    return [v0, v1, v2];
  }

  const mockExtractPages = async (filePath) => {
    const raw = await fs.readFile(filePath, 'utf8');
    if (raw.includes('LECTURE_2_TRANSFORMERS')) {
      return [
        { page: 1, text: 'Introduction to sequence models and RNN limitations.' },
        { page: 12, text: 'Self-attention and Transformer architecture scale quadratically with sequence length.' },
      ];
    }
    return [
      { page: 1, text: 'Course syllabus: Final exam is 60% and project is 40% of the total grading.' },
      { page: 5, text: 'Gradient descent updates weights using the learning rate alpha.' },
    ];
  };

  const mockEmbedChunks = async (texts) => {
    embedCallCount += 1;
    return texts.map((t) => computeMockVector(t));
  };

  const mockEmbedSearchQuery = async (query) => computeMockVector(query);

  const mockAskRag = async ({ question, chunks }) => {
    const top = chunks[0];
    return {
      answer: `Based on ${top.filename}, ${top.content} [p.${top.page}]`,
      model: 'gemini-3.8-flash',
      interactionId: 'interaction-rag-1',
    };
  };

  const app = createApp({
    dbPath: ':memory:',
    extractPages: mockExtractPages,
    embedChunks: mockEmbedChunks,
    embedSearchQuery: mockEmbedSearchQuery,
    askRag: mockAskRag,
  });

  beforeEach(() => {
    resetDbForTests();
    embedCallCount = 0;
  });

  it('supports courses, multi-document PDF ingestion, embedding caching, and RAG with page citations', async () => {
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        const { port } = server.address();
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });

    // 1. Upload with no file -> 400 NO_FILE
    {
      const res = await fetch(`${baseUrl}/api/upload`, { method: 'POST' });
      const body = await res.json();
      assert.equal(res.status, 400);
      assert.equal(body.code, 'NO_FILE');
    }

    // 2. Upload with wrong file type -> 400 INVALID_FILE_TYPE
    {
      const form = new FormData();
      form.append('file', new Blob(['hello world'], { type: 'text/plain' }), 'notes.txt');
      const res = await fetch(`${baseUrl}/api/upload`, { method: 'POST', body: form });
      const body = await res.json();
      assert.equal(res.status, 400);
      assert.equal(body.code, 'INVALID_FILE_TYPE');
    }

    // 3. Create a custom course
    let courseId;
    {
      const res = await fetch(`${baseUrl}/api/courses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'CS5242 Neural Networks' }),
      });
      const body = await res.json();
      assert.equal(res.status, 201);
      assert.equal(body.course.name, 'CS5242 Neural Networks');
      courseId = body.course.id;
    }

    // 4. Upload Document 1 (Lecture 1)
    let doc1Id;
    const pdf1Bytes = '%PDF-1.7\nLECTURE_1_BASICS\n%%EOF';
    {
      const form = new FormData();
      form.append('file', new Blob([pdf1Bytes], { type: 'application/pdf' }), 'Lecture01_Basics.pdf');
      form.append('courseId', courseId);

      const res = await fetch(`${baseUrl}/api/upload`, { method: 'POST', body: form });
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.ok(body.documentId);
      assert.equal(body.pages, 2);
      assert.equal(body.chunkCount, 2);
      assert.equal(body.cached, false);
      assert.equal(embedCallCount, 1);
      doc1Id = body.documentId;
    }

    // 5. Re-upload identical Document 1 -> should hit cache and NOT re-embed
    {
      const form = new FormData();
      form.append('file', new Blob([pdf1Bytes], { type: 'application/pdf' }), 'Lecture01_Basics.pdf');
      form.append('courseId', courseId);

      const res = await fetch(`${baseUrl}/api/upload`, { method: 'POST', body: form });
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.documentId, doc1Id);
      assert.equal(body.cached, true);
      assert.equal(embedCallCount, 1, 'Should not call embedding API again for unchanged file');
    }

    // 6. Upload Document 2 (Lecture 2) to the same course
    {
      const pdf2Bytes = '%PDF-1.7\nLECTURE_2_TRANSFORMERS\n%%EOF';
      const form = new FormData();
      form.append('file', new Blob([pdf2Bytes], { type: 'application/pdf' }), 'Lecture02_Transformers.pdf');
      form.append('courseId', courseId);

      const res = await fetch(`${baseUrl}/api/upload`, { method: 'POST', body: form });
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.cached, false);
      assert.equal(embedCallCount, 2);
    }

    // 7. Verify GET /api/documents lists both PDFs in the course
    {
      const res = await fetch(`${baseUrl}/api/documents?courseId=${courseId}`);
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.documents.length, 2);
    }

    // 8. Ask a question across all documents in the course about Transformers -> should retrieve Lecture02 [p.12]
    {
      const res = await fetch(`${baseUrl}/api/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          courseId,
          question: 'How does Transformer self-attention scale?',
          topK: 2,
        }),
      });
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.match(body.answer, /\[p\.12\]/);
      assert.ok(Array.isArray(body.citations));
      assert.equal(body.citations.length, 2);
      assert.equal(body.citations[0].filename, 'Lecture02_Transformers.pdf');
      assert.equal(body.citations[0].page, 12);
    }

    // 9. Ask a question scoped to Document 1 about gradient descent -> should retrieve Lecture01 [p.5]
    {
      const res = await fetch(`${baseUrl}/api/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          courseId,
          documentId: doc1Id,
          question: 'How does gradient descent use the learning rate?',
        }),
      });
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.match(body.answer, /\[p\.5\]/);
      assert.equal(body.citations[0].filename, 'Lecture01_Basics.pdf');
      assert.equal(body.citations[0].page, 5);
    }

    // 10. Error handling: empty question & non-existent documentId
    {
      const emptyRes = await fetch(`${baseUrl}/api/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ courseId, question: '   ' }),
      });
      assert.equal(emptyRes.status, 400);

      const missingRes = await fetch(`${baseUrl}/api/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ courseId, documentId: 'non-existent', question: 'What is on page 1?' }),
      });
      assert.equal(missingRes.status, 404);
    }
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('StudyPilot M2 End-to-End Real PDF Upload + RAG Pipeline', () => {
  let e2eServer;
  let e2eBaseUrl;

  const e2eApp = createApp({
    dbPath: ':memory:',
    // Uses real extractPagesFromPdf (pdfjs-dist)
    embedChunks: async (texts) =>
      texts.map((t) => (t.toLowerCase().includes('backpropagation') ? [0.1, 0.99] : [0.99, 0.1])),
    embedSearchQuery: async (q) =>
      q.toLowerCase().includes('backpropagation') ? [0.1, 0.99] : [0.99, 0.1],
    askRag: async ({ chunks }) => ({
      answer: `From the slides: ${chunks[0].content} [p.${chunks[0].page}]`,
      model: 'gemini-3.8-flash',
    }),
  });

  it('ingests a real 2-page PDF via /api/upload and retrieves page 2 citation via /api/ask', async () => {
    resetDbForTests();
    await new Promise((resolve) => {
      e2eServer = e2eApp.listen(0, () => {
        e2eBaseUrl = `http://127.0.0.1:${e2eServer.address().port}`;
        resolve();
      });
    });

    const realPdfBuffer = buildValidTwoPagePdfBuffer();
    const form = new FormData();
    form.append('file', new Blob([realPdfBuffer], { type: 'application/pdf' }), 'RealSlides.pdf');

    const uploadRes = await fetch(`${e2eBaseUrl}/api/upload`, {
      method: 'POST',
      body: form,
    });
    const uploadBody = await uploadRes.json();
    assert.equal(uploadRes.status, 200);
    assert.equal(uploadBody.pages, 2);
    assert.equal(uploadBody.chunkCount, 2);

    const askRes = await fetch(`${e2eBaseUrl}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: 'Where are backpropagation formulas explained?',
        topK: 1,
      }),
    });
    const askBody = await askRes.json();
    assert.equal(askRes.status, 200);
    assert.match(askBody.answer, /\[p\.2\]/);
    assert.equal(askBody.citations[0].page, 2);
    assert.match(askBody.citations[0].content, /backpropagation formulas/i);
  });

  after(async () => {
    if (e2eServer) {
      await new Promise((resolve) => e2eServer.close(resolve));
    }
  });
});
