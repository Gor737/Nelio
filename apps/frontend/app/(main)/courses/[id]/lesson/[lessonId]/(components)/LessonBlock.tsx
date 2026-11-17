import { ContentBlock } from "@/lib/types/lessonTypes";
import { FileIcon, PlayIcon } from "@/app/components/icons";
import styles from "./LessonPlayer.module.css";
import ReactMarkdown from "react-markdown";

type Props = {
  block: ContentBlock;
};

// One content block of the lesson: TEXT, VIDEO or FILE.
export const LessonBlock = ({ block }: Props) => {
  return (
    <section className={styles.block}>
      <span className={styles.blockType}>{block.type}</span>

      {block.type === "TEXT" && (
        <div className={styles.text}>
          <ReactMarkdown>{block.textBody ?? ""}</ReactMarkdown>
        </div>
      )}

      {block.type === "VIDEO" && (
        <div className={styles.video}>
          {block.video ? (
            <iframe
              src={block.video.embedUrl}
              title="Lesson video"
              allow="accelerometer; encrypted-media; gyroscope; picture-in-picture; fullscreen"
              allowFullScreen
            />
          ) : (
            // No video data: keep the placeholder
            <span className={styles.play}>
              <PlayIcon />
            </span>
          )}
        </div>
      )}

      {block.type === "FILE" && (
        <div className={styles.file}>
          <span className={styles.fileIcon}>
            <FileIcon />
          </span>
          <span className={styles.fileName}>{block.file?.name}</span>
          {/* TODO: GET …/blocks/:blockId/download, then open the returned url */}
          <button type="button" className={styles.secondaryButton} disabled>
            Download
          </button>
        </div>
      )}
    </section>
  );
};
