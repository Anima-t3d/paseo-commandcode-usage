# Command Code usage for Paseo

A [Paseo](https://github.com/getpaseo/paseo) plugin that puts **Command Code** (`cmd`) plan usage
in the Usage screen, next to Claude and Codex — the same figures the CLI prints under `/usage`.

```
Command Code                    GOAT
  Period    ████░░░░░░  41% used      resets in 18d 04h
  5-hour    █░░░░░░░░░  12% used      resets in 2h 05m
  Weekly    ██████░░░░  63% used      resets in 4d 06h
  Monthly credits 12.00 / 70 · Purchased 0.00 · Credits left 12.00
```

*Illustrative figures. The plugin reports your own account's numbers.*

## Requirements

- Paseo **0.11** or later with plugins enabled (see [Install](#install))
- Command Code CLI installed and logged in (`~/.commandcode/auth.json`)

## Install

```bash
paseo plugin add git:Anima-t3d/paseo-commandcode-usage
```

If the plugin lands as `disabled` with an empty error, plugins are off daemon-wide. The switch is
a root key in `~/.paseo/config.json`:

```bash
cp ~/.paseo/config.json /tmp/paseo-config.bak
# set "pluginsEnabled": true at the root of the file
paseo reload --json
paseo plugin ls commandcode-usage      # expect STATUS=running
```

Turning that switch on lets **every** installed plugin run unsandboxed on the daemon host. Decide
that deliberately.

## What it reports

| | |
| --- | --- |
| **Period** | Credit consumption for the billing period. This is the line at the top of `/usage`, it is **not** the weekly window, and it is usually the highest of the three. |
| **5-hour** | The rolling five-hour window, with its reset time. |
| **Weekly** | The rolling weekly window, with its reset time. |
| **Balances** | Monthly and purchased credits left, the plan's monthly allowance, and the total credits left. |

## How the numbers are derived

Computed exactly as the CLI computes them (`projectUsageView()` in its own bundle):

```
remaining = monthlyCredits + purchasedCredits + freeCredits
pool      = max(planMonthlyCredits, monthlyCredits) + purchasedCredits + freeCredits
period%   = (pool - remaining) / pool
```

`planMonthlyCredits` comes from the plan table in that bundle: `individual-goat` 70,
`individual-pro` 30, `individual-pro-v1` 80, `individual-max` 150, `individual-ultra` 300,
`teams-pro` 40, `individual-go` 10, `individual-provider` 15.

The panel **rounds** rather than floors — an API value just under 7.5% renders as `8%` — so every
percentage here is round-half-up. Checked against the CLI's own panel in the same minute, on a
live account: the panel and the plugin agreed on all three windows once the rounding was fixed
(the first version floored and read a point low on every bar).

## Data source

Four `GET`s against `https://api.commandcode.ai`, authorised with the API key already in
`~/.commandcode/auth.json`:

| Route | Gives |
| --- | --- |
| `/alpha/whoami?limits=1` | user and org (`null` on individual plans) |
| `/alpha/billing/subscriptions` | plan id, period start and end |
| `/alpha/billing/credits` | credits plus `windowLimits{fiveHour, weekly}` |
| `/alpha/usage/summary?since=<periodStart>` | period cost, used only when the plan is unknown |

`orgId` is sent when the account belongs to an org and omitted otherwise — the API rejects a
literal `null`. Units in `windowLimits` are credits; `resetAt` is epoch **milliseconds**. The
routes are undocumented and can change without notice, so anything that depends on this number
should keep an independent reader as a fallback.

## Safety

- **GET only.** Nothing is written, ever.
- The login store is re-read on every fetch so the CLI's own token rotation takes effect.
- No credential is copied, cached, logged or included in a report. The account key is a hash of
  the store path — never the token, never the email.
- A rejected login renders through the platform's own remedy path; the plugin does not invent
  user-facing instructions.

## Known gap: the per-agent meter

The global card works. The **per-agent chat meter** for a Command Code agent does not, and not
because of this plugin: session discovery receives only `{provider, model, env}`, Command Code
keeps its login at a fixed `~/.commandcode/auth.json`, and its launch environment names no store,
while the usage contract forbids scanning default stores from session discovery.

This plugin therefore reports an account for a session only when the session's environment names
a store (`COMMAND_CODE_HOME` or `CMD_CONFIG_DIR`) — which a normal `cmd acp` launch does not.

Closing that needs a platform change: either a provider declaring the credential store its agents
use, or naming the usage source that owns its account. Tracked in
[getpaseo/paseo#7439](https://github.com/getpaseo/paseo/discussions/7439).

## Development

```bash
npm install          # dev dependencies only (typecheck)
npx tsc --noEmit     # must be clean
paseo plugin reload commandcode-usage
```

Server-only plugin: no client entry, so it does not require a matching app version.

## License

MIT — see [LICENSE](LICENSE).
