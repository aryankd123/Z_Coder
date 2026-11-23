/**
 * Labelled input with an optional inline error message. Used by the login and signup forms.
 * @param {{ label: string, error?: string } & import('react').InputHTMLAttributes<HTMLInputElement>} props
 */
export default function FormField({ label, error, id, ...inputProps }) {
  const errorId = error ? `${id}-error` : undefined;
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium text-slate-300">
        {label}
      </label>
      <input
        id={id}
        aria-invalid={Boolean(error)}
        aria-describedby={errorId}
        className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
        {...inputProps}
      />
      {error && (
        <p id={errorId} className="text-sm text-rose-400">
          {error}
        </p>
      )}
    </div>
  );
}
