import { createServerSupabaseClient } from "./supabase/server";

export async function getSession() {
  try {
    const supabase = await createServerSupabaseClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();

    return session;
  } catch (error) {
    console.error("Error getting session:", error);
    return null;
  }
}

export async function getUser() {
  try {
    const session = await getSession();
    return session?.user || null;
  } catch (error) {
    console.error("Error getting user:", error);
    return null;
  }
}
