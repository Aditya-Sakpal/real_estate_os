import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: { id: string } & DefaultSession["user"];
    /** How this session was started; a phone session holds less. */
    method?: "oauth" | "sso" | "phone";
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    userId?: string;
    method?: string;
  }
}

export {};
