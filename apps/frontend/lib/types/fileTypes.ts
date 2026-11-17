// What an uploaded file is for (POST /files `kind`). Limits are checked by the backend:
// AVATAR 2 MB (JPEG, PNG, WebP), COURSE_COVER 5 MB (same types), LESSON_ATTACHMENT 25 MB.
export type FileKind = "AVATAR" | "COURSE_COVER" | "LESSON_ATTACHMENT";

// Response of POST /files (FileAssetDto).
export type FileAsset = {
  id: string;
  kind: FileKind;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  url: string | null; // public URL for AVATAR / COURSE_COVER, null for attachments (signed URLs only)
};
