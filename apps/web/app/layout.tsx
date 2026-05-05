import "./globals.css";
import { ReactNode } from "react";
import { Navbar } from "../components/Navbar";
import Link from "next/link";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="flex min-h-screen flex-col">
        <Navbar />
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-4 sm:px-6 sm:py-6">{children}</main>
        <footer className="border-t border-slate-800 bg-slate-950/80 px-4 py-4 text-sm text-slate-400 sm:px-6">
          <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-2">
            <p>PullVault fairness tools are publicly verifiable.</p>
            <div className="flex items-center gap-3">
              <Link href="/verify" className="text-cyan-400 hover:text-cyan-300">Verify Fairness</Link>
              <Link href="/audit" className="text-cyan-400 hover:text-cyan-300">Public Audit</Link>
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
}
