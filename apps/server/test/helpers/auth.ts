import bcrypt from "bcryptjs";
import request from "supertest";
import { Express } from "express";
import { STARTING_BALANCE } from "@pullvault/common";
import { pool } from "../../src/db/pool";
import { signToken } from "../../src/utils/jwt";

interface SignupUserOptions {
  bypassHttp?: boolean;
  accountAgeHours?: number;
}

export async function signupUser(app: Express, label: string, options: SignupUserOptions = {}) {
  const email = `${label}-${Date.now()}-${Math.floor(Math.random() * 100000)}@test.local`;
  const password = "TestPass123!";

  if (!options.bypassHttp) {
    const response = await request(app).post("/signup").send({ email, password });
    if (response.status >= 400) {
      throw new Error(`Signup failed: ${response.status} ${JSON.stringify(response.body)}`);
    }

    if (options.accountAgeHours && options.accountAgeHours > 0) {
      await ageUserAccount(response.body.user.id as string, options.accountAgeHours);
    }

    return {
      email,
      password,
      token: response.body.token as string,
      userId: response.body.user.id as string
    };
  }

  const client = await pool.connect();
  try {
    const passwordHash = await bcrypt.hash(password, 10);
    const createdAt = new Date(Date.now() - ((options.accountAgeHours ?? 2) * 60 * 60 * 1000));
    const userResult = await client.query(
      `insert into users(email, password_hash, created_at)
       values($1, $2, $3)
       returning id, email`,
      [email, passwordHash, createdAt.toISOString()]
    );

    const user = userResult.rows[0] as { id: string; email: string };
    await client.query(
      `insert into balances(user_id, available_balance, held_balance, total_balance)
       values($1, $2, 0, $2)`,
      [user.id, STARTING_BALANCE]
    );

    return {
      email,
      password,
      token: signToken({ userId: user.id, email: user.email }),
      userId: user.id,
    };
  } finally {
    client.release();
  }
}

async function ageUserAccount(userId: string, hours: number): Promise<void> {
  await pool.query(
    `update users
     set created_at = now() - ($2::int * interval '1 hour')
     where id = $1`,
    [userId, hours]
  );
}
