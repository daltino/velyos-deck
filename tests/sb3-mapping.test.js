const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const repoRoot = path.resolve(__dirname, "..");

function loadScript(file, extra = {}) {
  const context = {
    console,
    window: {},
    ...extra,
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(
    fs.readFileSync(path.join(repoRoot, file), "utf8"),
    context,
    { filename: file },
  );
  return context;
}

function makeState(ctx) {
  return { cc14: new ctx.CC14Reassembler() };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test("DDJ-SB3 browse encoder moves library selection", () => {
  const ctx = loadScript("dj/sb3-mapping.js");
  const state = makeState(ctx);
  assert.deepEqual(plain(ctx.translateSB3([0xB6, 0x40, 0x01], state)), [
    { action: "browse", delta: 1, fast: false },
  ]);
  assert.deepEqual(plain(ctx.translateSB3([0xB6, 0x40, 0x7F], state)), [
    { action: "browse", delta: -1, fast: false },
  ]);
  assert.deepEqual(plain(ctx.translateSB3([0xB6, 0x64, 0x02], state)), [
    { action: "browse", delta: 2, fast: true },
  ]);
});

test("DDJ-SB3 load buttons target selected deck A/B and ignore deck 3/4", () => {
  const ctx = loadScript("dj/sb3-mapping.js");
  const state = makeState(ctx);
  assert.deepEqual(plain(ctx.translateSB3([0x96, 0x46, 0x7F], state)), [
    { action: "loadSelected", deck: 0 },
  ]);
  assert.deepEqual(plain(ctx.translateSB3([0x96, 0x47, 0x7F], state)), [
    { action: "loadSelected", deck: 1 },
  ]);
  assert.deepEqual(plain(ctx.translateSB3([0x96, 0x48, 0x7F], state)), [
    { action: "deckLayerIgnored" },
  ]);
});

test("DDJ-SB3 14-bit controls emit normalized values", () => {
  const ctx = loadScript("dj/sb3-mapping.js");
  const state = makeState(ctx);
  assert.deepEqual(plain(ctx.translateSB3([0xB0, 0x00, 0x40], state)), []);
  assert.deepEqual(plain(ctx.translateSB3([0xB0, 0x20, 0x00], state)), [
    { action: "tempo", value: 8192 / 16383, deck: 0 },
  ]);
  assert.deepEqual(plain(ctx.translateSB3([0xB6, 0x1F, 0x7F], state)), []);
  assert.deepEqual(plain(ctx.translateSB3([0xB6, 0x3F, 0x7F], state)), [
    { action: "crossfader", value: 1 },
  ]);
});

test("DDJ-SB3 pad mode buttons affect pad translation", () => {
  const ctx = loadScript("dj/sb3-mapping.js");
  const state = makeState(ctx);
  assert.deepEqual(plain(ctx.translateSB3([0x90, 0x69, 0x7F], state)), [
    { action: "padMode", deck: 0, mode: "beatJump" },
  ]);
  assert.deepEqual(plain(ctx.translateSB3([0x97, 0x42, 0x7F], state)), [
    { action: "pad", deck: 0, mode: "beatJump", slot: 2, shifted: false, pressed: true },
  ]);
  assert.deepEqual(plain(ctx.translateSB3([0x97, 0x4A, 0x7F], state)), [
    { action: "pad", deck: 0, mode: "beatJump", slot: 2, shifted: true, pressed: true },
  ]);
});

test("Library hardware selection moves and returns selected track", () => {
  const ctx = loadScript("dj/library.js", {
    document: { querySelectorAll: () => [] },
    localStorage: { getItem: () => null, setItem: () => {} },
  });
  const rows = [];
  const lib = Object.create(ctx.Library.prototype);
  Object.assign(lib, {
    filtered: [{ id: "a" }, { id: "b" }, { id: "c" }],
    selectedId: null,
    tbody: {
      querySelectorAll: () => rows,
      querySelector: () => null,
    },
    app: { midi: { syncLeds() {} } },
  });

  lib._ensureSelection();
  assert.equal(lib.selectedId, "a");
  assert.deepEqual(lib.moveSelection(2), { id: "c" });
  assert.equal(lib.selectedId, "c");
  assert.deepEqual(lib.moveSelection(-10), { id: "a" });
});
