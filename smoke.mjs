#!/usr/bin/env node
// Smoke test for the NewKwLab API Bundle agent skill.
//
// Spins up a LOCAL gateway instance from the production code
// (gateway/ec2/server.mjs) against a throwaway SQLite ledger in /tmp,
// seeds a trial customer (1,000 credits) through the regular code path
// (ec2/seed-customer.mjs), then drives the `nkw` CLI through:
//   health -> usage -> cardcheck -> usage -> cardcheck (cache)
// and asserts the charge/balance linkage end to end.
//
// The production gateway.db is never touched: GATEWAY_DB_PATH always
// points inside the temp dir, which is deleted on exit.
//
// Usage:  node access/skills/smoke.mjs
// Exit:   0 = PASS, 1 = FAIL. Per-assertion lines go to stdout.

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // access/skills/
const bundleRoot = join(here, "..", ".."); // api-bundle/
const ec2Dir = join(bundleRoot, "gateway", "ec2");
const cliPath = join(bundleRoot, "access", "cli", "src", "cli.mjs");

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function runNode(args, env, timeoutMs = 60_000) {
  const r = spawnSync(process.execPath, args, {
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: timeoutMs,
  });
  return r;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function waitForHealth(base, child, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return false;
    try {
      const res = await fetch(`${base}/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

const tmp = mkdtempSync(join(tmpdir(), "nkw-skills-smoke-"));
const dbPath = join(tmp, "gw-smoke.db");
let server = null;
let failed = false;

try {
  // 1. Init a fresh ledger in the temp dir.
  const init = runNode([join(ec2Dir, "init-db.mjs"), dbPath], {
    GATEWAY_DB_PATH: dbPath,
  });
  check("init-db creates temp ledger", init.status === 0, (init.stdout || "").trim().split("\n")[0] ?? "");
  if (init.status !== 0) throw new Error(`init-db failed: ${init.stderr}`);

  // 2. Seed a trial customer + key through the regular code path.
  const seed = runNode(
    [
      join(ec2Dir, "seed-customer.mjs"),
      "--email", "skills-smoke@example.com",
      "--plan", "trial",
      "--label", "skills-smoke",
    ],
    { GATEWAY_DB_PATH: dbPath },
  );
  const seedLine = (seed.stdout || "").trim().split("\n").filter(Boolean).pop() ?? "";
  let seeded;
  try {
    seeded = JSON.parse(seedLine);
  } catch {
    throw new Error(`seed-customer output not JSON: ${seed.stdout} ${seed.stderr}`);
  }
  check(
    "seed trial customer (1,000 credits + key)",
    seed.status === 0 && seeded.balance === 1000 && /^nkw_live_/.test(seeded.key ?? ""),
    `balance=${seeded.balance}`,
  );
  const apiKey = seeded.key;

  // 3. Start the local gateway instance on the temp ledger.
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let serverLog = "";
  server = spawn(process.execPath, [join(ec2Dir, "server.mjs")], {
    env: {
      ...process.env,
      GATEWAY_DB_PATH: dbPath,
      GATEWAY_PORT: String(port),
      GATEWAY_HOST: "127.0.0.1",
      GATEWAY_CRON: "off",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (d) => (serverLog += d));
  server.stderr.on("data", (d) => (serverLog += d));

  const up = await waitForHealth(base, server);
  check("local gateway instance starts", up, up ? base : serverLog.slice(-400));
  if (!up) throw new Error("gateway did not come up");

  const cliEnv = { NKW_BASE_URL: base, NKW_API_KEY: apiKey };
  const cli = (args) => runNode([cliPath, ...args], cliEnv);

  // 4. health through the CLI.
  const health = cli(["health"]);
  let healthOk = false;
  try {
    healthOk = health.status === 0 && JSON.parse(health.stdout).ok === true;
  } catch { /* stays false */ }
  check("CLI health -> {ok:true}", healthOk);

  // 5. usage before: balance must equal the seeded 1,000.
  const usage0 = cli(["usage"]);
  const u0 = JSON.parse(usage0.stdout);
  check("CLI usage (before) balance = 1000", usage0.status === 0 && u0.balance === 1000, `balance=${u0.balance}`);

  // 6. One real cardcheck call: valid card, 1 credit, balance 999.
  const card1 = cli(["cardcheck", "4242424242424242"]);
  let cardData = {};
  try { cardData = JSON.parse(card1.stdout); } catch { /* stays {} */ }
  const summary1 = /credits charged: (\d+), balance: (\d+), cache: (\w+)/.exec(card1.stderr ?? "");
  check(
    "CLI cardcheck -> valid Visa, charged 1, balance 999, cache MISS",
    card1.status === 0 &&
      cardData.valid === true &&
      summary1?.[1] === "1" &&
      summary1?.[2] === "999" &&
      summary1?.[3] === "MISS",
    (card1.stderr || "").trim().split("\n").pop() ?? "",
  );

  // 7. usage after: ledger must have moved exactly with the charge.
  const usage1 = cli(["usage"]);
  const u1 = JSON.parse(usage1.stdout);
  const cardRow = Array.isArray(u1.usage_by_product)
    ? u1.usage_by_product.find((r) => r.product_id === "cardcheck")
    : undefined;
  check(
    "CLI usage (after) balance = 999 and cardcheck row charged 1",
    usage1.status === 0 && u1.balance === 999 && cardRow?.charged === 1 && cardRow?.calls === 1,
    `balance=${u1.balance}, cardcheck=${JSON.stringify(cardRow)}`,
  );

  // 8. Repeat the same call: 24h cache hit, 0 credits, balance unmoved.
  const card2 = cli(["cardcheck", "4242424242424242"]);
  const summary2 = /credits charged: (\d+), balance: (\d+), cache: (\w+)/.exec(card2.stderr ?? "");
  check(
    "CLI cardcheck repeat -> charged 0, cache HIT",
    card2.status === 0 && summary2?.[1] === "0" && summary2?.[3] === "HIT",
    (card2.stderr || "").trim().split("\n").pop() ?? "",
  );
  const usage2 = cli(["usage"]);
  const u2 = JSON.parse(usage2.stdout);
  check("CLI usage (final) balance still 999", usage2.status === 0 && u2.balance === 999, `balance=${u2.balance}`);
} catch (e) {
  failed = true;
  console.error(`smoke aborted: ${e.message}`);
} finally {
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));
    if (server.exitCode === null) server.kill("SIGKILL");
  }
  rmSync(tmp, { recursive: true, force: true });
}

const passed = results.filter((r) => r.ok).length;
console.log(`\nSMOKE RESULT: ${!failed && passed === results.length ? "PASS" : "FAIL"} (${passed}/${results.length} assertions)`);
process.exit(!failed && passed === results.length ? 0 : 1);
