// test-ftp.js — standalone FTPS connection test.
// Run with: node test-ftp.js
// Prints the full FTP protocol exchange so we can see exactly where auth fails.
// Safe to delete after debugging.
const ftp = require('basic-ftp');

(async () => {
  const c = new ftp.Client(15000);
  c.ftp.verbose = true; // log every FTP command + response
  try {
    await c.access({
      host:     'ftp.holmgraphics.ca',
      port:     21,
      user:     'shop@shop.holmgraphics.ca',
      password: process.env.TEST_FTP_PASS || 'Mimaki@111',
      secure:   true,
      secureOptions: { checkServerIdentity: () => undefined },
    });
    console.log('\n[OK] Logged in.');
    console.log('Current dir:', await c.pwd());
    console.log('Top-level listing:');
    const list = await c.list();
    for (const f of list) {
      console.log(`  ${f.isDirectory ? 'D' : 'F'} ${f.name}`);
    }
  } catch (e) {
    console.error('\n[FAIL]', e.message || e);
  } finally {
    c.close();
  }
})();
