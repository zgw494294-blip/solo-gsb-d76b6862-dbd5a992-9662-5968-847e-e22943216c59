#!/usr/bin/env node
/**
 * Frontend regression for the cross-run async chain.
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
 *    return-to-live and terminate keep working.
 *
 * Same-run polling-ordering regressions (overlapping polls of ONE run):
 *
 *  - when an older poll is waiting on history and a newer poll has already
 *    displayed/been adopted with pause #2, the older poll's stale list
 *    (containing only pause #1) arriving after the user selected pause #2
 *    must NOT be treated as an eviction (no message, no kick back to live,
 *    no dropdown/selection/highlight rollback);
 *  - an older poll's late stale state (pause #1/#2) landing after a newer
 *    poll adopted pause #2/#3 must not roll back liveState, pause_seq,
 *    badge, prompt or buttons, and must send no further history request;
 *  - a genuine server-side eviction (the newest poll's list no longer
 *    contains the selected pause) is still reported and returns to live.
 *
 * Terminal finalization must not depend on history replies or on being the
 * newest poll: at finish/exception/terminate, even if later polls are
 * perpetually in flight and /api/pauses replies are held forever, the page
 * stops polling, unlocks the editor and permits rerun, while history already
 * fetched stays reviewable and late history replies still populate the
 * dropdown. A normal finish closes cleanly as well.
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
    scheduleFailFast();
  }
}
function eq(actual, expected, msg) {
  const ok = actual === expected;
  if (!ok) {
    failures++;
    console.error(`FAIL - ${msg}: expected ${JSON.stringify(expected)}, ` +
                  `got ${JSON.stringify(actual)}`);
    scheduleFailFast();
  } else {
    console.log("ok - " + msg);
  }
}
// Exit immediately on the first failed batch: without this, a later step can
// hang against unfixed code (the terminal-lock bug leaves a poll parked on an
// unanswered request), the Node event loop drains and the process would
// leave with status 0, masking the failure. The check is scheduled as a
// microtask so it fires even from mid-scenario hangs (the awaited promise
// never resumes; the pending microtask still runs once the stack unwinds).
function failFastIfBroken() {
  if (failures) {
    console.error(`\n${failures} frontend assertion(s) failed`);
    process.exit(1);
  }
}
let failFastScheduled = false;
function scheduleFailFast() {
  if (failures && !failFastScheduled) {
    failFastScheduled = true;
    Promise.resolve().then(failFastIfBroken);
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
    pending.push({ method: opts.method || "GET", url, resolve });
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
// Text of the gutter ({"→ ..": highlighted}) of the currently rendered line
// rows; lets assertions read which source line the listing highlights.
const listingRows = () =>
  elements.listing.children.map((row) =>
    row.children[0] ? row.children[0].textContent : "");
const highlightedLine = () => {
  const row = listingRows().find((t) => t.startsWith("→"));
  return row ? Number(String(row).trim().replace(/^→\s*/, "")) : null;
};
const localsText = () => elements.locals.tbody.textContent;

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
// Scenario 6: same-run polling regression — an older poll must never roll
// back a newer poll's adopted state/history (false eviction + live rollback)
// ===========================================================================

async function scenarioSameRunStalePolls() {
  await resetForScenario();
  await admitRun("six");
  await answerPoll("six", state("six", "paused", 1, { current_line: 1 }),
    [pause(1, 1, {})]);

  // --- history-mode false eviction, exact ordering from the report ---
  // An older poll is already waiting on its /api/pauses 200 while the NEWER
  // poll returns first and is adopted with pause #2 (dropdown/view show #2).
  // The user selects pause #2, and only THEN does the older poll's held
  // history reply return — carrying the stale list generated earlier, which
  // contains pause #1 only.
  const older = evalApp("poll()");
  const newer = evalApp("poll()");
  await tick();
  const reqStateOlder = take(isState, "older poll state");
  const reqStateNewer = take(isState, "newer poll state");

  // Older poll's state (pause #1 era) lands and its history 200 is produced,
  // then held without resolving.
  reqStateOlder.resolve(jsonResponse(200,
    state("six", "paused", 1, { current_line: 1 })));
  await tick();
  const olderPauses = take(pausesFor("six"), "older poll held pauses 200");

  // Newer poll answers first with pause #2 and the fresh 2-entry list; it is
  // adopted. The user now selects pause #2 from the dropdown.
  reqStateNewer.resolve(jsonResponse(200,
    state("six", "paused", 2, { current_line: 2 })));
  await tick();
  take(pausesFor("six"), "newer poll pauses").resolve(jsonResponse(200, {
    run_id: "six",
    pauses: [pause(1, 1, {}), pause(2, 2, { x: "1" })],
  }));
  await newer;
  await tick();
  check(optionTexts().some((t) => t.includes("停顿 #2")),
    "[6] dropdown shows newer pause #2");
  elements.history.value = "2";
  elements.history.dispatch("change", { target: elements.history });
  await tick();
  eq(highlightedLine(), 2, "[6] selected pause #2 renders line 2");
  eq(evalApp("pauseSeq"), 2, "[6] live pause_seq is 2");

  // The held older history 200 now returns with the STALE [#1]-only list.
  olderPauses.resolve(jsonResponse(200,
    { run_id: "six", pauses: [pause(1, 1, {})] }));
  await older;
  await tick();
  eq(elements.message.textContent, "",
    "[6] stale #1-only list does NOT report pause #2 as evicted");
  eq(elements["history-banner"].hidden, false,
    "[6] stays in history view, not kicked back to live");
  eq(highlightedLine(), 2, "[6] highlight stays on the selected pause #2");
  check(optionTexts().some((t) => t.includes("#2")),
    "[6] dropdown keeps the newer pause #2 entry");
  check(elements["btn-step"].disabled && elements["btn-continue"].disabled,
    "[6] controls stay disabled in history mode");

  // --- live-mode rollback: late stale state must not win in live view ---
  elements.history.value = "";
  elements.history.dispatch("change", { target: elements.history });
  await tick();
  take(isState, "return-to-live state").resolve(jsonResponse(200,
    state("six", "paused", 2, { current_line: 2 })));
  await tick();
  take(pausesFor("six"), "return-to-live pauses").resolve(jsonResponse(200, {
    run_id: "six",
    pauses: [pause(1, 1, {}), pause(2, 2, { x: "1" })],
  }));
  await tick();
  check(!elements["btn-step"].disabled, "[6] controls re-enabled back live");

  // Two overlapping polls: newer adopts pause #3; the older's stale pause-#2
  // state lands afterwards and must be dropped wholesale (it must never even
  // fetch its history list).
  const old2 = evalApp("poll()");
  const new2 = evalApp("poll()");
  await tick();
  const old2State = take(isState, "older2 state");
  const new2State = take(isState, "newer2 state");
  new2State.resolve(jsonResponse(200,
    state("six", "paused", 3, { current_line: 3, locals: { x: "2" } })));
  await tick();
  take(pausesFor("six"), "newer2 pauses").resolve(jsonResponse(200, {
    run_id: "six",
    pauses: [pause(1, 1, {}), pause(2, 2, { x: "1" }), pause(3, 3, { x: "2" })],
  }));
  await new2;
  await tick();
  eq(evalApp("pauseSeq"), 3, "[6] pause_seq advanced to 3");

  old2State.resolve(jsonResponse(200,
    state("six", "paused", 2, { current_line: 2 })));
  await old2;
  await tick();
  eq(evalApp("pauseSeq"), 3, "[6] late stale state does not roll pause_seq back");
  eq(elements.status.textContent, "已暂停", "[6] badge unchanged");
  eq(pending.filter((r) => pausesFor("six")(r)).length, 0,
    "[6] dropped stale state fetches no history");
  check(!elements["btn-step"].disabled, "[6] buttons untouched by stale poll");
}

// ===========================================================================
// Scenario 7: terminal finalize with later polls perpetually in flight and a
// held /api/pauses reply — the page must unlock, stop polling and permit
// rerun; history stays reviewable and a late history reply still populates it
// ===========================================================================

async function scenarioTerminalWithInflightPolls() {
  await resetForScenario();
  await admitRun("seven");
  await answerPoll("seven", state("seven", "paused", 1), [pause(1, 1, {})]);
  const intervalId = activeIntervals()[0];

  const termP = evalApp("terminateRun()");
  await tick();
  take(isControl("terminate"), "POST /api/terminate")
    .resolve(jsonResponse(200, { ok: true, status: "terminated" }));
  await termP;
  await tick();
  // terminateRun() triggered a poll (P0); the interval fires another (P1).
  const p0 = take(isState, "terminal poll state");
  evalApp("poll()"); // P1: a later poll, still in flight
  await tick();
  const p1 = take(isState, "later poll state");
  // Yet another later poll exists and its STATE reply is held forever: under
  // the old "only the newest poll may finalize" rule the page would stay
  // locked waiting for P1 (and for P0's history reply).
  evalApp("poll()");
  await tick();
  const p2 = take(isState, "perpetually-in-flight poll state");

  // P0 receives the terminal state; its /api/pauses reply is then held.
  p0.resolve(jsonResponse(200,
    state("seven", "terminated", 1, { current_line: 1 })));
  await tick();
  const p0Pauses = take(pausesFor("seven"), "terminal poll pauses (held)");

  // Finalize must already have happened, without the history reply and
  // despite P1/P2 being newer and in flight.
  eq(elements.status.textContent, "已终止", "[7] badge terminated immediately");
  eq(elements.code.readOnly, false,
    "[7] source editable even while history reply and later polls are held");
  check(elements["btn-run"].disabled === false, "[7] rerun enabled");
  check(elements["btn-terminate"].disabled, "[7] terminate disabled at terminal");
  check(!activeIntervals().includes(intervalId),
    "[7] polling stopped despite in-flight newer polls");
  check(optionTexts().some((t) => t.includes("停顿 #1")),
    "[7] previously fetched history stays reviewable");
  // History view on the retained snapshot still works.
  elements.history.value = "1";
  elements.history.dispatch("change", { target: elements.history });
  await tick();
  eq(elements["history-banner"].hidden, false, "[7] can still review pause #1");
  check(elements["btn-step"].disabled && elements["btn-continue"].disabled,
    "[7] step/continue disabled while reviewing a terminated run");

  // A rerun is admitted while P0's history reply is still held and P1/P2
  // state replies are outstanding: nothing late can relock or re-terminate.
  await admitRun("sevenB");
  eq(elements.code.readOnly, true, "[7] new run locks the editor again");
  check(activeIntervals().length === 1, "[7] new run polls on its own timer");

  // The held old history 200 and P1/P2 old terminal states land now: they
  // describe the OLD run and must be dropped silently (no relock, no rerun
  // disable, no extra poll, no message).
  p0Pauses.resolve(jsonResponse(200,
    { run_id: "seven", pauses: [pause(1, 1, {})] }));
  p1.resolve(jsonResponse(200,
    state("seven", "terminated", 1, { current_line: 1 })));
  p2.resolve(jsonResponse(200,
    state("seven", "terminated", 1, { current_line: 1 })));
  await tick(); await tick();
  eq(elements.message.textContent, "", "[7] late old-terminal polls are silent");
  eq(elements.code.readOnly, true, "[7] editor stays locked for the new run");
  check(elements["btn-run"].disabled, "[7] new run not stopped by old terminals");
  check(!elements["btn-terminate"].disabled, "[7] terminate stays for new run");
  check(activeIntervals().length === 1, "[7] new run timer untouched");

  await answerPoll("sevenB", state("sevenB", "paused", 1), [pause(1, 1, {})]);
  eq(elements.status.textContent, "已暂停", "[7] new run reaches its pause");
  // Outstanding old-run history requests (created by dropped P1/P2 after
  // state guard) are irrelevant; leave them and reset.
}

// ===========================================================================
// Scenario 8: normal finish closes cleanly (single in-flight poll) and a
// genuine eviction is still reported
// ===========================================================================

async function scenarioNormalFinishAndEviction() {
  await resetForScenario();
  await admitRun("eight");
  await answerPoll("eight", state("eight", "paused", 1), [pause(1, 1, {})]);
  const intervalId = activeIntervals()[0];
  check(!elements["btn-terminate"].disabled, "[8] terminate enabled while paused");

  // Natural finish arrives on the single outstanding poll: clean finalize.
  evalApp("poll()");
  await tick();
  take(isState, "finish state").resolve(jsonResponse(200,
    state("eight", "finished", 1, { current_line: null })));
  await tick();
  take(pausesFor("eight"), "finish pauses").resolve(jsonResponse(200, {
    run_id: "eight",
    pauses: [pause(1, 1, {})],
  }));
  await tick(); await flushTimeouts();
  eq(elements.status.textContent, "已结束", "[8] badge finished");
  eq(elements.code.readOnly, false, "[8] editor editable after finish");
  check(elements["btn-run"].disabled === false, "[8] rerun enabled after finish");
  check(elements["btn-terminate"].disabled, "[8] terminate disabled at finish");
  check(!activeIntervals().includes(intervalId), "[8] timer cleared after finish");
  check(optionTexts().some((t) => t.includes("停顿 #1")),
    "[8] history reviewable after finish");

  // Genuine eviction: the NEWEST poll of a run returns a list that no longer
  // contains the selected pause (server dropped it beyond the retention).
  await admitRun("nine");
  await answerPoll("nine",
    state("nine", "paused", 101, { current_line: 5 }),
    [pause(100, 4, { x: "99" }), pause(101, 5, { x: "100" })]);
  elements.history.value = "100";
  elements.history.dispatch("change", { target: elements.history });
  await tick();
  evalApp("poll()");
  await tick();
  take(isState, "evicting state").resolve(jsonResponse(200,
    state("nine", "paused", 102, { current_line: 6 })));
  await tick();
  take(pausesFor("nine"), "evicting pauses").resolve(jsonResponse(200, {
    run_id: "nine",
    pauses: [pause(101, 5, { x: "100" }), pause(102, 6, { x: "101" })],
  }));
  await tick(); await flushTimeouts();
  check(elements.message.textContent.includes("#100")
    && elements.message.textContent.includes("淘汰"),
    "[8] genuine eviction still reported with the pause number");
  eq(elements["history-banner"].hidden, true,
    "[8] eviction returns to live view");
  check(!elements["btn-step"].disabled, "[8] live controls re-enabled after eviction");
}

async function main() {
  await scenarioTwoOldPollChains();
  await scenarioLateStepResponse();
  await scenarioLateTerminateResponse();
  await scenarioRejectedAndRacingAdmissions();
  await scenarioCurrentRunFeatures();
  await scenarioSameRunStalePolls();
  failFastIfBroken();  // unfixed code parks on the terminal-lock scenario next
  await scenarioTerminalWithInflightPolls();
  failFastIfBroken();
  await scenarioNormalFinishAndEviction();
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
