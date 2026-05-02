"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

export function Navbar() {
  const pathname = usePathname();
  const router = useRouter();
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  useEffect(() => {
    const checkAuth = () => {
      setIsAuthenticated(!!localStorage.getItem("token"));
    };

    checkAuth();
    window.addEventListener("storage", checkAuth);
    window.addEventListener("auth-change", checkAuth);

    return () => {
      window.removeEventListener("storage", checkAuth);
      window.removeEventListener("auth-change", checkAuth);
    };
  }, []);

  const handleLogout = () => {
    localStorage.removeItem("token");
    window.dispatchEvent(new Event("auth-change"));
    router.push("/auth");
  };

  const navLinks = [
    { href: "/", label: "Packs" },
    { href: "/collection", label: "Collection" },
    { href: "/marketplace", label: "Marketplace" },
    { href: "/auctions", label: "Auctions" },
    { href: "/admin/analytics", label: "Analytics" }
  ];

  return (
    <header className="sticky top-0 z-50 border-b border-slate-800 bg-slate-950/80 px-4 py-3 backdrop-blur-md sm:px-6 sm:py-4">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 sm:gap-3">
        <div className="flex min-w-0 items-center gap-3 sm:gap-8">
          <Link href="/" className="bg-gradient-to-r from-cyan-400 to-indigo-400 bg-clip-text text-lg font-bold text-transparent sm:text-xl">
            PullVault
          </Link>
          <nav className="hidden gap-2 md:flex">
            {navLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className={`rounded-md px-3 py-2 text-sm font-medium transition-colors hover:bg-slate-800 ${pathname === link.href ? "bg-slate-800 text-cyan-400" : "text-slate-300"}`}
              >
                {link.label}
              </Link>
            ))}
          </nav>
        </div>

        <div className="flex items-center gap-2 sm:gap-4">
          {isAuthenticated ? (
            <button
              onClick={handleLogout}
              className="rounded-md border border-slate-700 px-3 py-2 text-sm font-medium text-slate-300 transition-colors hover:bg-slate-800 hover:text-white sm:px-4"
            >
              Log Out
            </button>
          ) : (
            <Link
              href="/auth"
              className="rounded-md bg-cyan-500 px-3 py-2 text-sm font-semibold text-slate-900 transition-transform hover:scale-105 active:scale-95 sm:px-4"
            >
              Sign In
            </Link>
          )}
        </div>

        <nav className="flex w-full gap-2 overflow-x-auto pb-1 md:hidden">
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={`whitespace-nowrap rounded-md px-3 py-2 text-xs font-medium transition-colors ${pathname === link.href ? "bg-slate-800 text-cyan-400" : "bg-slate-900 text-slate-300"}`}
            >
              {link.label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}
