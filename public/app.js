// Feature-detect Invoker Commands API for declarative dialog close button
if (!('commandForElement' in HTMLButtonElement.prototype)) {
  document.addEventListener('click', (event) => {
    const button = event.composedPath().find((el) => el.matches?.('button[commandfor]'));
    if (!button) return;
    const target = document.getElementById(button.getAttribute('commandfor'));
    const command = button.getAttribute('command');
    if (target && command === 'close' && typeof target.close === 'function') {
      target.close();
    }
  });
}

const state = {
  courseId: 'default-course',
  courses: [],
  documents: [],
  selectedDocumentId: '', // '' means search across all documents in the active course
  questions: [],
  weakTopics: [],
  isUploading: false,
  isAsking: false,
  isGeneratingQuiz: false,
};

const courseSelect = document.getElementById('course-select');
const courseForm = document.getElementById('course-form');
const newCourseNameInput = document.getElementById('new-course-name');

const uploadForm = document.getElementById('upload-form');
const pdfFileInput = document.getElementById('pdf-file');
const uploadBtn = document.getElementById('upload-btn');
const uploadFeedback = document.getElementById('upload-feedback');
const documentList = document.getElementById('document-list');
const statusBadge = document.getElementById('status-badge');
const docScopeSelect = document.getElementById('doc-scope-select');

const weakTopicsTbody = document.getElementById('weak-topics-tbody');

const askForm = document.getElementById('ask-form');
const questionInput = document.getElementById('question-input');
const askBtn = document.getElementById('ask-btn');
const askFeedback = document.getElementById('ask-feedback');
const chatHistory = document.getElementById('chat-history');
const emptyChatMsg = document.getElementById('empty-chat-msg');

const quizForm = document.getElementById('quiz-form');
const quizTopicInput = document.getElementById('quiz-topic-input');
const quizCountSelect = document.getElementById('quiz-count-select');
const generateQuizBtn = document.getElementById('generate-quiz-btn');
const quizFeedback = document.getElementById('quiz-feedback');
const quizList = document.getElementById('quiz-list');

const citationDialog = document.getElementById('citation-dialog');
const citationDialogTitle = document.getElementById('citation-dialog-title');
const citationDialogMeta = document.getElementById('citation-dialog-meta');
const citationDialogBody = document.getElementById('citation-dialog-body');

const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB

// Keep aria-invalid synced with CSS :user-invalid state
function syncAriaInvalid(el) {
  if (!el || typeof el.matches !== 'function') return;
  try {
    el.setAttribute('aria-invalid', el.matches(':user-invalid') ? 'true' : 'false');
  } catch {
    // Ignore if selector is unsupported in older browsers
  }
}

document.addEventListener('blur', (e) => syncAriaInvalid(e.target), true);
document.addEventListener('input', (e) => {
  if (e.target?.hasAttribute?.('aria-invalid')) {
    syncAriaInvalid(e.target);
  }
});

function showFeedback(element, message, type = 'info') {
  element.textContent = message;
  element.className = `feedback ${type}`;
  element.hidden = false;
}

function hideFeedback(element) {
  element.hidden = true;
  element.textContent = '';
}

function openCitationPreview(citation) {
  citationDialogTitle.textContent = `${citation.filename} — Page ${citation.page}`;
  citationDialogMeta.textContent = `Chunk #${citation.chunkIndex + 1} • Similarity Score: ${citation.score}`;
  citationDialogBody.textContent = citation.content;
  if (typeof citationDialog.showModal === 'function') {
    citationDialog.showModal();
  }
}

/**
 * Safely renders assistant text while converting [p.12] or [p. 12] patterns into clickable citation buttons.
 */
function renderAnswerWithClickableCitations(container, answerText, citations = []) {
  const citationRegex = /\[p\.\s*(\d+)\]/gi;
  let lastIndex = 0;
  let match;

  while ((match = citationRegex.exec(answerText)) !== null) {
    if (match.index > lastIndex) {
      container.appendChild(document.createTextNode(answerText.slice(lastIndex, match.index)));
    }

    const pageNum = Number(match[1]);
    const matchingChunk =
      citations.find((c) => Number(c.page) === pageNum) || citations[0] || null;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'citation-pill';
    btn.textContent = `[p.${pageNum}]`;
    btn.title = matchingChunk
      ? `View source from ${matchingChunk.filename} (Page ${pageNum})`
      : `Page ${pageNum}`;

    if (matchingChunk) {
      btn.addEventListener('click', () =>
        openCitationPreview({
          ...matchingChunk,
          page: pageNum,
        })
      );
    }

    container.appendChild(btn);
    lastIndex = citationRegex.lastIndex;
  }

  if (lastIndex < answerText.length) {
    container.appendChild(document.createTextNode(answerText.slice(lastIndex)));
  }
}

function appendMessage(role, text, citations = []) {
  if (emptyChatMsg) {
    emptyChatMsg.hidden = true;
  }

  const wrapper = document.createElement('div');
  wrapper.className = `message ${role}`;

  const label = document.createElement('span');
  label.className = 'message-label';
  label.textContent = role === 'user' ? 'You' : 'StudyPilot';

  const body = document.createElement('div');
  if (role === 'assistant') {
    renderAnswerWithClickableCitations(body, text, citations);
  } else {
    body.textContent = text;
  }

  wrapper.appendChild(label);
  wrapper.appendChild(body);

  if (role === 'assistant' && citations.length > 0) {
    const bar = document.createElement('div');
    bar.className = 'citations-bar';

    const barLabel = document.createElement('span');
    barLabel.className = 'citations-bar-label';
    barLabel.textContent = 'Retrieved Sources:';
    bar.appendChild(barLabel);

    for (const cit of citations) {
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'citation-pill';
      pill.textContent = `${cit.filename} [p.${cit.page}]`;
      pill.title = `Click to inspect chunk #${cit.chunkIndex + 1} (score: ${cit.score})`;
      pill.addEventListener('click', () => openCitationPreview(cit));
      bar.appendChild(pill);
    }

    wrapper.appendChild(bar);
  }

  chatHistory.appendChild(wrapper);
  chatHistory.scrollTop = chatHistory.scrollHeight;
}

function renderWeakTopics() {
  weakTopicsTbody.textContent = '';

  if (!state.weakTopics || state.weakTopics.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 4;
    td.className = 'doc-empty';
    td.textContent = 'Complete a quiz question to track topic accuracy.';
    tr.appendChild(td);
    weakTopicsTbody.appendChild(tr);
    return;
  }

  for (const item of state.weakTopics) {
    const tr = document.createElement('tr');

    const th = document.createElement('th');
    th.scope = 'row';
    th.textContent = item.topic;

    const errTd = document.createElement('td');
    const errBadge = document.createElement('span');
    errBadge.className = `error-rate-pill ${item.errorRate >= 50 ? 'high' : 'low'}`;
    errBadge.textContent = `${item.errorRate}%`;
    errTd.appendChild(errBadge);

    const accTd = document.createElement('td');
    accTd.textContent = `${item.accuracy}%`;

    const countTd = document.createElement('td');
    countTd.textContent = `${item.correctAttempts}/${item.totalAttempts} correct`;

    tr.appendChild(th);
    tr.appendChild(errTd);
    tr.appendChild(accTd);
    tr.appendChild(countTd);
    weakTopicsTbody.appendChild(tr);
  }
}

function renderQuizQuestions() {
  quizList.textContent = '';

  if (!state.questions || state.questions.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'No quiz questions generated for this course yet.';
    quizList.appendChild(empty);
    return;
  }

  state.questions.forEach((q, qIdx) => {
    const card = document.createElement('div');
    card.className = 'quiz-item';

    const header = document.createElement('div');
    header.className = 'quiz-item-header';

    const topicSpan = document.createElement('span');
    topicSpan.className = 'topic-tag';
    topicSpan.textContent = q.topic;

    const pageSpan = document.createElement('span');
    pageSpan.className = 'citation-pill';
    pageSpan.textContent = `[p.${q.sourcePage}]`;

    header.appendChild(topicSpan);
    header.appendChild(pageSpan);

    const qText = document.createElement('div');
    qText.className = 'quiz-question-text';
    qText.textContent = `Q${qIdx + 1}. ${q.question}`;

    const optionsContainer = document.createElement('div');
    optionsContainer.className = 'quiz-options';

    const explanationBox = document.createElement('div');
    explanationBox.className = 'quiz-explanation';
    explanationBox.hidden = true;

    const optionButtons = [];

    q.options.forEach((optText, optIdx) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'quiz-option-btn';
      btn.textContent = `${String.fromCharCode(65 + optIdx)}. ${optText}`;

      btn.addEventListener('click', async () => {
        optionButtons.forEach((b) => {
          b.disabled = true;
        });

        try {
          const res = await fetch('/api/quiz/attempt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              questionId: q.id,
              userAnswer: optIdx,
            }),
          });
          const result = await res.json();
          if (!res.ok) {
            throw new Error(result.error || 'Failed to submit answer.');
          }

          optionButtons.forEach((b, idx) => {
            if (idx === result.correctAnswerIndex) {
              b.classList.add('correct');
            } else if (idx === optIdx && !result.isCorrect) {
              b.classList.add('wrong');
            }
          });

          explanationBox.textContent =
            (result.isCorrect ? '✅ Correct! ' : '❌ Incorrect. ') +
            `${result.explanation} (Source: [p.${result.sourcePage}])`;
          explanationBox.hidden = false;

          if (result.weakTopics) {
            state.weakTopics = result.weakTopics;
            renderWeakTopics();
          }
        } catch (err) {
          showFeedback(quizFeedback, err.message, 'error');
          optionButtons.forEach((b) => {
            b.disabled = false;
          });
        }
      });

      optionButtons.push(btn);
      optionsContainer.appendChild(btn);
    });

    card.appendChild(header);
    card.appendChild(qText);
    card.appendChild(optionsContainer);
    card.appendChild(explanationBox);
    quizList.appendChild(card);
  });
}

function renderDocumentList() {
  documentList.textContent = '';
  docScopeSelect.textContent = '';

  const allOption = document.createElement('option');
  allOption.value = '';
  allOption.textContent = `All Documents in Course (${state.documents.length})`;
  docScopeSelect.appendChild(allOption);

  if (state.documents.length === 0) {
    const emptyItem = document.createElement('li');
    emptyItem.className = 'doc-empty';
    emptyItem.textContent = 'No PDFs uploaded for this course yet.';
    documentList.appendChild(emptyItem);

    statusBadge.textContent = '0 Documents Indexed';
    statusBadge.classList.remove('active');
    questionInput.disabled = true;
    askBtn.disabled = true;
    generateQuizBtn.disabled = true;
    return;
  }

  for (const doc of state.documents) {
    const li = document.createElement('li');
    li.className = 'doc-item';

    const nameEl = document.createElement('div');
    nameEl.className = 'doc-item-name';
    nameEl.textContent = doc.filename;

    const metaEl = document.createElement('div');
    metaEl.className = 'doc-item-meta';
    metaEl.textContent = `${doc.pages} page(s) • ${doc.chunk_count} chunk(s) indexed`;

    li.appendChild(nameEl);
    li.appendChild(metaEl);
    documentList.appendChild(li);

    const opt = document.createElement('option');
    opt.value = doc.id;
    opt.textContent = doc.filename;
    docScopeSelect.appendChild(opt);
  }

  docScopeSelect.value = state.selectedDocumentId;
  statusBadge.textContent = `${state.documents.length} PDF(s) Indexed`;
  statusBadge.classList.add('active');
  questionInput.disabled = false;
  askBtn.disabled = false;
  generateQuizBtn.disabled = false;
}

async function loadCourses() {
  try {
    const res = await fetch('/api/courses');
    const data = await res.json();
    if (!res.ok) return;

    state.courses = data.courses || [];
    courseSelect.textContent = '';
    for (const course of state.courses) {
      const opt = document.createElement('option');
      opt.value = course.id;
      opt.textContent = course.name;
      courseSelect.appendChild(opt);
    }

    if (state.courses.some((c) => c.id === state.courseId)) {
      courseSelect.value = state.courseId;
    } else if (state.courses.length > 0) {
      state.courseId = state.courses[0].id;
      courseSelect.value = state.courseId;
    }
  } catch {
    // Ignore initial load error
  }
}

async function loadDocuments() {
  try {
    const res = await fetch(`/api/documents?courseId=${encodeURIComponent(state.courseId)}`);
    const data = await res.json();
    if (!res.ok) return;
    state.documents = data.documents || [];
    renderDocumentList();
  } catch {
    // Ignore initial load error
  }
}

async function loadQuizAndWeakTopics() {
  try {
    const res = await fetch(`/api/quiz?courseId=${encodeURIComponent(state.courseId)}`);
    const data = await res.json();
    if (!res.ok) return;
    state.questions = data.questions || [];
    state.weakTopics = data.weakTopics || [];
    renderQuizQuestions();
    renderWeakTopics();
  } catch {
    // Ignore initial load error
  }
}

courseSelect.addEventListener('change', async () => {
  state.courseId = courseSelect.value;
  state.selectedDocumentId = '';
  await loadDocuments();
  await loadQuizAndWeakTopics();
});

docScopeSelect.addEventListener('change', () => {
  state.selectedDocumentId = docScopeSelect.value;
});

courseForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = newCourseNameInput.value.trim();
  if (!name) return;

  try {
    const res = await fetch('/api/courses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Failed to create course.');
    }

    newCourseNameInput.value = '';
    state.courseId = data.course.id;
    state.selectedDocumentId = '';
    await loadCourses();
    await loadDocuments();
    await loadQuizAndWeakTopics();
  } catch (err) {
    showFeedback(uploadFeedback, err.message, 'error');
  }
});

uploadForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  hideFeedback(uploadFeedback);

  const file = pdfFileInput.files?.[0];
  if (!file) {
    showFeedback(uploadFeedback, 'Please select a PDF file first.', 'error');
    return;
  }

  if (!file.name.toLowerCase().endsWith('.pdf') || file.type !== 'application/pdf') {
    showFeedback(uploadFeedback, 'Invalid file type. Only PDF (.pdf) files are allowed.', 'error');
    return;
  }

  if (file.size > MAX_FILE_SIZE_BYTES) {
    showFeedback(uploadFeedback, 'File is too large. Maximum allowed size is 20 MB.', 'error');
    return;
  }

  state.isUploading = true;
  uploadBtn.disabled = true;
  uploadBtn.textContent = 'Parsing & Embedding...';
  showFeedback(
    uploadFeedback,
    'Extracting text per page, chunking, and generating embeddings...',
    'info'
  );

  try {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('courseId', state.courseId);

    const response = await fetch('/api/upload', {
      method: 'POST',
      body: formData,
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Failed to upload PDF.');
    }

    await loadDocuments();
    pdfFileInput.value = '';
    questionInput.focus();

    const cacheNote = data.cached ? ' (loaded from cache)' : '';
    showFeedback(
      uploadFeedback,
      `Indexed "${data.filename}": ${data.pages} page(s), ${data.chunkCount} chunk(s)${cacheNote}.`,
      'success'
    );
  } catch (error) {
    showFeedback(uploadFeedback, error.message, 'error');
  } finally {
    state.isUploading = false;
    uploadBtn.disabled = false;
    uploadBtn.textContent = 'Upload & Index PDF';
  }
});

askForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  hideFeedback(askFeedback);

  if (state.documents.length === 0) {
    showFeedback(askFeedback, 'Please upload at least one PDF in this course first.', 'error');
    return;
  }

  const question = questionInput.value.trim();
  if (!question) {
    showFeedback(askFeedback, 'Please enter a non-empty question.', 'error');
    return;
  }

  state.isAsking = true;
  askBtn.disabled = true;
  questionInput.disabled = true;
  askBtn.textContent = 'Retrieving & Thinking...';

  appendMessage('user', question);
  questionInput.value = '';

  try {
    const payload = {
      courseId: state.courseId,
      question,
    };
    if (state.selectedDocumentId) {
      payload.documentId = state.selectedDocumentId;
    }

    const response = await fetch('/api/ask', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Failed to get an answer from StudyPilot.');
    }

    appendMessage('assistant', data.answer, data.citations || []);
  } catch (error) {
    showFeedback(askFeedback, error.message, 'error');
  } finally {
    state.isAsking = false;
    askBtn.disabled = false;
    questionInput.disabled = false;
    askBtn.textContent = 'Ask StudyPilot (RAG)';
    questionInput.focus();
  }
});

quizForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  hideFeedback(quizFeedback);

  if (state.documents.length === 0) {
    showFeedback(quizFeedback, 'Upload a PDF before generating a quiz.', 'error');
    return;
  }

  state.isGeneratingQuiz = true;
  generateQuizBtn.disabled = true;
  generateQuizBtn.textContent = 'Generating...';
  showFeedback(quizFeedback, 'Generating structured multiple-choice questions with Gemini...', 'info');

  try {
    const payload = {
      courseId: state.courseId,
      count: Number(quizCountSelect.value) || 3,
      topic: quizTopicInput.value.trim(),
    };
    if (state.selectedDocumentId) {
      payload.documentId = state.selectedDocumentId;
    }

    const res = await fetch('/api/quiz/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Failed to generate quiz.');
    }

    await loadQuizAndWeakTopics();
    showFeedback(
      quizFeedback,
      `Generated ${data.questions.length} multiple-choice question(s)! Click an option below to test yourself.`,
      'success'
    );
  } catch (err) {
    showFeedback(quizFeedback, err.message, 'error');
  } finally {
    state.isGeneratingQuiz = false;
    generateQuizBtn.disabled = false;
    generateQuizBtn.textContent = 'Generate Quiz';
  }
});

// Initialize on load
await loadCourses();
await loadDocuments();
await loadQuizAndWeakTopics();
