// Runs every account-deletion integration test, in order, against your
// running backend (`npm run dev` on :3001) and the database in server/.env
// (production, no real users yet). Asks for "production" once and answers
// each script's own prompt with it. Every script cleans up after itself and
// never touches user 1. A failing script doesn't stop the run: all of them
// run, then a summary table is printed, followed by the reason for every
// failure (the script's FAIL lines and/or the error that stopped it).
//
// The scripts log in throwaway users, and /api/auth/login allows 20 requests
// per minute per IP, so by default the runner waits 65s between scripts --
// longer than the limiter's one-minute window, so every script starts with
// fresh limits (about 10 extra minutes). --no-pause skips the waits.
//
// A script that stops during SETUP with a transient error (HTTP 429 rate
// limit, connection refused/reset, timeout, backend unreachable) is retried
// once after another wait. Real failures -- any FAIL check, or a setup error
// that isn't transient -- are never retried, and a retried script is marked
// as such in the summary together with the first attempt's error.
//
//   node scripts/runAllTests.js [--no-pause]

import { spawn } from 'child_process';
import path from 'path';
import readline from 'readline/promises';
import { fileURLToPath } from 'url';
import '../config.js'; // loads server/.env (DATABASE_URL for the banner)

const SCRIPTS = [
  ['Verification codes', 'testVerificationCodes.js'],
  ['Auth hardening', 'testAuthHardening.js'],
  ['Discovery filters', 'testDiscoveryFilters.js'],
  ['SniffedOut serializers', 'testSniffedOut.js'],
  ['Account deletion', 'testAccountDeletion.js'],
  ['Account endpoints', 'testAccountEndpoints.js'],
  ['Public deletion', 'testPublicDeletion.js'],
  ['Media purge', 'testMediaPurge.js'],
  ['Frozen circles', 'testFrozenCircles.js'],
  ['Circle membership', 'testCircleMembership.js'],
  ['Admin + support', 'testAdminSupport.js'],
  ['Payment proofs', 'testPaymentProofs.js'],
  ['Private circles', 'testPrivateCircles.js'],
  ['Ownership transfer', 'testOwnershipTransfer.js'],
  ['No-pet user', 'testNoPetUser.js'],
  ['Circle + chat fixes', 'testCircleChatFixes.js'],
  ['Older bug fixes', 'testOlderBugFixes.js'],
  ['Security phase 1 (unit)', 'testSecurityPhase1Unit.js'],
  ['Security phase 1', 'testSecurityPhase1.js'],
  ['Blocking', 'testBlocking.js'],
  // Last on purpose: its first check shows whether the backend's NOTIFY
  // listener survived the whole run.
  ['Listener recovery', 'testListenerRecovery.js'],
];

const API_BASE = process.env.API_BASE || 'http://localhost:3001';
const PAUSE_MS = process.argv.includes('--no-pause') ? 0 : 65000;
const RETRY_PAUSE_MS = 70000; // always waited before a retry, even with --no-pause
const SCRIPT_TIMEOUT_MS = 10 * 60 * 1000;
const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(scriptsDir, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Errors worth one retry when they stop a script during setup.
const TRANSIENT = /\b429\b|RATE_LIMIT|Too many requests|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|fetch failed|Backend not reachable|did not connect|Connection terminated/i;

// Pulls out why a script failed: its FAIL lines, the error that stopped it,
// a failed cleanup, or (if none of those) its last lines of output.
function failureDetails(output) {
  const lines = output.split(/\r?\n/);
  const details = [];
  for (const line of lines) {
    if (/^\s*FAIL\s/.test(line)) details.push(line.trim());
  }
  const stopped = lines.findIndex(l => l.includes('Test run stopped early:'));
  if (stopped >= 0) {
    // The message is on that line; for a bare "Error" header, add the next line.
    details.push(lines[stopped].trim());
    if (/stopped early:\s*(Error)?\s*$/.test(lines[stopped]) && lines[stopped + 1]) details.push(lines[stopped + 1].trim());
  }
  for (const line of lines) {
    if (/CLEANUP FAILED|Backend not reachable|\[runner\] timed out/.test(line)) details.push(line.trim());
  }
  if (!details.length) {
    details.push(...lines.map(l => l.trim()).filter(Boolean).slice(-5));
  }
  return details;
}

// Runs one test script, answering its "production" prompt, mirroring its
// stdout and stderr live, and reading its final "N passed, M failed" line.
function runScript(file) {
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(scriptsDir, file)], {
      cwd: serverDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    let output = '';
    child.stdout.on('data', chunk => {
      const text = chunk.toString();
      output += text;
      process.stdout.write(text);
    });
    child.stderr.on('data', chunk => {
      const text = chunk.toString();
      output += text;
      process.stderr.write(text);
    });
    child.stdin.end('production\n');
    const timer = setTimeout(() => {
      output += '\n[runner] timed out -- killed\n';
      child.kill();
    }, SCRIPT_TIMEOUT_MS);
    child.on('close', exitCode => {
      clearTimeout(timer);
      const matches = [...output.matchAll(/(\d+) passed, (\d+) failed/g)];
      const last = matches[matches.length - 1];
      const passed = last ? Number(last[1]) : null;
      const failed = last ? Number(last[2]) : null;
      const aborted = /Aborted -- nothing was done|Backend not reachable/.test(output);
      const ok = exitCode === 0 && failed === 0 && passed !== null && !aborted;
      const hasFailChecks = /^\s*FAIL\s/m.test(output);
      // Stopped before any check ran (or only the setup error counted).
      const setupFailure = !ok && !hasFailChecks && (passed === 0 || passed === null)
        && /Test run stopped early|Backend not reachable|\[runner\] timed out/.test(output);
      const details = ok ? [] : failureDetails(output);
      resolve({
        exitCode, passed, failed, ok,
        seconds: Math.round((Date.now() - started) / 1000),
        details,
        // Judged on the error that stopped the script, not on the whole output.
        transientSetupFailure: setupFailure && TRANSIENT.test(details.join('\n')),
      });
    });
  });
}

async function main() {
  const target = new URL(process.env.DATABASE_URL);
  console.log(`Database: ${target.hostname}:${target.port || 5432}${target.pathname}   Backend: ${API_BASE}`);
  console.log(`Runs ${SCRIPTS.length} test scripts with throwaway users; each cleans up after itself. Never touches user 1.`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('Type "production" to continue: ');
  rl.close();
  if (answer.trim() !== 'production') {
    console.log('Aborted -- nothing was done.');
    return 0;
  }
  try {
    const health = await fetch(`${API_BASE}/api/health`);
    if (!health.ok) throw new Error(`HTTP ${health.status}`);
  } catch (err) {
    console.error(`Backend not reachable at ${API_BASE} (${err.message}). Start it with "npm run dev" first.`);
    return 1;
  }

  const results = [];
  for (const [i, [name, file]] of SCRIPTS.entries()) {
    if (i > 0 && PAUSE_MS) {
      console.log(`\n[runner] waiting ${PAUSE_MS / 1000}s for the rate-limit window...`);
      await sleep(PAUSE_MS);
    }
    console.log(`\n${'='.repeat(70)}\n[runner] ${i + 1}/${SCRIPTS.length}: ${name} (${file})\n${'='.repeat(70)}`);
    let result = await runScript(file);
    let firstAttempt = null;
    if (result.transientSetupFailure) {
      firstAttempt = result;
      console.log(`\n[runner] ${name} stopped during setup with what looks like a transient error:`);
      for (const line of result.details) console.log(`[runner]   ${line}`);
      console.log(`[runner] retrying once in ${RETRY_PAUSE_MS / 1000}s...`);
      await sleep(RETRY_PAUSE_MS);
      console.log(`\n${'='.repeat(70)}\n[runner] ${i + 1}/${SCRIPTS.length}: ${name} (${file}) -- retry\n${'='.repeat(70)}`);
      result = await runScript(file);
    }
    results.push({ name, file, ...result, firstAttempt });
  }

  console.log(`\n${'='.repeat(78)}\nSummary\n${'='.repeat(78)}`);
  console.log(`${'Script'.padEnd(26)}${'Passed'.padStart(8)}${'Failed'.padStart(8)}${'Time'.padStart(8)}  Result`);
  let allOk = true;
  let totalPassed = 0;
  let totalFailed = 0;
  for (const r of results) {
    if (!r.ok) allOk = false;
    totalPassed += r.passed || 0;
    totalFailed += r.failed || 0;
    let result = r.ok ? 'OK' : r.passed === null ? `FAILED (no summary, exit ${r.exitCode})` : 'FAILED';
    if (r.firstAttempt) result += ' (after 1 retry)';
    console.log(`${r.name.padEnd(26)}${String(r.passed ?? '-').padStart(8)}${String(r.failed ?? '-').padStart(8)}${`${r.seconds}s`.padStart(8)}  ${result}`);
  }
  console.log(`${'Total'.padEnd(26)}${String(totalPassed).padStart(8)}${String(totalFailed).padStart(8)}`);

  // Why things failed (or needed a retry), so nothing is hidden by the table.
  const explained = results.filter(r => !r.ok || r.firstAttempt);
  if (explained.length) {
    console.log(`\n${'='.repeat(78)}\nDetails\n${'='.repeat(78)}`);
    for (const r of explained) {
      if (r.firstAttempt) {
        console.log(`\n${r.name} -- first attempt stopped during setup (retried):`);
        for (const line of r.firstAttempt.details) console.log(`    ${line}`);
      }
      if (!r.ok) {
        console.log(`\n${r.name} -- ${r.firstAttempt ? 'retry also ' : ''}failed:`);
        for (const line of r.details) console.log(`    ${line}`);
      }
    }
  }
  console.log(allOk ? '\nAll test scripts passed.' : '\nSome test scripts failed -- see Details above and their full output further up.');
  return allOk ? 0 : 1;
}

main().then(code => process.exit(code)).catch(err => {
  console.error(err);
  process.exit(1);
});
