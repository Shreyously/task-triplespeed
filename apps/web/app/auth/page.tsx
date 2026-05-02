"use client";
import { useState } from "react";
import { API_BASE } from "../../lib/config";
import { useRouter } from "next/navigation";

export default function AuthPage() {
  const router = useRouter();
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [msg, setMsg] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setIsLoading(true);
    setMsg("");

    const path = isLogin ? "login" : "signup";

    try {
      const r = await fetch(`${API_BASE}/auth/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password })
      });
      const data = await r.json();

      if (r.ok) {
        localStorage.setItem("token", data.token);
        window.dispatchEvent(new Event("auth-change"));
        router.push("/collection");
        return;
      }
      setMsg(data.error || "Authentication failed");
    } catch {
      setMsg("Network error. Please try again.");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="flex min-h-[80vh] items-center justify-center px-1 sm:px-0">
      <div className="w-full max-w-md overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/50 shadow-2xl backdrop-blur-xl">
        <div className="h-2 w-full bg-gradient-to-r from-cyan-500 to-indigo-500"></div>

        <div className="p-5 sm:p-8">
          <div className="mb-6 text-center sm:mb-8">
            <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">{isLogin ? "Welcome back" : "Create an account"}</h1>
            <p className="mt-2 text-sm text-slate-400">{isLogin ? "Enter your details to access your vault." : "Join PullVault to start collecting."}</p>
          </div>

          <form onSubmit={submit} className="space-y-5 sm:space-y-6">
            <div className="space-y-4">
              <div>
                <label className="mb-1 block text-sm font-medium text-slate-300">Email</label>
                <input type="email" className="w-full rounded-lg border border-slate-700 bg-slate-950/50 p-3 text-white placeholder-slate-500 outline-none transition-colors focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500" value={email} onChange={(e) => setEmail(e.target.value)} required />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-slate-300">Password</label>
                <div className="relative">
                  <input type={showPassword ? "text" : "password"} className="w-full rounded-lg border border-slate-700 bg-slate-950/50 p-3 pr-10 text-white placeholder-slate-500 outline-none transition-colors focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500" value={password} onChange={(e) => setPassword(e.target.value)} required />
                  <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute inset-y-0 right-0 flex items-center pr-3 text-slate-400 hover:text-slate-200">{showPassword ? "Hide" : "Show"}</button>
                </div>
              </div>
            </div>

            {msg && <div className="safe-break rounded-lg border border-rose-500/20 bg-rose-500/10 p-3 text-sm text-rose-400">{msg}</div>}

            <button type="submit" disabled={isLoading} className="w-full rounded-lg bg-gradient-to-r from-cyan-500 to-indigo-500 p-3 font-semibold text-white transition-all hover:from-cyan-400 hover:to-indigo-400 focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:ring-offset-2 focus:ring-offset-slate-900 disabled:opacity-50">
              {isLoading ? "Please wait..." : (isLogin ? "Sign In" : "Sign Up")}
            </button>
          </form>

          <div className="mt-6 text-center text-sm text-slate-400">
            {isLogin ? "Don't have an account?" : "Already have an account?"}{" "}
            <button onClick={() => { setIsLogin(!isLogin); setMsg(""); }} className="font-medium text-cyan-400 hover:text-cyan-300 hover:underline">{isLogin ? "Sign up" : "Sign in"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
