import { Logo } from "@/components/Logo";
import { config } from "@/api/config";
import { LoginForm } from "./LoginForm";

export const metadata = { title: "Sign in · OTS admin" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; expired?: string }> }) {
  const { next, expired } = await searchParams;
  return (
    <div className="flex min-h-dvh items-center justify-center bg-surface px-4">
      <div className="w-full max-w-sm rounded-2xl border border-line bg-white p-8">
        <Logo />
        <h1 className="mt-6 text-xl font-semibold">Sign in to OTS admin</h1>
        <p className="mt-1 text-sm text-muted">Review dataset and sample requests from the booth.</p>
        {expired && (
          <p role="status" className="mt-4 rounded-lg bg-surface px-3 py-2 text-sm text-ink">
            You were signed out after {config.adminIdleMinutes} minutes away. Sign in again to continue.
          </p>
        )}
        <LoginForm next={next ?? "/admin"} />
      </div>
    </div>
  );
}
