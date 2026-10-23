/**
 * Command Code plan usage, read from the CLI's own billing API.
 *
 * The numbers here are the ones the CLI prints under `/usage`, computed the same way:
 *
 *   remaining = monthlyCredits + purchasedCredits + freeCredits
 *   pool      = max(planMonthlyCredits, monthlyCredits) + purchasedCredits + freeCredits
 *   period%   = (pool - remaining) / pool
 *
 * `planMonthlyCredits` comes from the plan table in the CLI's own bundle; without it the top
 * line cannot be reproduced from the billing payload alone. The panel ROUNDS rather than floors
 * (an API value just under 7.5% renders as 8%), so every percentage here is rounded.
 *
 * The top line is period credit consumption, NOT the weekly window, and it is usually the
 * highest of the three.
 *
 * Read-only by construction: GET requests only, the login store is re-read on every fetch and
 * never written, and no credential is copied, cached or logged.
 *
 * Session scoping: Command Code keeps its login at a fixed `~/.commandcode/auth.json` and its
 * launch environment names no store, so a session-scoped discovery cannot find it without
 * scanning default stores -- which the usage contract forbids. Sessions therefore report an
 * account only when their environment names a store (COMMAND_CODE_HOME or CMD_CONFIG_DIR). The
 * per-agent meter stays empty until the platform exposes that path to session discovery; the
 * global card is unaffected.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  hashAccountKey,
  unavailable,
  type UsageAccount,
  type UsageReport,
  type UsageScope,
  type UsageSourceRegistration,
  type UsageWindow,
} from "@getpaseo/plugin/server/usage";

const API = "https://api.commandcode.ai";
const DEFAULT_STORE = join(homedir(), ".commandcode", "auth.json");
/** Environment keys a launcher may use to point an agent at a specific Command Code home. */
const STORE_ENV_KEYS = ["COMMAND_CODE_HOME", "CMD_CONFIG_DIR"] as const;
const HARNESS = "cmd";

/** The CLI's plan table (`Er` in its bundle): monthly credits granted per plan. */
const PLAN_MONTHLY: Record<string, number> = {
  "individual-go": 10,
  "individual-go-v1": 10,
  "individual-goat": 70,
  "individual-pro": 30,
  "individual-pro-v1": 80,
  "individual-provider": 15,
  "individual-max": 150,
  "individual-ultra": 300,
  "teams-pro": 40,
};

/** Display names for the plans we know; an unknown id is shown as-is. */
const PLAN_LABEL: Record<string, string> = {
  "individual-go": "Go",
  "individual-go-v1": "Go",
  "individual-goat": "GOAT",
  "individual-pro": "Pro",
  "individual-pro-v1": "Pro",
  "individual-provider": "Provider",
  "individual-max": "Max",
  "individual-ultra": "Ultra",
  "teams-pro": "Teams Pro",
};

const input = z.object({ path: z.string() }).strict();

interface Auth {
  apiKey: string;
  userName?: string;
}

interface CreditsPayload {
  credits?: {
    monthlyCredits?: number | null;
    purchasedCredits?: number | null;
    freeCredits?: number | null;
  };
  windowLimits?: {
    fiveHour?: { used?: number | null; cap?: number | null; exceeded?: boolean | null; resetAt?: number | null };
    weekly?: { used?: number | null; cap?: number | null; exceeded?: boolean | null; resetAt?: number | null };
  };
}

interface SubscriptionPayload {
  data?: { status?: string; planId?: string | null; currentPeriodStart?: string; currentPeriodEnd?: string };
}

/** Round the way the panel does. Negative values do not occur in this payload. */
function pct(used: number, cap: number | null | undefined): number | null {
  if (!cap || cap <= 0) return null;
  return Math.min((used / cap) * 100, 100);
}

function rr(x: number): number {
  return Math.round(x);
}

function iso(ms: number | null | undefined): string | null {
  if (!ms || !Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function tone(usedPct: number | null, exceeded?: boolean | null): UsageWindow["tone"] {
  if (exceeded) return "danger";
  if (usedPct === null) return "default";
  if (usedPct >= 90) return "danger";
  if (usedPct >= 80) return "warning";
  return "ok";
}

async function readAuth(path: string): Promise<Auth> {
  // Force 0600-style handling by reading the file as data: no copies, no rewrites.
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as { apiKey?: string; userName?: string };
  if (!parsed.apiKey) throw new Error("no apiKey in " + path);
  return { apiKey: parsed.apiKey, userName: parsed.userName };
}

class Rejected extends Error {
  constructor(readonly status: number) {
    super("Command Code rejected the stored login (HTTP " + status + ")");
  }
}

async function get<T>(path: string, apiKey: string): Promise<T> {
  // The API answers 403 to the default Python urllib UA; a CLI-shaped UA is what it expects.
  const res = await fetch(API + path, {
    headers: {
      Authorization: "Bearer " + apiKey,
      Accept: "application/json",
      "User-Agent": "command-code/paseo-plugin",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 401 || res.status === 403) throw new Rejected(res.status);
  if (!res.ok) throw new Error("HTTP " + res.status + " for " + path);
  return (await res.json()) as T;
}

async function readStore(scope: UsageScope): Promise<string[]> {
  if (scope.kind === "global") return [DEFAULT_STORE];
  // Never scan a default store from session discovery: only what the session names.
  const out: string[] = [];
  for (const key of STORE_ENV_KEYS) {
    const dir = scope.env?.[key];
    if (dir) out.push(join(dir, "auth.json"));
  }
  return out;
}

export const commandCodeUsage: UsageSourceRegistration = {
  id: "commandcode",
  label: "Command Code",
  input,

  async discover(scope) {
    const accounts: UsageAccount[] = [];
    for (const path of await readStore(scope)) {
      let auth: Auth;
      try {
        auth = await readAuth(path);
      } catch {
        continue; // no login at that path: no card, no error
      }
      const account: UsageAccount = {
        key: hashAccountKey(path),
        harness: HARNESS,
        input: { path },
      };
      if (auth.userName) account.label = auth.userName;
      accounts.push(account);
    }
    return accounts;
  },

  async fetch(raw) {
    const { path } = input.parse(raw);

    let auth: Auth;
    try {
      auth = await readAuth(path);
    } catch {
      throw new Error("the Command Code login store at " + path + " is gone");
    }

    try {
      // whoami carries the org; individual plans have none, and orgId must then be omitted.
      const who = await get<{ user?: { userName?: string; email?: string }; org?: { id?: string } | null }>(
        "/alpha/whoami?limits=1",
        auth.apiKey,
      );
      const orgId = who.org?.id ?? null;
      const orgQuery = orgId ? "?orgId=" + encodeURIComponent(orgId) : "";

      const sub = await get<SubscriptionPayload>("/alpha/billing/subscriptions" + orgQuery, auth.apiKey);
      const credits = await get<CreditsPayload>("/alpha/billing/credits" + orgQuery, auth.apiKey);

      const planId = sub.data?.planId ?? "";
      const allow = planId ? PLAN_MONTHLY[planId] ?? null : null;

      const cred = credits.credits ?? {};
      const monthlyLeft = Math.max(0, Number(cred.monthlyCredits ?? 0));
      const purchased = Math.max(0, Number(cred.purchasedCredits ?? 0));
      const free = Math.max(0, Number(cred.freeCredits ?? 0));
      const remaining = monthlyLeft + purchased + free;

      let periodPct: number | null = null;
      if (allow !== null) {
        const pool = Math.max(allow, monthlyLeft) + purchased + free;
        if (pool > 0) periodPct = Math.min(((pool - remaining) / pool) * 100, 100);
      } else {
        // No plan entry: fall back to the period summary, which is what the CLI does.
        const since = sub.data?.currentPeriodStart;
        const summary = await get<{ totalCost?: number }>(
          "/alpha/usage/summary" + (since ? "?since=" + encodeURIComponent(since) : ""),
          auth.apiKey,
        );
        const used = Math.max(0, Number(summary.totalCost ?? 0));
        if (used + remaining > 0) periodPct = (used / (used + remaining)) * 100;
      }

      const lim = credits.windowLimits ?? {};
      const five = lim.fiveHour ?? {};
      const week = lim.weekly ?? {};
      const fivePct = pct(Number(five.used ?? 0), five.cap);
      const weekPct = pct(Number(week.used ?? 0), week.cap);

      const windows: UsageWindow[] = [];
      if (periodPct !== null) {
        const used = rr(periodPct);
        windows.push({
          id: "period",
          label: "Period",
          shortLabel: "per",
          summary: true,
          usedPct: used,
          remainingPct: 100 - used,
          resetsAt: sub.data?.currentPeriodEnd ?? null,
          tone: tone(used),
        });
      }
      if (fivePct !== null) {
        const used = rr(fivePct);
        windows.push({
          id: "five_hour",
          label: "5-hour",
          shortLabel: "5h",
          summary: true,
          usedPct: used,
          remainingPct: 100 - used,
          resetsAt: iso(five.resetAt),
          tone: tone(used, five.exceeded),
        });
      }
      if (weekPct !== null) {
        const used = rr(weekPct);
        windows.push({
          id: "weekly",
          label: "Weekly",
          shortLabel: "wk",
          summary: true,
          usedPct: used,
          remainingPct: 100 - used,
          resetsAt: iso(week.resetAt),
          tone: tone(used, week.exceeded),
        });
      }

      if (windows.length === 0) {
        return { status: "error", error: "the billing payload carried no usage window" };
      }

      const report: UsageReport = {
        status: "available",
        planLabel: PLAN_LABEL[planId] ?? planId ?? undefined,
        windows,
        balances: [
          {
            id: "monthly",
            label: "Monthly credits",
            remaining: Math.round(monthlyLeft * 100) / 100,
            limit: allow,
            unit: "credits",
            resetsAt: sub.data?.currentPeriodEnd ?? null,
          },
          ...(purchased > 0
            ? [
                {
                  id: "purchased",
                  label: "Purchased credits",
                  remaining: Math.round(purchased * 100) / 100,
                  unit: "credits" as const,
                },
              ]
            : []),
        ],
        details: [
          { id: "credits_left", label: "Credits left", value: (Math.round(remaining * 100) / 100).toFixed(2) },
          ...(who.user?.userName
            ? [{ id: "account", label: "Account", value: who.user.userName }]
            : []),
        ],
      };
      return report;
    } catch (err) {
      if (err instanceof Rejected) {
        return unavailable({ kind: "rejected", status: err.status, refreshedBy: HARNESS });
      }
      const message = err instanceof Error ? err.message : String(err);
      return { status: "error", error: message };
    }
  },
};
