// State of my Teacher application (GET /me/teacher-application). NONE = never applied.
export type ApplicationStatus = "NONE" | "PENDING" | "ACTIVE" | "REJECTED" | "REVOKED";

export type TeacherApplication = {
  status: ApplicationStatus;
  message: string | null;
  decisionNote: string | null; // the Admin's note on a rejection / revocation
  decidedAt: string | null;
};

// Body of POST /me/teacher-application. 10–1000 characters.
export type ApplyTeacherRequest = {
  message: string;
};
