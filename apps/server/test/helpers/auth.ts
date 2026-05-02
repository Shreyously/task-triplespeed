import request from "supertest";
import { Express } from "express";

export async function signupUser(app: Express, label: string) {
  const email = `${label}-${Date.now()}-${Math.floor(Math.random() * 100000)}@test.local`;
  const password = "TestPass123!";
  const response = await request(app).post("/signup").send({ email, password });
  if (response.status >= 400) {
    throw new Error(`Signup failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return {
    email,
    password,
    token: response.body.token as string,
    userId: response.body.user.id as string
  };
}
