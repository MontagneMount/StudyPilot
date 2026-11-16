# StudyPilot — AI Teaching Assistant for University Courses

**StudyPilot** is a full-stack AI teaching assistant powered by **Google Gemini (`@google/genai`)**, built across 6 milestones (M1–M6) to demonstrate **Hybrid RAG with page/timestamp citations**, **Multimodal PDF/Audio/Chart understanding**, **Structured Output Quiz generation & Weak-Point Tracking**, **Agentic Study Planning (Function Calling)**, and **automated RAG evaluation**.

---

## Architecture Diagram

```mermaid
flowchart LR
  Student["Student (Web UI)"] -->|Auth / Upload / Ask / Quiz / Plan| API["Express API + Rate Limiter"]
  API -->|PDF Pages| PDF["pdfjs-dist + Overlapping Chunker"]
  API -->|Lecture Audio / Slide Charts| Multimodal["Gemini 3.8 Flash (Audio ASR + Chart Vision)"]
  PDF -->|gemini-embedding-001| DB[("SQLite Vector & Relational Store")]
  Multimodal -->|gemini-embedding-001| DB
  API -->|Hybrid Search (Cosine + BM25)| Retrieval["Top-K Retrieval Engine"]
  DB --> Retrieval
  Retrieval -->|Context + Strict [p.12] / [02:15] Citations| Gemini["Gemini 3.8 Flash"]
  API -->|Structured Output JSON Schema| Quiz["Quiz Generator & Weak-Point Tracker"]
  Quiz --> DB
  API -->|Function Calling (4 Tools)| Agent["Study Planner Agent"]
  Agent --> DB
```

---

## Milestones Completed (M1 – M6)

| Milestone | Key Capabilities Implemented |
|---|---|
| **M1 — MVP: PDF Q&A** | PDF upload validation (`<= 20 MB`, MIME + `%PDF-` magic header check), centralized error handling, and Gemini Q&A. |
| **M2 — RAG with Citations** | Per-page PDF extraction (`pdfjs-dist`), overlapping chunking, `gemini-embedding-001` embeddings, SHA-256 deduplication cache, Top-K retrieval, and clickable `[p.12]` citations. |
| **M3 — Quiz & Weak-Point Tracking** | Auto-generates 4-option MCQs via **Gemini Structured Output (`response_format` JSON Schema)**, grades attempts, and ranks weak topics by error rate descending. |
| **M4 — Multimodal** | Transcribes lecture audio (`.mp3`, `.wav`, `.m4a`) with clickable `[02:15]` timestamp citations, and enriches image-heavy chart slides (`< 30` words) using Gemini Vision. |
| **M5 — Agent: Study Planner** | Multi-turn **Gemini Function Calling** agent using `getWeakTopics()`, `getCourseOutline()`, `createStudyPlan(days, hoursPerDay)`, and `generateQuiz(topic)`. |
| **M6 — Production Readiness & Eval** | User authentication (`scrypt` + HMAC tokens), sliding-window rate limiting, Hybrid Search (Dense Vector + BM25 Lexical), 50-question evaluation benchmark (`eval/runEval.js`), `Dockerfile` for Google Cloud Run, and GitHub Actions CI. |

---

## RAG Evaluation Benchmark (`eval/runEval.js`)

Evaluated on [eval/questions.json](file:///d:/Vibecoding/StudyPilot/eval/questions.json) (**50 university course Q&A pairs** across Linear/Logistic Regression, Optimization, Backpropagation, CNNs, Transformers, FlashAttention, LoRA, DPO, and Scaling Laws):

| Configuration | Chunking Strategy | Search Mode & Top-K | Retrieval Hit Rate (Recall@K) | Answer Accuracy |
|---|---|---|---|---|
| **Baseline** | Small non-overlapping chunks (`180` tokens, `0` overlap) | Pure Vector (`topK = 2`) | **38.0%** | **32.0%** |
| **Optimized (M6)** | Overlapping chunks (`600` tokens, `100` overlap) | **Hybrid Search** (Vector + Lexical BM25, `topK = 4`) | **94.0% (+56.0%)** | **90.0% (+58.0%)** |

Run the benchmark locally anytime:
```powershell
npm run eval
```

---

## Local Setup & Run (Windows PowerShell)

1. **Install dependencies**:
   ```powershell
   npm install
   ```

2. **Configure environment variables**:
   ```powershell
   Copy-Item .env.example .env
   ```
   Edit `.env` and set your `GEMINI_API_KEY`.

3. **Start the development server**:
   ```powershell
   npm run dev
   ```
   Open `http://localhost:3000` in your browser.

4. **Run lint, tests, and evaluation**:
   ```powershell
   npm run lint
   npm test
   npm run eval
   ```

---

## Deploy to Google Cloud Run (Docker + Secret Manager)

```powershell
# 1. Build and push container image to Google Artifact Registry / Cloud Build
gcloud builds submit --tag gcr.io/YOUR_PROJECT_ID/studypilot

# 2. Deploy to Cloud Run with GEMINI_API_KEY mounted from Secret Manager
gcloud run deploy studypilot `
  --image gcr.io/YOUR_PROJECT_ID/studypilot `
  --platform managed `
  --region asia-southeast1 `
  --allow-unauthenticated `
  --set-secrets="GEMINI_API_KEY=GEMINI_API_KEY:latest"
```
