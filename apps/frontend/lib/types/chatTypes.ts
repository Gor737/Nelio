export type ConversationType = 'DIRECT' | 'GROUP' | 'COURSE_CHANNEL';
export type MemberRole = 'MEMBER' | 'ADMIN';

export type ChatPerson = {
  id: string;
  fullName: string;
  avatarUrl: string | null;
};

export type Conversation = {
  id: string;
  type: ConversationType;
  title: string | null;        // DIRECT-ի դեպքում null
  courseId: string | null;
  peer: ChatPerson | null;     // միայն DIRECT-ի դեպքում
  memberCount: number;
  myRole: MemberRole;
  isMuted: boolean;
  unreadCount: number;
  lastSeq: number;
  lastReadSeq: number;
  lastMessageAt: string | null; // ISO date
  readOnly: boolean;
  createdAt: string;
};

export type ConversationsPage = {
  items: Conversation[];
  page: number;
  pageSize: number;
  total: number;
};

export type MessageSender = {
  id: string;
  fullName: string;
};

export type Message = {
  id: string;
  conversationId: string;
  seq: number;             
  sender: MessageSender;
  body: string | null;     
  clientId: string;
  deleted: boolean;
  editedAt: string | null;
  createdAt: string;
};

export type MessageHistory = {
  items: Message[];        
  hasMore: boolean;        
};