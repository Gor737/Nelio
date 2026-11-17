export type RegisterResponse = {
  message: string;
};

export type RegisterRequest = {
  fullName: string;
  email: string;
  password: string;
};

export type LoginRequest = {
  email: string;
  password: string;
};

export type LoginResponse = {
  accessToken: string;
  tokenType: string;
  expiresIn: number;
};

// Body of PATCH /me: only these two fields are allowed. avatarFileId: null removes the avatar.
export type UpdateMeRequest = {
  fullName?: string;
  avatarFileId?: string | null;
};

// Body of POST /auth/change-password. newPassword: 10–128 characters.
export type ChangePasswordRequest = {
  currentPassword: string;
  newPassword: string;
};

export type VerifyRequest = {
  token: string;
};

// One role row of the account; only ACTIVE roles grant anything (e.g. TEACHER → Studio).
export type RoleState = {
  role: string; // STUDENT | TEACHER | ADMIN
  status: string; // ACTIVE | PENDING | ...
};

// Response of GET /me and PATCH /me (MeDto). The only response that contains the email.
export type MeResponse = {
  id: string;
  email: string;
  fullName: string;
  avatarUrl: string | null;
  roles: RoleState[];
  emailVerified: boolean;
  createdAt: string; // ISO date
};
