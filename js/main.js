"use strict";

/* ==================================================
   1. 共用工具與文字資料儲存
   ================================================== */

const $ = selector => document.querySelector(selector);
const PAGE = document.body.dataset.page;
const PREFIX = "warmSchedule:";
const query = new URLSearchParams(location.search);

function escapeHTML(value = "") {
  return String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[character]));
}

function dateKey(date = new Date()) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
  const date = new Date(value + "T12:00:00");
  return !Number.isNaN(date.getTime()) && dateKey(date) === value;
}

const TODAY = dateKey();
const SELECTED_DATE = validDate(query.get("date"))
  ? query.get("date")
  : TODAY;

function read(key, fallback) {
  const raw = localStorage.getItem(PREFIX + key);
  if (raw === null) return fallback;

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("儲存資料無法讀取，請到設置清除本網站資料。");
  }
}

function write(key, value) {
  localStorage.setItem(PREFIX + key, JSON.stringify(value));
}

function createID() {
  return globalThis.crypto?.randomUUID?.()
    || Date.now().toString(36) + Math.random().toString(36).slice(2);
}

const getTasks = () => read("tasks", []);
const getSessions = () => read("sessions", []);
const getProfile = () => read("profile", { name: "生活規劃者" });
const getSettings = () => read("settings", { monday: true });

function showMessage(text) {
  $("#message").textContent = text;
}

function showError(error) {
  console.error(error);
  showMessage(
    error.message ||
    "操作失敗，請檢查瀏覽器儲存權限或剩餘空間。"
  );
}

// 統一處理事件錯誤，避免儲存失敗時仍顯示成功。
function safe(handler) {
  return async event => {
    try {
      await handler(event);
    } catch (error) {
      showError(error);
    }
  };
}

function heading(title, description) {
  return `
    <header>
      <h1>${escapeHTML(title)}</h1>
      <p>${escapeHTML(description)}</p>
    </header>
  `;
}

function formatDuration(milliseconds) {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
  return [
    Math.floor(seconds / 3600),
    Math.floor(seconds / 60) % 60,
    seconds % 60
  ].map(number => String(number).padStart(2, "0")).join(":");
}

function orderedTasks(items) {
  return [...items].sort((a, b) =>
    a.date.localeCompare(b.date) ||
    (a.time || "99:99").localeCompare(b.time || "99:99")
  );
}

/* ==================================================
   2. IndexedDB：照片與頭像
   ================================================== */

let databasePromise;

function openDatabase() {
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open("warmScheduleMedia", 1);

      request.onupgradeneeded = () => {
        request.result.createObjectStore("media", { keyPath: "id" });
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  return databasePromise;
}

async function mediaAction(mode, operation) {
  const database = await openDatabase();

  return new Promise((resolve, reject) => {
    const transaction = database.transaction("media", mode);
    const store = transaction.objectStore("media");
    const request = operation(store);
    let result;

    request.onsuccess = () => {
      result = request.result;
    };

    // 等交易完成才視為儲存成功。
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(
      transaction.error || new Error("圖片儲存已中止。")
    );
  });
}

const getAllMedia = () =>
  mediaAction("readonly", store => store.getAll());

const getMedia = id =>
  mediaAction("readonly", store => store.get(id));

const putMedia = item =>
  mediaAction("readwrite", store => store.put(item));

const deleteMedia = id =>
  mediaAction("readwrite", store => store.delete(id));

const clearMedia = () =>
  mediaAction("readwrite", store => store.clear());

const imageURLs = [];

function blobURL(blob) {
  const url = URL.createObjectURL(blob);
  imageURLs.push(url);
  return url;
}

window.addEventListener("pagehide", () => {
  imageURLs.forEach(url => URL.revokeObjectURL(url));
});

// 壓縮圖片，避免直接儲存大型原圖。
async function prepareImage(file, maximumSide = 1400) {
  if (!file) throw new Error("請先選擇圖片。");

  const allowed = ["image/jpeg", "image/png", "image/webp"];
  if (!allowed.includes(file.type)) {
    throw new Error("請選擇 JPG、PNG 或 WebP 圖片。");
  }

  if (file.size > 12 * 1024 * 1024) {
    throw new Error("圖片大小不能超過 12MB。");
  }

  const url = URL.createObjectURL(file);

  try {
    const image = new Image();
    image.src = url;
    await image.decode();

    const scale = Math.min(
      1,
      maximumSide / Math.max(image.width, image.height)
    );

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));

    const context = canvas.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    return await new Promise((resolve, reject) => {
      canvas.toBlob(blob => {
        if (blob) resolve(blob);
        else reject(new Error("圖片處理失敗。"));
      }, "image/jpeg", 0.85);
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* ==================================================
   3. 共用導航
   ================================================== */

function renderNavigation() {
  const links = [
    ["home", "index.html", "首頁"],
    ["today", "today.html", "今日計劃"],
    ["todo", "todo.html", "待辦事項"],
    ["calendar", "calendar.html", "日曆"],
    ["timer", "timer.html", "計時器"],
    ["data", "data.html", "數據"],
    ["settings", "settings.html", "設置"],
    ["profile", "profile.html", "個人主頁"]
  ];

  const activePage = PAGE === "record" ? "calendar" : PAGE;

  $("#navigation").innerHTML = `
    <aside id="sidebar">
      <header>
        <h2><a href="index.html">暖序日程</a></h2>
        <p>整理時間，記錄生活。</p>
      </header>

      <nav aria-label="主要導航">
        <ul>
          ${links.map(([key, file, title]) => `
            <li>
              <a href="${file}"
                ${key === activePage ? 'aria-current="page"' : ""}>
                ${title}
              </a>
            </li>
          `).join("")}
        </ul>
      </nav>

      <p>使用者：<span id="nav-name"></span></p>
      <small>資料僅儲存在目前瀏覽器。</small>
      <hr>
    </aside>
  `;

  $("#nav-name").textContent = getProfile().name;
}

/* ==================================================
   4. 首頁
   ================================================== */

function renderHome() {
  const all = getTasks();
  const todayTasks = orderedTasks(all.filter(task => task.date === TODAY));
  const remaining = todayTasks.filter(task => !task.completed);
  const focus = getSessions()
    .filter(session => session.date === TODAY)
    .reduce((total, session) => total + session.duration, 0);

  $("#content").innerHTML =
    heading(`你好，${getProfile().name}`, `${TODAY} · 開始安排今天的生活。`) +
    `
      <section>
        <h2>今日概覽</h2>
        <ul>
          <li>今日事項：${todayTasks.length} 項</li>
          <li>今日未完成：${remaining.length} 項</li>
          <li>今日已儲存專注時間：${formatDuration(focus)}</li>
        </ul>
        <p>
          <a href="today.html">查看今日計劃</a> |
          <a href="todo.html">撰寫事項</a> |
          <a href="record.html?date=${TODAY}">記錄今日照片</a>
        </p>
      </section>

      <section>
        <h2>接下來的安排</h2>
        ${remaining.length ? `
          <ol>
            ${remaining.slice(0, 5).map(task => `
              <li>
                ${escapeHTML(task.time || "未指定時間")}：
                ${escapeHTML(task.title)}
              </li>
            `).join("")}
          </ol>
        ` : "<p>今天沒有未完成事項。</p>"}
      </section>
    `;
}

/* ==================================================
   5. 事項：新增、修改、完成、刪除、搜尋
   ================================================== */

function taskFormHTML(date) {
  return `
    <section>
      <h2 id="form-title">撰寫事項</h2>

      <form id="task-form">
        <p>
          <label>
            事項名稱
            <input name="title" required maxlength="100"
              placeholder="例如：完成網站版面">
          </label>
        </p>

        <p>
          <label>
            日期
            <input name="date" type="date" required value="${date}">
          </label>
        </p>

        <p>
          <label>
            時間（可留空）
            <input name="time" type="time">
          </label>
        </p>

        <p>
          <label>
            優先程度
            <select name="priority">
              <option value="normal">一般</option>
              <option value="high">重要</option>
            </select>
          </label>
        </p>

        <p>
          <label>
            預計時間（分鐘）
            <input name="minutes" type="number"
              min="0" max="1440" step="1" value="30" required>
          </label>
        </p>

        <p>
          <label>
            事項內容
            <textarea name="note" rows="4" maxlength="2000"
              placeholder="寫下細節或提醒"></textarea>
          </label>
        </p>

        <button type="submit" id="save-task">新增事項</button>
        <button type="button" id="cancel-edit" hidden>取消修改</button>
      </form>
    </section>
  `;
}

function taskListHTML(items) {
  if (!items.length) return "<p>目前沒有符合條件的事項。</p>";

  return orderedTasks(items).map(task => `
    <article>
      <h3>
        ${task.completed
          ? `<s>${escapeHTML(task.title)}</s>`
          : escapeHTML(task.title)}
        ${task.priority === "high" ? "【重要】" : ""}
      </h3>

      <p>
        ${escapeHTML(task.date)} ·
        ${escapeHTML(task.time || "未指定時間")} ·
        預計 ${task.minutes} 分鐘
      </p>

      ${task.note ? `
        <p>${escapeHTML(task.note).replace(/\n/g, "<br>")}</p>
      ` : ""}

      <label>
        <input type="checkbox" data-toggle="${task.id}"
          ${task.completed ? "checked" : ""}>
        已完成
      </label>

      <p>
        <button type="button" data-edit="${task.id}">修改</button>
        <button type="button" data-delete="${task.id}">刪除</button>
      </p>
      <hr>
    </article>
  `).join("");
}

function renderTasks() {
  const isToday = PAGE === "today";
  const initialDate = isToday ? TODAY : SELECTED_DATE;
  let editingID = null;

  $("#content").innerHTML =
    heading(
      isToday ? "今日計劃" : "待辦事項",
      isToday ? `${TODAY} · 按時間查看今天的安排。` : "撰寫及管理所有日程事項。"
    ) +
    taskFormHTML(initialDate) +
    `
      <section>
        <h2>${isToday ? "今天的日程" : "事項列表"}</h2>

        <p>
          <label>
            搜尋事項
            <input id="task-search" type="search" placeholder="輸入關鍵字">
          </label>
        </p>

        <p>
          <label>
            篩選狀態
            <select id="task-filter">
              <option value="all">全部</option>
              <option value="active">未完成</option>
              <option value="completed">已完成</option>
            </select>
          </label>
        </p>

        <div id="task-list"></div>
      </section>
    `;

  const form = $("#task-form");

  function refreshList() {
    const keyword = $("#task-search").value.trim().toLowerCase();
    const filter = $("#task-filter").value;

    const visible = getTasks().filter(task => {
      if (isToday && task.date !== TODAY) return false;
      if (filter === "active" && task.completed) return false;
      if (filter === "completed" && !task.completed) return false;
      return (task.title + " " + task.note).toLowerCase().includes(keyword);
    });

    $("#task-list").innerHTML = taskListHTML(visible);
  }

  function resetEditor() {
    editingID = null;
    form.reset();
    form.elements.date.value = initialDate;
    $("#form-title").textContent = "撰寫事項";
    $("#save-task").textContent = "新增事項";
    $("#cancel-edit").hidden = true;
  }

  function editTask(key) {
    const task = getTasks().find(item => item.id === key);
    if (!task) return;

    editingID = key;

    for (const name of ["title", "date", "time", "priority", "minutes", "note"]) {
      form.elements[name].value = task[name];
    }

    $("#form-title").textContent = "修改事項";
    $("#save-task").textContent = "儲存修改";
    $("#cancel-edit").hidden = false;
    form.elements.title.focus();
  }

  form.onsubmit = safe(event => {
    event.preventDefault();

    const title = form.elements.title.value.trim();
    const date = form.elements.date.value;
    const minutes = Number(form.elements.minutes.value);

    if (!title) throw new Error("事項名稱不能只包含空白。");
    if (!validDate(date)) throw new Error("請輸入有效日期。");
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440) {
      throw new Error("預計時間必須是 0 至 1440 的整數。");
    }

    const values = {
      title,
      date,
      time: form.elements.time.value,
      priority: form.elements.priority.value,
      minutes,
      note: form.elements.note.value.trim()
    };

    const all = getTasks();

    if (editingID) {
      const index = all.findIndex(task => task.id === editingID);
      if (index === -1) throw new Error("這項事項已不存在。");
      all[index] = { ...all[index], ...values };
    } else {
      all.push({
        id: createID(),
        ...values,
        completed: false,
        completedDate: null,
        createdAt: new Date().toISOString()
      });
    }

    write("tasks", all);
    resetEditor();
    refreshList();
    showMessage("事項已儲存。");
  });

  $("#cancel-edit").onclick = resetEditor;
  $("#task-search").oninput = safe(refreshList);
  $("#task-filter").onchange = safe(refreshList);

  $("#task-list").onchange = safe(event => {
    const key = event.target.dataset.toggle;
    if (!key) return;

    const all = getTasks();
    const task = all.find(item => item.id === key);

    if (task) {
      task.completed = event.target.checked;
      task.completedDate = task.completed ? dateKey() : null;

      try {
        write("tasks", all);
      } catch (error) {
        refreshList();
        throw error;
      }

      refreshList();
      showMessage("事項狀態已更新。");
    }
  });

  $("#task-list").onclick = safe(event => {
    const button = event.target.closest("button");
    if (!button) return;

    if (button.dataset.edit) editTask(button.dataset.edit);

    if (button.dataset.delete && confirm("確定刪除這項事項？")) {
      const key = button.dataset.delete;
      write("tasks", getTasks().filter(task => task.id !== key));
      if (editingID === key) resetEditor();
      refreshList();
      showMessage("事項已刪除。");
    }
  });

  refreshList();
}

/* ==================================================
   6. 日曆
   ================================================== */

async function renderCalendar() {
  $("#content").innerHTML =
    heading("日曆", "選擇日期，查看日程及生活照片。") +
    "<p>正在讀取日曆……</p>";

  const media = await getAllMedia();
  const photos = media.filter(item => item.kind === "photo");
  const allTasks = getTasks();

  const selected = new Date(SELECTED_DATE + "T12:00:00");
  const year = selected.getFullYear();
  const month = selected.getMonth();

  const previous = dateKey(new Date(year, month - 1, 1));
  const next = dateKey(new Date(year, month + 1, 1));

  const monday = getSettings().monday;
  const weekdays = monday
    ? ["一", "二", "三", "四", "五", "六", "日"]
    : ["日", "一", "二", "三", "四", "五", "六"];

  const firstWeekday = new Date(year, month, 1).getDay();
  const offset = monday ? (firstWeekday + 6) % 7 : firstWeekday;
  const count = new Date(year, month + 1, 0).getDate();
  const cells = Math.ceil((offset + count) / 7) * 7;

  let body = "";

  for (let index = 0; index < cells; index++) {
    if (index % 7 === 0) body += "<tr>";

    const day = index - offset + 1;

    if (day < 1 || day > count) {
      body += "<td></td>";
    } else {
      const date = dateKey(new Date(year, month, day));
      const taskCount = allTasks.filter(task => task.date === date).length;
      const photoCount = photos.filter(photo => photo.date === date).length;

      body += `
        <td>
          <a href="calendar.html?date=${date}"
            ${date === SELECTED_DATE ? 'aria-current="date"' : ""}>
            ${date === SELECTED_DATE ? `<strong>${day}</strong>` : day}
          </a>
          ${date === TODAY ? "<small>今天</small>" : ""}
          ${taskCount ? `<br><small>事項 ${taskCount}</small>` : ""}
          ${photoCount ? `<br><small>照片 ${photoCount}</small>` : ""}
        </td>
      `;
    }

    if (index % 7 === 6) body += "</tr>";
  }

  const dayTasks = orderedTasks(
    allTasks.filter(task => task.date === SELECTED_DATE)
  );
  const dayPhotos = photos.filter(photo => photo.date === SELECTED_DATE);

  $("#content").innerHTML =
    heading("日曆", "選擇日期，查看日程及生活照片。") +
    `
      <section>
        <h2>${year} 年 ${month + 1} 月</h2>
        <p>
          <a href="calendar.html?date=${previous}">上一月</a> |
          <a href="calendar.html?date=${TODAY}">回到今天</a> |
          <a href="calendar.html?date=${next}">下一月</a>
        </p>

        <table>
          <caption>月份日曆；日期連結可查看當日內容</caption>
          <thead>
            <tr>
              ${weekdays.map(day => `<th scope="col">${day}</th>`).join("")}
            </tr>
          </thead>
          <tbody>${body}</tbody>
        </table>
      </section>

      <section>
        <h2>${SELECTED_DATE} 的日程</h2>
        <p>
          <a href="todo.html?date=${SELECTED_DATE}">為這一天新增事項</a>
        </p>

        ${dayTasks.length ? `
          <ul>
            ${dayTasks.map(task => `
              <li>
                ${escapeHTML(task.time || "未指定時間")}：
                ${escapeHTML(task.title)}
                ${task.completed ? "（已完成）" : "（未完成）"}
              </li>
            `).join("")}
          </ul>
        ` : "<p>這一天還沒有日程。</p>"}
      </section>

      <section>
        <h2>${SELECTED_DATE} 的生活照片</h2>
        <p>
          <a href="record.html?date=${SELECTED_DATE}">上傳生活照片</a>
        </p>
        <div id="photos"></div>
      </section>
    `;

  const container = $("#photos");

  if (!dayPhotos.length) {
    container.textContent = "這一天還沒有照片。";
  }

  for (const photo of dayPhotos) {
    const figure = document.createElement("figure");
    const image = document.createElement("img");
    image.src = blobURL(photo.blob);
    image.width = 240;
    image.alt = photo.caption || `${photo.date} 的生活照片`;

    const caption = document.createElement("figcaption");
    caption.textContent = photo.caption || `${photo.date} 的生活記錄`;

    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "刪除照片";
    button.onclick = safe(async () => {
      if (!confirm("確定刪除這張照片？")) return;
      await deleteMedia(photo.id);
      // 重新開啟同一天，日曆照片數量也會更新。
      location.href = `calendar.html?date=${SELECTED_DATE}`;
    });

    figure.append(image, caption, button);
    container.append(figure);
  }
}

/* ==================================================
   7. 每日生活照片上傳
   ================================================== */

function renderRecord() {
  $("#content").innerHTML =
    heading("記錄生活照片", `${SELECTED_DATE} · 留下今天的一個片段。`) +
    `
      <form id="photo-form">
        <p>
          <label>
            選擇圖片
            <input id="photo-file" type="file"
              accept="image/jpeg,image/png,image/webp" required>
          </label>
        </p>

        <p>支援 JPG、PNG、WebP，每張不超過 12MB。</p>

        <p>
          <img id="photo-preview" width="240" alt="待上傳照片預覽" hidden>
        </p>

        <p>
          <label>
            照片說明
            <textarea id="photo-caption" rows="4" maxlength="1000"
              placeholder="例如：今天和朋友去海邊散步"></textarea>
          </label>
        </p>

        <button type="submit" id="upload-button">儲存並返回日曆</button>
        <a href="calendar.html?date=${SELECTED_DATE}">取消</a>
      </form>
    `;

  let previewURL = null;

  $("#photo-file").onchange = () => {
    if (previewURL) URL.revokeObjectURL(previewURL);

    const file = $("#photo-file").files[0];
    const preview = $("#photo-preview");
    preview.hidden = !file;

    if (file) {
      previewURL = URL.createObjectURL(file);
      preview.src = previewURL;
    }
  };

  window.addEventListener("pagehide", () => {
    if (previewURL) URL.revokeObjectURL(previewURL);
  });

  $("#photo-form").onsubmit = safe(async event => {
    event.preventDefault();
    const button = $("#upload-button");
    button.disabled = true;
    showMessage("正在處理及儲存圖片……");

    try {
      const blob = await prepareImage($("#photo-file").files[0]);

      await putMedia({
        id: createID(),
        kind: "photo",
        date: SELECTED_DATE,
        caption: $("#photo-caption").value.trim(),
        blob,
        createdAt: new Date().toISOString()
      });

      // 確認 IndexedDB 交易完成後才跳轉。
      location.href = `calendar.html?date=${SELECTED_DATE}`;
    } finally {
      button.disabled = false;
    }
  });
}

/* ==================================================
   8. 計時器：跨頁保留狀態
   ================================================== */

function emptyTimer() {
  return { elapsed: 0, startedAt: null, task: "" };
}

function timerElapsed(state) {
  return state.elapsed + (
    state.startedAt === null
      ? 0
      : Math.max(0, Date.now() - state.startedAt)
  );
}

function renderTimer() {
  $("#content").innerHTML =
    heading("計時器", "專注在一件事情上；開始後切換頁面仍會繼續計時。") +
    `
      <section>
        <p>
          <label>
            專注事項
            <input id="timer-task" maxlength="100"
              placeholder="例如：製作網站">
          </label>
        </p>

        <h2 id="timer-display">00:00:00</h2>
        <p id="timer-state"></p>

        <p>
          <button id="timer-start" type="button">開始／繼續</button>
          <button id="timer-pause" type="button">暫停</button>
          <button id="timer-reset" type="button">重設</button>
          <button id="timer-save" type="button">儲存專注記錄</button>
        </p>

        <p>
          計時包含頁面離開後的時間，直到你按下暫停或重設。
          只有儲存的記錄會計入數據。
        </p>
      </section>
    `;

  $("#timer-task").value = read("timer", emptyTimer()).task;

  function updateDisplay() {
    const state = read("timer", emptyTimer());
    $("#timer-display").textContent = formatDuration(timerElapsed(state));
    $("#timer-state").textContent =
      state.startedAt === null ? "目前已暫停" : "正在計時";

    $("#timer-start").disabled = state.startedAt !== null;
    $("#timer-pause").disabled = state.startedAt === null;
  }

  $("#timer-task").oninput = safe(() => {
    const state = read("timer", emptyTimer());
    state.task = $("#timer-task").value;
    write("timer", state);
  });

  $("#timer-start").onclick = safe(() => {
    const state = read("timer", emptyTimer());

    if (state.startedAt === null) {
      state.startedAt = Date.now();
      state.task = $("#timer-task").value;
      write("timer", state);
    }

    updateDisplay();
  });

  $("#timer-pause").onclick = safe(() => {
    const state = read("timer", emptyTimer());
    state.elapsed = timerElapsed(state);
    state.startedAt = null;
    write("timer", state);
    updateDisplay();
  });

  $("#timer-reset").onclick = safe(() => {
    if (!confirm("確定重設？未儲存的計時將被清除。")) return;

    write("timer", {
      ...emptyTimer(),
      task: $("#timer-task").value
    });

    updateDisplay();
    showMessage("計時已重設。");
  });

  $("#timer-save").onclick = safe(() => {
    const state = read("timer", emptyTimer());
    const task = $("#timer-task").value.trim();
    const milliseconds = timerElapsed(state);

    if (!task) throw new Error("請輸入專注事項名稱。");
    if (milliseconds < 1000) throw new Error("請至少計時一秒後再儲存。");

    const all = getSessions();
    all.push({
      id: createID(),
      task,
      duration: milliseconds,
      date: dateKey(),
      savedAt: new Date().toISOString()
    });

    write("sessions", all);
    write("timer", emptyTimer());
    $("#timer-task").value = "";
    updateDisplay();
    showMessage("專注記錄已儲存，可到數據頁查看。");
  });

  updateDisplay();

  const interval = setInterval(() => {
    try {
      updateDisplay();
    } catch (error) {
      clearInterval(interval);
      showError(error);
    }
  }, 500);

  window.addEventListener("pagehide", () => clearInterval(interval));
}

/* ==================================================
   9. 數據與表格
   ================================================== */

function renderData() {
  const allTasks = getTasks();
  const allSessions = getSessions();

  const completed = allTasks.filter(task => task.completed).length;
  const rate = allTasks.length
    ? Math.round(completed / allTasks.length * 100)
    : 0;

  const plannedMinutes = allTasks.reduce(
    (total, task) => total + task.minutes, 0
  );

  const focusMilliseconds = allSessions.reduce(
    (total, session) => total + session.duration, 0
  );

  const days = [];

  for (let offset = 6; offset >= 0; offset--) {
    const date = new Date();
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() - offset);
    const key = dateKey(date);

    days.push({
      date: key,
      minutes: Math.floor(
        allSessions
          .filter(session => session.date === key)
          .reduce((total, session) => total + session.duration, 0) / 60000
      )
    });
  }

  const maximum = Math.max(1, ...days.map(day => day.minutes));

  $("#content").innerHTML =
    heading("數據", "根據已儲存的事項及專注記錄計算。") +
    `
      <section>
        <h2>整體摘要</h2>
        <ul>
          <li>事項總數：${allTasks.length}</li>
          <li>已完成：${completed}</li>
          <li>完成率：${rate}%</li>
          <li>所有事項預計時間：${plannedMinutes} 分鐘</li>
          <li>累計專注時間：${formatDuration(focusMilliseconds)}</li>
        </ul>
      </section>

      <section>
        <h2>最近七天專注時間</h2>
        <ul>
          ${days.map(day => `
            <li>
              ${day.date}：
              <meter min="0" max="${maximum}" value="${day.minutes}">
                ${day.minutes} 分鐘
              </meter>
              ${day.minutes} 分鐘
            </li>
          `).join("")}
        </ul>
        <p>跨午夜的專注記錄歸入按下儲存當天。</p>
      </section>

      <section>
        <h2>事項明細</h2>
        <table>
          <caption>所有事項及完成狀態</caption>
          <thead>
            <tr>
              <th scope="col">事項</th>
              <th scope="col">日期</th>
              <th scope="col">預計分鐘</th>
              <th scope="col">狀態</th>
            </tr>
          </thead>
          <tbody>
            ${orderedTasks(allTasks).map(task => `
              <tr>
                <td>${escapeHTML(task.title)}</td>
                <td>${escapeHTML(task.date)}</td>
                <td>${task.minutes}</td>
                <td>${task.completed ? "已完成" : "未完成"}</td>
              </tr>
            `).join("") || '<tr><td colspan="4">暫無事項。</td></tr>'}
          </tbody>
        </table>
      </section>

      <section>
        <h2>專注記錄</h2>
        <table>
          <caption>已儲存的計時紀錄，最新記錄在前</caption>
          <thead>
            <tr>
              <th scope="col">日期</th>
              <th scope="col">專注事項</th>
              <th scope="col">時間</th>
            </tr>
          </thead>
          <tbody>
            ${[...allSessions].reverse().map(session => `
              <tr>
                <td>${escapeHTML(session.date)}</td>
                <td>${escapeHTML(session.task)}</td>
                <td>${formatDuration(session.duration)}</td>
              </tr>
            `).join("") || '<tr><td colspan="3">暫無專注記錄。</td></tr>'}
          </tbody>
        </table>
      </section>
    `;
}

/* ==================================================
   10. 個人主頁：修改姓名及上傳頭像
   ================================================== */

async function renderProfile() {
  $("#content").innerHTML =
    heading("個人主頁", "設定你的姓名與頭像。") +
    `
      <section>
        <h2>個人資料</h2>
        <p id="avatar-placeholder">尚未設定頭像。</p>
        <img id="avatar" width="120" height="120" alt="個人頭像" hidden>

        <form id="name-form">
          <p>
            <label>
              名字
              <input id="profile-name" required maxlength="40">
            </label>
          </p>
          <button type="submit">儲存名字</button>
        </form>
      </section>

      <section>
        <h2>上傳頭像</h2>
        <form id="avatar-form">
          <p>
            <label>
              選擇 JPG、PNG 或 WebP 圖片
              <input id="avatar-file" type="file"
                accept="image/jpeg,image/png,image/webp" required>
            </label>
          </p>
          <button type="submit" id="avatar-save">儲存頭像</button>
          <button type="button" id="avatar-remove">移除頭像</button>
        </form>
      </section>
    `;

  $("#profile-name").value = getProfile().name;

  async function updateAvatar() {
    const item = await getMedia("avatar");
    $("#avatar").hidden = !item;
    $("#avatar-placeholder").hidden = Boolean(item);

    if (item) {
      $("#avatar").src = blobURL(item.blob);
    } else {
      $("#avatar").removeAttribute("src");
    }
  }

  $("#name-form").onsubmit = safe(event => {
    event.preventDefault();
    const name = $("#profile-name").value.trim();

    if (!name) throw new Error("名字不能只包含空白。");

    write("profile", { ...getProfile(), name });
    $("#nav-name").textContent = name;
    showMessage("名字已更新。");
  });

  $("#avatar-form").onsubmit = safe(async event => {
    event.preventDefault();
    const button = $("#avatar-save");
    button.disabled = true;

    try {
      const blob = await prepareImage($("#avatar-file").files[0], 500);
      await putMedia({
        id: "avatar",
        kind: "avatar",
        blob
      });

      await updateAvatar();
      $("#avatar-file").value = "";
      showMessage("頭像已更新。");
    } finally {
      button.disabled = false;
    }
  });

  $("#avatar-remove").onclick = safe(async () => {
    if (!confirm("確定移除頭像？")) return;
    await deleteMedia("avatar");
    await updateAvatar();
    showMessage("頭像已移除。");
  });

  await updateAvatar();
}

/* ==================================================
   11. 設置
   ================================================== */

function renderSettings() {
  $("#content").innerHTML =
    heading("設置", "管理日曆顯示方式及本機資料。") +
    `
      <section>
        <h2>日曆偏好</h2>
        <form id="settings-form">
          <p>
            <label>
              每週第一天
              <select id="week-start">
                <option value="monday">星期一</option>
                <option value="sunday">星期日</option>
              </select>
            </label>
          </p>
          <button type="submit">儲存設置</button>
        </form>
      </section>

      <section>
        <h2>資料儲存說明</h2>
        <ul>
          <li>事項、名字及計時記錄儲存在 localStorage。</li>
          <li>照片及頭像儲存在 IndexedDB。</li>
          <li>不同瀏覽器或不同網站網址不會同步。</li>
          <li>清除瀏覽器網站資料會刪除這些記錄。</li>
          <li>私人瀏覽模式的資料可能在關閉視窗後消失。</li>
        </ul>
      </section>

      <section>
        <h2>清除資料</h2>
        <p>此操作會刪除所有事項、照片、頭像、名字與計時記錄，無法復原。</p>
        <button type="button" id="clear-data">清除本網站所有資料</button>
      </section>
    `;

  $("#week-start").value =
    getSettings().monday ? "monday" : "sunday";

  $("#settings-form").onsubmit = safe(event => {
    event.preventDefault();

    write("settings", {
      monday: $("#week-start").value === "monday"
    });

    showMessage("設置已儲存，日曆頁會使用新的每週起始日。");
  });

  $("#clear-data").onclick = safe(async () => {
    if (!confirm("確定清除本網站所有資料？此操作無法復原。")) return;

    const button = $("#clear-data");
    button.disabled = true;

    try {
      await clearMedia();

      // 只刪除本網站的資料，不清除其他網站或程式的 key。
      for (const key of [
        "tasks", "sessions", "timer", "profile", "settings"
      ]) {
        localStorage.removeItem(PREFIX + key);
      }

      location.href = "index.html";
    } finally {
      button.disabled = false;
    }
  });
}

/* ==================================================
   12. 啟動目前 HTML 頁面
   ================================================== */

async function initialize() {
  renderNavigation();

  switch (PAGE) {
    case "home":
      renderHome();
      break;

    case "today":
    case "todo":
      renderTasks();
      break;

    case "calendar":
      await renderCalendar();
      break;

    case "record":
      renderRecord();
      break;

    case "timer":
      renderTimer();
      break;

    case "data":
      renderData();
      break;

    case "profile":
      await renderProfile();
      break;

    case "settings":
      renderSettings();
      break;

    default:
      throw new Error("找不到這個頁面的設定。");
  }
}

initialize().catch(showError);