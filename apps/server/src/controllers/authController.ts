import { Request, Response } from "express";
import { login, signup } from "../services/authService";

export async function signupController(req: Request, res: Response) {
  const result = await signup(req.body.email, req.body.password);
  res.json(result);
}

export async function loginController(req: Request, res: Response) {
  const result = await login(req.body.email, req.body.password);
  res.json(result);
}

export async function meController(req: Request, res: Response) {
  res.json({ user: req.user });
}
