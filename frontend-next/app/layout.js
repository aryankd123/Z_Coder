import './globals.css';
import { AuthProvider } from '@/lib/auth-context';
import Navbar from '@/components/Navbar';

export const metadata = {
  title: 'ZCoder: code together in real time',
  description: 'Collaborative coding rooms with a shared editor, live chat and code execution.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <AuthProvider>
          <Navbar />
          <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
        </AuthProvider>
      </body>
    </html>
  );
}
