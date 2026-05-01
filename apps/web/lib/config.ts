const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:4000";
const SOCKET_BASE = process.env.NEXT_PUBLIC_SOCKET_BASE ?? "http://localhost:4000";

export { API_BASE, SOCKET_BASE };

export function uuid() {
  return crypto.randomUUID();
}
