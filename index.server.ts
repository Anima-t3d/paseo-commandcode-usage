import type { PluginServerContext } from "@getpaseo/plugin/server";
import { commandCodeUsage } from "./server/commandcode";

export default function contribute(server: PluginServerContext) {
  server.registerUsageSource(commandCodeUsage);
  return () => {};
}
