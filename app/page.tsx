import Link from "next/link";
import { redirect } from "next/navigation";
import { getUser } from "@/lib/supabase/server";

export default async function HomePage() {
  const user = await getUser();
  if (user) redirect("/dashboard");

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-surface-border px-6 py-4 flex justify-between items-center">
        <span className="text-xl font-semibold">Council of Agents</span>
        <nav className="flex gap-4">
          <Link href="/login" className="text-gray-300 hover:text-white">Log in</Link>
          <Link href="/signup" className="btn-primary">Sign up</Link>
        </nav>
      </header>

      <main className="flex-1 flex flex-col items-center justify-center px-6 text-center">
        <h1 className="text-4xl md:text-5xl font-bold mb-4">
          Multi-Agent Voice Conferences
        </h1>
        <p className="text-gray-400 max-w-xl mb-8">
          Create AI advisors with unique personalities, configure meetings, and participate
          in real-time voice discussions with multiple AI participants.
        </p>
        <Link href="/signup" className="btn-primary text-lg px-8 py-3">
          Get Started
        </Link>
      </main>
    </div>
  );
}
