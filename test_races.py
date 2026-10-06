#!/usr/bin/env python3
"""Race-condition tests for the run/terminate/event coordination.

Run with:  python3 -m unittest test_races -v

Covers:
  * terminate arriving while the run is still registered but Popen has not
    returned (controlled thread interleaving via a gate);
  * immediate re-run after termination: old child dead+reaped, old run_id
    can no longer control it, two live children never coexist;
  * late events after termination can never flip a terminal run back to an
    active state (white-box event application + end-to-end event flood);
  * normal pause/step/continue flow and duplicate/stale 409 rules;
  * terminating a runaway infinite loop after continue;
  * multiple rerun requests parked on an unreaped predecessor: a woken
    waiter must re-check the run current at that moment and must not
    register/spawn a run while the replacement that won the slot is
    terminal but not yet reaped.
"""

import json
import os
import shutil
import subprocess
import threading
import time
import unittest
from unittest import mock

import app as appmod


SIMPLE_CODE = "x = 1\ny = 2\nprint(x + y)\n"
LOOP_CODE = "while True:\n    pass\n"
FLOOD_CODE = "for i in range(1000000):\n    print(i)\n"


def wait_for(predicate, timeout=10.0, interval=0.01):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return predicate()


class RaceTests(unittest.TestCase):
    def setUp(self):
        self.client = appmod.app.test_client()
        self.created = []  # every Popen handle created during this test
        self._real_popen = appmod.subprocess.Popen

        def tracking_popen(*args, **kwargs):
            proc = self._real_popen(*args, **kwargs)
            self.created.append(proc)
            return proc

        self._patch = mock.patch.object(appmod.subprocess, "Popen", tracking_popen)
        self._patch.start()
        # Start every test from a clean registry.
        with appmod.COND:
            appmod.CURRENT = None

    def tearDown(self):
        self._patch.stop()
        # Best-effort cleanup of any child left behind by a failing test.
        with appmod.COND:
            current = appmod.CURRENT
        if (current is not None and current.status in appmod.ACTIVE_STATES
                and current.proc_started):
            self.client.post("/api/terminate", json={"run_id": current.run_id})
        for proc in self.created:
            if proc.poll() is None:
                try:
                    proc.kill()
                except OSError:
                    pass
                try:
                    proc.wait(timeout=5)
                except Exception:
                    pass

    # ---- helpers -------------------------------------------------------

    def state(self):
        return self.client.get("/api/state").get_json()

    def start_run(self, code=SIMPLE_CODE):
        res = self.client.post("/api/run", json={"code": code})
        self.assertEqual(res.status_code, 200, res.get_data(as_text=True))
        return res.get_json()["run_id"]

    def wait_paused(self, run_id):
        ok = wait_for(lambda: self.state()["status"] == "paused")
        self.assertTrue(ok, f"run {run_id} never paused: {self.state()}")

    def assert_proc_dead(self, proc):
        self.assertIsNotNone(proc.poll(), "child process was not reaped")
        with self.assertRaises(ProcessLookupError):
            os.kill(proc.pid, 0)

    # ---- 1. terminate during startup (controlled interleaving) ---------

    def test_terminate_during_startup_then_immediate_rerun(self):
        entered = threading.Event()
        release = threading.Event()
        _real_popen = self._real_popen

        def gated_popen(*args, **kwargs):
            entered.set()
            self.assertTrue(release.wait(timeout=10), "gate never released")
            proc = _real_popen(*args, **kwargs)
            self.created.append(proc)
            return proc

        with mock.patch.object(appmod.subprocess, "Popen", gated_popen):
            start_result = {}
            starter = threading.Thread(
                target=lambda: start_result.update(self.client.post(
                    "/api/run", json={"code": SIMPLE_CODE}).get_json())
            )
            starter.start()
            self.assertTrue(entered.wait(10), "starter never reached Popen")

            # The run is registered (CURRENT exists) but its child does not
            # exist yet: terminate must be remembered, not lost.
            with appmod.COND:
                old_id = appmod.CURRENT.run_id
                self.assertIsNone(appmod.CURRENT.proc)
                self.assertFalse(appmod.CURRENT.proc_started)

            terminate_result = {}

            def do_terminate():
                res = self.client.post("/api/terminate", json={"run_id": old_id})
                terminate_result["status_code"] = res.status_code
                terminate_result["body"] = res.get_json()

            terminator = threading.Thread(target=do_terminate)
            terminator.start()
            # Terminate is now parked waiting for startup; it must not
            # succeed before the child handle exists and is reaped.
            terminator.join(timeout=0.5)
            self.assertTrue(terminator.is_alive(),
                            "terminate returned while Popen was still gated")

            release.set()
            terminator.join(timeout=10)
            starter.join(timeout=10)
            self.assertFalse(starter.is_alive())
            self.assertFalse(terminator.is_alive())

        self.assertEqual(terminate_result["status_code"], 200, terminate_result)
        self.assertEqual(terminate_result["body"]["status"], "terminated")
        self.assertEqual(start_result["run_id"], old_id)

        with appmod.COND:
            old_run = appmod.CURRENT
            old_proc = old_run.proc
            self.assertEqual(old_run.status, "terminated")
            self.assertTrue(old_run.reaped, "old child not reaped after terminate")
        self.assert_proc_dead(old_proc)

        # Immediate re-run: the old child must be fully reaped first, and
        # only one run may exist afterwards.
        n_before = len(self.created)
        new_id = self.start_run()
        self.assertNotEqual(new_id, old_id)
        self.assertEqual(len(self.created), n_before + 1)
        new_proc = self.created[-1]
        self.assertIsNone(new_proc.poll(), "new child should be alive")
        self.assert_proc_dead(old_proc)  # old child still dead, not reused

        # The stale identifier can no longer drive (terminate) the old run.
        stale = self.client.post("/api/terminate", json={"run_id": old_id})
        self.assertEqual(stale.status_code, 409)

        self.wait_paused(new_id)
        self.cleanup_run(new_id)

    # ---- 2. immediate re-run after an ordinary terminate ----------------

    def test_immediate_rerun_after_terminate(self):
        old_id = self.start_run()
        self.wait_paused(old_id)
        old_proc = appmod.CURRENT.proc

        res = self.client.post("/api/terminate", json={"run_id": old_id})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.get_json()["status"], "terminated")
        self.assert_proc_dead(old_proc)
        self.assertTrue(appmod.CURRENT.reaped)

        new_id = self.start_run()  # no delay: must not 409
        self.assertNotEqual(new_id, old_id)
        self.wait_paused(new_id)
        self.assertEqual(self.state()["status"], "paused")
        self.cleanup_run(new_id)

    # ---- 3. late events must not resurrect a terminal run ---------------

    def test_apply_event_ignores_late_and_foreign_events(self):
        old = appmod.Run("x = 1\n")
        current = appmod.Run("y = 2\n")
        pause = {"type": "pause", "line": 1, "locals": {"a": "1"}}

        with appmod.COND:
            # Terminated run: buffered pause/end/stdout events are dropped.
            appmod.CURRENT = old
            old.status = "terminated"
            appmod._apply_event(old, dict(pause))
            appmod._apply_event(old, {"type": "end"})
            appmod._apply_event(old, {"type": "stdout", "data": "late"})
            self.assertEqual(old.status, "terminated")
            self.assertEqual(old.pause_seq, 0)
            self.assertIsNone(old.current_line)
            self.assertEqual(old.stdout, "")

            # Finished run cannot go back to paused either.
            old.status = "finished"
            appmod._apply_event(old, dict(pause))
            self.assertEqual(old.status, "finished")

            # Events belonging to a run that is no longer current are
            # dropped even if that run object still looks active.
            appmod.CURRENT = current
            current.status = "running"
            old.status = "running"
            appmod._apply_event(old, dict(pause))
            self.assertEqual(old.status, "running")
            self.assertEqual(old.pause_seq, 0)
            appmod.CURRENT = None  # neither synthetic run owns a process

    def test_late_events_after_terminate_end_to_end(self):
        # Child floods stdout events; after continue the pipe is full of
        # events not yet read when terminate lands. Draining them after the
        # kill must not change the terminated state.
        run_id = self.start_run(FLOOD_CODE)
        self.wait_paused(run_id)
        seq = self.state()["pause_seq"]

        res = self.client.post("/api/continue", json={"run_id": run_id, "pause_seq": seq})
        self.assertEqual(res.status_code, 200)
        self.assertTrue(wait_for(lambda: self.state()["status"] == "running"))
        # Let the child get ahead and stuff the pipe, then kill it.
        time.sleep(0.2)
        proc = appmod.CURRENT.proc
        res = self.client.post("/api/terminate", json={"run_id": run_id})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.get_json()["status"], "terminated")

        # terminate succeeded => child reaped => reader finished draining;
        # even so, keep polling: nothing may flip the state back.
        self.assertTrue(appmod.CURRENT.reaped)
        self.assert_proc_dead(proc)
        for _ in range(30):
            snap = self.state()
            self.assertEqual(snap["run_id"], run_id)
            self.assertEqual(snap["status"], "terminated")
            time.sleep(0.01)

    # ---- 4. normal pause / step / continue semantics --------------------

    def test_normal_pause_step_continue_and_dedup(self):
        run_id = self.start_run("x = 1\nx = 2\nx = 3\n")
        self.wait_paused(run_id)

        snap = self.state()
        self.assertEqual(snap["current_line"], 1)
        self.assertEqual(snap["pause_seq"], 1)

        ok = self.client.post("/api/step", json={"run_id": run_id, "pause_seq": 1})
        self.assertEqual(ok.status_code, 200)
        self.assertTrue(wait_for(lambda: self.state()["status"] == "paused"))
        self.assertEqual(self.state()["current_line"], 2)
        self.assertEqual(self.state()["pause_seq"], 2)

        # Duplicate of the consumed pause and stale seq are 409, no advance.
        dup = self.client.post("/api/step", json={"run_id": run_id, "pause_seq": 1})
        self.assertEqual(dup.status_code, 409)
        stale = self.client.post("/api/continue",
                                 json={"run_id": run_id, "pause_seq": 1})
        self.assertEqual(stale.status_code, 409)
        self.assertEqual(self.state()["current_line"], 2)

        cont = self.client.post("/api/continue",
                                json={"run_id": run_id, "pause_seq": 2})
        self.assertEqual(cont.status_code, 200)
        self.assertTrue(wait_for(lambda: self.state()["status"] == "finished"))
        self.assertTrue(appmod.CURRENT.reaped)

        # A terminate for an already-finished run is stale -> 409, never 500.
        late = self.client.post("/api/terminate", json={"run_id": run_id})
        self.assertEqual(late.status_code, 409)

    # ---- 5. runaway infinite loop termination ---------------------------

    def test_infinite_loop_terminate(self):
        run_id = self.start_run(LOOP_CODE)
        self.wait_paused(run_id)
        seq = self.state()["pause_seq"]
        res = self.client.post("/api/continue",
                               json={"run_id": run_id, "pause_seq": seq})
        self.assertEqual(res.status_code, 200)
        self.assertTrue(wait_for(lambda: self.state()["status"] == "running"))
        time.sleep(0.1)  # burning CPU in the child now

        proc = appmod.CURRENT.proc
        res = self.client.post("/api/terminate", json={"run_id": run_id})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.get_json()["status"], "terminated")
        self.assert_proc_dead(proc)
        self.assertTrue(appmod.CURRENT.reaped)

        # A fresh run is accepted right away.
        new_id = self.start_run()
        self.assertNotEqual(new_id, run_id)
        self.cleanup_run(new_id)

    # ---- 6. conflict rules stay 409 -------------------------------------

    def test_single_run_conflict_and_expired_controls(self):
        first_id = self.start_run()
        self.wait_paused(first_id)

        # A second concurrent run conflicts with 409.
        conflict = self.client.post("/api/run", json={"code": SIMPLE_CODE})
        self.assertEqual(conflict.status_code, 409)
        self.assertEqual(len(self.created), 1, "conflicting run spawned a process")

        # Step with an unknown run id is 409.
        bad = self.client.post("/api/step",
                               json={"run_id": "deadbeef", "pause_seq": 1})
        self.assertEqual(bad.status_code, 409)

        # Terminate the first run, then start a new one: the old run id is
        # expired for every control endpoint.
        self.assertEqual(
            self.client.post("/api/terminate", json={"run_id": first_id}).status_code,
            200)
        second_id = self.start_run()
        for path in ("/api/terminate",):
            res = self.client.post(path, json={"run_id": first_id})
            self.assertEqual(res.status_code, 409)
        for path in ("/api/step", "/api/continue"):
            res = self.client.post(path, json={"run_id": first_id, "pause_seq": 1})
            self.assertEqual(res.status_code, 409)
        self.wait_paused(second_id)
        self.cleanup_run(second_id)

    def cleanup_run(self, run_id):
        """Terminate a paused/active run and assert the child is reaped."""
        proc = appmod.CURRENT.proc
        res = self.client.post("/api/terminate", json={"run_id": run_id})
        self.assertEqual(res.status_code, 200, res.get_data(as_text=True))
        self.assert_proc_dead(proc)

    # ---- 7. uncontrolled interleaving stress ---------------------------

    def test_stress_run_terminate_rerun(self):
        n_threads = 4
        cycles = 40
        errors = []
        max_alive = {"v": 0}
        stop = threading.Event()

        def sampler():
            while not stop.is_set():
                alive = sum(1 for p in self.created if p.poll() is None)
                if alive > max_alive["v"]:
                    max_alive["v"] = alive
                time.sleep(0.002)

        monitor = threading.Thread(target=sampler)
        monitor.start()

        def worker(tid):
            client = appmod.app.test_client()
            try:
                for i in range(cycles):
                    res = client.post("/api/run", json={"code": SIMPLE_CODE})
                    if res.status_code == 409:
                        continue  # another thread holds the single run slot
                    self.assertEqual(res.status_code, 200)
                    rid = res.get_json()["run_id"]
                    # Alternate: terminate straight away (may still be in
                    # startup) or after the first pause.
                    if (i + tid) % 2 == 0:
                        time.sleep(0.002)
                    else:
                        if not wait_for(
                                lambda c=client, r=rid:
                                c.get("/api/state").get_json().get("run_id") == r
                                and c.get("/api/state").get_json()["status"] == "paused",
                                timeout=10):
                            errors.append(f"{tid}/{i}: never paused")
                            continue
                    t = client.post("/api/terminate", json={"run_id": rid})
                    if t.status_code != 200 or t.get_json()["status"] != "terminated":
                        errors.append(f"{tid}/{i}: terminate {t.status_code} {t.get_json()}")
                        continue
                    # Immediate re-run: must be admitted once reaped and
                    # then terminated as well.
                    r2 = client.post("/api/run", json={"code": SIMPLE_CODE})
                    if r2.status_code == 200:
                        rid2 = r2.get_json()["run_id"]
                        t2 = client.post("/api/terminate", json={"run_id": rid2})
                        if t2.status_code != 200:
                            errors.append(f"{tid}/{i}: rerun terminate {t2.status_code}")
            except Exception as exc:  # noqa: BLE001 - report from worker
                errors.append(f"worker {tid}: {exc!r}")

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(n_threads)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=60)
            self.assertFalse(t.is_alive(), "worker hung (deadlock?)")
        stop.set()
        monitor.join(timeout=5)

        self.assertEqual(errors, [])
        self.assertGreaterEqual(len(self.created), 4)
        self.assertLessEqual(max_alive["v"], 1,
                             f"up to {max_alive['v']} children lived at once")
        # Every child ever created must be dead AND reaped (poll not None),
        # with no survivors left behind.
        for proc in self.created:
            self.assertIsNotNone(proc.poll(), "child never reaped")
            with self.assertRaises(ProcessLookupError):
                os.kill(proc.pid, 0)


    # ---- 8. Popen failure racing terminate ------------------------------

    def test_popen_failure_during_pending_terminate(self):
        entered = threading.Event()
        terminator_started = threading.Event()
        release = threading.Event()

        def failing_popen(*args, **kwargs):
            entered.set()
            # Only fail after terminate has parked waiting for startup.
            self.assertTrue(terminator_started.wait(timeout=10))
            self.assertTrue(release.wait(timeout=10))
            raise OSError("spawn failed")

        with mock.patch.object(appmod.subprocess, "Popen", failing_popen):
            result = {}

            def do_run():
                res = self.client.post("/api/run", json={"code": SIMPLE_CODE})
                result["run"] = (res.status_code, res.get_json())

            t = threading.Thread(target=do_run)
            t.start()
            self.assertTrue(entered.wait(10))
            with appmod.COND:
                rid = appmod.CURRENT.run_id

            def do_terminate():
                terminator_started.set()
                res = self.client.post("/api/terminate", json={"run_id": rid})
                result["term"] = (res.status_code, res.get_json())

            tt = threading.Thread(target=do_terminate)
            tt.start()
            release.set()  # let Popen fail while terminate is parked
            t.join(timeout=10)
            tt.join(timeout=10)
            self.assertFalse(t.is_alive())
            self.assertFalse(tt.is_alive())
        self.assertEqual(result["run"][0], 200)
        self.assertEqual(result["term"][0], 200)
        with appmod.COND:
            self.assertIn(appmod.CURRENT.status, appmod.TERMINAL_STATES)
            self.assertTrue(appmod.CURRENT.reaped)

        # Next run admitted normally.
        new_id = self.start_run()
        self.wait_paused(new_id)
        self.cleanup_run(new_id)

    # ---- 9. multiple rerun waiters racing for the freed slot ------------

    def test_waiters_cannot_overtake_unreaped_replacement(self):
        """Two rerun requests park on an old run that ended but is not
        reaped yet. Once the old child is reaped, the slot is taken by a
        replacement run that has already reported a terminal state while
        its exit cleanup (reaping) is still incomplete: the parked waiters
        must re-park on the replacement instead of registering/spawning a
        new run (which would leave two live children and invalidate the
        replacement's run_id). Only after the replacement is reaped may
        exactly one waiter be admitted; the other gets 409."""
        # A real run plays the replacement: its child is alive and paused.
        # Pinning its status to a terminal state reproduces the window
        # where the end/exception event already landed but the reader
        # thread has not reaped the child yet.
        replacement_id = self.start_run()
        self.wait_paused(replacement_id)
        with appmod.COND:
            replacement = appmod.CURRENT
            replacement_proc = replacement.proc
            replacement.status = "finished"  # reported over, cleanup pending
            self.assertFalse(replacement.reaped)
            self.assertIsNone(replacement_proc.poll())

            # The older run both requests will park on: terminal, unreaped.
            old = appmod.Run("x = 1\n")
            old.status = "finished"
            appmod.CURRENT = old

        real_wait = appmod._wait_reaped
        wait_calls = []  # every run object a request parks on, in order
        both_parked = threading.Event()

        def spy_wait(run, timeout=appmod.REAP_WAIT_TIMEOUT):
            wait_calls.append(run)
            if len(wait_calls) == 2:
                both_parked.set()
            return real_wait(run, timeout=timeout)

        results = []

        def do_run(tag):
            res = self.client.post("/api/run", json={"code": SIMPLE_CODE})
            results.append((tag, res.status_code, res.get_json()))

        with mock.patch.object(appmod, "_wait_reaped", spy_wait):
            threads = [threading.Thread(target=do_run, args=(i,))
                       for i in range(2)]
            for t in threads:
                t.start()
            self.assertTrue(both_parked.wait(10),
                            "both rerun requests should park on the old run")
            self.assertEqual(len(self.created), 1,
                             "only the replacement's child exists so far")

            # The old child is reaped; meanwhile the replacement (terminal,
            # unreaped) is the current run when the waiters wake up.
            with appmod.COND:
                old.reaped = True
                appmod.CURRENT = replacement
                appmod.COND.notify_all()

            # The waiters must re-park on the unreaped replacement: no new
            # run is registered, no child is spawned, no request returns.
            self.assertTrue(
                wait_for(lambda: len(wait_calls) >= 4, timeout=10),
                f"waiters did not re-park on the unreaped replacement: "
                f"parks={len(wait_calls)} procs={len(self.created)} "
                f"results={results}")
            self.assertTrue(all(run is replacement for run in wait_calls[2:]),
                            "waiters parked on something other than the replacement")
            self.assertEqual(len(self.created), 1,
                             "a second child was spawned while the replacement "
                             "was unreaped (two live children)")
            self.assertIsNone(replacement_proc.poll(),
                              "the replacement's child must still be alive")
            self.assertEqual(len(results), 0,
                             "a parked request returned while the replacement "
                             "was unreaped")
            with appmod.COND:
                self.assertIs(appmod.CURRENT, replacement,
                              "a waiting request replaced the current run, "
                              "invalidating its run_id")

            # The replacement's child exits and is reaped by its reader
            # thread: the slot frees up. Exactly one waiter is admitted and
            # spawns exactly one child; the other sees the now-active run
            # and gets 409.
            appmod._kill_proc(replacement_proc)
            self.assertTrue(wait_for(lambda: replacement.reaped, timeout=10),
                            "replacement child was never reaped")
            for t in threads:
                t.join(timeout=10)
                self.assertFalse(t.is_alive(), "rerun request hung")

        self.assertEqual(sorted(r[1] for r in results), [200, 409], results)
        self.assertEqual(len(self.created), 2,
                         "exactly one new child may be spawned after reaping")
        self.assert_proc_dead(replacement_proc)
        winner = next(r for r in results if r[1] == 200)
        new_id = winner[2]["run_id"]
        self.assertEqual(self.state()["run_id"], new_id)
        self.wait_paused(new_id)
        self.cleanup_run(new_id)

    def test_waiter_conflicts_with_active_replacement(self):
        """A request parked on an unreaped old run wakes up to find the
        slot held by an ACTIVE replacement run: it must get 409 and must
        not spawn a process or replace CURRENT."""
        active = appmod.Run("y = 2\n")  # replacement holding the slot
        old = appmod.Run("x = 1\n")
        old.status = "finished"  # terminal, unreaped
        with appmod.COND:
            appmod.CURRENT = old

        real_wait = appmod._wait_reaped
        parked = threading.Event()

        def spy_wait(run, timeout=appmod.REAP_WAIT_TIMEOUT):
            parked.set()
            return real_wait(run, timeout=timeout)

        result = {}

        def do_run():
            res = self.client.post("/api/run", json={"code": SIMPLE_CODE})
            result["status"] = res.status_code
            result["body"] = res.get_json()

        with mock.patch.object(appmod, "_wait_reaped", spy_wait):
            t = threading.Thread(target=do_run)
            t.start()
            self.assertTrue(parked.wait(10),
                            "request should park on the unreaped old run")
            # The old child is reaped, but an active run now owns the slot.
            with appmod.COND:
                old.reaped = True
                appmod.CURRENT = active
                appmod.COND.notify_all()
            t.join(timeout=10)
            self.assertFalse(t.is_alive(), "rerun request hung")

        self.assertEqual(result["status"], 409, result)
        self.assertEqual(len(self.created), 0,
                         "conflicting request spawned a process")
        with appmod.COND:
            self.assertIs(appmod.CURRENT, active,
                          "rejected request replaced the current run")

    def test_reap_wait_timeout_409_never_replaces_current(self):
        """If the old run stays terminal-but-unreaped past the wait
        timeout, /api/run returns 409 without spawning a process and
        without replacing the current run."""
        old = appmod.Run("x = 1\n")
        old.status = "finished"  # terminal, never gets reaped
        with appmod.COND:
            appmod.CURRENT = old
        with mock.patch.object(appmod, "REAP_WAIT_TIMEOUT", 0.3):
            started = time.monotonic()
            res = self.client.post("/api/run", json={"code": SIMPLE_CODE})
            elapsed = time.monotonic() - started
        self.assertEqual(res.status_code, 409, res.get_data(as_text=True))
        self.assertGreaterEqual(elapsed, 0.25,
                                "returned before waiting out the reap timeout")
        self.assertEqual(len(self.created), 0,
                         "timed-out request spawned a process")
        with appmod.COND:
            self.assertIs(appmod.CURRENT, old,
                          "timed-out request replaced the current run")

    # ---- 10. pause history snapshots and /api/pauses --------------------

    HISTORY_CODE = "x = 1\nprint('hello')\nx = 2\n"

    def get_pauses(self, run_id):
        res = self.client.get(f"/api/pauses?run_id={run_id}")
        self.assertEqual(res.status_code, 200, res.get_data(as_text=True))
        body = res.get_json()
        self.assertEqual(body["run_id"], run_id)
        return body["pauses"]

    def test_pause_history_snapshots_in_pause_seq_order(self):
        run_id = self.start_run(self.HISTORY_CODE)
        self.wait_paused(run_id)

        # seq 1: line 1, nothing executed yet.
        p = self.get_pauses(run_id)
        self.assertEqual([q["pause_seq"] for q in p], [1])
        self.assertEqual(p[0]["current_line"], 1)
        self.assertEqual(p[0]["locals"], {})
        self.assertEqual(p[0]["stdout"], "")
        self.assertFalse(p[0]["stdout_truncated"])

        # seq 2: after `x = 1`, before the print.
        self.client.post("/api/step",
                         json={"run_id": run_id, "pause_seq": 1})
        self.assertTrue(wait_for(
            lambda: self.state()["current_line"] == 2))
        p = self.get_pauses(run_id)
        self.assertEqual([q["pause_seq"] for q in p], [1, 2])
        self.assertEqual(p[1]["current_line"], 2)
        self.assertEqual(p[1]["locals"], {"x": "1"})
        self.assertEqual(p[1]["stdout"], "")

        # A duplicate/stale control is 409 and records no new pause.
        dup = self.client.post("/api/step",
                               json={"run_id": run_id, "pause_seq": 1})
        self.assertEqual(dup.status_code, 409)
        self.assertEqual(len(self.get_pauses(run_id)), 2)

        # seq 3: print has run, its stdout is part of this snapshot only.
        self.client.post("/api/step",
                         json={"run_id": run_id, "pause_seq": 2})
        self.assertTrue(wait_for(
            lambda: self.state()["current_line"] == 3))
        p = self.get_pauses(run_id)
        self.assertEqual([q["pause_seq"] for q in p], [1, 2, 3])
        self.assertEqual(p[2]["locals"], {"x": "1"})
        self.assertEqual(p[2]["stdout"], "hello\n")
        # Earlier snapshots stay exactly as they were at their pause.
        self.assertEqual(p[0]["stdout"], "")
        self.assertEqual(p[1]["stdout"], "")

        # History is still readable after a natural finish.
        self.client.post("/api/continue",
                         json={"run_id": run_id, "pause_seq": 3})
        self.assertTrue(wait_for(
            lambda: self.state()["status"] == "finished"))
        p = self.get_pauses(run_id)
        self.assertEqual([q["pause_seq"] for q in p], [1, 2, 3])
        self.assertEqual(p[2]["stdout"], "hello\n")

    def test_pauses_endpoint_409_for_missing_unknown_and_expired(self):
        # No run at all.
        self.assertEqual(
            self.client.get("/api/pauses").status_code, 409)
        self.assertEqual(
            self.client.get("/api/pauses?run_id=deadbeef").status_code, 409)

        run_id = self.start_run()
        self.wait_paused(run_id)
        # Unknown id while a run is active.
        self.assertEqual(
            self.client.get("/api/pauses?run_id=deadbeef").status_code, 409)

        # A freshly admitted run expires the old id; the new run's history
        # starts at pause_seq 1 and is independent of the old one.
        old_id = run_id
        self.assertEqual(
            self.client.post("/api/terminate",
                             json={"run_id": old_id}).status_code, 200)
        new_id = self.start_run()
        self.assertNotEqual(new_id, old_id)
        self.wait_paused(new_id)
        self.assertEqual(
            self.client.get(f"/api/pauses?run_id={old_id}").status_code, 409)
        p = self.get_pauses(new_id)
        self.assertEqual([q["pause_seq"] for q in p], [1])
        self.cleanup_run(new_id)

    def test_history_cleared_only_by_admitted_run(self):
        run_id = self.start_run(self.HISTORY_CODE)
        self.wait_paused(run_id)
        self.assertEqual(len(self.get_pauses(run_id)), 1)

        # A rejected startup (active run conflict) must not clear history.
        rejected = self.client.post("/api/run",
                                    json={"code": SIMPLE_CODE})
        self.assertEqual(rejected.status_code, 409)
        self.assertEqual(self.state()["run_id"], run_id)
        self.assertEqual(len(self.get_pauses(run_id)), 1)
        self.cleanup_run(run_id)

    def test_eviction_keeps_last_100_without_renumbering(self):
        run = appmod.Run("x = 1\n")
        with appmod.COND:
            appmod.CURRENT = run
            try:
                for i in range(1, 106):
                    appmod._apply_event(
                        run, {"type": "pause", "line": 1,
                              "locals": {"i": str(i)}})
                self.assertEqual(len(run.pauses), appmod.MAX_PAUSE_HISTORY)
                # Oldest six evicted (1..5 gone plus one: 105-100+1 = 6),
                # surviving seq numbers are NOT renumbered.
                self.assertEqual(run.pauses[0]["pause_seq"], 6)
                self.assertEqual(run.pauses[-1]["pause_seq"], 105)
                self.assertEqual(run.pause_seq, 105)
                self.assertEqual(run.pauses[0]["locals"], {"i": "6"})
                body = self.client.get(
                    f"/api/pauses?run_id={run.run_id}").get_json()
                self.assertEqual(len(body["pauses"]), 100)
                self.assertEqual(body["pauses"][0]["pause_seq"], 6)
                self.assertEqual(body["pauses"][-1]["pause_seq"], 105)
            finally:
                appmod.CURRENT = None  # synthetic run owns no process

    def test_snapshot_freezes_stdout_and_truncation_flag(self):
        run = appmod.Run("x = 1\n")
        with appmod.COND:
            appmod.CURRENT = run
            try:
                appmod._apply_event(
                    run, {"type": "pause", "line": 1, "locals": {}})
                first = run.pauses[0]

                # stdout grows past the retention window and gets truncated.
                chunk_a = "a" * (appmod.MAX_STDOUT_CHARS // 2 + 10)
                chunk_b = "b" * (appmod.MAX_STDOUT_CHARS // 2 + 10)
                appmod._apply_event(run, {"type": "stdout", "data": chunk_a})
                appmod._apply_event(run, {"type": "stdout", "data": chunk_b})
                self.assertTrue(run.stdout_truncated)

                appmod._apply_event(
                    run, {"type": "pause", "line": 2, "locals": {}})
                second = run.pauses[1]

                # The first pause is frozen before any of that output.
                self.assertEqual(first["stdout"], "")
                self.assertFalse(first["stdout_truncated"])
                # The second pause sees the retained tail and its flag.
                self.assertEqual(len(second["stdout"]),
                                 appmod.MAX_STDOUT_CHARS)
                self.assertTrue(second["stdout"].endswith(chunk_b[-100:]))
                self.assertTrue(second["stdout_truncated"])
            finally:
                appmod.CURRENT = None

    def test_pauses_endpoint_empty_for_active_run_without_pause(self):
        # White-box: a run registered (running) before its first pause
        # event answers 200 with an empty list.
        run = appmod.Run("x = 1\n")
        with appmod.COND:
            appmod.CURRENT = run
            try:
                res = self.client.get(f"/api/pauses?run_id={run.run_id}")
                self.assertEqual(res.status_code, 200)
                self.assertEqual(res.get_json()["pauses"], [])
            finally:
                appmod.CURRENT = None


class DelayedResponseTests(unittest.TestCase):
    """Cross-run async chain: old in-flight replies delayed across the
    admission of a new run.

    The browser keeps two overlapping poll chains per run and each chain
    issues /api/state plus /api/pauses; control endpoints (step/continue/
    terminate) and even rejected /api/run replies can also be in flight when
    a new run is admitted. The server's job in this contract is:

      * produce every reply (payload AND status code) under COND and finish
        serialising it outside the lock, so a reply that is *already built*
        (in particular a 200 with the old run's pauses) can be held back and
        delivered arbitrarily late without blocking admission or any other
        request;
      * self-describe every payload with the run it belongs to: the delayed
        old state/pauses 200 must still carry the OLD run_id (the frontend
        drops it instead of writing old history/state into the new run), and
        the old run_id is 409 for pauses/controls once the new run is
        admitted;
      * change nothing about the new run while the old reply is parked: its
        status/pauses/lifecycle advance normally and its slot is not
        blocked.
    """

    def setUp(self):
        self.client = appmod.app.test_client()
        self.created = []
        self._real_popen = appmod.subprocess.Popen

        def tracking_popen(*args, **kwargs):
            proc = self._real_popen(*args, **kwargs)
            self.created.append(proc)
            return proc

        self._patch = mock.patch.object(appmod.subprocess, "Popen", tracking_popen)
        self._patch.start()
        with appmod.COND:
            appmod.CURRENT = None

    def tearDown(self):
        self._patch.stop()
        with appmod.COND:
            current = appmod.CURRENT
        if (current is not None and current.status in appmod.ACTIVE_STATES
                and current.proc_started):
            self.client.post("/api/terminate", json={"run_id": current.run_id})
        for proc in self.created:
            if proc.poll() is None:
                try:
                    proc.kill()
                except OSError:
                    pass
                try:
                    proc.wait(timeout=5)
                except Exception:
                    pass

    def state(self):
        return self.client.get("/api/state").get_json()

    def start_run(self, code=SIMPLE_CODE):
        res = self.client.post("/api/run", json={"code": code})
        self.assertEqual(res.status_code, 200, res.get_data(as_text=True))
        return res.get_json()["run_id"]

    def wait_paused(self, run_id):
        ok = wait_for(lambda: self.state()["status"] == "paused")
        self.assertTrue(ok, f"run {run_id} never paused: {self.state()}")

    def cleanup_run(self, run_id):
        proc = appmod.CURRENT.proc
        res = self.client.post("/api/terminate", json={"run_id": run_id})
        self.assertEqual(res.status_code, 200, res.get_data(as_text=True))
        self.assertIsNotNone(proc.poll(), "child not reaped")

    def gated_jsonify(self, gates):
        """Patch flask.jsonify (the same symbol app.py imported) so that,
        while a path's gate is armed AND its one-shot window is open, the
        matching response blocks until released. Arming opens a window that
        captures exactly one request; the captured request parks until
        release is set, then the gate auto-disarms and resets so the test
        may re-arm to park the next response. The response object is fully
        built before blocking and the COND lock has already been released,
        so a parked reply cannot stall run lifecycle transitions. `gates`
        maps path -> {"armed", "window_open", "entered", "release",
        "vacated"} events."""
        real_jsonify = appmod.jsonify
        lock = threading.Lock()

        def fake_jsonify(*args, **kwargs):
            response = real_jsonify(*args, **kwargs)
            path = appmod.request.path
            gate = gates.get(path)
            if gate is None:
                return response
            # Capture the gate object under the lock: a re-arm replaces the
            # mapping with a fresh generation, so this request keeps parking
            # on / releasing its own gate no matter what the test does next.
            with lock:
                should_park = (gate["armed"].is_set()
                               and gate["window_open"].is_set())
                if should_park:
                    gate["window_open"].clear()  # one request per arming
                    gate["entered"].set()
            if not should_park:
                return response
            # Plain wait: assertions must never run in worker threads (a
            # failure there would surface as an unrelated HTTP 500). The
            # test thread checks timing via wait_entered/release.
            gate["release"].wait(timeout=30)
            # Vacate BEFORE clearing armed: re-arm waits on vacated, so it
            # must never observe a vacated previous gate that still looks
            # armed (two generations coexisting would lose a release).
            gate["vacated"].set()
            gate["armed"].clear()
            return response

        return mock.patch.object(appmod, "jsonify", fake_jsonify)

    def call_in_thread(self, client, method, path, gate_key, gates,
                       json_body=None):
        """Perform one request in a thread and store its result."""
        result = {}

        def do():
            if method == "GET":
                res = client.get(path)
            else:
                res = client.post(path, json=json_body)
            result["status"] = res.status_code
            result["body"] = res.get_json()

        t = threading.Thread(target=do)
        t.start()
        return t, result

    def _new_gate(self):
        return {
            "armed": threading.Event(),
            "window_open": threading.Event(),
            "release": threading.Event(),
            "entered": threading.Event(),
            "vacated": threading.Event(),
        }

    def _make_gates(self, paths):
        gates = {}
        for path in paths:
            gate = self._new_gate()
            gate["vacated"].set()  # initial generation: nothing in flight
            gates[path] = gate
        return gates

    def arm(self, gates, path):
        """Arm the gate and open the one-shot capture window. Every arming
        installs FRESH events in the mapping: a request already parked on
        a previous generation keeps referencing its own gate object, so
        later generations can never erase its release signal. Arming waits
        for the previous generation's worker to vacate (it was released),
        keeping generations strictly serial; arming while the current
        generation is still parked is a test bug."""
        old = gates[path]
        self.assertTrue(old["vacated"].wait(10),
                        f"previous gate for {path} never vacated before re-arm")
        if old["armed"].is_set():
            raise RuntimeError(f"gate for {path} re-armed while still parked")
        gate = self._new_gate()
        gate["window_open"].set()
        gate["armed"].set()
        gates[path] = gate

    def wait_entered(self, gates, path):
        self.assertTrue(gates[path]["entered"].wait(10),
                        f"gate for {path} never entered")
        # The request is now parked; test-side calls with the same path are
        # no longer captured (the one-shot window closed on entry).

    def release(self, gates, path):
        """Release the parked request of the current generation and wait
        until its worker vacated. The gate is captured before signalling:
        a later re-arm replaces the mapping, but releasing must act on the
        generation that was actually parked."""
        gate = gates[path]
        gate["release"].set()
        self.assertTrue(gate["vacated"].wait(10),
                        f"gate for {path} never vacated after release")

    # ---- delayed old /api/state reply crossing a new admission ----------

    def test_delayed_old_state_reply_cannot_touch_new_run(self):
        old_id = self.start_run()
        self.wait_paused(old_id)

        gates = self._make_gates(["/api/state"])
        client = appmod.app.test_client()
        with self.gated_jsonify(gates):
            self.arm(gates, "/api/state")
            t, result = self.call_in_thread(
                client, "GET", "/api/state", "/api/state", gates)
            # The state reply (200, old run) is built and parked.
            self.wait_entered(gates, "/api/state")

            # While that reply is in flight the old run is terminated and a
            # new run admitted: admission must not block on the parked reply.
            self.assertEqual(
                self.client.post("/api/terminate",
                                 json={"run_id": old_id}).status_code, 200)
            new_id = self.start_run()
            self.assertNotEqual(new_id, old_id)
            self.wait_paused(new_id)

            # The new run is fully usable while the old reply is still held.
            # (Gate is single-shot and already consumed by the parked reply,
            # so further /api/state calls pass straight through.)
            snap = self.state()
            self.assertEqual(snap["run_id"], new_id)
            self.assertEqual(snap["status"], "paused")
            self.assertEqual(snap["pause_seq"], 1)

            self.release(gates, "/api/state")
            t.join(timeout=10)
            self.assertFalse(t.is_alive())

        # The delayed reply still describes the OLD run as it was when the
        # response was BUILT (paused, before terminate landed): the frontend
        # drops it solely via run_id, so neither this stale paused state nor
        # the old run's later terminal state can ever flip the new run's UI
        # or stop its polling.
        self.assertEqual(result["status"], 200)
        self.assertEqual(result["body"]["run_id"], old_id)
        self.assertIn(result["body"]["status"], ("paused", "terminated"))

        # The new run kept advancing while/after the old reply landed.
        snap = self.state()
        self.assertEqual(snap["run_id"], new_id)
        self.assertEqual(snap["status"], "paused")
        self.cleanup_run(new_id)

    # ---- the headline chain: two old poll chains in parallel, one parked
    #      on a 200 pauses reply, both landing after the new run is admitted

    def test_parallel_old_poll_chains_delayed_across_admission(self):
        old_id = self.start_run()
        self.wait_paused(old_id)
        old_pauses = self.client.get(
            f"/api/pauses?run_id={old_id}").get_json()["pauses"]
        self.assertEqual(len(old_pauses), 1)

        gates = self._make_gates(
            ["/api/state", "/api/pauses", "/api/terminate"])
        client_a = appmod.app.test_client()
        client_b = appmod.app.test_client()
        client_term = appmod.app.test_client()
        with self.gated_jsonify(gates):
            # Poll chain A: its pauses follow-up is answered 200 while the
            # old run is still around, and that reply is held back.
            self.arm(gates, "/api/pauses")
            ta, ra = self.call_in_thread(
                client_a, "GET", f"/api/pauses?run_id={old_id}",
                "/api/pauses", gates)
            self.wait_entered(gates, "/api/pauses")

            # The old run reaches a terminal state; the terminate SUCCESS
            # reply is itself parked so chain B can observe "terminated"
            # while the terminal transition is committed but no terminate
            # response has been processed by the browser yet.
            self.arm(gates, "/api/terminate")
            tt, rt = self.call_in_thread(
                client_term, "POST", "/api/terminate", "/api/terminate",
                gates, json_body={"run_id": old_id})
            self.wait_entered(gates, "/api/terminate")
            self.assertEqual(appmod.CURRENT.status, "terminated")
            self.assertTrue(appmod.CURRENT.reaped)

            # Poll chain B now queries state: it gets the terminal state
            # (200) and that reply is held back across the admission.
            self.arm(gates, "/api/state")
            tb, rb = self.call_in_thread(
                client_b, "GET", "/api/state", "/api/state", gates)
            self.wait_entered(gates, "/api/state")

            # The user's new run is admitted while all three old replies
            # (terminate success, terminal state, old pauses 200) are in
            # flight.
            new_id = self.start_run()
            self.assertNotEqual(new_id, old_id)
            self.wait_paused(new_id)

            # New run's live view is healthy while the old replies park.
            self.assertEqual(self.state()["run_id"], new_id)

            # Exact ordering from the bug report: B completes first (its
            # terminal-state reply lands), the parked terminate success
            # resolves, then A's pauses reply returns.
            self.release(gates, "/api/state")
            tb.join(timeout=10)
            self.release(gates, "/api/terminate")
            tt.join(timeout=10)
            self.release(gates, "/api/pauses")
            ta.join(timeout=10)
            self.assertFalse(
                ta.is_alive() or tb.is_alive() or tt.is_alive())

        # All delayed replies self-describe the OLD run. The frontend
        # run_id guards must drop all of them: the old pause list must never
        # populate the new run's dropdown and the old terminal state / old
        # terminate success must never stop the new polling or flip buttons.
        self.assertEqual(rt["status"], 200)
        self.assertEqual(rt["body"], {"ok": True, "status": "terminated"})

        self.assertEqual(ra["status"], 200)
        self.assertEqual(ra["body"]["run_id"], old_id)
        self.assertEqual(
            [q["pause_seq"] for q in ra["body"]["pauses"]],
            [q["pause_seq"] for q in old_pauses])

        self.assertEqual(rb["status"], 200)
        self.assertEqual(rb["body"]["run_id"], old_id)
        self.assertEqual(rb["body"]["status"], "terminated")

        # The new run's history is independent and still starts at seq 1;
        # old snapshots were never copied into it.
        new_pauses = self.client.get(
            f"/api/pauses?run_id={new_id}").get_json()["pauses"]
        self.assertEqual([q["pause_seq"] for q in new_pauses], [1])
        snap = self.state()
        self.assertEqual(snap["run_id"], new_id)
        self.assertEqual(snap["status"], "paused")
        self.cleanup_run(new_id)

    # ---- old control replies (409 and 200) delayed across admission -----

    def test_delayed_old_step_reply_does_not_touch_new_run(self):
        old_id = self.start_run()
        self.wait_paused(old_id)
        seq = self.state()["pause_seq"]
        self.assertEqual(seq, 1)

        gates = self._make_gates(["/api/step"])
        client = appmod.app.test_client()
        with self.gated_jsonify(gates):
            # The accepted step (200) consumes pause #1.
            accepted = self.client.post(
                "/api/step", json={"run_id": old_id, "pause_seq": seq})
            self.assertEqual(accepted.status_code, 200)
            self.assertTrue(wait_for(
                lambda: self.state()["pause_seq"] == 2
                and self.state()["status"] == "paused"))

            # A duplicate for the already consumed pause yields 409; hold
            # that failure reply back across the new-run admission.
            self.arm(gates, "/api/step")
            t, result = self.call_in_thread(
                client, "POST", "/api/step", "/api/step", gates,
                json_body={"run_id": old_id, "pause_seq": seq})
            self.wait_entered(gates, "/api/step")

            self.assertEqual(
                self.client.post(
                    "/api/terminate", json={"run_id": old_id}).status_code, 200)
            new_id = self.start_run()
            self.wait_paused(new_id)

            self.release(gates, "/api/step")
            t.join(timeout=10)
            self.assertFalse(t.is_alive())

        self.assertEqual(result["status"], 409)
        self.assertEqual(self.state()["run_id"], new_id)
        self.assertEqual(self.state()["status"], "paused")
        self.cleanup_run(new_id)

    def test_delayed_old_terminate_success_reply_does_not_touch_new_run(self):
        old_id = self.start_run()
        self.wait_paused(old_id)

        gates = self._make_gates(["/api/terminate"])
        client = appmod.app.test_client()
        with self.gated_jsonify(gates):
            # A valid terminate: 200 {ok, status} is built (child killed and
            # reaped) but the reply lands only after the new run is admitted.
            self.arm(gates, "/api/terminate")
            t, result = self.call_in_thread(
                client, "POST", "/api/terminate", "/api/terminate", gates,
                json_body={"run_id": old_id})
            self.wait_entered(gates, "/api/terminate")

            # The success guarantee still holds while the reply is parked:
            # the child is dead and reaped, so the new run is admitted at
            # once.
            new_id = self.start_run()
            self.assertNotEqual(new_id, old_id)
            self.wait_paused(new_id)

            self.release(gates, "/api/terminate")
            t.join(timeout=10)
            self.assertFalse(t.is_alive())

        self.assertEqual(result["status"], 200)
        self.assertEqual(result["body"], {"ok": True, "status": "terminated"})
        # The old terminate's success response must not flip the new run's
        # UI: it is still paused and its terminate is still available.
        snap = self.state()
        self.assertEqual(snap["run_id"], new_id)
        self.assertEqual(snap["status"], "paused")
        self.cleanup_run(new_id)

    # ---- old pauses 200 (built pre-admission) and 409 (post-admission)
    #      both delayed, plus a rejected run reply -----------------------

    def test_delayed_pauses_200_then_expired_409_and_rejected_run_view(self):
        old_id = self.start_run()
        self.wait_paused(old_id)
        old_pauses = self.client.get(
            f"/api/pauses?run_id={old_id}").get_json()["pauses"]
        self.assertEqual(
            self.client.post(
                "/api/terminate", json={"run_id": old_id}).status_code, 200)

        gates = self._make_gates(["/api/pauses", "/api/run"])
        client = appmod.app.test_client()
        with self.gated_jsonify(gates):
            # Old id is still current (terminal) when this request runs: a
            # 200 with the old history is BUILT before admission and held
            # back across it -- the frontend bug path.
            self.arm(gates, "/api/pauses")
            t_old200, r_old200 = self.call_in_thread(
                client, "GET", f"/api/pauses?run_id={old_id}",
                "/api/pauses", gates)
            self.wait_entered(gates, "/api/pauses")

            new_id = self.start_run()
            self.wait_paused(new_id)

            # Let the pre-admission 200 land only now (after admission);
            # the gate resets on vacate so it can be re-armed.
            self.release(gates, "/api/pauses")
            t_old200.join(timeout=10)
            self.assertFalse(t_old200.is_alive())

            # After admission the same old id is expired: its 409 reply is
            # generated now and also held back.
            self.arm(gates, "/api/pauses")
            t_old409, r_old409 = self.call_in_thread(
                appmod.app.test_client(), "GET",
                f"/api/pauses?run_id={old_id}", "/api/pauses", gates)
            self.wait_entered(gates, "/api/pauses")

            # A rejected /api/run (active conflict) whose 409 is also slow:
            # rejecting it must leave the admitted new run untouched.
            self.arm(gates, "/api/run")
            t_run, r_run = self.call_in_thread(
                appmod.app.test_client(), "POST", "/api/run", "/api/run",
                gates, json_body={"code": SIMPLE_CODE})
            self.wait_entered(gates, "/api/run")
            # The rejection clears nothing: history and current run intact.
            self.assertEqual(self.state()["run_id"], new_id)

            self.release(gates, "/api/pauses")
            self.release(gates, "/api/run")
            t_old409.join(timeout=10)
            t_run.join(timeout=10)
            self.assertFalse(t_old409.is_alive() or t_run.is_alive())

        # The pre-admission reply stays a 200 but self-describes as the OLD
        # run (dropped by the frontend guard); the post-admission request
        # gets the unchanged 409 contract.
        self.assertEqual(r_old200["status"], 200)
        self.assertEqual(r_old200["body"]["run_id"], old_id)
        self.assertEqual(
            [p["pause_seq"] for p in r_old200["body"]["pauses"]],
            [p["pause_seq"] for p in old_pauses])
        self.assertEqual(r_old409["status"], 409)
        self.assertEqual(r_run["status"], 409)
        snap = self.state()
        self.assertEqual(snap["run_id"], new_id)
        self.assertEqual(snap["status"], "paused")
        self.cleanup_run(new_id)

    # ---- parked replies never hold COND: live controls still flow -------

    def test_parked_old_reply_never_blocks_new_run_controls(self):
        old_id = self.start_run()
        self.wait_paused(old_id)

        gates = self._make_gates(["/api/pauses"])
        client = appmod.app.test_client()
        with self.gated_jsonify(gates):
            self.arm(gates, "/api/pauses")
            t, result = self.call_in_thread(
                client, "GET", f"/api/pauses?run_id={old_id}",
                "/api/pauses", gates)
            self.wait_entered(gates, "/api/pauses")

            # Even before the admission, unrelated requests must not queue
            # behind COND while a reply is parked: state answers and an
            # accepted step goes through immediately...
            step = self.client.post(
                "/api/step", json={"run_id": old_id, "pause_seq": 1})
            self.assertEqual(step.status_code, 200)
            # ...and the duplicate for the now-consumed pause is rejected
            # with 409 right away.
            dup = self.client.post(
                "/api/step", json={"run_id": old_id, "pause_seq": 1})
            self.assertEqual(dup.status_code, 409)

            self.assertEqual(
                self.client.post(
                    "/api/terminate", json={"run_id": old_id}).status_code, 200)
            new_id = self.start_run()
            self.wait_paused(new_id)
            seq = self.state()["pause_seq"]

            # New run's normal controls work while the old reply is parked:
            # step advances and a fresh pause snapshot appears.
            ok = self.client.post(
                "/api/step", json={"run_id": new_id, "pause_seq": seq})
            self.assertEqual(ok.status_code, 200)
            self.assertTrue(wait_for(
                lambda: self.state()["run_id"] == new_id
                and self.state()["status"] == "paused"
                and self.state()["pause_seq"] == seq + 1))

            self.release(gates, "/api/pauses")
            t.join(timeout=10)
            self.assertFalse(t.is_alive())

        self.assertEqual(result["status"], 200)
        self.assertEqual(result["body"]["run_id"], old_id)
        self.assertEqual(self.state()["run_id"], new_id)
        self.cleanup_run(new_id)


@unittest.skipUnless(shutil.which("node"), "node is required for the JS frontend race checks")
class FrontendAsyncChainTests(unittest.TestCase):
    """Runs the controllable-fetch browser regression (test_frontend_races.js)
    against the REAL static/app.js: two overlapping old poll chains, late old
    control/run responses and the current run's own features. The harness
    exits non-zero on any failed assertion."""

    def test_frontend_cross_run_async_chain(self):
        here = os.path.dirname(os.path.abspath(__file__))
        script = os.path.join(here, "test_frontend_races.js")
        proc = subprocess.run(
            ["node", script], cwd=here,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        if proc.returncode != 0:
            self.fail(
                f"frontend race harness exited {proc.returncode}:\n"
                + proc.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)
