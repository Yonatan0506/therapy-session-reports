import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.therapy.sessionreports",
  appName: "סיכומי טיפול",
  webDir: "dist",
  server: {
    url: "https://therapy-session-reports-82786531752.me-west1.run.app",
    cleartext: false
  },
  android: {
    allowMixedContent: false
  }
};

export default config;
