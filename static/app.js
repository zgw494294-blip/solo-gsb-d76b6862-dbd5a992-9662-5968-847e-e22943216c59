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
let liveState = null;    // latest /api/state snapshot for runId
let pauses = [];         // pause snapshots returned by /api/pauses (asc seq)
let viewingSeq = null;   // selected historical pause_seq, or null = live view
let historySig = "";     // dropdown contents signature, to avoid rebuilding
// 每次 poll 开始时自增：同运行的重叠轮询（间隔轮询与手动 poll）只有最新
// 一轮允许落地，旧轮询在任意 await 之后恢复时都必须自我丢弃。
let pollSeq = 0;
// 已采纳内容的最新轮询序号（同一次采纳里 state 与 pauses 共享一代）。
// 同运行内一旦较晚轮询已采纳状态，较早轮询即为“被取代”：它迟到的旧状态、
// 旧历史列表一律丢弃，不得回退 liveState/pause_seq/徽标/下拉/选中项/提示/按钮。
let adoptedPollSeq = 0;
// 每次“获准启动的新运行”自增：/api/run 的迟到拒绝（如双击中落败的那一个
// 请求、等待回收期间排队的重跑）不得在新运行获准后再弹错误提示。
let admitSeq = 0;

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
  adoptedPollSeq = 0;  // 新运行重新计代，上一运行的轮询世代随之作废
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
  // 每轮轮询一个序号。两层防护：
  // 1) 归属（run_id）：在每一个 await 之后都校验，旧运行的状态/停顿/终态
  //    响应即使迟到也绝不写入新运行，更不能替新运行收尾（停轮询/解除只读/
  //    切换终止按钮）。
  // 2) 同运行代际（pollSeq / adoptedPollSeq）：较晚轮询一旦采纳状态，较早
  //    轮询即被取代——它迟到的旧状态与“只含更旧停顿”的历史列表必须整体
  //    丢弃，不得回退历史、选中项、liveState、pause_seq、徽标、提示或按钮
  //    （否则会把实时视图回退到旧停顿，并把仍在列表中的所选停顿误报为
  //    “已淘汰”）。
  const myPollSeq = ++pollSeq;
  const myRunId = runId;
  const newRunTookOver = () => runId !== myRunId;
  const superseded = () => adoptedPollSeq > myPollSeq;

  let data;
  try {
    const res = await fetch("/api/state");
    data = await res.json();
  } catch (e) {
    return;
  }
  // 旧运行的迟到状态不覆盖新运行；同运行里较晚轮询已采纳更新状态时，这轮
  // 较早轮询的旧状态（旧 pause_seq/旧 status/旧行号与变量）整体丢弃。
  if (newRunTookOver() || data.run_id !== myRunId || superseded()) return;

  // 有效终态立即收尾，且不等待历史响应：即使此后总有“更晚一轮”的轮询在
  // 飞行中（其 state/pauses 因卡顿/丢包迟迟不回），页面也不会一直只读、
  // 不能重跑。历史快照在终态后仍可通过下拉回看；随后到达的历史响应只更新
  // 下拉。终态收尾只校验归属（不校验代际）：本轮终态来自当前运行，服务端
  // 终态粘滞，任何在途的更新轮询都不会再产生更“新”的活动态；归属校验则
  // 保证旧运行的终态不会替新运行收尾。
  const terminal = ["finished", "exception", "terminated"].includes(data.status);
  if (terminal) {
    stopPolling();
    setRunningUI(false);
  }

  liveState = data;
  pauseSeq = data.pause_seq;
  renderStatusBadge(data.status);
  adoptedPollSeq = myPollSeq;
  // 实时视图立即用最新状态渲染（含按状态启用/禁用按钮），不等历史请求；
  // 历史模式保持定格，稍后只在历史阶段按需渲染。
  if (!inHistoryMode()) renderView(data);

  // 历史请求在重跑获准之前可能已经拿到 200，却等到现在才完成：这里对
  // 返回值再次校验归属，旧运行的停顿列表绝不能写入新运行；同运行内若已被
  // 较晚轮询取代，旧列表（可能只含已被更新列表超越的停顿）也不得覆盖较新
  // 的历史/选中项与“已淘汰”判定。
  const latest = await fetchPauses(myRunId);
  if (newRunTookOver() || superseded()) return;
  if (latest) pauses = latest;
  populateHistory();

  if (inHistoryMode()) {
    const selected = pauses.find((p) => String(p.pause_seq) === viewingSeq);
    if (selected) {
      // 轮询继续更新实时状态（徽标/下拉），但不切走所选历史记录
      renderHistory(selected);
    } else {
      // 到这里的列表一定属于“当前运行 + 当前最新代际”：找不到所选记录只
      // 可能是服务端真的淘汰了它（旧轮询的短列表会在上方代际校验处被丢弃，
      // 不会再误报淘汰）。提示并返回实时视图（liveState 刚刷新过）。
      showLive(data, `停顿 #${viewingSeq} 已超出最近保留条数被淘汰，已返回实时视图`);
    }
  }

  if (terminal && inHistoryMode()) {
    // 终态后停在历史视图：保持单步/继续禁用（终止/编辑已在上方恢复）。
    $("btn-step").disabled = true;
    $("btn-continue").disabled = true;
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
