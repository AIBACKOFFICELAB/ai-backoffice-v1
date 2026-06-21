"use client";

import { useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";

export default function LogoutPage() {
  const router = useRouter();

  useEffect(() => {
    const logout = async () => {
      const supabase = createClient();
      await supabase.auth.signOut();
      router.push("/auth/login");
    };

    logout();
  }, [router]);

  return (
    <div className="flex items-center justify-center min-h-screen bg-slate-50">
      <div className="text-center">
        <p className="text-slate-600">Signing you out...</p>
      </div>
    </div>
  );
}
