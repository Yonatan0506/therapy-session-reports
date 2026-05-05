import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.therapy.sessionreports",
  appName: "סיכומי טיפול",
  webDir: "dist",
  server: {
    url: "https://therapy-session-reports.onrender.com",
    cleartext: false
  },
  android: {
    allowMixedContent: false
  }
};

export default config;
