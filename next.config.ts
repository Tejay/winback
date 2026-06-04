import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  env: {
    // Stamped at config-eval time (once per build). The admin sidebar
    // reads this via lib/admin/build-info.ts to display "deployed Nh
    // ago". On `next dev` this is the time the dev server started —
    // fine for the local-dev footer.
    BUILD_TIME: new Date().toISOString(),
  },
};

export default nextConfig;
