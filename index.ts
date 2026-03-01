// Lead Qualifier — OpenClaw plugin entry point.
// Registers: service (message_received hook), agent tools, CLI commands.

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createConfigSchema, resolveConfig } from "./src/config.js";
import { createLeadQualifierService } from "./src/service.js";
import { registerLeadQualifierTools } from "./src/tools.js";
import { createLeadQualifierCli } from "./src/cli.js";

const plugin = {
  id: "lead-qualifier",
  name: "Lead Qualifier",
  description:
    "Autonomous B2B agent-to-agent lead qualification. Your agent pitches, qualifies, and books meetings autonomously — only pings you when a warm meeting is booked.",
  configSchema: createConfigSchema(),

  register(api: OpenClawPluginApi) {
    let cfg;
    try {
      cfg = resolveConfig(api.pluginConfig);
    } catch (err) {
      api.logger.error(`lead-qualifier: invalid config — ${String(err)}`);
      api.logger.error("lead-qualifier: plugin will not start. Set config.pitch at minimum.");
      return;
    }

    // Background service: wires the message_received hook
    api.registerService(createLeadQualifierService(cfg, api));

    // Register agent-callable tools.
    // stateDir is resolved from the OPENCLAW_STATE_DIR env var (set by the gateway)
    // or falls back to ~/.openclaw. The service start(ctx) provides a typed ctx.stateDir,
    // but tools also need it independently since they can be called outside the service lifecycle.
    const stateDir =
      process.env["OPENCLAW_STATE_DIR"] ?? `${process.env["HOME"] ?? "~"}/.openclaw`;

    registerLeadQualifierTools(api, { stateDir, cfg, api });

    // CLI commands: `openclaw lead-qualifier ...`
    api.registerCli(createLeadQualifierCli(cfg, api), { commands: ["lead-qualifier"] });

    api.logger.info("lead-qualifier: plugin registered");
  },
};

export default plugin;
