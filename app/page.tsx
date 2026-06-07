import Link from "next/link";
import { getUser } from "@/lib/supabase/server";
import { PromptLanding } from "@/components/landing/PromptLanding";

export default async function HomePage() {
  const user = await getUser();

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-surface-border px-6 py-4 flex justify-between items-center">
        <span className="text-xl font-semibold">Council of Agents</span>
        <nav className="flex gap-4">
          {user ? (
            <Link href="/dashboard" className="btn-primary">
              Dashboard
            </Link>
          ) : (
            <>
              <Link href="/login" className="text-gray-300 hover:text-white">
                Log in
              </Link>
              <Link href="/signup" className="btn-primary">
                Sign up
              </Link>
            </>
          )}
        </nav>
      </header>

      <main className="flex-1">
        <PromptLanding isLoggedIn={!!user} />
      </main>
    </div>
  );
}
