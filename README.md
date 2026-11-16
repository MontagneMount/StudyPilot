# StudyPilot

**StudyPilot** is an AI teaching assistant for university course materials, powered by Google Gemini (`@google/genai`).

## Completed Milestones: M1 – M5

- **M1 — MVP: PDF Q&A**: PDF upload validation (`<= 20 MB`, MIME + `%PDF-` header check) and Gemini Q&A.
- **M2 — RAG with Page Citations**: Per-page PDF parsing (`pdfjs-dist`), overlapping chunking, `gemini-embedding-001` vectors stored in SQLite (`node:sqlite`), SHA-256 embedding cache, Top-K cosine similarity retrieval, and clickable `[p.12]` citations.
- **M3 — Quiz & Weak-Point Tracking**:
  - Auto-generates 4-option multiple-choice questions using **Gemini Structured Output (`response_format` JSON Schema)**: `{ question, options[4], answerIndex, explanation, topic, sourcePage }`.
  - Records every student attempt in `quiz_attempts` and computes per-topic accuracy & error rate.
  - Displays a live **Weak-Point Tracking Dashboard** ranking topics by error rate descending.
- **M4 — Multimodal (Lecture Audio & Slide Chart Vision)**:
  - **Lecture Audio Transcription**: Upload `.mp3`, `.wav`, `.m4a`, `.ogg`, or `.webm` lecture recordings $\rightarrow$ transcribed by Gemini into timestamped segments (`MM:SS`) $\rightarrow$ indexed like a document with clickable `[02:15]` timestamp citations.
  - **Image-Heavy Slide & Chart Understanding**: Automatically detects image-heavy PDF pages (`< 30` words of selectable text) and standalone slide/chart images (`.png`, `.jpg`, `.webp`), sending them to Gemini Vision to extract chart axes, data trends, and diagram explanations before indexing.
- **M5 — Agent: Study Planner (Function Calling)**:
  - Uses **Gemini Function Calling** (`tools` + `function_call` / `function_result` multi-turn loop) with 4 tools: `getWeakTopics()`, `getCourseOutline()`, `createStudyPlan(days, hoursPerDay)`, and `generateQuiz(topic)`.
  - Produces a personalized day-by-day study schedule prioritizing the student's highest-error-rate weak topics.

```mermaid
flowchart LR
  User["Student (Browser)"] -->|PDF / Audio / Chart Image| Ingest["Multimodal Ingest (pdfjs + Gemini Audio/Vision)"]
  Ingest -->|ai.models.embedContent| DB[("SQLite (courses, documents, chunks, quiz_questions, quiz_attempts)")]
  User -->|POST /api/ask| Retrieve["Cosine Similarity Top-K"]
  DB --> Retrieve
  Retrieve -->|Strict Page [p.12] & Timestamp [02:15] Prompt| Gemini["Gemini 3.8 Flash"]
  User -->|POST /api/quiz/generate| QuizGen["Structured Output (JSON Schema)"]
  DB --> QuizGen
  QuizGen --> Gemini
  User -->|POST /api/plan| Agent["Study Planner Agent (Function Calling)"]
  Agent -->|getWeakTopics / getCourseOutline / createStudyPlan / generateQuiz| DB
  Agent --> Gemini
```

## Setup & Run (Windows PowerShell)

1. **Install dependencies**:
   ```powershell
   npm install
   ```

2. **Configure environment variables**:
   ```powershell
   Copy-Item .env.example .env
   ```
   Open `.env` and set your `GEMINI_API_KEY`.

3. **Run the server**:
   ```powershell
   npm run dev
   ```
   Open `http://localhost:3000` in your browser.

4. **Run automated tests**:
   ```powershell
   npm test
   ```
