import { defineConfig } from "vitest/config";
import path from "path";

/**
 * バックテスト検証ハーネス専用の設定。
 * 通常の `npm test` (vitest.config.ts) からは外してある。ネットワークを叩くし
 * 数分かかるので、CI のユニットテストと混ぜたくない。
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["scripts/**/*.harness.ts"],
    testTimeout: 20 * 60 * 1000,
    hookTimeout: 20 * 60 * 1000,
    // 表を読みたいので出力を切らない
    disableConsoleIntercept: true,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
