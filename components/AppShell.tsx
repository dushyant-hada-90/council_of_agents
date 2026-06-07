"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

const nav = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/agents", label: "Agents" },
  { href: "/meetings", label: "Meetings" },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-surface-border px-6 py-3 flex justify-between items-center bg-surface-raised">
        <div className="flex items-center gap-8">
          <Link href="/dashboard" className="text-lg font-semibold">
            Council of Agents
          </Link>
          <nav className="hidden md:flex gap-1">
            {nav.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={`px-3 py-1.5 rounded-lg text-sm ${
                  pathname.startsWith(item.href)
                    ? "bg-accent-muted text-accent"
                    : "text-gray-400 hover:text-white"
                }`}
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
        <button onClick={handleLogout} className="btn-secondary text-sm">
          Log out
        </button>
      </header>
      <main className="flex-1 p-6 max-w-7xl mx-auto w-full">{children}</main>
    </div>
  );
}
