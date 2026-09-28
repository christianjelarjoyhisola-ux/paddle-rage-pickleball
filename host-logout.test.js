const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync('index.html', 'utf8');
const source = html.slice(html.indexOf('async function hostLogout()'), html.indexOf('\nfunction closeHostBookings()'));

function fixture(signOut) {
  const button = { disabled: false };
  const removed = [], destinations = [], messages = [];
  const context = vm.createContext({
    document: { querySelector: () => button },
    window: { _supabase: { auth: { signOut } }, location: { replace: value => destinations.push(value) } },
    sessionStorage: { removeItem: key => removed.push(`session:${key}`) },
    localStorage: { removeItem: key => removed.push(`local:${key}`) },
    toast: message => messages.push(message),
    console: { error() {} },
  });
  vm.runInContext(source, context);
  return { context, button, removed, destinations, messages };
}

test('host logout clears the actual auth session before redirecting', async () => {
  let signedOut = false;
  const f = fixture(async options => {
    assert.equal(options.scope, 'local');
    assert.equal(f.destinations.length, 0);
    assert.equal(f.removed.length, 0);
    signedOut = true;
    return { error: null };
  });
  await f.context.hostLogout();
  assert.equal(signedOut, true);
  assert.deepEqual(f.removed, ['session:pb_session', 'local:pb_session', 'local:pb_remember']);
  assert.deepEqual(f.destinations, ['host.html']);
});

for (const throws of [false, true]) test(`logout failure stays retryable (${throws ? 'network' : 'auth error'})`, async () => {
  const f = fixture(async () => { if (throws) throw new Error('offline'); return { error: new Error('failed') }; });
  await f.context.hostLogout();
  assert.equal(f.button.disabled, false);
  assert.equal(f.destinations.length, 0);
  assert.equal(f.removed.length, 0);
  assert.match(f.messages[0], /try again/);
});

test('repeated logout clicks make only one sign-out request', async () => {
  let calls = 0, finish;
  const f = fixture(() => { calls++; return new Promise(resolve => { finish = resolve; }); });
  const pending = f.context.hostLogout();
  await f.context.hostLogout();
  assert.equal(calls, 1);
  finish({ error: null });
  await pending;
  assert.equal(f.destinations.length, 1);
});
