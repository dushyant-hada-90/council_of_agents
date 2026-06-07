import { getSession } from "@/lib/auth/session";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { redirect } from "next/navigation";

export interface AppUser {
  id: string;
  username: string;
  display_name: string | null;
}

export function getDb() {
  return getSupabaseAdmin();
}

export async function getUser(): Promise<AppUser | null> {
  const session = await getSession();
  if (!session) return null;

  const db = getDb();
  const { data, error } = await db
    .from("app_users")
    .select("id, username, display_name")
    .eq("id", session.userId)
    .single();

  if (error || !data) return null;
  return data as AppUser;
}

export async function requireUser(): Promise<AppUser> {
  const user = await getUser();
  if (!user) throw new Error("Unauthorized");
  return user;
}

export async function requireUserOrRedirect(
  redirectTo = "/login"
): Promise<AppUser> {
  const user = await getUser();
  if (!user) redirect(redirectTo);
  return user;
}
