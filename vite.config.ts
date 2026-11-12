import vinext from "vinext";
import { defineConfig } from "vite";
import hostingConfig from "./.openai/hosting.json";
import { readExecutionProfile } from "./scripts/execution-profile.mjs";
import { configureToolEnvironment } from "./scripts/tool-environment.mjs";
import { sites } from "./scripts/vite/sites-vite-plugin";
import { connectorPreview } from "./scripts/vite/connector-preview-plugin.mjs";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

// The app deliberately imports Lucide's small public per-icon modules. Vinext
// does not expose a conventional HTML entry for Vite's dependency scan, so
// declare the used deep imports once to prevent route-by-route optimizer
// reloads and hundreds of module requests during local browser tests.
const lucideIconDependencies = [
  "activity",
  "alert-triangle",
  "arrow-down",
  "arrow-down-right",
  "arrow-left",
  "arrow-right",
  "arrow-up-right",
  "bell",
  "bell-ring",
  "book-open-text",
  "bookmark",
  "bookmark-check",
  "bot",
  "braces",
  "brain-circuit",
  "briefcase-business",
  "check",
  "check-circle-2",
  "chevron-down",
  "chevron-left",
  "chevron-right",
  "chevron-up",
  "circle",
  "circle-check",
  "circle-dollar-sign",
  "circle-help",
  "clock-3",
  "cloud",
  "database",
  "download",
  "external-link",
  "eye",
  "file-check-2",
  "file-search",
  "file-text",
  "gauge",
  "globe-2",
  "grip-vertical",
  "inbox",
  "info",
  "layers-3",
  "line-chart",
  "link",
  "list-plus",
  "loader-2",
  "loader-circle",
  "lock-keyhole",
  "log-in",
  "log-out",
  "menu",
  "message-square-text",
  "minus",
  "more-horizontal",
  "network",
  "newspaper",
  "octagon-x",
  "panel-left",
  "plus",
  "radio",
  "radio-tower",
  "refresh-cw",
  "rotate-ccw",
  "search",
  "search-check",
  "server",
  "settings-2",
  "shield-check",
  "sliders-horizontal",
  "sparkles",
  "star",
  "target",
  "trash-2",
  "trending-down",
  "trending-up",
  "triangle-alert",
  "wallet-cards",
  "wifi-off",
  "workflow",
  "x",
  "zap",
].map((icon) => `lucide-react/icons/${icon}`);

const clientComponentDependencies = [
  "@base-ui/react",
  "@shadcn/react/message-scroller",
  "class-variance-authority",
  "clsx",
  "cmdk",
  "date-fns",
  "embla-carousel-react",
  "framer-motion",
  "input-otp",
  "next-themes",
  "radix-ui",
  "react-day-picker",
  "react-hook-form",
  "react-resizable-panels",
  "recharts",
  "sonner",
  "tailwind-merge",
  "vaul",
];

const { d1, r2 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";
const managedLinux = readExecutionProfile() === "managed-linux";

const localBindingConfig = {
  main: "./worker/index.ts",
  compatibility_flags: ["nodejs_compat"],
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: "site-creator-d1",
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: "site-creator-r2",
        },
      ]
    : [],
};

export default defineConfig(async ({ command }) => {
  configureToolEnvironment(process.cwd());

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    optimizeDeps: {
      include: [...clientComponentDependencies, ...lucideIconDependencies],
    },
    // Vite only applies root-level dependency optimization to the client
    // environment. Pre-bundle Motion for the two server environments as well
    // so the first local RSC request does not crawl its full module graph.
    environments: {
      rsc: {
        optimizeDeps: {
          include: [...clientComponentDependencies, ...lucideIconDependencies],
        },
      },
      ssr: {
        optimizeDeps: {
          include: [...clientComponentDependencies, ...lucideIconDependencies],
        },
      },
    },
    server: {
      watch: {
        ignored: ["**/outputs/**", "**/playwright-report/**", "**/test-results/**"],
        ...(isCodexSeatbeltSandbox
          ? { useFsEvents: false, usePolling: true }
          : {}),
      },
      ...(managedLinux
        ? { host: "0.0.0.0", allowedHosts: ["terminal.local"] }
        : {}),
    },
    plugins: [
      vinext(),
      sites({ mockAuth: !managedLinux }),
      connectorPreview(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        inspectorPort: false,
        config: {
          ...localBindingConfig,
          ...(command === "serve"
            ? {
                services: [
                  {
                    binding: "CONNECTORS",
                    service: "sites-connector-preview",
                    entrypoint: "ConnectorPreview",
                  },
                ],
              }
            : {}),
        },
        ...(command === "serve"
          ? {
              auxiliaryWorkers: [
                {
                  config: {
                    name: "sites-connector-preview",
                    main: "./scripts/connector-preview/worker.mjs",
                    compatibility_date: "2026-05-15",
                  },
                },
              ],
            }
          : {}),
      }),
    ],
  };
});
