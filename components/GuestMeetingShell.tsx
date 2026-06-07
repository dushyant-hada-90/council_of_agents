interface GuestMeetingShellProps {
  topic: string;
  children: React.ReactNode;
}

export function GuestMeetingShell({ topic, children }: GuestMeetingShellProps) {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-surface-border px-6 py-4 flex justify-between items-center">
        <div>
          <span className="text-xl font-semibold">Council of Agents</span>
          <p className="text-sm text-gray-500 truncate max-w-md">{topic}</p>
        </div>
        <nav className="flex gap-3 text-sm">
          <a href="/login" className="text-gray-300 hover:text-white">
            Log in
          </a>
          <a href="/signup" className="btn-primary text-sm px-4 py-1.5">
            Sign up
          </a>
        </nav>
      </header>
      <main className="flex-1 p-6">{children}</main>
    </div>
  );
}
