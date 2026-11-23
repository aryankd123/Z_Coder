'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { ApiError } from '@/lib/api';
import { safeRedirect } from '@/lib/safe-redirect';
import FormField from '@/components/FormField';

const MESSAGES = {
  INVALID_CREDENTIALS: 'Email or password is incorrect.',
  RATE_LIMITED: 'Too many failed attempts. Wait a few minutes and try again.',
  NETWORK_ERROR: 'Could not reach the server. Is the API running?',
};

function LoginForm() {
  const { status, login } = useAuth();
  const router = useRouter();
  const next = safeRedirect(useSearchParams().get('next'));
  const [form, setForm] = useState({ email: '', password: '' });
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Already logged in? Go straight to the destination.
  useEffect(() => {
    if (status === 'authenticated') router.replace(next);
  }, [status, router, next]);

  async function handleSubmit(event) {
    event.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      await login(form);
      router.replace(next);
    } catch (err) {
      setError((err instanceof ApiError && MESSAGES[err.code]) || err.message || 'Login failed.');
    } finally {
      setSubmitting(false);
    }
  }

  const update = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

  return (
    <form onSubmit={handleSubmit} className="mx-auto max-w-sm space-y-5 rounded-lg border border-slate-800 bg-slate-900 p-6" noValidate>
      <h1 className="text-2xl font-semibold">Log in</h1>
      {error && (
        <p role="alert" className="rounded-md bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
          {error}
        </p>
      )}
      <FormField id="email" label="Email" type="email" autoComplete="email" required value={form.email} onChange={update('email')} />
      <FormField
        id="password"
        label="Password"
        type="password"
        autoComplete="current-password"
        required
        value={form.password}
        onChange={update('password')}
      />
      <button
        type="submit"
        disabled={submitting || !form.email || !form.password}
        className="w-full rounded-md bg-emerald-500 py-2 font-medium text-slate-950 hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submitting ? 'Logging in…' : 'Log in'}
      </button>
      <p className="text-center text-sm text-slate-400">
        No account?{' '}
        <Link href="/signup" className="text-emerald-400 hover:underline">
          Sign up
        </Link>
      </p>
    </form>
  );
}

export default function LoginPage() {
  // useSearchParams() needs a Suspense boundary in the App Router.
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
