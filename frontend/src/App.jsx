import React, { useState, useEffect } from 'react';

/**
 * StudyPilot React (Vite) Component Architecture (M6)
 * Mirrors the full StudyPilot feature set: Auth, Courses, Multimodal Upload,
 * RAG Chat with Clickable Citations, Structured Output Quiz, Weak-Point Dashboard, and Study Planner Agent.
 */
export default function App() {
  const [courses, setCourses] = useState([]);
  const [courseId, setCourseId] = useState('default-course');
  const [documents, setDocuments] = useState([]);
  const [weakTopics, setWeakTopics] = useState([]);
  const [questions, setQuestions] = useState([]);
  const [chatMessages, setChatMessages] = useState([]);
  const [questionText, setQuestionText] = useState('');
  const [plannerPrompt, setPlannerPrompt] = useState('I have an exam in 7 days, 2 hours a day');
  const [studyPlan, setStudyPlan] = useState(null);

  useEffect(() => {
    fetch('/api/courses')
      .then((r) => r.json())
      .then((d) => setCourses(d.courses || []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch(`/api/documents?courseId=${encodeURIComponent(courseId)}`)
      .then((r) => r.json())
      .then((d) => setDocuments(d.documents || []))
      .catch(() => {});

    fetch(`/api/quiz?courseId=${encodeURIComponent(courseId)}`)
      .then((r) => r.json())
      .then((d) => {
        setQuestions(d.questions || []);
        setWeakTopics(d.weakTopics || []);
      })
      .catch(() => {});
  }, [courseId]);

  const handleAsk = async (e) => {
    e.preventDefault();
    if (!questionText.trim()) return;
    const q = questionText.trim();
    setQuestionText('');
    setChatMessages((prev) => [...prev, { role: 'user', text: q }]);

    const res = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ courseId, question: q }),
    });
    const data = await res.json();
    if (res.ok) {
      setChatMessages((prev) => [
        ...prev,
        { role: 'assistant', text: data.answer, citations: data.citations || [] },
      ]);
    }
  };

  const handlePlan = async (e) => {
    e.preventDefault();
    const res = await fetch('/api/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ courseId, prompt: plannerPrompt }),
    });
    const data = await res.json();
    if (res.ok) {
      setStudyPlan(data);
    }
  };

  return (
    <div className="container">
      <header className="app-header">
        <h1>StudyPilot (React + Vite)</h1>
        <span className="badge active">{documents.length} Materials Indexed</span>
      </header>

      <main className="main-grid">
        <aside className="sidebar-col">
          <section className="card">
            <h2>Active Course</h2>
            <select
              className="select-input"
              value={courseId}
              onChange={(e) => setCourseId(e.target.value)}
            >
              {courses.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </section>

          <section className="card">
            <h2>Weak-Point Dashboard</h2>
            <ul>
              {weakTopics.map((wt) => (
                <li key={wt.topic}>
                  <strong>{wt.topic}</strong>: {wt.errorRate}% error rate ({wt.accuracy}% accuracy)
                </li>
              ))}
            </ul>
          </section>
        </aside>

        <div className="content-col">
          <section className="card">
            <h2>Ask StudyPilot (Hybrid RAG)</h2>
            <div className="chat-history">
              {chatMessages.map((m, idx) => (
                <div key={idx} className={`message ${m.role}`}>
                  {m.text}
                </div>
              ))}
            </div>
            <form onSubmit={handleAsk}>
              <textarea
                value={questionText}
                onChange={(e) => setQuestionText(e.target.value)}
                placeholder="Ask a question..."
              />
              <button type="submit" className="btn btn-primary">
                Ask
              </button>
            </form>
          </section>

          <section className="card">
            <h2>Agent: Study Planner ({questions.length} Quiz Questions Ready)</h2>
            <form onSubmit={handlePlan} className="input-row">
              <input
                type="text"
                value={plannerPrompt}
                onChange={(e) => setPlannerPrompt(e.target.value)}
              />
              <button type="submit" className="btn btn-primary">
                Run Planner Agent
              </button>
            </form>
            {studyPlan?.plan && (
              <div className="planner-schedule">
                {studyPlan.plan.schedule.map((d) => (
                  <div key={d.day} className="day-card">
                    <strong>
                      Day {d.day} ({d.hours}h)
                    </strong>
                    <div>{d.focusTopic}</div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
