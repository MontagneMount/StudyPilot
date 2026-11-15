# StudyPilot

**StudyPilot** is an AI teaching assistant for university course materials, powered by Google Gemini (`@google/genai`).

## Current Milestone: M2 — RAG with Page-Level Citations

- **Multi-Course & Multi-Document Support**: Organize PDFs by course (`courses`, `documents`, `chunks` tables persisted in SQLite via Node.js built-in `node:sqlite`).
- **Per-Page PDF Parsing & Chunking**: Extracts text page-by-page with `pdfjs-dist`, splits into overlapping chunks (~500–800 tokens), and retains `{ documentId, page, chunkIndex }` metadata.
- **Embedding & Caching**: Embeds chunks with `gemini-embedding-001` (`ai.models.embedContent`) and caches file hashes (SHA-256) so unchanged PDFs are never re-embedded.
- **Top-K Vector Retrieval & Strict Citations**: Embeds each question, retrieves the most relevant chunks via cosine similarity, and answers strictly from context with clickable `[p.12]` page citations in the UI.

```mermaid
flowchart LR
  User["Student (Browser)"] -->|POST /api/upload| Ingest["pdfjs-dist + Chunking"]
  Ingest -->|ai.models.embedContent| Embed["gemini-embedding-001"]
  Embed -->|Save chunks + vectors| DB[("SQLite (courses, documents, chunks)")]
  User -->|POST /api/ask| Retrieve["Cosine Similarity Top-K"]
  DB --> Retrieve
  Retrieve -->|Context + Strict Citation Prompt| Gemini["Gemini 3.8 Flash"]
  Gemini -->|Answer + Clickable [p.X]| User
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
