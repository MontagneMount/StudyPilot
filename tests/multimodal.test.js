import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import { resetDbForTests } from '../src/db/index.js';
import { chunkAudioTranscript, enrichImageHeavyPages } from '../src/services/ingest.js';

describe('StudyPilot M4 Unit Tests (Audio Timestamp Chunking & Image-Heavy Slide Enrichment)', () => {
  it('converts timestamped audio transcript segments into chunks with timestamp citationLabels', () => {
    const segments = [
      { timestamp: '00:00', text: 'Welcome to Lecture 4 on convolutional neural networks.' },
      { timestamp: '02:15', text: 'Stride controls how the filter shifts across the input feature map.' },
    ];

    const chunks = chunkAudioTranscript(segments);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].citationLabel, '00:00');
    assert.equal(chunks[1].citationLabel, '02:15');
    assert.match(chunks[1].content, /\[Audio Timestamp 02:15\] Stride controls/);
  });

  it('detects image-heavy PDF pages (< 30 words) and enriches them with Gemini visual descriptions', async () => {
    const denseText = Array.from({ length: 45 }, (_, i) => `term${i}`).join(' ');
    const pages = [
      { page: 1, text: denseText, wordCount: 45, isImageHeavy: false },
      { page: 3, text: 'Figure 3: Loss Curve', wordCount: 4, isImageHeavy: true },
    ];

    let inspectedPages = [];
    const mockDescribeVisualPages = async (_filePath, pageNums) => {
      inspectedPages = pageNums;
      return [
        {
          page: 3,
          visualDescription:
            'Line chart showing training loss decreasing to 0.02 while validation loss plateaus at epoch 15.',
        },
      ];
    };

    const enriched = await enrichImageHeavyPages('dummy.pdf', pages, {
      describeVisualPages: mockDescribeVisualPages,
    });

    assert.deepEqual(inspectedPages, [3], 'Only image-heavy page 3 should be sent for visual analysis');
    assert.equal(enriched[0].text, denseText);
    assert.match(enriched[1].text, /validation loss plateaus at epoch 15/i);
    assert.equal(enriched[1].visualEnriched, true);
  });
});

describe('StudyPilot M4 Multimodal API Integration Tests (Audio Transcription & Slide Chart Vision)', () => {
  let server;
  let baseUrl;

  // Semantic mock vectors:
  // Dim 0: audio stride topic
  // Dim 1: visual chart epoch 15 topic
  // Dim 2: general intro
  function computeMultimodalVector(text) {
    const lower = text.toLowerCase();
    const v0 = lower.includes('stride') || lower.includes('filter') ? 0.95 : 0.05;
    const v1 = lower.includes('epoch 15') || lower.includes('validation loss') ? 0.95 : 0.05;
    const v2 = lower.includes('welcome') || lower.includes('syllabus') ? 0.9 : 0.1;
    return [v0, v1, v2];
  }

  const mockExtractPages = async () => [
    {
      page: 1,
      text: Array.from({ length: 35 }, () => 'introductory').join(' ') + ' welcome to the course.',
      wordCount: 39,
      isImageHeavy: false,
    },
    {
      page: 3,
      text: 'Figure 3: Overfitting Chart',
      wordCount: 4,
      isImageHeavy: true,
    },
  ];

  const mockDescribeVisualPages = async (_filePath, pageNums) =>
    pageNums.map((page) => ({
      page,
      visualDescription:
        'Chart on slide shows validation loss diverges and plateaus at epoch 15 due to overfitting.',
    }));

  const mockTranscribeAudio = async () => [
    { timestamp: '00:00', text: 'Welcome everyone to week 4 lecture recording.' },
    { timestamp: '02:15', text: 'A stride of 2 halves the spatial dimensions of the feature map.' },
  ];

  const mockDescribeImage = async () =>
    'Diagram of Encoder-Decoder architecture showing cross-attention arrows.';

  const mockEmbedChunks = async (texts) => texts.map((t) => computeMultimodalVector(t));
  const mockEmbedSearchQuery = async (q) => computeMultimodalVector(q);

  const mockAskRag = async ({ chunks }) => {
    const top = chunks[0];
    return {
      answer: `Answer from ${top.filename}: ${top.content} [${top.citationLabel}]`,
      model: 'gemini-3.8-flash',
    };
  };

  const app = createApp({
    dbPath: ':memory:',
    extractPages: mockExtractPages,
    describeVisualPages: mockDescribeVisualPages,
    transcribeAudio: mockTranscribeAudio,
    describeImage: mockDescribeImage,
    embedChunks: mockEmbedChunks,
    embedSearchQuery: mockEmbedSearchQuery,
    askRag: mockAskRag,
  });

  beforeEach(() => {
    resetDbForTests();
  });

  it('ingests lecture audio with timestamp citations and image-heavy PDF slides with chart vision', async () => {
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });

    // 1. Upload Lecture Audio (.mp3)
    {
      const form = new FormData();
      form.append(
        'file',
        new Blob(['ID3-mock-mp3-audio-bytes'], { type: 'audio/mpeg' }),
        'Lecture04_CNN_Audio.mp3'
      );

      const res = await fetch(`${baseUrl}/api/upload`, {
        method: 'POST',
        body: form,
      });
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.type, 'audio');
      assert.equal(body.chunkCount, 2);
    }

    // 2. Ask question answered by Lecture Audio -> returns timestamp citation [02:15]
    {
      const res = await fetch(`${baseUrl}/api/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: 'How does stride affect the spatial dimensions of the filter output?',
          topK: 1,
        }),
      });
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.match(body.answer, /\[02:15\]/);
      assert.equal(body.citations[0].docType, 'audio');
      assert.equal(body.citations[0].citationLabel, '02:15');
    }

    // 3. Upload PDF with an image-heavy chart slide (Page 3)
    {
      const form = new FormData();
      form.append(
        'file',
        new Blob(['%PDF-1.7\nSLIDES_WITH_CHART_ON_PAGE_3\n%%EOF'], { type: 'application/pdf' }),
        'Lecture05_Charts.pdf'
      );

      const res = await fetch(`${baseUrl}/api/upload`, {
        method: 'POST',
        body: form,
      });
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.type, 'pdf');
      assert.equal(body.pages, 2);
    }

    // 4. Ask question about the chart on Page 3 -> retrieves visual chart description with [p.3]
    {
      const res = await fetch(`${baseUrl}/api/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: 'At what epoch does validation loss plateau in the chart?',
          topK: 1,
        }),
      });
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.match(body.answer, /\[p\.3\]/);
      assert.equal(body.citations[0].page, 3);
      assert.equal(body.citations[0].citationLabel, 'p.3');
      assert.match(body.citations[0].content, /epoch 15/i);
    }
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
