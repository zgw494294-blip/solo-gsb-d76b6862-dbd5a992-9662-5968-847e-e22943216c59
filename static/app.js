"use strict";

const $ = (id) => document.getElementById(id);

const EXAMPLES = {
  assign: `# 赋值示例
x = 1
y = 2
total = x + y
name = "alice"
msg = name + " has " + str(total) + " apples"
print(msg)`,

  func: `# 函数调用示例
def add(a, b):
    result = a + b
    return result

def main():
    x = add(3, 4)
    y = add(x, 10)
    print("y =", y)

main()`,

  loop: `# 循环示例
total = 0
for i in range(5):
    total += i
    print("i =", i, "total =", total)

n = 3
while n > 0:
    n -= 1
print("done", total)`,

  exc: `# 异常示例
def div(a, b):
    return a / b

values = [10, 5, 0]
for v in values:
    print("100 /", v, "=", div(100, v))
print("never reached")`,
};

const STATUS_TEXT = {
  idle: "空闲",
  running: "运行中",
  paused: "已暂停",
  finished: "已结束",
  exception: "异常终止",
  terminated: "已终止",
};

let runId = null;        // run id of the run this page is driving
let pauseSeq = 0;        // pause sequence number of the latest (live) pause
let pollTimer = null;
let liveState = null;    // latest /api/state snapshot for runId (monotonic)
let pauses = [];         // pause snapshots returned by /api/pauses (asc seq)
let viewingSeq = null;   // selected historical pause_seq, or null = live view
let historySig = "";     // dropdown contents signature, to avoid rebuilding
// 同一运行内重叠的轮询（400ms 定时轮询与手动/控制触发的 poll）可能乱序返回：
// 较晚轮询采纳的状态/历史一旦落地，较早轮询的迟到响应不得再回退任何视图。
// 快照在服务端只随时间前进，因此以“已采纳内容”为单调高水位即可识别旧响应，
// 不依赖响应恰好按发出顺序返回：
//   - liveState 的 (pause_seq, 状态阶段) 只允许前进（stateIsStale）；
//   - 停顿集合只增不减（淘汰发生时最大 pause_seq 也严格增大），最大序号倒退
//     的列表必来自更旧的轮询（pausesIsOlder）。
// 跨运行的归属仍由每处 await 之后的 run_id 校验保证（见 fetchPauses/poll）。
// 每次“获准启动的新运行”自增：/api/run 的迟到拒绝（如双击中落败的那一个
// 请求、等待回收期间排队的重跑）不得在新运行获准后再弹错误提示。
let admitSeq = 0;

const TERMINAL_STATES = ["finished", "exception", "terminated"];

function isTerminal(status) {
  return TERMINAL_STATES.includes(status);
}

// 状态阶段序：同一 pause_seq 下，paused（刚停顿）早于 running（步进/继续已
// 被接受、下一停顿事件尚未到达），终态最晚且粘滞。
function statusRank(status) {
  if (isTerminal(status)) return 2;
  if (status === "running") return 1;
  return 0;
}

// 迟到状态是否比“已展示的最新状态”更旧。执行只会前进：pause_seq 倒退必旧；
// 同序号下阶段倒退（running→paused、终态→活动态）也必旧。序号更大的快照
// （新停顿）即使阶段看起来“更低”（running seq N → paused seq N+1）也是新的。
function stateIsStale(incoming, current) {
  if (!current || incoming.run_id !== current.run_id) return false;
  if (incoming.pause_seq < current.pause_seq) return true;
  if (incoming.pause_seq === current.pause_seq) {
    return statusRank(incoming.status) < statusRank(current.status);
  }
  return false;
}

function lastPauseSeq(list) {
  return list.length ? list[list.length - 1].pause_seq : 0;
}

// 停顿列表是否比已采纳的更旧：服务端按 pause_seq 升序返回，且集合只增不减
// （淘汰只在新增停顿的同一事件里发生，届时最大序号严格增大）。最大序号相同
// 视为同代（幂等重渲），不倒退即可。
function pausesIsOlder(incoming, current) {
  return lastPauseSeq(incoming) < lastPauseSeq(current);
}

function inHistoryMode() {
  return viewingSeq !== null;
}

function showMessage(text) {
  $("message").textContent = text || "";
}

function updateLineCount() {
  const lines = $("code").value.split("\n").length;
  const el = $("line-count");
  el.textContent = `${lines} / ${MAX_LINES} 行`;
  el.classList.toggle("over", lines > MAX_LINES);
}

function setRunningUI(running) {
  $("code").readOnly = running;               // 运行期间源码只读
  $("examples").disabled = running;
  $("btn-run").disabled = running;
  $("btn-terminate").disabled = !running;
  if (running) {
    $("btn-step").disabled = true;
    $("btn-continue").disabled = true;
  }
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(poll, 400);
  poll();
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

async function startRun() {
  showMessage("");
  // 记录本次启动尝试对应的归属代际：响应返回后若已有更晚的获准启动
  // （双击/快速重跑：先回 200 的请求已经切走归属），这个迟到结果必须
  // 静默丢弃，不得再改提示，更不能清空/切回当前运行的历史与视图。
  const myAdmitSeq = admitSeq;
  const { ok, data } = await postJSON("/api/run", { code: $("code").value });
  if (!ok) {
    if (admitSeq !== myAdmitSeq) return;  // 已有获准的新运行：静默丢弃
    // 启动被拒绝（如活动运行冲突）：不清空既有停顿，也不切走当前视图
    showMessage(data.error || "启动失败");
    return;
  }
  // 只有 200（服务端真正接纳）才切换归属：更换 runId、清空上一运行的
  // 历史与视图、恢复只读并重启轮询。极端乱序下已有更晚的获准启动时，
  // 同样静默丢弃这个迟到的 200。
  if (admitSeq !== myAdmitSeq) return;
  admitSeq += 1;
  runId = data.run_id;
  pauseSeq = 0;
  liveState = null;
  pauses = [];
  historySig = null;  // 强制下次重建下拉框，清掉上一个运行的停顿条目
  exitHistoryView();
  showMessage("");    // 清掉同批失败请求可能已显示的 409 提示
  populateHistory();
  setRunningUI(true);
  renderStatusBadge("running");  // 归属切换：徽标立即属于新运行，旧终态不再停留
  startPolling();
}

async function control(kind) {
  if (!runId || inHistoryMode()) return;  // 历史模式禁用步进/继续
  // 捕获本次请求所属的运行；await 返回后若页面已获准启动新运行，旧请求
  // 的成功/失败一律静默丢弃：不改提示、不改按钮，也不触发轮询去动新运行。
  const myRunId = runId;
  // 同一次停顿只发一次；服务端也会拒绝重复/过期请求
  $("btn-step").disabled = true;
  $("btn-continue").disabled = true;
  const { ok, data } = await postJSON(`/api/${kind}`, {
    run_id: myRunId,
    pause_seq: pauseSeq,  // 始终用实时 pause_seq，绝不用历史序号推进
  });
  if (runId !== myRunId) return;  // 旧运行的迟到响应，不触碰新运行的任何 UI
  if (!ok) {
    showMessage(data.error || "请求被拒绝");
  } else {
    showMessage("");
  }
  setTimeout(poll, 60);
}

async function terminateRun() {
  if (!runId) return;  // 历史模式下仍作用于当前运行
  const myRunId = runId;
  const { ok, data } = await postJSON("/api/terminate", { run_id: myRunId });
  if (runId !== myRunId) return;  // 旧终止请求的迟到响应不得作用于新运行
  if (!ok) showMessage(data.error || "终止失败");
  poll();
}

async function fetchPauses(forRunId) {
  try {
    const res = await fetch(
      `/api/pauses?run_id=${encodeURIComponent(forRunId)}`);
    if (!res.ok) return null;  // 过期/未知 run_id（409）：保持现有列表
    const data = await res.json();
    // 这个 200 可能在请求发出后很久才返回（期间新运行已获准）：响应体里
    // 的 run_id 是最终凭据，不匹配本轮轮询捕获的运行就整体丢弃。
    if (data.run_id !== forRunId) return null;
    return data.pauses || [];
  } catch (e) {
    return null;
  }
}

async function poll() {
  if (!runId) return;
  // 捕获本轮轮询所属的运行；每一个 await 之后都校验归属，保证旧运行的
  // 状态/停顿响应绝不会写入新运行（跨运行隔离）。同运行内的乱序则交给
  // stateIsStale / pausesIsOlder 的单调高水位：只有内容更新的响应能落地。
  const myRunId = runId;
  const newRunTookOver = () => runId !== myRunId;

  let data;
  try {
    const res = await fetch("/api/state");
    data = await res.json();
  } catch (e) {
    return;
  }
  // 旧运行的迟到状态响应不得覆盖新运行：run_id 不匹配直接丢弃。
  if (newRunTookOver() || data.run_id !== myRunId) return;
  // 同运行较早轮询的迟到状态：较晚轮询采纳的状态一旦展示，旧快照不得
  // 再回退 liveState / pauseSeq / 徽标 / 提示 / 按钮（停顿选择也不会被它
  // 触发“误淘汰”）。直接整体丢弃，也不再为它请求/改写历史。
  if (stateIsStale(data, liveState)) return;

  liveState = data;
  pauseSeq = data.pause_seq;

  // 有效终态立即收尾：停轮询、恢复编辑与重跑。绝不等待本轮 /api/pauses
  // 完成——历史请求可能长期在途（甚至永不返回），而页面之后持续发起的
  // 轮询若都持有终态，旧实现会一直无法收尾、整页只读且不能重跑。
  if (isTerminal(data.status)) {
    stopPolling();
    setRunningUI(false);
    // 终态下单步/继续永远不可用（setRunningUI 不动这两个按钮）：历史在途
    // 时也不能短暂亮起；历史模式本就禁用，这里再置一次同样无害。
    $("btn-step").disabled = true;
    $("btn-continue").disabled = true;
  }

  renderAdoptedState(data);

  // 历史列表尽力刷新：仍处于活动态时下一轮轮询会继续；终态后历史本就
  // 冻结。这一步慢/失败都不影响上面已经完成的终态收尾。
  const latest = await fetchPauses(myRunId);
  if (newRunTookOver()) return;
  if (latest && !pausesIsOlder(latest, pauses)) {
    // 较新轮询已经采纳更新的列表时，较早轮询的旧列表（如只含停顿 #1）
    // 不得覆盖：否则选中停顿 #2 后会被误判“已淘汰”并退出回看。
    pauses = latest;
  }
  populateHistory();

  // 终态收尾期间（上面的 await）可能已有更晚轮询采纳终态；非终态的迟到
  // 轮询不得在这之后重渲活动视图、重新启用步进/继续或恢复只读。
  if (liveState && isTerminal(liveState.status)) {
    if (inHistoryMode()) {
      const selected = pauses.find((p) => String(p.pause_seq) === viewingSeq);
      if (selected) renderHistory(selected);  // 终态后仍可回看所选停顿
    } else {
      renderView(liveState);  // 历史在途时也能定格终态视图
    }
    return;
  }

  if (inHistoryMode()) {
    const selected = pauses.find((p) => String(p.pause_seq) === viewingSeq);
    if (selected) {
      // 轮询继续更新实时状态（徽标/下拉），但不切走所选历史记录
      renderHistory(selected);
    } else {
      // 所选记录确实已被淘汰（列表已被采纳为最新且仍不含它）：提示并
      // 返回实时视图（liveState 刚刷新过）
      showLive(liveState,
        `停顿 #${viewingSeq} 已超出最近保留条数被淘汰，已返回实时视图`);
    }
  } else {
    renderView(data);
  }
}

// 采纳一个状态快照后的首次渲染：徽标/视图属于该状态；历史模式下列表尚未
// 刷新，继续定格所选停顿但让实时徽标前进，步进/继续保持禁用。
function renderAdoptedState(state) {
  renderStatusBadge(state.status);
  if (inHistoryMode()) {
    const selected = pauses.find((p) => String(p.pause_seq) === viewingSeq);
    if (selected) renderHistory(selected);
  } else {
    renderView(state);
  }
}

function renderStatusBadge(status) {
  const badge = $("status");
  badge.textContent = STATUS_TEXT[status] || status;
  badge.className = "badge badge-" + status;
}

function renderView(state) {
  renderStatusBadge(state.status);
  renderListing(state.lines, state.current_line, state.status !== "finished");
  renderLocals(state.locals);

  let out = state.stdout || "";
  if (state.stdout_truncated) out = "（输出过长，仅保留末尾部分）\n" + out;
  $("stdout").textContent = out;
  $("exception").textContent = state.exception || "";

  const paused = state.status === "paused";
  $("btn-step").disabled = !paused;
  $("btn-continue").disabled = !paused;
}

function renderHistory(pause) {
  // 历史快照：定格当时的待执行行/局部变量/已保留输出；不改动状态徽标
  const lines = liveState ? liveState.lines : [];
  renderListing(lines, pause.current_line, true);
  renderLocals(pause.locals);
  let out = pause.stdout || "";
  if (pause.stdout_truncated) out = "（输出过长，仅保留末尾部分）\n" + out;
  $("stdout").textContent = out;
  $("exception").textContent = "";
  $("btn-step").disabled = true;
  $("btn-continue").disabled = true;
}

function renderListing(lines, currentLine, highlight) {
  const listing = $("listing");
  listing.textContent = "";
  listing.classList.remove("empty");
  lines.forEach((text, i) => {
    const isCurrent = highlight && i + 1 === currentLine;
    const row = document.createElement("div");
    row.className = "code-line";
    if (isCurrent) row.classList.add("current");
    const gutter = document.createElement("span");
    gutter.className = "gutter";
    gutter.textContent = (isCurrent ? "→ " : "  ")
      + String(i + 1).padStart(2, " ");
    const code = document.createElement("span");
    code.className = "text";
    code.textContent = text || " ";
    row.appendChild(gutter);
    row.appendChild(code);
    listing.appendChild(row);
  });
}

function renderLocals(locals) {
  const tbody = $("locals").querySelector("tbody");
  tbody.textContent = "";
  const names = Object.keys(locals || {});
  if (names.length === 0) {
    const tr = document.createElement("tr");
    tr.className = "empty";
    const td = document.createElement("td");
    td.textContent = "（无）";
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }
  for (const name of names) {
    const tr = document.createElement("tr");
    const tdName = document.createElement("td");
    tdName.className = "var-name";
    tdName.textContent = name;
    const tdVal = document.createElement("td");
    tdVal.className = "var-value";
    tdVal.textContent = locals[name];
    tr.appendChild(tdName);
    tr.appendChild(tdVal);
    tbody.appendChild(tr);
  }
}

// ---- pause history dropdown ---------------------------------------------

function populateHistory() {
  const select = $("history");
  const sig = pauses.map((p) => p.pause_seq).join(",");
  if (sig === historySig) return;  // 无新停顿/无淘汰：不重建，保留当前选择
  historySig = sig;

  select.textContent = "";
  const liveOpt = document.createElement("option");
  liveOpt.value = "";
  liveOpt.textContent = "实时视图（最新状态）";
  select.appendChild(liveOpt);
  for (const p of pauses) {
    const opt = document.createElement("option");
    opt.value = String(p.pause_seq);
    opt.textContent = `停顿 #${p.pause_seq}（第 ${p.current_line} 行）`;
    select.appendChild(opt);
  }
  select.value = inHistoryMode() ? viewingSeq : "";
}

function enterHistoryView(seq) {
  const pause = pauses.find((p) => String(p.pause_seq) === seq);
  if (!pause) return;
  viewingSeq = String(seq);
  $("history").value = viewingSeq;
  $("history-banner").hidden = false;
  renderHistory(pause);
}

function exitHistoryView() {
  viewingSeq = null;
  $("history").value = "";
  $("history-banner").hidden = true;
}

function showLive(state, message) {
  // 用给定（最新）状态切回实时视图并据此重新启用/禁用控制
  exitHistoryView();
  showMessage(message || "");
  renderView(state);
}

async function returnToLive() {
  // 返回实时视图：先获取最新状态再启用控制
  exitHistoryView();
  showMessage("");
  if (runId) {
    await poll();  // poll 此刻处于实时模式，会用最新状态渲染并设置控制
  } else if (liveState) {
    renderView(liveState);
  }
}

$("btn-run").addEventListener("click", startRun);
$("btn-step").addEventListener("click", () => control("step"));
$("btn-continue").addEventListener("click", () => control("continue"));
$("btn-terminate").addEventListener("click", terminateRun);
$("btn-back-live").addEventListener("click", returnToLive);
$("history").addEventListener("change", (e) => {
  const value = e.target.value;
  if (value === "") {
    returnToLive();
  } else {
    enterHistoryView(value);
  }
});
$("code").addEventListener("input", updateLineCount);
$("examples").addEventListener("change", (e) => {
  const code = EXAMPLES[e.target.value];
  if (code) {
    $("code").value = code + "\n";
    updateLineCount();
  }
  e.target.value = "";
});

updateLineCount();
