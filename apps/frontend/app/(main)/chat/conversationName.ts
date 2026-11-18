import { Conversation } from "@/lib/types/chatTypes";

// DIRECT -> the other person's name, GROUP / COURSE_CHANNEL -> the title
export const getConversationName = (c: Conversation): string =>
  (c.type === "DIRECT" ? c.peer?.fullName : c.title) ?? "Unknown";
