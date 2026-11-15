import crypto from 'node:crypto';

/**
 * In-memory store for uploaded PDF metadata during M1.
 * Maps fileId -> { fileId, filename, size, mimeType, geminiUri, geminiName, inlineBase64, uploadedAt }
 */
const filesMap = new Map();

export function saveFileRecord({
  filename,
  size,
  mimeType = 'application/pdf',
  geminiUri = null,
  geminiName = null,
  inlineBase64 = null,
}) {
  const fileId = crypto.randomUUID();
  const record = {
    fileId,
    filename,
    size,
    mimeType,
    geminiUri,
    geminiName,
    inlineBase64,
    uploadedAt: new Date().toISOString(),
  };
  filesMap.set(fileId, record);
  return record;
}

export function getFileRecord(fileId) {
  return filesMap.get(fileId) || null;
}

export function clearFileStore() {
  filesMap.clear();
}

