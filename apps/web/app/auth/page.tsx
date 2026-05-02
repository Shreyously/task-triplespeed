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
    } catch (err) {
      setMsg("Network error. Please try again.");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="flex min-h-[80vh] items-center justify-center">
      <div className="w-full max-w-md overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/50 shadow-2xl backdrop-blur-xl">
        {/* Header gradient */}
        <div className="h-2 w-full bg-gradient-to-r from-cyan-500 to-indigo-500"></div>

        <div className="p-8">
          <div className="mb-8 text-center">
            <h1 className="text-3xl font-bold tracking-tight text-white">
              {isLogin ? "Welcome back" : "Create an account"}
            </h1>
            <p className="mt-2 text-sm text-slate-400">
              {isLogin ? "Enter your details to access your vault." : "Join PullVault to start collecting."}
            </p>
          </div>

          <form onSubmit={submit} className="space-y-6">
            <div className="space-y-4">
              <div>
                <label className="mb-1 block text-sm font-medium text-slate-300">Email</label>
                <input
                  type="email"
                  className="w-full rounded-lg border border-slate-700 bg-slate-950/50 p-3 text-white placeholder-slate-500 outline-none transition-colors focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-slate-300">Password</label>
                <div className="relative">
                  <input
                    type={showPassword ? "text" : "password"}
                    className="w-full rounded-lg border border-slate-700 bg-slate-950/50 p-3 pr-10 text-white placeholder-slate-500 outline-none transition-colors focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute inset-y-0 right-0 flex items-center pr-3 text-slate-400 hover:text-slate-200"
                  >
                    {showPassword ? (
                      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 0 0 1.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.451 10.451 0 0 1 12 4.5c4.756 0 8.773 3.162 10.065 7.498a10.522 10.522 0 0 1-4.293 5.774M6.228 6.228 3 3m3.228 3.228 3.65 3.65m7.894 7.894L21 21m-3.228-3.228-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243m4.242 4.242L9.88 9.88" />
                      </svg>
                    ) : (
                      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z" />
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                      </svg>
                    )}
                  </button>
                </div>
              </div>
            </div>

            {msg && (
              <div className="rounded-lg bg-rose-500/10 p-3 text-sm text-rose-400 border border-rose-500/20">
                {msg}
              </div>
            )}

            <button
              type="submit"
              disabled={isLoading}
              className="w-full rounded-lg bg-gradient-to-r from-cyan-500 to-indigo-500 p-3 font-semibold text-white transition-all hover:from-cyan-400 hover:to-indigo-400 focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:ring-offset-2 focus:ring-offset-slate-900 disabled:opacity-50"
            >
              {isLoading ? "Please wait..." : (isLogin ? "Sign In" : "Sign Up")}
            </button>
          </form>

          <div className="mt-6 text-center text-sm text-slate-400">
            {isLogin ? "Don't have an account?" : "Already have an account?"}{" "}
            <button
              onClick={() => { setIsLogin(!isLogin); setMsg(""); }}
              className="font-medium text-cyan-400 hover:text-cyan-300 hover:underline"
            >
              {isLogin ? "Sign up" : "Sign in"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
