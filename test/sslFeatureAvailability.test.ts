import assert from "node:assert/strict";
import test from "node:test";
import {
  setFeatureAvailability,
} from "../src/services/featureAvailability.ts";
import { sslService } from "../src/services/sslService.ts";

test("SSL 证书功能关闭时在调用 Tauri 前拒绝服务请求", async () => {
  setFeatureAvailability("sslCertificates", {
    enabled: false,
    reason: "SSL 证书功能维护中",
  });

  await assert.rejects(
    sslService.list(),
    /SSL 证书功能维护中/,
  );
});
