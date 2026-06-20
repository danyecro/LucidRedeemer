// CLI to manage client auth tokens for the public relay.
//
// Run on the VM (in the lucid_discord_bridge folder):
//   node manage-tokens.js list
//   node manage-tokens.js add "<label>" [expiry-days]
//   node manage-tokens.js revoke <label|token>
//   node manage-tokens.js enable <label|token>
//   node manage-tokens.js remove <label|token>

const { addToken, setEnabled, removeToken, listTokens } = require('./auth');

const [cmd, ...args] = process.argv.slice(2);

function printToken(t) {
  const exp = t.expiresAt ? t.expiresAt.slice(0, 10) : 'never';
  console.log(`  ${t.enabled ? '●' : '○'} ${t.label}`);
  console.log(`     token:   ${t.token}`);
  console.log(`     created: ${t.createdAt.slice(0, 10)}   expires: ${exp}   ${t.enabled ? 'enabled' : 'DISABLED'}`);
}

function usage() {
  console.log('Commands:');
  console.log('  list');
  console.log('  add "<label>" [expiry-days]');
  console.log('  revoke <label|token>');
  console.log('  enable <label|token>');
  console.log('  remove <label|token>');
}

switch (cmd) {
  case 'list': {
    const ts = listTokens();
    if (!ts.length) { console.log('No tokens yet.'); break; }
    console.log(`${ts.length} token(s):`);
    ts.forEach(printToken);
    break;
  }
  case 'add': {
    const label = args[0];
    const days = args[1] ? parseInt(args[1], 10) : 0;
    if (!label) { console.error('Usage: add "<label>" [expiry-days]'); process.exit(1); }
    const rec = addToken(label, days);
    console.log('Created token:');
    printToken(rec);
    break;
  }
  case 'revoke': {
    if (!args[0]) { console.error('Usage: revoke <label|token>'); process.exit(1); }
    const rec = setEnabled(args[0], false);
    console.log(rec ? `Revoked: ${rec.label}` : 'Not found.');
    break;
  }
  case 'enable': {
    if (!args[0]) { console.error('Usage: enable <label|token>'); process.exit(1); }
    const rec = setEnabled(args[0], true);
    console.log(rec ? `Enabled: ${rec.label}` : 'Not found.');
    break;
  }
  case 'remove': {
    if (!args[0]) { console.error('Usage: remove <label|token>'); process.exit(1); }
    console.log(removeToken(args[0]) ? 'Removed.' : 'Not found.');
    break;
  }
  default:
    usage();
}
