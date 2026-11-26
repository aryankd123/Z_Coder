import Link from 'next/link';

/** Shown for any URL that doesn't match a page. */
export default function NotFound() {
  return (
    <div className="mx-auto max-w-md space-y-3 py-16 text-center">
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p className="text-slate-400">That page doesn&apos;t exist.</p>
      <Link href="/" className="text-emerald-400 hover:underline">
        Go home
      </Link>
    </div>
  );
}
