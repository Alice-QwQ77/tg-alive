import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiPrefix = env.VITE_API_PREFIX || "/api";
  const gateway = env.VITE_DEV_GATEWAY || "http://127.0.0.1:8787";

  return {
    plugins: [
      react(),
      nodePolyfills({
        globals: {
          Buffer: true,
          global: true,
          process: true
        },
        protocolImports: true
      })
    ],
    define: {
      global: "globalThis"
    },
    server: {
      proxy: {
        [apiPrefix]: {
          target: gateway,
          changeOrigin: true,
          ws: true
        }
      }
    },
    preview: {
      proxy: {
        [apiPrefix]: {
          target: gateway,
          changeOrigin: true,
          ws: true
        }
      }
    }
  };
});
