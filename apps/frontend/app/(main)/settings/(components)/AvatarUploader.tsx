import { ChangeEvent, useRef, useState } from "react";
import { useUpdateMeMutation } from "@/lib/features/auth/authApi";
import { useUploadFileMutation } from "@/lib/features/files/filesApi";
import { getErrorMessage } from "@/lib/api/errors";
import { MeResponse } from "@/lib/types/authTypes";
import styles from "./Settings.module.css";

const MAX_AVATAR_BYTES = 2 * 1024 * 1024; // backend limit for AVATAR

// Avatar circle + "Upload photo" / "Remove photo". Two requests:
// 1) POST /files (kind AVATAR) → file id, 2) PATCH /me { avatarFileId }.
export const AvatarUploader = ({ me }: { me: MeResponse }) => {
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploadFile, { isLoading: uploading }] = useUploadFileMutation();
  const [updateMe, { isLoading: saving }] = useUpdateMeMutation();
  const busy = uploading || saving;

  const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = ""; // allow picking the same file again
    if (!file) return;
    if (file.size > MAX_AVATAR_BYTES) return setError("The image can be at most 2 MB.");
    setError(null);
    try {
      const formData = new FormData();
      formData.append("kind", "AVATAR");
      formData.append("file", file);
      const uploaded = await uploadFile(formData).unwrap();
      await updateMe({ avatarFileId: uploaded.id }).unwrap();
    } catch (err) {
      setError(getErrorMessage(err, undefined, {
        FILE_TOO_LARGE: "The image can be at most 2 MB.",
        FILE_TYPE_NOT_ALLOWED: "Use a JPEG, PNG or WebP image.",
      }));
    }
  };

  const handleRemove = async () => {
    setError(null);
    try {
      await updateMe({ avatarFileId: null }).unwrap();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  };

  return (
    <div className={styles.avatarRow}>
      <span className={styles.avatar} aria-hidden="true">
        {me.fullName.charAt(0)}
        {me.avatarUrl && <img className={styles.avatarImg} src={me.avatarUrl} alt="" />}
      </span>
      <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={handleFile} />
      <button type="button" className={styles.secondaryButton} disabled={busy} onClick={() => fileRef.current?.click()}>
        {busy ? "Uploading…" : "Upload photo"}
      </button>
      {me.avatarUrl && (
        <button type="button" className={styles.textButton} disabled={busy} onClick={handleRemove}>
          Remove photo
        </button>
      )}
      {error && <p className={styles.errorText} role="alert">{error}</p>}
    </div>
  );
};
