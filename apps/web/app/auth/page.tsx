"use client";
import { useState } from "react";
import { API_BASE } from "../../lib/config";

export default function AuthPage() {
  const [email, setEmail] = useState("test@example.com");
  const [password, setPassword] = useState("password123");
  const [msg, setMsg] = useState("");

  async function submit(path: "signup" | "login") {
    const r = await fetch(`${API_BASE}/auth/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password })
    });
    const data = await r.json();
    if (r.ok) {
      localStorage.setItem("token", data.token);
      setMsg(`Success ${path}`);
      return;
    }
    setMsg(data.error || "Failed");
  }

  return (
    <div className="card max-w-md space-y-3">
      <h1 className="text-2xl font-bold">Auth</h1>
      <input className="w-full rounded bg-slate-800 p-2" value={email} onChange={(e) => setEmail(e.target.value)} />
      <input className="w-full rounded bg-slate-800 p-2" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      <div className="flex gap-2">
        <button className="rounded bg-cyan-500 px-3 py-2 text-slate-900" onClick={() => submit("signup")}>Signup</button>
        <button className="rounded bg-slate-300 px-3 py-2 text-slate-900" onClick={() => submit("login")}>Login</button>
      </div>
      <p>{msg}</p>
    </div>
  );
}
