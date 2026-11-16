import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import { resetDbForTests } from '../src/db/index.js';
import { lexicalSimilarity } from '../src/services/retrieval.js';
import { runFullEvaluation } from '../eval/runEval.js';

describe('StudyPilot M6 Unit & Evaluation Benchmark Tests', () => {
  it('computes lexical BM25-style keyword overlap for Hybrid Search', () => {
    const score = lexicalSimilarity(
      'What is the closed-form Normal Equation for Ridge Regression?',
      'Page 2: Ridge Regression modifies the Normal Equation to w = (X^T X + lambda I)^(-1) X^T y.'
    );
    assert.ok(score > 0.5, `Expected high lexical overlap score, got ${score}`);
  });

  it('runs the 50-question evaluation suite and proves chunking + hybrid search optimization improves accuracy', async () => {
    const report = await runFullEvaluation();
    assert.ok(report.questionCount >= 50, 'Eval set must have at least 50 Q&A pairs');
    assert.ok(
      report.optimized.retrievalHitRate > report.baseline.retrievalHitRate,
      `Expected optimized hit rate (${report.optimized.retrievalHitRate}%) > baseline (${report.baseline.retrievalHitRate}%)`
    );
    assert.ok(
      report.optimized.answerAccuracy > report.baseline.answerAccuracy,
      `Expected optimized accuracy (${report.optimized.answerAccuracy}%) > baseline (${report.baseline.answerAccuracy}%)`
    );
  });
});

describe('StudyPilot M6 Production Readiness API (Auth & Rate Limiting)', () => {
  let server;
  let baseUrl;

  const app = createApp({
    dbPath: ':memory:',
    rateLimitMax: 6,
    rateLimitWindowMs: 60 * 1000,
  });

  beforeEach(() => {
    resetDbForTests();
  });

  it('registers users, authenticates sessions via Bearer token, and enforces rate limiting', async () => {
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });

    // 1. Register a new student account
    let token;
    {
      const res = await fetch(`${baseUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'student@e.ntu.edu.sg',
          password: 'securePassword123',
        }),
      });
      const body = await res.json();
      assert.equal(res.status, 201);
      assert.equal(body.user.email, 'student@e.ntu.edu.sg');
      assert.ok(body.token);
      token = body.token;
    }

    // 2. Duplicate registration returns 409 EMAIL_EXISTS
    {
      const res = await fetch(`${baseUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'student@e.ntu.edu.sg',
          password: 'securePassword123',
        }),
      });
      const body = await res.json();
      assert.equal(res.status, 409);
      assert.equal(body.code, 'EMAIL_EXISTS');
    }

    // 3. Login with valid credentials -> 200 OK
    {
      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'student@e.ntu.edu.sg',
          password: 'securePassword123',
        }),
      });
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.ok(body.token);
    }

    // 4. Verify GET /api/auth/me with Bearer token
    {
      const res = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.user.email, 'student@e.ntu.edu.sg');
    }

    // 5. Verify rate limiter triggers 429 RATE_LIMIT_EXCEEDED after exceeding 6 requests in window
    {
      await fetch(`${baseUrl}/api/health`);
      await fetch(`${baseUrl}/api/health`);
      const blockedRes = await fetch(`${baseUrl}/api/health`);
      const blockedBody = await blockedRes.json();
      assert.equal(blockedRes.status, 429);
      assert.equal(blockedBody.code, 'RATE_LIMIT_EXCEEDED');
    }
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
