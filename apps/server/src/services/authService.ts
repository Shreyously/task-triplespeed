import bcrypt from "bcryptjs";
import { STARTING_BALANCE } from "@pullvault/common";
import { withTx, pool } from "../db/pool";
import { createUser, getUserByEmail } from "../repositories/userRepository";
import { createBalance } from "../repositories/balanceRepository";
import { signToken } from "../utils/jwt";

export async function signup(email: string, password: string) {
  return withTx(async (client) => {
    const existing = await getUserByEmail(client, email);
    if (existing) throw new Error("Email already in use");
    const hash = await bcrypt.hash(password, 10);
    const user = await createUser(client, email, hash);
    await createBalance(client, user.id, STARTING_BALANCE);
    const token = signToken({ userId: user.id, email: user.email });
    return { token, user: { id: user.id, email: user.email } };
  });
}

export async function login(email: string, password: string) {
  const client = await pool.connect();
  try {
    const user = await getUserByEmail(client, email);
    if (!user) throw new Error("Invalid credentials");
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) throw new Error("Invalid credentials");
    const token = signToken({ userId: user.id, email: user.email });
    return { token, user: { id: user.id, email: user.email } };
  } finally {
    client.release();
  }
}
