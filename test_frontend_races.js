#!/usr/bin/env node
/**
 * Frontend regression for the cross-run async chain and the within-run
 * overlapping-poll ordering.
 *
 * Drives the REAL static/app.js inside a minimal DOM with fully
 * controllable fetch response ordering and asserts that:
 *
 *  - two overlapping OLD poll chains (one parked on a /api/pauses 200
 *    generated before the new run was admitted, the other holding the old
 *    terminal state) can never write the old pause history / state / badge
 *    into the newly admitted run, never stop its polling, never flip its
 *    buttons, and never unlock the read-only source;
 *  - old step/terminate responses (success or failure) landing after the
 *    new run is admitted are dropped silently: no message, no buttons, no
 *    extra poll;
 *  - a rejected /api/run keeps the current run's view and history, and a
 *    409 landing after a concurrent 200 admission is dropped silently;
 *  - the current run's normal polling, history selection, refresh-before-
 *    return-to-live and terminate keep working;
 *  - WITHIN a single run, an earlier poll's stale /api/pauses list (only
 *    pause #1 when built) landing after a later poll adopted pause #2 and
 *    the user selected it never overwrites history, never reports a false
 *    eviction and never leaves history view, and the subsequent step still
 *    uses the live pause_seq;
 *  - an earlier poll's stale /api/state (older pause_seq, or paused after
 *    running at the same seq) cannot roll back the adopted live state,
 *    badge, listing, controls or pause_seq and issues no pauses follow-up;
 *  - a valid terminal state finalizes immediately (polling stopped, editor
 *    unlocked, re-run enabled) even if this and every following poll's
 *    /api/pauses never returns; the frozen history stays reviewable and a
 *    freshly admitted run is untouched by the old run's parked replies;
 *  - a genuine eviction (a strictly newer adopted list no longer contains
 *    the selected pause) still reports and returns to live.
 *
 * Run standalone:        node test_frontend_races.js
 * Run via the suite:     python3 -m unittest test_races -v
 * Exit code is non-zero on the first assertion failure batch.
 */
"use strict";

const vm = require("vm");
const fs = require("fs");
const path = require("path");

let failures = 0;
function check(cond, msg) {
  if (cond) {
    console.log("ok - " + msg);
  } else {
    failures++;
    console.error("FAIL - " + msg);
  }
}
function eq(actual, expected, msg) {
  const ok = actual === expected;
  if (!ok) {
    failures++;
    console.error(`FAIL - ${msg}: expected ${JSON.stringify(expected)}, ` +
                  `got ${JSON.stringify(actual)}`);
  } else {
    console.log("ok - " + msg);
  }
}

// ---- minimal DOM ---------------------------------------------------------

function makeElement(id, leaf = false) {
  const el = {
    id,
    value: "",
    hidden: false,
    disabled: false,
    readOnly: false,
    className: "",
    _text: "",
    children: [],
    handlers: {},
    classList: {
      add() {},
      remove() {},
      toggle() {},
    },
  };
  Object.defineProperty(el, "textContent", {
    get() { return el._text; },
    set(v) {
      el._text = String(v);
      if (v === "") el.children.length = 0; // container reset before rebuild
    },
  });
  el.addEventListener = (ev, fn) => {
    (el.handlers[ev] = el.handlers[ev] || []).push(fn);
  };
  el.dispatch = (ev, event) => (el.handlers[ev] || []).slice()
    .forEach((fn) => fn(event));
  el.appendChild = (child) => { el.children.push(child); return child; };
  if (!leaf) {
    // #locals only: its tbody is rebuilt with rows.
    const tbody = makeElement(id + ":tbody", true);
    el.querySelector = (sel) => (sel === "tbody" ? tbody : null);
    el.tbody = tbody;
  }
  return el;
}

function makeOption() {
  return { value: "", textContent: "" };
}

const IDS = ["code", "examples", "btn-run", "btn-step", "btn-continue",
  "btn-terminate", "btn-back-live", "history", "message", "status",
  "line-count", "listing", "stdout", "exception", "history-banner",
  "locals"];
const elements = {};
for (const id of IDS) elements[id] = makeElement(id);
elements["btn-step"].disabled = true;
elements["btn-continue"].disabled = true;
elements["btn-terminate"].disabled = true;
elements["history-banner"].hidden = true;

const documentStub = {
  getElementById: (id) => elements[id],
  createElement: () => makeElement("anon"),
};
// Options need only value/textContent, not full element machinery.
documentStub.createElement = (tag) =>
  (tag === "option" ? makeOption() : makeElement("anon"));

// ---- controllable timers / fetch ----------------------------------------

const intervals = new Map();
let intervalSeq = 0;
const timeoutQueue = [];
const pending = []; // {method, url, resolve}

function fetchStub(url, opts = {}) {
  return new Promise((resolve) => {
    pending.push({
      method: opts.method || "GET", url, resolve, body: opts.body || null,
    });
  });
}
function jsonResponse(status, obj) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => obj,
  };
}
function take(predicate, what) {
  const i = pending.findIndex(predicate);
  if (i < 0) {
    throw new Error(`no pending request matching ${what || predicate}; ` +
      `pending=[${pending.map((r) => r.method + " " + r.url).join(", ")}]`);
  }
  return pending.splice(i, 1)[0];
}
const isState = (r) => r.url === "/api/state";
const isRun = (r) => r.url === "/api/run";
const isControl = (name) => (r) => r.url === `/api/${name}`;
const pausesFor = (id) => (r) =>
  r.url.startsWith("/api/pauses") && r.url.includes(`run_id=${id}`);

const tick = () => new Promise((r) => setImmediate(r));
async function flushTimeouts() {
  const q = timeoutQueue.splice(0);
  for (const fn of q) fn();
  await tick();
}

const sandbox = {
  console,
  document: documentStub,
  fetch: fetchStub,
  MAX_LINES: 80,
  setInterval: (fn) => {
    const id = ++intervalSeq;
    intervals.set(id, fn);
    return id;
  },
  clearInterval: (id) => { if (id != null) intervals.delete(id); },
  setTimeout: (fn) => { timeoutQueue.push(fn); return timeoutQueue.length; },
  Promise, URL, encodeURIComponent, JSON,
};
vm.createContext(sandbox);

const appSource = fs.readFileSync(
  path.join(__dirname, "static", "app.js"), "utf8");
vm.runInContext(appSource, sandbox, { filename: "app.js" });
const evalApp = (expr) => vm.runInContext(expr, sandbox);

process.on("unhandledRejection", (err) => {
  failures++;
  console.error("FAIL - unhandled rejection:", err && err.stack || err);
});

// ---- payload factories ---------------------------------------------------

const LINES = ["x = 1", "x = 2", "print(x)"];
function state(id, status, seq, extra = {}) {
  return Object.assign({
    run_id: id,
    status,
    pause_seq: seq,
    current_line: seq,
    locals: seq >= 2 ? { x: String(seq - 1) } : {},
    stdout: "",
    stdout_truncated: false,
    exception: null,
    lines: LINES,
  }, extra);
}
function pause(seq, line = seq, locals = seq >= 2 ? { x: String(seq - 1) } : {}) {
  return { pause_seq: seq, current_line: line, locals,
           stdout: "", stdout_truncated: false };
}

async function admitRun(id) {
  const p = evalApp("startRun()");
  await tick();
  take(isRun, "POST /api/run").resolve(jsonResponse(200, { run_id: id }));
  await p;
  await tick();
}
async function answerPoll(id, st, pauseList) {
  take(isState, "GET /api/state").resolve(jsonResponse(200, st));
  await tick();
  take(pausesFor(id), `GET /api/pauses ${id}`)
    .resolve(jsonResponse(200, { run_id: id, pauses: pauseList }));
  await tick();
}
const optionTexts = () => elements.history.children.map((o) => o.textContent);
const activeIntervals = () => Array.from(intervals.keys());
// The gutter of the highlighted row ("→ NN") as rendered by renderListing.
function markedLine() {
  for (const row of elements.listing.children) {
    const gutter = row.children[0];
    if (gutter && gutter.textContent.startsWith("→")) {
      return Number(gutter.textContent.trim().slice(1));
    }
  }
  return null;
}

// Drop every request still pending from a previous scenario: those poll
// chains captured an older run id and their resolution is irrelevant to the
// next scenario (in the browser they'd simply be dropped by the run_id
// guard). Their promises stay unresolved; the page holds no reference that
// can affect the new scenario.
function drainPending() {
  pending.length = 0;
}
async function resetForScenario() {
  await tick();
  await flushTimeouts();
  drainPending();
}

// ===========================================================================
// Scenario 1: the headline cross-run chain from the bug report
// ===========================================================================

async function scenarioTwoOldPollChains() {
  // --- old run admitted, reaches its first pause ---
  await admitRun("old");
  await answerPoll("old", state("old", "paused", 1), [pause(1, 1, {})]);
  eq(elements.status.textContent, "已暂停", "[1] old badge paused");
  check(!elements["btn-step"].disabled, "[1] step enabled while old paused");

  // --- two overlapping old poll chains, exactly like two 400ms ticks ---
  const chainA = evalApp("poll()");
  const chainB = evalApp("poll()");
  await tick();
  const stateReqs = [];
  stateReqs.push(take(isState)); // chain A
  stateReqs.push(take(isState)); // chain B
  const [reqStateA, reqStateB] = stateReqs;

  // Chain A observes the old terminal state and its /api/pauses follow-up
  // is answered 200 *before* the new run exists -- then that reply is held.
  reqStateA.resolve(jsonResponse(200,
    state("old", "terminated", 2, { current_line: 2 })));
  await tick();
  const reqPausesA = take(pausesFor("old"), "chain A pauses 200");

  // --- the user starts a new run; it is admitted while BOTH old chains
  //     and the old pauses 200 are still in flight ---
  await admitRun("new");
  eq(elements.code.readOnly, true, "[1] source locked on new admission");
  const newIntervalId = activeIntervals()[0];
  // The new run's own initial poll is already waiting: exactly one.
  eq(pending.filter(isState).length, 1,
    "[1] new run starts exactly one initial state poll");

  // Chain B lands first (it held the old terminal state), then A's pauses
  // 200 returns -- the exact ordering from the report.
  reqStateB.resolve(jsonResponse(200,
    state("old", "terminated", 2, { current_line: 2 })));
  await chainB;
  await tick();
  reqPausesA.resolve(jsonResponse(200,
    { run_id: "old", pauses: [pause(1, 1, {}), pause(2, 2, { x: "1" })] }));
  await chainA;
  await tick();

  // The old chains must not have touched the new run: the badge belongs to
  // the new run (already "running" since admission), terminate is usable,
  // polling is scheduled, source is read-only, no old pause #2, and the old
  // chains scheduled no polls of their own.
  eq(elements.status.textContent, "运行中",
    "[1] badge not overwritten by old terminal state");
  check(activeIntervals().includes(newIntervalId),
    "[1] new run's polling was not stopped by the old terminal poll");
  check(!elements["btn-terminate"].disabled,
    "[1] terminate stays enabled for the new run");
  eq(elements.code.readOnly, true, "[1] source stays read-only");
  eq(elements.message.textContent, "", "[1] no message from old chains");
  check(!optionTexts().some((t) => t.includes("#2")),
    "[1] old pause #2 never written before new poll answers");

  // The new run's own poll now completes with its first pause.
  await answerPoll("new", state("new", "paused", 1), [pause(1, 1, {})]);
  eq(elements.status.textContent, "已暂停", "[1] new badge paused");
  check(!elements["btn-step"].disabled, "[1] new step enabled");
  check(!elements["btn-terminate"].disabled, "[1] new terminate enabled");
  check(activeIntervals().includes(newIntervalId),
    "[1] polling still active for new run");
  const opts = optionTexts();
  check(opts.some((t) => t.includes("停顿 #1")), "[1] dropdown has new #1");
  check(!opts.some((t) => t.includes("#2")),
    "[1] dropdown never received old pause #2");
  // No stray requests leaked from the dropped old chains.
  check(pending.filter(isState).length === 0,
    "[1] dropped old chains scheduled no extra state polls");
}

// ===========================================================================
// Scenario 2: an old step response (200 and 409) lands after admission
// ===========================================================================

async function scenarioLateStepResponse() {
  await admitRun("run2");
  await answerPoll("run2", state("run2", "paused", 1), [pause(1, 1, {})]);

  const stepP = evalApp('control("step")');
  await tick();
  const reqStep = take(isControl("step"), "POST /api/step");
  check(elements["btn-step"].disabled, "[2] buttons optimistically disabled");

  // New run admitted while the old step reply is still in flight.
  await admitRun("run2b");
  // Old step SUCCESS lands late: must be dropped entirely. The pending
  // state request is only the new run's initial poll; the dropped response
  // must not add to it (its setTimeout(poll) belongs to the old run and is
  // suppressed by the run_id guard).
  const statesBefore = pending.filter(isState).length;
  reqStep.resolve(jsonResponse(200, { ok: true, pause_seq: 1 }));
  await stepP;
  await tick();
  await flushTimeouts();
  eq(elements.message.textContent, "", "[2] late old step 200 shows no message");
  check(pending.filter(isState).length === statesBefore,
    "[2] late old step 200 triggers no poll");

  // Old step FAILURE variant: 409 must not overwrite the new run's prompt.
  const stepP2 = evalApp('control("continue")');
  await tick();
  const reqStep2 = take(isControl("continue"));
  await admitRun("run2c");
  elements.message.textContent = "";
  const statesBefore2 = pending.filter(isState).length;
  reqStep2.resolve(jsonResponse(409, { error: "重复或过期的请求，已拒绝且未推进" }));
  await stepP2;
  await tick();
  await flushTimeouts();
  eq(elements.message.textContent, "", "[2] late old step 409 shows no message");
  check(pending.filter(isState).length === statesBefore2,
    "[2] late old step 409 triggers no poll");
  eq(elements.code.readOnly, true, "[2] source still read-only");
}

// ===========================================================================
// Scenario 3: an old terminate SUCCESS lands after the new run is admitted
// ===========================================================================

async function scenarioLateTerminateResponse() {
  await resetForScenario();
  await admitRun("run3");
  await answerPoll("run3", state("run3", "paused", 1), [pause(1, 1, {})]);

  const termP = evalApp("terminateRun()");
  await tick();
  const reqTerm = take(isControl("terminate"), "POST /api/terminate");

  await admitRun("run3b");
  reqTerm.resolve(jsonResponse(200, { ok: true, status: "terminated" }));
  await termP;
  await tick();

  // The old terminate success must not end the new run: it adds no poll of
  // its own (the only pending state request is the new run's initial poll),
  // the source stays read-only, terminate stays available, badge stays live.
  eq(pending.filter(isState).length, 1,
    "[3] old terminate success triggers no poll for the new run");
  await answerPoll("run3b", state("run3b", "paused", 1), [pause(1, 1, {})]);
  eq(elements.status.textContent, "已暂停", "[3] new run still paused");
  check(!elements["btn-terminate"].disabled, "[3] new terminate still enabled");
  eq(elements.code.readOnly, true, "[3] source stays read-only");
  check(activeIntervals().length === 1, "[3] new run keeps exactly one poll timer");
}

// ===========================================================================
// Scenario 4: rejected admissions preserve the current view; a 409 racing a
//              winning 200 is dropped silently
// ===========================================================================

async function scenarioRejectedAndRacingAdmissions() {
  await resetForScenario();
  await admitRun("run4");
  await answerPoll("run4", state("run4", "paused", 2, { current_line: 2 }),
    [pause(1, 1, {}), pause(2, 2, { x: "1" })]);
  const optionsBefore = optionTexts();
  const intervalBefore = activeIntervals()[0];

  // Rejected startup (active conflict): current history/view stay intact.
  const rejected = evalApp("startRun()");
  await tick();
  take(isRun).resolve(jsonResponse(409,
    { error: "已有未结束的运行，请先终止或等待其结束" }));
  await rejected;
  await tick();
  eq(elements.message.textContent, "已有未结束的运行，请先终止或等待其结束",
    "[4] rejection explains the conflict");
  eq(elements.code.readOnly, true, "[4] source stays read-only on rejection");
  check(optionTexts().join("|") === optionsBefore.join("|"),
    "[4] history untouched by rejected startup");
  eq(activeIntervals()[0], intervalBefore,
    "[4] poll timer untouched by rejected startup");
  check(pending.filter(isState).length === 0,
    "[4] rejected startup starts no poll");

  // Two startup requests racing: one admitted (200), the other rejected
  // (409) with its response landing last. The late 409 must be silent and
  // the admitted run must own the page.
  const clickA = evalApp("startRun()");
  const clickB = evalApp("startRun()");
  await tick();
  const reqs = [take(isRun), take(isRun)];
  // Server ordering: B wins admission; A's conflict 409 lands afterwards.
  reqs[1].resolve(jsonResponse(200, { run_id: "run4b" }));
  await clickB;
  await tick();
  reqs[0].resolve(jsonResponse(409,
    { error: "已有未结束的运行，请先终止或等待其结束" }));
  await clickA;
  await tick();
  eq(elements.message.textContent, "",
    "[4] late 409 after a winning admission is silent");
  check(optionTexts().length === 1, // dropdown rebuilt empty, new poll pending
    "[4] admitted run cleared the old history");
  await answerPoll("run4b", state("run4b", "paused", 1), [pause(1, 1, {})]);
  check(optionTexts().some((t) => t.includes("停顿 #1")),
    "[4] admitted run populates its own fresh history");
}

// ===========================================================================
// Scenario 5: current-run polling, history select, return-to-live refresh,
//              terminate and post-terminal history all keep working
// ===========================================================================

async function scenarioCurrentRunFeatures() {
  await resetForScenario();
  await admitRun("run5");
  await answerPoll("run5", state("run5", "paused", 2, { current_line: 2 }),
    [pause(1, 1, {}), pause(2, 2, { x: "1" })]);
  check(!elements["btn-step"].disabled, "[5] step enabled on live pause");

  // Enter history view: controls disabled, banner shown.
  elements.history.value = "1";
  elements.history.dispatch("change", { target: elements.history });
  await tick();
  check(elements["btn-step"].disabled, "[5] step disabled in history mode");
  check(elements["btn-continue"].disabled, "[5] continue disabled in history");
  eq(elements["history-banner"].hidden, false, "[5] history banner shown");
  check(!elements["btn-terminate"].disabled, "[5] terminate stays enabled");

  // Polling continues and must not leave the selected record: state moves
  // to pause #3 while the user keeps viewing #1; dropdown gains #3.
  const histPoll = evalApp("poll()");
  await tick();
  take(isState).resolve(jsonResponse(200,
    state("run5", "paused", 3, { current_line: 3 })));
  await tick();
  take(pausesFor("run5")).resolve(jsonResponse(200, {
    run_id: "run5",
    pauses: [pause(1, 1, {}), pause(2, 2, { x: "1" }), pause(3, 3, { x: "2" })],
  }));
  await histPoll;
  await tick();
  eq(elements["history-banner"].hidden, false, "[5] stays in history view");
  check(elements["btn-step"].disabled, "[5] controls stay disabled");
  check(optionTexts().some((t) => t.includes("#3")),
    "[5] dropdown gained fresh pause #3 while viewing history");

  // Return to live: it fetches the latest state BEFORE re-enabling controls.
  const backP = evalApp("returnToLive()");
  await tick();
  const stateDuringReturn = pending.filter(isState).length;
  check(stateDuringReturn >= 1, "[5] return-to-live refreshes state first");
  take(isState).resolve(jsonResponse(200,
    state("run5", "paused", 3, { current_line: 3 })));
  await tick();
  take(pausesFor("run5")).resolve(jsonResponse(200, {
    run_id: "run5",
    pauses: [pause(1, 1, {}), pause(2, 2, { x: "1" }), pause(3, 3, { x: "2" })],
  }));
  await backP;
  await tick();
  eq(elements["history-banner"].hidden, true, "[5] banner hidden back live");
  check(!elements["btn-step"].disabled, "[5] controls re-enabled from fresh state");

  // Terminate the current run: terminal poll stops polling/unlocks the
  // editor/disables terminate, but the pause history remains available.
  const termP = evalApp("terminateRun()");
  await tick();
  take(isControl("terminate")).resolve(
    jsonResponse(200, { ok: true, status: "terminated" }));
  await termP;
  await tick();
  take(isState).resolve(jsonResponse(200,
    state("run5", "terminated", 3, { current_line: 3 })));
  await tick();
  take(pausesFor("run5")).resolve(jsonResponse(200, {
    run_id: "run5",
    pauses: [pause(1, 1, {}), pause(2, 2, { x: "1" }), pause(3, 3, { x: "2" })],
  }));
  await tick();
  await flushTimeouts();
  eq(elements.status.textContent, "已终止", "[5] badge terminated");
  eq(activeIntervals().length, 0, "[5] polling stopped after terminate");
  eq(elements.code.readOnly, false, "[5] source editable again");
  check(elements["btn-terminate"].disabled, "[5] terminate disabled at terminal");
  check(optionTexts().some((t) => t.includes("#3")),
    "[5] history still reviewable after termination");
}

// ===========================================================================
// Scenario 6: within a SINGLE run, an earlier poll's old pauses list (only
// pause #1 when the response was generated) lands AFTER a later poll has
// already shown pause #2 and the user selected it. The old list must not
// overwrite the adopted history: stay viewing #2, no false eviction notice,
// no return to live.
// ===========================================================================

async function scenarioStalePausesListSameRun() {
  await resetForScenario();
  await admitRun("run6");
  await answerPoll("run6", state("run6", "paused", 1), [pause(1, 1, {})]);

  // Two overlapping polls, exactly like two 400ms ticks. Chain A issues its
  // /api/pauses request while only pause #1 existed.
  const chainA = evalApp("poll()");
  const chainB = evalApp("poll()");
  await tick();
  const stateA = take(isState);
  const stateB = take(isState);
  stateA.resolve(jsonResponse(200, state("run6", "paused", 1)));
  await tick();
  const pausesA = take(pausesFor("run6"), "[6] chain A pauses request");

  // The later poll B adopts pause #2 with the newer history.
  stateB.resolve(jsonResponse(200,
    state("run6", "paused", 2, { current_line: 2 })));
  await tick();
  take(pausesFor("run6"), "[6] chain B pauses request").resolve(
    jsonResponse(200, {
      run_id: "run6",
      pauses: [pause(1, 1, {}), pause(2, 2, { x: "1" })],
    }));
  await chainB;
  await tick();
  eq(markedLine(), 2, "[6] live view advanced to pause #2");

  // User selects pause #2 from the newer dropdown.
  elements.history.value = "2";
  elements.history.dispatch("change", { target: elements.history });
  await tick();
  eq(elements["history-banner"].hidden, false, "[6] viewing pause #2");
  check(elements["btn-step"].disabled, "[6] controls disabled while reviewing");

  // Chain A's OLD 200 (built when only #1 existed) now lands last: it must
  // be dropped against the adopted history, so neither a false "evicted"
  // message nor a return-to-live may happen.
  pausesA.resolve(jsonResponse(200,
    { run_id: "run6", pauses: [pause(1, 1, {})] }));
  await chainA;
  await tick();
  eq(elements.message.textContent, "", "[6] no false eviction message");
  eq(elements["history-banner"].hidden, false,
    "[6] stays in history view after stale list lands");
  check(optionTexts().some((t) => t.includes("#2")),
    "[6] adopted history with #2 not overwritten");
  check(elements["btn-step"].disabled, "[6] step stays disabled in review");
  check(!elements["btn-terminate"].disabled, "[6] terminate still available");

  // Returning to live refreshes with the freshest state (still pause #2),
  // and a subsequent step uses the live pause_seq, not a rolled-back one.
  const backP = evalApp("returnToLive()");
  await tick();
  take(isState).resolve(jsonResponse(200,
    state("run6", "paused", 2, { current_line: 2 })));
  await tick();
  take(pausesFor("run6")).resolve(jsonResponse(200, {
    run_id: "run6",
    pauses: [pause(1, 1, {}), pause(2, 2, { x: "1" })],
  }));
  await backP;
  await tick();
  check(!elements["btn-step"].disabled, "[6] step enabled back at live");

  const stepP = evalApp('control("step")');
  await tick();
  const reqStep = take(isControl("step"), "[6] POST /api/step");
  eq(JSON.parse(reqStep.body).pause_seq, 2,
    "[6] step sends the adopted live pause_seq (no rollback to 1)");
  reqStep.resolve(jsonResponse(200, { ok: true, pause_seq: 2 }));
  await stepP;
  await tick();
}

// ===========================================================================
// Scenario 7: within a SINGLE run, a later poll has adopted a newer state
// (pause #3; also running after continue at the same seq); the earlier
// poll's stale /api/state landing afterwards must not roll back the live
// pause, badge, listing or controls, and must issue no follow-up pauses.
// ===========================================================================

async function scenarioStaleStateSameRun() {
  await resetForScenario();
  await admitRun("run7");
  await answerPoll("run7", state("run7", "paused", 2, { current_line: 2 }),
    [pause(1, 1, {}), pause(2, 2, { x: "1" })]);

  const chainA = evalApp("poll()");
  const chainB = evalApp("poll()");
  await tick();
  const stateA = take(isState);
  const stateB = take(isState);
  stateB.resolve(jsonResponse(200,
    state("run7", "paused", 3, { current_line: 3 })));
  await tick();
  take(pausesFor("run7")).resolve(jsonResponse(200, {
    run_id: "run7",
    pauses: [pause(1, 1, {}), pause(2, 2, { x: "1" }), pause(3, 3, { x: "2" })],
  }));
  await chainB;
  await tick();
  eq(markedLine(), 3, "[7] live view at pause #3");
  check(!elements["btn-step"].disabled, "[7] step enabled at pause #3");

  // The earlier poll lands with the stale pause #1 snapshot.
  stateA.resolve(jsonResponse(200, state("run7", "paused", 1)));
  await chainA;
  await tick();
  eq(elements.status.textContent, "已暂停", "[7] badge stays paused");
  eq(markedLine(), 3, "[7] listing not rolled back to pause #1");
  check(!elements["btn-step"].disabled, "[7] step stays enabled");
  check(pending.filter((r) => pausesFor("run7")(r)).length === 0,
    "[7] stale state chain fetches no pauses follow-up");
  const seqBefore = evalApp("pauseSeq");
  eq(seqBefore, 3, "[7] live pause_seq stays 3");

  // Same pause_seq, earlier status rank: a paused snapshot arriving after
  // the run was continued (running) must not roll the badge back either.
  const contP = evalApp('control("continue")');
  await tick();
  const reqCont = take(isControl("continue"), "[7] POST /api/continue");
  reqCont.resolve(jsonResponse(200, { ok: true, pause_seq: 3 }));
  await contP;
  await tick();
  await flushTimeouts();  // control() schedules one follow-up poll
  take(isState, "[7] refresh after continue").resolve(jsonResponse(200,
    state("run7", "running", 3, { current_line: 3 })));
  await tick();
  take(pausesFor("run7")).resolve(jsonResponse(200, {
    run_id: "run7",
    pauses: [pause(1, 1, {}), pause(2, 2, { x: "1" }), pause(3, 3, { x: "2" })],
  }));
  await tick();
  eq(elements.status.textContent, "运行中", "[7] badge running after continue");
  check(elements["btn-step"].disabled, "[7] controls disabled while running");

  const oldP = evalApp("poll()");
  const newP = evalApp("poll()");
  await tick();
  const oldState = take(isState);
  take(isState).resolve(jsonResponse(200,
    state("run7", "running", 3, { current_line: 3 })));
  await tick();
  take(pausesFor("run7")).resolve(jsonResponse(200, {
    run_id: "run7",
    pauses: [pause(1, 1, {}), pause(2, 2, { x: "1" }), pause(3, 3, { x: "2" })],
  }));
  await newP;
  await tick();
  oldState.resolve(jsonResponse(200,
    state("run7", "paused", 3, { current_line: 3 })));
  await oldP;
  await tick();
  eq(elements.status.textContent, "运行中",
    "[7] stale paused snapshot cannot roll running back to paused");
  check(elements["btn-step"].disabled, "[7] controls stay disabled for running");
}

// ===========================================================================
// Scenario 8: a valid terminal state must finalize the page (stop polling,
// unlock editor, re-run enabled) even though this poll's /api/pauses never
// returns and further terminal polls keep arriving; the history stays
// reviewable, and a fresh run can be admitted and driven afterwards.
// ===========================================================================

async function scenarioTerminalFinalizationIndependentOfPauses() {
  await resetForScenario();
  await admitRun("run8");
  await answerPoll("run8", state("run8", "paused", 2, { current_line: 2 }),
    [pause(1, 1, {}), pause(2, 2, { x: "1" })]);

  // A poll observes the terminal state; its pauses follow-up is parked and
  // never answered in this scenario.
  const terminalChain = evalApp("poll()");
  await tick();
  take(isState, "[8] terminal state request")
    .resolve(jsonResponse(200, state("run8", "finished", 2)));
  await tick();
  const parkedPauses = take(pausesFor("run8"), "[8] parked pauses request");
  await terminalChain;
  await tick();

  // Finalization already happened: page editable, rerun enabled, polling
  // stopped, badge terminal, and history still present for review.
  eq(elements.status.textContent, "已结束", "[8] badge finished");
  eq(activeIntervals().length, 0, "[8] polling stopped without pauses reply");
  eq(elements.code.readOnly, false, "[8] editor unlocked without pauses reply");
  check(!elements["btn-run"].disabled, "[8] re-run enabled at terminal");
  check(elements["btn-terminate"].disabled, "[8] terminate disabled at terminal");
  check(optionTexts().some((t) => t.includes("#2")),
    "[8] adopted history still shown in dropdown");

  // More overlapping polls holding terminal states, each with an
  // unanswered pauses follow-up: nothing re-locks the page.
  for (let i = 0; i < 3; i++) {
    const p = evalApp("poll()");
    await tick();
    take(isState).resolve(jsonResponse(200, state("run8", "finished", 2)));
    await tick();
    take(pausesFor("run8"), `[8] trailing pauses ${i}`);  // parked, not answered
    await p;
    await tick();
    eq(elements.code.readOnly, false, `[8] still editable after trailing poll ${i}`);
    eq(activeIntervals().length, 0, `[8] polling stays stopped ${i}`);
  }

  // The terminal history remains reviewable despite every pauses request
  // being stuck.
  elements.history.value = "2";
  elements.history.dispatch("change", { target: elements.history });
  await tick();
  eq(elements["history-banner"].hidden, false, "[8] history reviewable at terminal");
  check(elements["btn-step"].disabled, "[8] no stepping while reviewing terminal");

  // A fresh run is admitted while the old pauses replies are still parked:
  // they self-describe run8 and are dropped by the run_id guard; the new
  // run locks the editor and drives normally.
  await admitRun("run8b");
  eq(elements.code.readOnly, true, "[8] editor locked for the new run");
  eq(elements.status.textContent, "运行中", "[8] badge belongs to the new run");
  parkedPauses.resolve(jsonResponse(200,
    { run_id: "run8", pauses: [pause(1, 1, {}), pause(2, 2, { x: "1" })] }));
  await tick();
  eq(elements.code.readOnly, true, "[8] parked old pauses cannot unlock new run");
  check(!optionTexts().some((t) => t.includes("#2")),
    "[8] old run's history never written into the new run");
  await answerPoll("run8b", state("run8b", "paused", 1), [pause(1, 1, {})]);
  eq(elements.status.textContent, "已暂停", "[8] new run reaches its own pause");
  check(!elements["btn-step"].disabled, "[8] new run's step enabled");
}

// ===========================================================================
// Scenario 9: a REAL eviction still reports and returns to live; the fresh
// list (larger max pause_seq) is adopted, only then the missing selection
// is treated as evicted.
// ===========================================================================

async function scenarioGenuineEvictionStillReported() {
  await resetForScenario();
  await admitRun("run9");
  await answerPoll("run9", state("run9", "paused", 1), [pause(1, 1, {})]);

  // The run advances far: pause #2 exists and can be reviewed...
  const kept = [];
  for (let seq = 2; seq <= 101; seq++) {
    kept.push(pause(seq, seq, { i: String(seq) }));
  }
  const growP = evalApp("poll()");
  await tick();
  take(isState).resolve(jsonResponse(200,
    state("run9", "paused", 101, { current_line: 101 })));
  await tick();
  take(pausesFor("run9")).resolve(jsonResponse(200, {
    run_id: "run9", pauses: [pause(1, 1, {})].concat(kept),
  }));
  await growP;
  await tick();
  // User reviews pause #2 while it is still retained.
  elements.history.value = "2";
  elements.history.dispatch("change", { target: elements.history });
  await tick();
  eq(elements["history-banner"].hidden, false, "[9] reviewing pause #2");

  // A fresh poll adopts a strictly newer list that evicted #2 (now #3..#101).
  const chain = evalApp("poll()");
  await tick();
  take(isState).resolve(jsonResponse(200,
    state("run9", "paused", 101, { current_line: 101 })));
  await tick();
  take(pausesFor("run9")).resolve(jsonResponse(200, {
    run_id: "run9", pauses: kept.slice(1),
  }));
  await chain;
  await tick();
  eq(elements.message.textContent,
    "停顿 #2 已超出最近保留条数被淘汰，已返回实时视图",
    "[9] genuine eviction is still reported");
  eq(elements["history-banner"].hidden, true, "[9] returned to live view");
  check(!elements["btn-step"].disabled, "[9] controls re-enabled back live");
}

async function main() {
  await scenarioTwoOldPollChains();
  await scenarioLateStepResponse();
  await scenarioLateTerminateResponse();
  await scenarioRejectedAndRacingAdmissions();
  await scenarioCurrentRunFeatures();
  await scenarioStalePausesListSameRun();
  await scenarioStaleStateSameRun();
  await scenarioTerminalFinalizationIndependentOfPauses();
  await scenarioGenuineEvictionStillReported();
  await tick();
  await flushTimeouts();
  if (failures) {
    console.error(`\n${failures} frontend assertion(s) failed`);
    process.exit(1);
  }
  console.log("\nall frontend cross-run async-chain checks passed");
}
main().catch((err) => {
  console.error("harness error:", err.stack || err);
  process.exit(2);
});
