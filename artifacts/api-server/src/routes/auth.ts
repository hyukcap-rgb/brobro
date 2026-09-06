import { Router, type IRouter } from "express";
import { LoginBody } from "@workspace/api-zod";
import { verifyCredentials } from "../lib/auth";

const router: IRouter = Router();

router.post("/auth/login", async (req, res) => {
  const input = LoginBody.safeParse(req.body);
  if (!input.success) {
    res.status(401).json({ error: "아이디/비밀번호를 확인해 주세요." });
    return;
  }
  const user = await verifyCredentials(input.data.username, input.data.password);
  if (!user) {
    res.status(401).json({ error: "아이디 또는 비밀번호가 올바르지 않습니다." });
    return;
  }
  req.session.userId = user.id;
  req.session.username = user.username;
  res.json({ authenticated: true, username: user.username });
});

router.post("/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ authenticated: false, username: null });
  });
});

router.get("/auth/me", (req, res) => {
  if (req.session?.userId) {
    res.json({ authenticated: true, username: req.session.username ?? null });
    return;
  }
  res.json({ authenticated: false, username: null });
});

export default router;
