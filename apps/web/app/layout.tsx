import "./globals.css";
import Link from "next/link";
import { ReactNode } from "react";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="border-b border-slate-800 p-4 flex gap-4">
          <Link href="/">Packs</Link>
          <Link href="/collection">Collection</Link>
          <Link href="/marketplace">Marketplace</Link>
          <Link href="/auctions">Auctions</Link>
          <Link href="/admin/analytics">Analytics</Link>
          <Link href="/auth">Auth</Link>
        </header>
        <main className="mx-auto max-w-6xl p-6">{children}</main>
      </body>
    </html>
  );
}
