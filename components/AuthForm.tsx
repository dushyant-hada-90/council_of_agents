"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export function AuthForm({ mode }: { mode: "login" | "signup" }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const endpoint = mode === "signup" ? "/api/auth/signup" : "/api/auth/login";
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, displayName }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Authentication failed");

      router.push("/dashboard");
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="card w-full max-w-md">
        <h1 className="text-2xl font-bold mb-2">
          {mode === "login" ? "Welcome back" : "Create account"}
        </h1>
        <p className="text-gray-400 text-sm mb-6">
          {mode === "login"
            ? "Sign in with your username and password."
            : "Pick a username and password to get started."}
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1">Username</label>
            <input
              type="text"
              required
              autoComplete="username"
              pattern="[a-zA-Z0-9_]{3,32}"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full"
              placeholder="e.g. dushyant"
            />
            <p className="text-xs text-gray-500 mt-1">3–32 characters: letters, numbers, underscore</p>
          </div>
          {mode === "signup" && (
            <div>
              <label className="block text-sm text-gray-400 mb-1">Display name (optional)</label>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="w-full"
                placeholder="Your name in meetings"
              />
            </div>
          )}
          <div>
            <label className="block text-sm text-gray-400 mb-1">Password</label>
            <input
              type="password"
              required
              minLength={6}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full"
            />
          </div>
          {error && <p className="text-red-400 text-sm">{error}</p>}
          <button type="submit" disabled={loading} className="btn-primary w-full">
            {loading ? "Please wait…" : mode === "login" ? "Log in" : "Sign up"}
          </button>
        </form>

        <p className="text-sm text-gray-400 mt-4 text-center">
          {mode === "login" ? (
            <>No account? <Link href="/signup" className="text-accent">Sign up</Link></>
          ) : (
            <>Have an account? <Link href="/login" className="text-accent">Log in</Link></>
          )}
        </p>
      </div>
    </div>
  );
}
