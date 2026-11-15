# Project Design Document: StudyPilot

You are my senior full-stack developer partner. Please help me build the project described below, step by step. I am a beginner-to-intermediate developer (HTML/CSS/JavaScript/Node.js) on Windows + PowerShell. Explain things in Chinese, but keep code, commands, and file names in English.

---

## 1. Overview

**StudyPilot** is an AI teaching assistant for university course materials, powered by Google Gemini.

- **Problem**: Students have many lecture PDFs, slides, and recordings. Finding answers, reviewing efficiently, and knowing weak points is hard.
- **Solution**: Upload course materials → ask questions with page-level citations → auto-generate quizzes → track weak topics → get a personalized study plan.
- **Target users**: University students (first user: myself, an MSc student at NTU).
- **Goal**: A real, deployable, resume-worthy project that demonstrates RAG, multimodal AI, agents, evaluation, and cloud deployment.

---

## 2. Tech Stack

| Layer | Choice | Reason |
|---|---|---|
| Backend | Node.js + Express | Simple, I already know JS |
| AI SDK | `@google/genai` (official Google Gen AI SDK) | Official, supports Gemini + embeddings + files |
| LLM | Gemini Flash model (configurable via env `GEMINI_MODEL`) | Fast, cheap, long context, multimodal |
| Embeddings | `gemini-embedding-001` (configurable) | For RAG retrieval |
| Frontend | M1–M3: plain HTML/CSS/JS; later: React (Vite) | Start simple |
| Database | M2+: PostgreSQL + `pgvector` (local via Docker), or SQLite + in-memory vectors for early dev | Vector search |
| File upload | `multer` | Standard for Express |
| Config | `dotenv` | Secrets in `.env` |
| Deployment | Google Cloud Run (Docker) | Fits Google ecosystem |
| Testing | `vitest` or Node built-in test runner | Lightweight |

Rules:
- Keep dependencies minimal. Explain why each package is needed before adding it.
- Never hardcode API keys. Use `process.env.GEMINI_API_KEY`. Provide `.env.example` only.
- Use ES modules (`"type": "module"`).
- Verify SDK usage against current official docs; if an API name I wrote is outdated, use the current one and tell me.

---

## 3. Folder Structure (target)

```
StudyPilot/
├── server.js                 # Express entry
├── src/
│   ├── routes/               # API routes (documents, chat, quiz, plan)
│   ├── services/
│   │   ├── gemini.js         # All Gemini API calls in one place
│   │   ├── ingest.js         # PDF parsing + chunking
│   │   ├── retrieval.js      # Embedding + vector search
│   │   └── quiz.js           # Quiz generation + grading
│   ├── db/                   # DB connection + schema
│   └── utils/
├── public/                   # Frontend (M1–M3)
├── eval/
│   ├── questions.json        # Eval set: question + expected answer + source page
│   └── runEval.js            # Measures accuracy / retrieval hit rate
├── uploads/                  # Temp files (gitignored)
├── tests/
├── .env.example
├── .gitignore
├── Dockerfile
├── package.json
└── README.md
```

---

## 4. Milestones

Build ONE milestone at a time. Each milestone must run locally and be demoable before moving on. At the end of each milestone, tell me: what changed, how to run, how to test, and suggest a git commit message.

### M1 — MVP: PDF Q&A
- Upload one PDF from the web page.
- Send the PDF directly to Gemini (Files API / inline data) together with the question.
- Display the answer.
- API: `POST /api/upload`, `POST /api/ask` `{ fileId, question }`
- Error handling: no file, wrong file type, file too large (limit 20MB), missing API key, Gemini errors.

### M2 — RAG with Citations
- Extract text per page (e.g. `pdf-parse` or `pdfjs-dist`), split into chunks (~500–800 tokens, with overlap), keep metadata `{ documentId, page, chunkIndex }`.
- Embed chunks, store vectors.
- On question: embed query → top-k similarity search → send retrieved chunks to Gemini with a strict prompt: "Answer only from the context; if not found, say so; cite pages like [p.12]."
- Support multiple documents per course.
- Frontend shows clickable citations.

### M3 — Quiz & Weak-Point Tracking
- Generate multiple-choice questions from selected chapters using **structured output (JSON schema)**: `{ question, options[4], answerIndex, explanation, topic, sourcePage }`.
- Record user answers; compute accuracy per topic.
- Dashboard: weak topics ranked by error rate.

### M4 — Multimodal
- Upload lecture audio → transcribe with Gemini → index transcript like a document (citations show timestamps).
- Understand charts/images inside slides (send page images to Gemini when the page is image-heavy).

### M5 — Agent: Study Planner
- Use **function calling**. Tools: `getWeakTopics()`, `getCourseOutline()`, `createStudyPlan(days, hoursPerDay)`, `generateQuiz(topic)`.
- User says "I have an exam in 7 days, 2 hours a day" → agent produces a day-by-day plan based on weak topics.

### M6 — Production Readiness
- User accounts (simple auth, e.g. Firebase Auth or session-based).
- Migrate frontend to React (Vite).
- Dockerfile + deploy to Google Cloud Run; secrets via Secret Manager.
- GitHub Actions: lint + tests on push.
- Rate limiting and input validation.
- **Evaluation**: `eval/questions.json` with ≥50 Q&A pairs; `runEval.js` reports retrieval hit rate (correct page in top-k) and answer accuracy (LLM-as-judge with Gemini). Record before/after numbers when changing chunk size, top-k, or adding hybrid search.

---

## 5. Data Model (M2+)

- `courses(id, name, created_at)`
- `documents(id, course_id, filename, type[pdf|audio], pages, created_at)`
- `chunks(id, document_id, page, chunk_index, content, embedding vector)`
- `quiz_questions(id, course_id, topic, question, options json, answer_index, explanation, source_page)`
- `quiz_attempts(id, question_id, user_answer, is_correct, created_at)`
- (M6) `users(id, email, created_at)` + `user_id` foreign keys

---

## 6. Non-Functional Requirements

- **Security**: no secrets in code or git; validate uploads (type, size); sanitize output rendered in HTML.
- **Cost**: use Flash model by default; cache embeddings; don't re-embed unchanged files.
- **Reliability**: retry on transient Gemini errors with backoff; clear error messages in UI.
- **Code quality**: small functions, meaningful names, comments only where helpful, beginner-readable.
- **Docs**: README with setup steps (Windows PowerShell commands), env vars, how to run, screenshots, architecture diagram (Mermaid).

---

## 7. Resume Outcome (what this project should prove)

- Built a RAG-based study assistant with Gemini API and pgvector, supporting PDF and audio ingestion with page-level citations.
- Improved answer accuracy from X% to Y% on a 50-question eval set via chunking and hybrid search optimization.
- Implemented an agentic study planner using Gemini function calling; deployed on Google Cloud Run with CI/CD.

---

## 8. How to Work With Me

1. First, briefly confirm you understand the project and point out any risks or better choices.
2. Then start **M1 only**: give me the complete file list, then the full content of each file, then PowerShell commands to install and run.
3. Wait for my feedback before starting the next milestone.
4. When I report an error, explain the cause in simple Chinese, then give the smallest fix.