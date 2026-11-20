export type AuthUser = { id: string; username: string; role: "admin" | "member" };
export type AuthState = { enabled: boolean; user: AuthUser | null };

export type RegisteredProject = {
  accessRole: "owner" | "editor";
  id: string;
  directory: string;
  name: string;
  lastOpenedAt: number;
};
