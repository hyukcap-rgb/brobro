import { Router, type IRouter } from "express";
import { UpdateSettingsBody } from "@workspace/api-zod";
import { getAppSettings, updateAppSettings } from "../lib/settings";

const router: IRouter = Router();

router.get("/settings", async (_req, res) => {
  res.json(await getAppSettings());
});

router.put("/settings", async (req, res) => {
  const input = UpdateSettingsBody.safeParse(req.body);
  if (!input.success) {
    res.status(400).json({ error: "설정 값을 확인해 주세요." });
    return;
  }
  try {
    res.json(await updateAppSettings(input.data));
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "설정을 저장하지 못했습니다." });
  }
});

export default router;
