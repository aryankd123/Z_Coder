'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { ApiError } from '@/lib/api';
import FormField from '@/components/FormField';

/**
 * Client-side checks are only for fast feedback. The server validates
 * everything again with zod, and its answer is the one that counts.
 */
function clientErrors({ name, email, password, confirm }) {
  const errors = {};
  if (!name.trim()) errors.name = 'Name is required.';
  if (!/^\S+@\S+\.\S+$/.test(email.trim())) errors.email = 'Enter a valid email address.';
  if (password.length < 8) errors.password = 'At least 8 characters.';
  else if (new TextEncoder().encode(password).length > 72) errors.password = 'At most 72 bytes.';
  if (confirm !== password) errors.confirm = 'Passwords do not match.';
  return errors;
}

export default function SignupPage() {
  const { status, signup } = useAuth();
  const router = useRouter();
  const [form, setForm] = useState({ name: '', email: '', password: '', confirm: '' });
  const [fieldErrors, setFieldErrors] = useState({});
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (status === 'authenticated') router.replace('/');
  }, [status, router]);

  async function handleSubmit(event) {
    event.preventDefault();
    setError('');
    const errors = clientErrors(form);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setSubmitting(true);
    try {
      await signup({ name: form.name, email: form.email, password: form.password });
      router.replace('/');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'EMAIL_TAKEN') {
        setFieldErrors({ email: 'An account with this email already exists.' });
      } else if (err instanceof ApiError && err.code === 'VALIDATION_FAILED') {
        // Show the server's per-field messages next to the fields.
        setFieldErrors(Object.fromEntries((err.details ?? []).map((d) => [d.path, `Server: ${d.message}`])));
      } else {
        setError(err.message || 'Sign up failed.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  const update = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

  return (
    <form onSubmit={handleSubmit} className="mx-auto max-w-sm space-y-5 rounded-lg border border-slate-800 bg-slate-900 p-6" noValidate>
      <h1 className="text-2xl font-semibold">Create an account</h1>
      {error && (
        <p role="alert" className="rounded-md bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
          {error}
        </p>
      )}
      <FormField id="name" label="Name" autoComplete="name" value={form.name} onChange={update('name')} error={fieldErrors.name} />
      <FormField id="email" label="Email" type="email" autoComplete="email" value={form.email} onChange={update('email')} error={fieldErrors.email} />
      <FormField
        id="password"
        label="Password"
        type="password"
        autoComplete="new-password"
        value={form.password}
        onChange={update('password')}
        error={fieldErrors.password}
      />
      <FormField
        id="confirm"
        label="Confirm password"
        type="password"
        autoComplete="new-password"
        value={form.confirm}
        onChange={update('confirm')}
        error={fieldErrors.confirm}
      />
      <button
        type="submit"
        disabled={submitting}
        className="w-full rounded-md bg-emerald-500 py-2 font-medium text-slate-950 hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submitting ? 'Creating account…' : 'Sign up'}
      </button>
      <p className="text-center text-sm text-slate-400">
        Already have an account?{' '}
        <Link href="/login" className="text-emerald-400 hover:underline">
          Log in
        </Link>
      </p>
    </form>
  );
}
