const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const page = fs.readFileSync('index.html', 'utf8');
const start = page.indexOf('async function startSplashSound');
const end = page.indexOf('\nfunction stopSplashSound', start);

assert.notEqual(start, -1, 'index.html must define startSplashSound');
assert.notEqual(end, -1, 'startSplashSound must remain independently testable');

const startSplashSoundSource = page.slice(start, end);

function createHarness({ rejectPlay = false, pauseOnAudibleVolume = false } = {}) {
  const label = { textContent: 'Play music' };
  const updates = [];
  const fades = [];
  let beatStarts = 0;
  let volumeAtPlay = null;

  let storedVolume = 1;
  const audio = {
    paused: true,
    defaultMuted: true,
    muted: true,
    play() {
      volumeAtPlay = this.volume;
      if (rejectPlay) {
        const error = new Error('Autoplay requires a user gesture');
        error.name = 'NotAllowedError';
        return Promise.reject(error);
      }
      this.paused = false;
      return Promise.resolve();
    }
  };
  Object.defineProperty(audio, 'volume', {
    enumerable: true,
    get() {
      return storedVolume;
    },
    set(value) {
      storedVolume = value;
      if (pauseOnAudibleVolume && !audio.paused && value > 0) audio.paused = true;
    }
  });

  const splashAudio = {
    active: false,
    starting: false,
    autoBlocked: false,
    fadeFrame: 0,
    targetVolume: 0.52
  };

  const context = vm.createContext({
    document: {
      getElementById(id) {
        return id === 'splashWelcomeMusic' ? audio : null;
      },
      querySelector(selector) {
        return selector === '.pr-splash-sound-label' ? label : null;
      }
    },
    splashAudio,
    splashIsVisible: () => true,
    fadeSplashMusic: (...args) => fades.push(args),
    updateSplashSoundButton: isPlaying => updates.push(isPlaying),
    startRageBeatAnimation: () => { beatStarts += 1; }
  });

  vm.runInContext(startSplashSoundSource, context);

  return {
    audio,
    fades,
    label,
    splashAudio,
    updates,
    start: automatic => context.startSplashSound(automatic),
    beatStarts: () => beatStarts,
    volumeAtPlay: () => volumeAtPlay
  };
}

test('automatic splash playback uses a silent permission request then raises volume without a fade', async () => {
  const harness = createHarness();

  const started = await harness.start(true);

  assert.equal(started, true);
  assert.equal(harness.volumeAtPlay(), 0);
  assert.equal(harness.audio.volume, harness.splashAudio.targetVolume);
  assert.equal(harness.audio.muted, false);
  assert.equal(harness.audio.defaultMuted, false);
  assert.equal(harness.fades.length, 0, 'automatic playback must not remain silent while a fade is scheduled');
  assert.equal(harness.splashAudio.active, true);
  assert.equal(harness.splashAudio.autoBlocked, false);
  assert.equal(harness.splashAudio.starting, false);
  assert.deepEqual(harness.updates, [true]);
  assert.equal(harness.beatStarts(), 1);
});

test('gesture-started splash playback can retain the premium fade-in', async () => {
  const harness = createHarness();

  const started = await harness.start(false);

  assert.equal(started, true);
  assert.equal(harness.volumeAtPlay(), 0);
  assert.equal(harness.fades.length, 1);
  const [audio, from, to, duration] = harness.fades[0];
  assert.equal(audio, harness.audio);
  assert.equal(from, 0);
  assert.equal(to, harness.splashAudio.targetVolume);
  assert.equal(duration, 650);
  assert.equal(harness.splashAudio.active, true);
  assert.deepEqual(harness.updates, [true]);
});

test('blocked automatic playback offers an honest tap-for-music fallback', async () => {
  const harness = createHarness({ rejectPlay: true });

  const started = await harness.start(true);

  assert.equal(started, false);
  assert.equal(harness.volumeAtPlay(), 0);
  assert.equal(harness.splashAudio.active, false);
  assert.equal(harness.splashAudio.autoBlocked, true);
  assert.equal(harness.splashAudio.starting, false);
  assert.equal(harness.label.textContent, 'Tap for music');
  assert.equal(harness.fades.length, 0);
  assert.deepEqual(harness.updates, [false]);
  assert.equal(harness.beatStarts(), 0);
});

test('automatic playback does not claim success when the browser pauses on the audible volume raise', async () => {
  const harness = createHarness({ pauseOnAudibleVolume: true });

  const started = await harness.start(true);

  assert.equal(started, false);
  assert.equal(harness.volumeAtPlay(), 0);
  assert.equal(harness.audio.paused, true);
  assert.equal(harness.splashAudio.active, false);
  assert.equal(harness.splashAudio.autoBlocked, true);
  assert.equal(harness.splashAudio.starting, false);
  assert.equal(harness.label.textContent, 'Tap for music');
  assert.equal(harness.fades.length, 0);
  assert.deepEqual(harness.updates, [false]);
  assert.equal(harness.beatStarts(), 0);
});
