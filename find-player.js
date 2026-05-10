/**
 * Brute-force scan for valid PUBG Mobile player IDs via the running daemon.
 * Generates random 10-digit IDs starting with 5 and checks /lookup.
 *
 * Usage: node find-player.js [--count=100] [--prefix=5]
 *   Requires the daemon running on http://127.0.0.1:7777
 */

const DAEMON = 'http://127.0.0.1:7777';
const CONCURRENCY = 10;

function randomId(prefix = '5') {
  const remaining = 10 - prefix.length;
  let id = prefix;
  for (let i = 0; i < remaining; i++) id += Math.floor(Math.random() * 10);
  return id;
}

async function checkId(id) {
  try {
    const r = await fetch(`${DAEMON}/lookup/${id}`);
    const d = await r.json();
    if (d.ret === 0 && d.info) {
      const name = d.info.charac_name || '';
      const autoGen = /^user\d+$/.test(name);
      return { id, name, openid: d.info.openid, banned: !!d.info.is_ban, autoGen };
    }
  } catch (_) {}
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const countArg = args.find(a => /^--count=\d+$/.test(a));
  const count = countArg ? parseInt(countArg.split('=')[1]) : 200;
  const prefixArg = args.find(a => /^--prefix=\d+$/.test(a));
  const prefix = prefixArg ? prefixArg.split('=')[1] : '5';

  // Verify daemon is up
  try {
    const h = await fetch(`${DAEMON}/health`);
    if (!h.ok) throw new Error();
  } catch (_) {
    console.error('Daemon not reachable at ' + DAEMON);
    process.exit(1);
  }

  console.log(`Scanning ${count} random IDs (prefix=${prefix}, concurrency=${CONCURRENCY})...`);
  console.log('Looking for: real name (not auto-generated), not banned\n');

  let checked = 0;
  let found = 0;
  const results = [];

  for (let batch = 0; batch < count; batch += CONCURRENCY) {
    const size = Math.min(CONCURRENCY, count - batch);
    const ids = Array.from({ length: size }, () => randomId(prefix));
    const promises = ids.map(id => checkId(id));
    const hits = (await Promise.all(promises)).filter(Boolean);

    checked += size;
    for (const h of hits) {
      found++;
      const tag = h.autoGen ? '  [auto-gen]' : h.banned ? '  [BANNED]' : '  ★ REAL';
      console.log(`[${checked}/${count}] ${h.id}  ${h.name}${tag}`);
      if (!h.autoGen && !h.banned) results.push(h);
    }

    if (checked % 50 === 0 && hits.length === 0) {
      process.stdout.write(`[${checked}/${count}] scanning...\r`);
    }
  }

  console.log(`\nDone. Checked ${checked}, found ${found} valid, ${results.length} real+active names.`);
  if (results.length > 0) {
    console.log('\nReal players found:');
    for (const r of results) {
      console.log(`  ${r.id}  ${r.name}  (openid: ${r.openid})`);
    }
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
