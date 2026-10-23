// Канбан-доска идей на CloudKit JS: читает публичную базу контейнера, а модератор публикует идеи, отвечает на них,
// отмечает версию выхода, объединяет дубли и задаёт очередь запланированного.
// Голоса считаются как в пакете: голос засчитывается, только если имя записи — «<идея>_<серверный создатель>»;
// голос за дубль идёт идее, с которой его объединили, и один человек считается один раз.
// С параметром ?demo доска работает на тестовых данных без CloudKit — для проверки вида.
"use strict";

const STATUSES = [
  { id: "pending", title: "На рассмотрении", note: "Видит только автор. Перетащите в «Открытые», чтобы опубликовать." },
  { id: "open", title: "Открытые" },
  { id: "planned", title: "Запланировано", note: "Порядок карточек — очередь: в приложении они идут так же. Перетаскивайте, чтобы поменять." },
  { id: "inProgress", title: "В работе" },
  { id: "done", title: "Готово" },
  { id: "rejected", title: "Отклонено", note: "Не видны никому, кроме автора." },
];
// Колонки, порядок в которых задаёт модератор. В приложении они — одна вкладка «Запланировано», «В работе» сверху.
const QUEUED = ["inProgress", "planned"];
const DAY = 86400000;
const REFRESH_MS = 60000;
// Голоса — самая тяжёлая часть загрузки: автообновление берёт их раз в пять минут, кнопка «Обновить» — всегда.
const VOTES_REFRESH_MS = 5 * 60000;
const DEMO = new URLSearchParams(location.search).has("demo");
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const plural = (n, one, few, many) => {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
};

const store = {
  get(key, fallback) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* приватный режим */ } },
};

const env = store.get("ideas.env", "development");
let cfg = {};
let backend = null;
let user = null;
let ideas = [], queue = { order: [], tag: null }, loaded = false, loadedAt = 0, votesAt = 0, loading = false;
let query = "", sort = store.get("ideas.sort", "votes"), version = "";
let openId = null, confirmDelete = false, editing = false, merging = false, mergeQuery = "", toastTimer = null, dragId = null;
const TITLE_LIMIT = 80, DETAILS_LIMIT = 1000, REPLY_LIMIT = 1000;
const MERGED_REPLY = "Объединена с идеей «";
// Ideas created after the previous visit get a dot until the next one.
const previousVisit = Number(store.get("ideas.lastVisit", "0")) || 0;
const folded = new Set(["rejected"]);
// On a phone the board shows one column at a time.
const narrow = window.matchMedia("(max-width: 640px)");
let activeColumn = store.get("ideas.column", "");
let panelEntering = false;
const saving = new Set();

// MARK: Запуск

boot();

async function boot() {
  wireStaticControls();
  if (DEMO) {
    cfg = { appName: "PokerLog" };
    backend = demoBackend();
  } else {
    try {
      await loadScript("config.js?t=" + Date.now()); // в обход 10-минутного кэша GitHub Pages
      cfg = window.IDEAS_CONFIG || {};
    } catch {
      return showState("Нет config.js", "Положите <code>config.js</code> рядом со страницей.");
    }
    const token = (cfg.apiTokens || {})[env] || "";
    if (!token) {
      const name = env === "production" ? "Production" : "Development";
      return showState(`Нет API-токена для ${name}`,
        `Создайте токен в CloudKit Console → Settings → Tokens &amp; Keys (окружение ${name}) `
        + `и вставьте его в <code>config.js</code>, в <code>apiTokens.${env}</code>.`);
    }
    await cloudKitReady();
    backend = cloudBackend(token);
  }
  document.title = `Идеи ${cfg.appName || ""}`.trim();
  $("#app-title").textContent = document.title;
  showSkeleton();
  narrow.addEventListener("change", render);
  try {
    setUser(await backend.start(setUser));
  } catch (error) {
    return showState("CloudKit не ответил", describe(error));
  }
  await load();
  setInterval(() => { if (document.visibilityState === "visible") load({ quiet: true }); }, REFRESH_MS);
  setInterval(renderUpdated, 15000);
  window.addEventListener("pagehide", () => store.set("ideas.lastVisit", String(Date.now())));
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src; s.onload = resolve; s.onerror = reject;
    document.head.append(s);
  });
}

function cloudKitReady() {
  return window.CloudKit ? Promise.resolve() : new Promise((r) => window.addEventListener("cloudkitloaded", r, { once: true }));
}

function wireStaticControls() {
  $("#demo-badge").hidden = !DEMO;
  for (const id of ["development", "production"]) {
    const button = $("#env-" + id);
    button.setAttribute("aria-pressed", String(env === id));
    button.onclick = () => { if (env !== id) { store.set("ideas.env", id); location.reload(); } };
  }
  for (const button of document.querySelectorAll("[data-sort]")) {
    button.setAttribute("aria-pressed", String(button.dataset.sort === sort));
    button.onclick = () => {
      sort = button.dataset.sort; store.set("ideas.sort", sort);
      document.querySelectorAll("[data-sort]").forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
      render();
    };
  }
  $("#q").oninput = (e) => { query = e.target.value.trim().toLowerCase(); render(); };
  $("#version").onchange = (e) => { version = e.target.value; render(); };
  $("#reload").onclick = () => load();
}

const icon = {
  up: '<svg width="10" height="6" viewBox="0 0 10 6" aria-hidden="true"><path d="M1 5l4-4 4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  fold: '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M7.5 2.5L4 6l3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  close: '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  reply: '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2.5h8a1 1 0 0 1 1 1v4.5a1 1 0 0 1-1 1H5.5L3 11V9H2a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
};

function spinReload() {
  const b = $("#reload");
  b.classList.remove("spin"); void b.offsetWidth; b.classList.add("spin");
  setTimeout(() => b.classList.remove("spin"), 520);
}

function setUser(identity) {
  user = identity || null;
  const who = $("#user");
  who.innerHTML = user ? "<b>Модератор</b>" : "Только чтение";
  who.title = user ? user.userRecordName : "Войдите через Apple ID с ролью Moderator, чтобы менять статусы";
  render();
}

// MARK: Подсчёт

// Where each merged idea's votes go: the end of its chain of merges. A chain that loops counts for nothing.
function mergeTargets(decisions) {
  const targets = new Map();
  for (const [id, decision] of decisions) {
    if (!decision.mergedInto) continue;
    const seen = new Set([id]);
    let target = decision.mergedInto;
    while (decisions.has(target) && decisions.get(target).mergedInto && !seen.has(target)) {
      seen.add(target);
      target = decisions.get(target).mergedInto;
    }
    if (!seen.has(target)) targets.set(id, target);
  }
  return targets;
}

// Votes by idea: everyone who voted for it or for a duplicate merged into it, once each, and how many of them this week.
function tallyVotes(votes, targets) {
  const voters = new Map(), own = new Map();
  for (const { idea, by, at } of votes) {
    own.set(idea, (own.get(idea) || 0) + 1);
    const id = targets.get(idea) || idea;
    const people = voters.get(id) || new Map();
    people.set(by, Math.min(people.get(by) ?? Infinity, at));
    voters.set(id, people);
  }
  const tally = new Map();
  for (const [id, people] of voters) {
    let week = 0;
    for (const at of people.values()) if (Date.now() - at < 7 * DAY) week += 1;
    tally.set(id, { total: people.size, week });
  }
  return { tally, own };
}

// MARK: Источники данных

function cloudBackend(apiToken) {
  CloudKit.configure({
    containers: [{
      containerIdentifier: cfg.containerIdentifier,
      apiTokenAuth: {
        apiToken, persist: true,
        signInButton: { id: "apple-sign-in-button", theme: "black" },
        signOutButton: { id: "apple-sign-out-button", theme: "black" },
      },
      environment: env,
    }],
  });
  const container = CloudKit.getDefaultContainer();
  const db = container.publicCloudDatabase;
  let votes = null;

  async function queryAll(q, options) {
    const records = [];
    let response = await db.performQuery(q, options);
    for (;;) {
      if (response.hasErrors) throw response.errors[0];
      records.push(...response.records);
      if (!response.moreRecordsComing) return records;
      response = await db.performQuery(response);
    }
  }
  const creator = (record) => {
    const name = record.created && record.created.userRecordName;
    if (name === "__defaultOwner__") return user ? user.userRecordName : null;
    return name || null;
  };
  const value = (record, key) => (record.fields && record.fields[key] ? record.fields[key].value : "");
  const check = (response) => { if (response.hasErrors) throw response.errors[0]; return response; };
  const missing = (error) => ["NOT_FOUND", "UNKNOWN_ITEM"].includes(error && (error.ckErrorCode || error.serverErrorCode));

  // The moderator's queue is one record, so reordering is one save and notifies nobody following an idea.
  async function fetchQueue() {
    const response = await db.fetchRecords(["queue"]);
    if (response.hasErrors) {
      if (missing(response.errors[0])) return { order: [], tag: null };
      throw response.errors[0];
    }
    const record = response.records[0];
    return { order: value(record, "featureIDs") || [], tag: record.recordChangeTag };
  }

  function watchAuth(onChange) {
    if (user) container.whenUserSignsOut().then(() => { onChange(null); toast("Вы вышли: доска только для чтения"); watchAuth(onChange); });
    else container.whenUserSignsIn().then((identity) => { onChange(identity); toast("Вы вошли как модератор"); watchAuth(onChange); }).catch(() => {});
  }

  return {
    async start(onChange) {
      const identity = await container.setUpAuth();
      user = identity || null;
      watchAuth(onChange);
      return identity;
    },
    async load({ withVotes = true } = {}) {
      const [requests, moderation, queued, fresh] = await Promise.all([
        queryAll({ recordType: "FeatureRequest" }, { resultsLimit: 200 }),
        queryAll({ recordType: "Moderation" }, { resultsLimit: 200 }),
        fetchQueue(),
        withVotes || !votes ? queryAll({ recordType: "Vote" }, { resultsLimit: 200, desiredKeys: ["featureRef"] }) : null,
      ]);
      if (fresh) {
        votes = [];
        for (const vote of fresh) {
          const ref = vote.fields.featureRef && vote.fields.featureRef.value;
          const by = creator(vote);
          if (!ref || !by || vote.recordName !== ref.recordName + "_" + by) continue;
          votes.push({ idea: ref.recordName, by, at: (vote.created && vote.created.timestamp) || 0 });
        }
      }
      // The decision is the moderator's own record, «moderation_<idea>»; an idea without one is pending.
      const decisions = new Map();
      for (const m of moderation) {
        const ref = m.fields.featureRef && m.fields.featureRef.value;
        if (!ref || m.recordName !== "moderation_" + ref.recordName) continue;
        const mergedInto = value(m, "mergedInto");
        decisions.set(ref.recordName, {
          status: value(m, "status"), reply: value(m, "reply"), releasedIn: value(m, "releasedIn"),
          mergedInto: mergedInto && mergedInto !== ref.recordName ? mergedInto : "", tag: m.recordChangeTag,
        });
      }
      const targets = mergeTargets(decisions);
      const { tally, own } = tallyVotes(votes, targets);
      return {
        queue: queued,
        votesFresh: !!fresh,
        ideas: requests.map((r) => {
          const d = decisions.get(r.recordName) || {};
          return {
            id: r.recordName,
            tag: r.recordChangeTag,
            title: value(r, "title"),
            details: value(r, "details"),
            status: d.status || "pending",
            statusTag: d.tag || null,
            reply: d.reply || "",
            releasedIn: d.releasedIn || "",
            mergedInto: d.mergedInto || "",
            mergeTarget: targets.get(r.recordName) || "",
            version: value(r, "appVersion"),
            created: (r.created && r.created.timestamp) || value(r, "createdAt") || 0,
            author: creator(r) || value(r, "authorID"),
            votes: (tally.get(r.recordName) || {}).total || 0,
            votesWeek: (tally.get(r.recordName) || {}).week || 0,
            ownVotes: own.get(r.recordName) || 0,
          };
        }),
      };
    },
    async save(idea, fields) {
      const payload = {};
      for (const [key, v] of Object.entries(fields)) payload[key] = { value: v };
      const response = check(await db.saveRecords([{ recordType: "FeatureRequest", recordName: idea.id, recordChangeTag: idea.tag, fields: payload }]));
      return response.records[0].recordChangeTag;
    },
    // Only the Moderator role may create or change these records, so an author can't publish their own idea.
    // Every save notifies the app's users who follow the idea, when the app turned notifications on.
    async saveModeration(idea, decision) {
      const record = {
        recordType: "Moderation", recordName: "moderation_" + idea.id,
        fields: {
          featureRef: { value: { recordName: idea.id, action: "NONE" } },
          status: { value: decision.status },
          reply: { value: decision.reply },
          releasedIn: { value: decision.releasedIn },
          mergedInto: { value: decision.mergedInto },
        },
      };
      if (idea.statusTag) record.recordChangeTag = idea.statusTag;
      const response = check(await db.saveRecords([record]));
      return response.records[0].recordChangeTag;
    },
    async saveQueue(order, tag) {
      const record = { recordType: "Queue", recordName: "queue", fields: { featureIDs: { value: order, type: "STRING_LIST" } } };
      if (tag) record.recordChangeTag = tag;
      const response = check(await db.saveRecords([record]));
      return response.records[0].recordChangeTag;
    },
    async remove(idea) {
      check(await db.deleteRecords([idea.id]));
      // The decision goes with the idea; a pending idea has none, and that's fine.
      if (idea.statusTag) await db.deleteRecords(["moderation_" + idea.id]).catch(() => {});
    },
  };
}

function demoBackend() {
  const now = Date.now();
  const rows = [
    ["Синхронизация между iPhone и iPad", "Хочу записывать сессии на телефоне в клубе, а разбирать раздачи дома на iPad. Сейчас данные живут только на одном устройстве.", "open", 21, 128, 9],
    ["Экспорт сессий в CSV для Excel", "Чтобы считать налоги и строить свои графики. Достаточно даты, места, бай-ина, кэшаута и длительности.", "open", 9, 64, 22],
    ["Заметки об оппонентах", "Короткая заметка и цветная метка у игрока, которые видны в каждой раздаче с ним.", "open", 4, 37, 31],
    ["Учёт рейка и чаевых", "Отдельное поле в сессии, чтобы видеть, сколько уходит заведению.", "open", 2, 3, 3],
    ["Виджет с результатом за неделю", "Маленький виджет на экране «Домой»: плюс или минус за 7 дней и число сессий.", "pending", .2, 0, 0],
    ["Тёмная тема для экрана лайва", "Ночью в клубе экран слишком яркий, хочется ещё темнее.", "pending", .6, 0, 0],
    ["Импорт из PokerTracker", "Перенести старую историю, чтобы статистика была за все годы.", "pending", 1.5, 0, 0],
    ["Таймер блайндов для домашних турниров", "Структура уровней, звук на смене и большой экран, который видно со всего стола.", "planned", 40, 91, 4],
    ["Приложение для Apple Watch", "Смотреть время сессии и добавлять докупки, не доставая телефон.", "planned", 30, 12, 1],
    ["Статистика по позициям", "VPIP, PFR и результат по каждой позиции за выбранный период.", "inProgress", 55, 73, 6],
    ["Тёмная тема для карточек раздач", "Карточки раздач, которыми делишься, в тёмных цветах.", "done", 80, 54, 0],
    ["Голосовая запись раздачи", "Надиктовать раздачу сразу после неё, а приложение само расставит действия.", "done", 120, 143, 2],
    ["Ставки на спорт", "Учёт ставок рядом с покером.", "rejected", 60, 3, 0],
    ["Синк с айпадом", "Чтобы на планшете были те же сессии.", "rejected", 14, 6, 1],
  ];
  let data = rows.map(([title, details, status, days, votes, votesWeek], i) => ({
    id: "demo-" + (i + 1), tag: "t0", title, details, status, votes, votesWeek, ownVotes: votes,
    statusTag: status === "pending" ? null : "s0", reply: "", releasedIn: "", mergedInto: "",
    created: now - days * DAY, version: "3." + (i % 3) + " (" + (40 + i) + ")", author: "_" + (0x9a3f20 + i * 7919).toString(16),
  }));
  const set = (id, fields) => { data = data.map((i) => (i.id === id ? { ...i, ...fields } : i)); };
  set("demo-14", { mergedInto: "demo-1", reply: MERGED_REPLY + "Синхронизация между iPhone и iPad»: голоса перенесены туда." });
  set("demo-8", { reply: "Берём следующим после статистики по позициям." });
  set("demo-12", { releasedIn: "3.1" });
  set("demo-13", { reply: "Приложение про покер, ставки на спорт в него не впишутся." });
  let order = ["demo-10", "demo-8", "demo-9"];
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const authButton = $("#demo-auth");
  return {
    async start(onChange) {
      authButton.hidden = false;
      const paint = () => { authButton.textContent = user ? "Выйти" : "Войти (демо)"; authButton.className = user ? "btn" : "btn primary"; };
      authButton.onclick = () => {
        onChange(user ? null : { userRecordName: "_demo-moderator" });
        paint();
        toast(user ? "Вы вошли как модератор (демо)" : "Вы вышли: доска только для чтения");
      };
      user = DEMO && new URLSearchParams(location.search).has("signedin") ? { userRecordName: "_demo-moderator" } : null;
      paint();
      return user;
    },
    async load() {
      await wait(500);
      // The sample's counts are per idea; a merged duplicate adds its own to its target's, as if nobody voted twice.
      const targets = mergeTargets(new Map(data.map((i) => [i.id, i])));
      const extra = new Map();
      for (const [from, to] of targets) {
        const source = data.find((i) => i.id === from);
        const sum = extra.get(to) || { votes: 0, week: 0 };
        extra.set(to, { votes: sum.votes + source.ownVotes, week: sum.week + source.votesWeek });
      }
      return {
        queue: { order: [...order], tag: "q0" },
        votesFresh: true,
        ideas: data.map((i) => ({
          ...i, mergeTarget: targets.get(i.id) || "",
          votes: i.ownVotes + ((extra.get(i.id) || {}).votes || 0),
          votesWeek: i.votesWeek + ((extra.get(i.id) || {}).week || 0),
        })),
      };
    },
    async save(idea, fields) { await wait(350); set(idea.id, fields); return "t" + Date.now(); },
    async saveModeration(idea, decision) { await wait(350); set(idea.id, decision); return "s" + Date.now(); },
    async saveQueue(next) { await wait(300); order = [...next]; return "q" + Date.now(); },
    async remove(idea) { await wait(350); data = data.filter((i) => i.id !== idea.id); },
  };
}

// MARK: Загрузка

async function load({ quiet = false } = {}) {
  // An automatic refresh waits while a card is being dragged or saved, so it doesn't move cards under the cursor.
  if (loading || (quiet && (dragId || saving.size))) return;
  loading = true;
  if (!quiet) { $("#updated").textContent = "Обновляю…"; $("#updated").className = "updated busy"; spinReload(); }
  try {
    const result = await backend.load({ withVotes: !quiet || Date.now() - votesAt > VOTES_REFRESH_MS });
    ideas = result.ideas.filter((i) => STATUSES.some((s) => s.id === i.status));
    queue = result.queue;
    loaded = true;
    loadedAt = Date.now();
    if (result.votesFresh) votesAt = loadedAt;
    render();
  } catch (error) {
    if (!loaded) showState("Не удалось загрузить идеи", describe(error));
    else if (!quiet) toast("Не удалось обновить. " + describe(error));
  } finally {
    loading = false;
    renderUpdated();
  }
}

function describe(error) {
  const code = error && (error.ckErrorCode || error.serverErrorCode);
  switch (code) {
    case "ACCESS_DENIED": return "Нет прав. Изменять идеи может только пользователь с ролью Moderator.";
    case "AUTHENTICATION_REQUIRED":
    case "AUTHENTICATION_FAILED": return "Войдите через Apple ID.";
    case "CONFLICT": return "Идею изменили в другом месте. Обновите доску.";
    case "NOT_FOUND":
    case "UNKNOWN_ITEM": return env === "production"
      ? "В Production нет схемы. Выкатите её в CloudKit Console: Deploy Schema Changes."
      : "Записи не найдены.";
    case "THROTTLED":
    case "TRY_AGAIN_LATER": return "CloudKit просит подождать. Попробуйте через минуту.";
    case "BAD_REQUEST": return (error.reason || "CloudKit отклонил запрос") + ". Возможно, схема в этом окружении старая: обновите её по CloudKit/schema.ckdb.";
    default: return (error && (error.reason || error.message)) || "Проверьте соединение и попробуйте ещё раз.";
  }
}

// MARK: Отрисовка

function showState(title, html) {
  $("#board").innerHTML = `<div class="state"><h2>${esc(title)}</h2><p>${html}</p></div>`;
  $("#stats").innerHTML = "";
  $("#updated").textContent = "";
}

function showSkeleton() {
  $("#board").innerHTML = STATUSES.map((s, n) => `<section class="col${n === 0 ? " active" : ""}" data-status="${s.id}" aria-hidden="true">
    <div class="col-head"><span class="dot ${s.id}"></span><h2>${s.title}</h2></div>
    <div class="list">${'<div class="skeleton"></div>'.repeat(3 - (n % 2))}</div></section>`).join("");
}

function renderSwitcher(counts) {
  if (!activeColumn || !STATUSES.some((s) => s.id === activeColumn)) activeColumn = counts.pending ? "pending" : "open";
  $("#switcher").innerHTML = STATUSES.map((s) =>
    `<button data-column="${s.id}" aria-pressed="${s.id === activeColumn}"><span class="dot ${s.id}"></span>${s.title}<span class="n">${counts[s.id] || 0}</span></button>`).join("");
}

function renderUpdated() {
  if (!loadedAt || loading) return;
  const min = Math.floor((Date.now() - loadedAt) / 60000);
  $("#updated").textContent = min < 1 ? "Обновлено только что" : `Обновлено ${min} мин назад`;
  $("#updated").className = "updated" + (user ? "" : " readonly");
}

const ago = (t) => {
  const ms = Date.now() - t, d = Math.floor(ms / DAY);
  if (d < 1) return Math.max(1, Math.round(ms / 3600000)) + " ч назад";
  if (d < 30) return d + " дн назад";
  return shortDate(t);
};
const shortDate = (t) => {
  const d = new Date(t), sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString("ru-RU", { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) }).replace(/\.$| г\.$/, "");
};
const statusTitle = (id) => (STATUSES.find((s) => s.id === id) || {}).title || id;
const isUnseen = (i) => previousVisit > 0 && i.created > previousVisit;
const ideaById = (id) => ideas.find((x) => x.id === id);
// «3.4 (52)» → «3.4»: the filter groups builds of one version.
const marketing = (v) => String(v || "").split(" ")[0];
// The board shows everything but duplicates merged into another idea; those are listed in its panel.
const onBoard = () => ideas.filter((i) => !i.mergeTarget);
const duplicatesOf = (id) => ideas.filter((i) => i.mergeTarget === id);

const comparators = {
  votes: (a, b) => b.votes - a.votes || b.created - a.created,
  trend: (a, b) => b.votesWeek - a.votesWeek || b.votes - a.votes,
  new: (a, b) => b.created - a.created,
};

// A column's ideas in the order shown: in the queued columns the moderator's queue first, then the chosen sort.
function ordered(items, status) {
  const base = items.slice().sort(comparators[sort]);
  if (!QUEUED.includes(status)) return base;
  const place = new Map(queue.order.map((id, n) => [id, n]));
  const at = (i) => (place.has(i.id) ? place.get(i.id) : Infinity);
  return base.sort((a, b) => (at(a) === at(b) ? 0 : at(a) < at(b) ? -1 : 1));
}

function matches(i) {
  if (version && marketing(i.version) !== version) return false;
  if (!query) return true;
  return [i.title, i.details, i.reply, i.author, i.id].join(" ").toLowerCase().includes(query);
}

function render() {
  if (!loaded) return;
  renderStats();
  renderVersions();
  const visible = onBoard().filter(matches);
  const counts = {};
  for (const i of visible) counts[i.status] = (counts[i.status] || 0) + 1;
  renderSwitcher(counts);
  $("#board").innerHTML = STATUSES.map((s) => {
    const items = ordered(visible.filter((i) => i.status === s.id), s.id);
    const isFolded = folded.has(s.id) && !narrow.matches;
    const classes = ["col", isFolded ? "folded" : "", s.id === activeColumn ? "active" : ""].filter(Boolean).join(" ");
    return `<section class="${classes}" data-status="${s.id}" aria-label="${s.title}">
      <div class="col-head"><span class="dot ${s.id}"></span><h2>${s.title}</h2><span class="count">${items.length}</span>
        <button class="fold" data-fold="${s.id}" aria-label="Свернуть колонку «${s.title}»" title="Свернуть">${icon.fold}</button></div>
      ${s.note ? `<div class="col-note">${s.note}</div>` : ""}
      <div class="list">${items.length ? items.map(card).join("") : `<div class="empty">${query || version ? "Ничего не найдено" : "Пока пусто"}</div>`}</div>
    </section>`;
  }).join("");
  renderPanel();
  renderUpdated();
}

function renderVersions() {
  const select = $("#version");
  const versions = [...new Set(onBoard().map((i) => marketing(i.version)).filter(Boolean))]
    .sort((a, b) => b.localeCompare(a, "ru", { numeric: true }));
  if (version && !versions.includes(version)) version = "";
  const html = `<option value="">Все версии</option>` + versions.map((v) => `<option value="${esc(v)}"${v === version ? " selected" : ""}>v${esc(v)}</option>`).join("");
  if (select.innerHTML !== html) select.innerHTML = html;
  select.hidden = versions.length < 2;
}

function renderStats() {
  const board = onBoard();
  const pending = board.filter((i) => i.status === "pending").length;
  const unseen = board.filter(isUnseen).length;
  const unreleased = board.filter((i) => i.status === "done" && !i.releasedIn).length;
  const votesWeek = board.reduce((s, i) => s + i.votesWeek, 0);
  const top = board.filter((i) => i.status === "open").sort(comparators.votes)[0];
  $("#stats").innerHTML = [
    pending ? `<button class="stat attention" data-jump="pending" title="Показать колонку «На рассмотрении»"><b>${pending}</b>${plural(pending, "ждёт проверки", "ждут проверки", "ждут проверки")}</button>` : "",
    unseen ? `<div class="stat"><b>${unseen}</b>${plural(unseen, "новая с прошлого визита", "новые с прошлого визита", "новых с прошлого визита")}</div>` : "",
    `<div class="stat"><b>${votesWeek.toLocaleString("ru-RU")}</b>${plural(votesWeek, "голос за неделю", "голоса за неделю", "голосов за неделю")}</div>`,
    top ? `<button class="stat" data-open="${esc(top.id)}" title="Открыть лидера"><b>${top.votes}</b>лидер:<span class="lead">${esc(top.title)}</span></button>` : "",
    unreleased ? `<button class="stat" data-jump="done" title="Готовые идеи без версии выхода: в приложении у них не будет «Вышло в версии»"><b>${unreleased}</b>без версии выхода</button>` : "",
  ].join("");
}

function statusOptions(current) {
  return STATUSES.map((s) => `<option value="${s.id}"${s.id === current ? " selected" : ""}>${s.title}</option>`).join("");
}

function card(i) {
  const canMove = !!user && !saving.has(i.id);
  const classes = ["card", saving.has(i.id) ? "saving" : "", isUnseen(i) ? "unseen" : ""].filter(Boolean).join(" ");
  const place = QUEUED.includes(i.status) ? queue.order.indexOf(i.id) : -1;
  const dupes = duplicatesOf(i.id).length;
  return `<article class="${classes}" tabindex="0" data-id="${esc(i.id)}" data-status="${i.status}" draggable="${canMove}"
      aria-label="${esc(i.title)}, ${i.votes} ${plural(i.votes, "голос", "голоса", "голосов")}${isUnseen(i) ? ", новая" : ""}">
    <div class="votes${i.votes >= 100 ? " hot" : ""}" aria-hidden="true">${icon.up}${i.votes}</div>
    <div class="card-body">
      <div class="card-title">${esc(i.title)}</div>
      <div class="card-meta">
        ${place >= 0 ? `<span class="tag queue" title="Место в очереди">№${place + 1}</span>` : ""}
        ${Date.now() - i.created < 2 * DAY ? '<span class="tag">новая</span>' : ""}
        ${i.status === "done" && i.releasedIn ? `<span class="tag released">вышло в ${esc(i.releasedIn)}</span>` : ""}
        <span>${ago(i.created)}</span>
        ${i.votesWeek ? `<span class="trend" title="Голоса за 7 дней">↑${i.votesWeek} за неделю</span>` : ""}
        ${dupes ? `<span class="tag dupes" title="Объединённые дубли">+${dupes} ${plural(dupes, "дубль", "дубля", "дублей")}</span>` : ""}
        ${i.reply ? `<span class="has-reply" title="Есть ответ: ${esc(i.reply)}">${icon.reply}</span>` : ""}
      </div>
      <div class="move"><select data-move="${esc(i.id)}" aria-label="Статус" ${canMove ? "" : "disabled"}>${statusOptions(i.status)}</select></div>
    </div>
    ${canMove && i.status === "pending" ? `<div class="quick">
      <button class="btn small primary" data-quick="open">Опубликовать</button>
      <button class="btn small" data-quick="rejected">Отклонить</button></div>` : ""}
  </article>`;
}

function replyHint(i) {
  if (i.status === "pending") return "Автор увидит ответ в приложении. Остальным идея ещё не видна.";
  if (i.status === "rejected") return "Увидит только автор: например, почему идея не подошла.";
  return "Виден всем в карточке идеи. Тем, кто следит за идеей, придёт уведомление.";
}

function renderPanel() {
  const root = $("#panel-root");
  const i = ideaById(openId);
  if (!i) { root.hidden = true; root.innerHTML = ""; return; }
  root.hidden = false;
  const locked = !user || saving.has(i.id);
  const dupes = duplicatesOf(i.id);
  const target = i.mergeTarget ? ideaById(i.mergeTarget) : null;
  const showRelease = i.status === "done" || i.releasedIn;
  root.innerHTML = `<div class="panel-scrim${panelEntering ? " enter" : ""}" data-close></div>
  <aside class="panel${panelEntering ? " enter" : ""}" role="dialog" aria-modal="true" aria-label="${esc(i.title)}">
    <div class="panel-top">
      <span class="badge ${i.status}"><span class="dot ${i.status}"></span>${statusTitle(i.status)}</span>
      <button class="close" data-close aria-label="Закрыть">${icon.close}</button>
    </div>
    ${target ? `<div class="merged-note">Дубль идеи <button class="link" data-open="${esc(target.id)}">«${esc(target.title)}»</button>: его голоса считаются там.</div>` : ""}
    ${editing ? `<form class="edit" id="edit-form">
        <label class="field">Название<input class="input" id="edit-title" maxlength="${TITLE_LIMIT}" required value="${esc(i.title)}"></label>
        <span class="counter" id="title-count"></span>
        <label class="field">Описание<textarea class="input" id="edit-details" maxlength="${DETAILS_LIMIT}">${esc(i.details)}</textarea></label>
        <span class="counter" id="details-count"></span>
        <div class="row"><button class="btn primary" type="submit">Сохранить</button><button class="btn" type="button" id="edit-cancel">Отмена</button></div>
      </form>` : `<div class="text"><h3>${esc(i.title)}</h3>
      ${i.details ? `<p>${esc(i.details)}</p>` : '<p class="empty-text">Автор не добавил описания.</p>'}
      ${user ? '<button class="btn small" id="edit" style="align-self:flex-start">Исправить текст</button>' : ""}</div>`}
    <dl class="facts">
      <div><dt>Голоса</dt><dd>${i.votes}${i.votesWeek ? `<small>↑${i.votesWeek}</small>` : ""}</dd></div>
      <div><dt>Предложена</dt><dd title="${esc(new Date(i.created).toLocaleString("ru-RU"))}">${shortDate(i.created)}</dd></div>
      <div><dt>Версия</dt><dd>${esc(i.version || "—")}</dd></div>
      <div><dt>Автор</dt><dd class="mono" title="${esc(i.author || "")}">${esc(i.author || "—")}</dd></div>
    </dl>
    <div class="section-label">Статус</div>
    <div class="status-pick" role="radiogroup" aria-label="Статус">
      ${STATUSES.map((s, n) => `<button role="radio" class="${s.id}" data-set-status="${s.id}" aria-checked="${s.id === i.status}" ${locked ? "disabled" : ""}>
        <span class="dot ${s.id}"></span>${s.title}${user ? `<kbd>${n + 1}</kbd>` : ""}</button>`).join("")}
    </div>
    ${user ? `<form class="reply" id="reply-form">
      <label class="field">Ответ ${i.status === "rejected" ? "автору" : "в приложении"}
        <textarea class="input" id="reply" maxlength="${REPLY_LIMIT}" placeholder="${i.status === "rejected" ? "Почему не подошла" : "Например: «Сделаем в 3.5, вместе с виджетами»"}">${esc(i.reply)}</textarea></label>
      ${showRelease ? `<label class="field">Вышло в версии<input class="input" id="released" maxlength="40" placeholder="3.4" value="${esc(i.releasedIn)}"></label>` : ""}
      <div class="row"><button class="btn primary small" type="submit" id="reply-save" disabled>Сохранить</button><span class="hint">${replyHint(i)}</span></div>
    </form>` : i.reply || i.releasedIn ? `<div class="reply-view">${i.reply ? `<div class="section-label">Ответ</div><p>${esc(i.reply)}</p>` : ""}
      ${i.releasedIn ? `<p class="hint">Вышло в версии ${esc(i.releasedIn)}</p>` : ""}</div>` : ""}
    ${!target && (dupes.length || (user && i.status !== "pending")) ? `<div class="dupes-box">
      <div class="section-label">Дубли</div>
      ${dupes.map((d) => `<div class="dupe"><button class="link" data-open="${esc(d.id)}">${esc(d.title)}</button>
        <span class="hint">${d.ownVotes} ${plural(d.ownVotes, "голос", "голоса", "голосов")}</span>
        ${user ? `<button class="btn small" data-unmerge="${esc(d.id)}">Разъединить</button>` : ""}</div>`).join("")}
      ${user ? (merging ? mergePicker(i) : `<button class="btn small" id="merge" style="align-self:flex-start">Это дубль другой идеи…</button>`) : ""}
    </div>` : ""}
    ${!user ? '<span class="hint">Чтобы менять статус и отвечать, войдите через Apple ID с ролью Moderator.</span>' : ""}
    ${user ? `<div class="panel-foot">${confirmDelete
      ? `<div class="confirm"><span>Удалить идею насовсем? Это нельзя отменить, голоса за неё перестанут учитываться.</span>
           <div class="row"><button class="btn danger-fill" id="del-yes">Удалить</button><button class="btn" id="del-no">Отмена</button></div></div>`
      : '<span class="keys"><kbd>E</kbd> правка · <kbd>Esc</kbd> закрыть</span><button class="btn small danger" id="del">Удалить идею</button>'}</div>` : ""}
  </aside>`;
  if (editing) {
    const title = $("#edit-title"), details = $("#edit-details");
    const count = () => {
      $("#title-count").textContent = `${title.value.length}/${TITLE_LIMIT}`;
      $("#details-count").textContent = `${details.value.length}/${DETAILS_LIMIT}`;
    };
    title.oninput = details.oninput = count;
    count();
    title.focus();
    title.setSelectionRange(title.value.length, title.value.length);
  }
  const form = $("#reply-form");
  if (form) {
    const dirty = () => {
      const released = $("#released");
      $("#reply-save").disabled = saving.has(i.id)
        || ($("#reply").value.trim() === i.reply && (!released || released.value.trim() === i.releasedIn));
    };
    form.oninput = dirty;
  }
  const search = $("#merge-q");
  if (search) {
    search.oninput = (e) => { mergeQuery = e.target.value.trim().toLowerCase(); $("#merge-list").innerHTML = mergeOptions(i); };
    search.focus();
  }
}

// Ideas this one may be a duplicate of: published ones, not itself, not its own duplicates.
function mergeOptions(i) {
  const options = onBoard()
    .filter((x) => x.id !== i.id && x.status !== "pending" && x.status !== "rejected")
    .filter((x) => !mergeQuery || (x.title + " " + x.details).toLowerCase().includes(mergeQuery))
    .sort(comparators.votes).slice(0, 8);
  return options.length
    ? options.map((x) => `<button class="option" data-merge-into="${esc(x.id)}"><span class="dot ${x.status}"></span>
        <span class="option-title">${esc(x.title)}</span><span class="hint">${x.votes}</span></button>`).join("")
    : '<div class="hint">Ничего не найдено</div>';
}

function mergePicker(i) {
  return `<div class="merge-picker">
    <input class="input" id="merge-q" placeholder="С какой идеей объединить?" value="${esc(mergeQuery)}" autocomplete="off">
    <div class="merge-list" id="merge-list">${mergeOptions(i)}</div>
    <div class="row"><span class="hint">Голоса перейдут к выбранной идее, эта скроется с доски и из приложения.</span>
      <button class="btn small" id="merge-cancel">Отмена</button></div>
  </div>`;
}

async function saveText(form) {
  const i = ideaById(openId);
  const title = form.querySelector("#edit-title").value.trim();
  const details = form.querySelector("#edit-details").value.trim();
  if (!i || !title || saving.has(i.id)) return;
  const before = { title: i.title, details: i.details };
  if (before.title === title && before.details === details) { editing = false; renderPanel(); return; }
  Object.assign(i, { title, details });
  saving.add(i.id); editing = false; render();
  try {
    i.tag = await backend.save(i, { title, details });
    toast("Текст идеи сохранён");
  } catch (error) {
    Object.assign(i, before);
    toast("Текст не сохранён. " + describe(error));
  } finally {
    saving.delete(i.id); render();
  }
}

// MARK: Изменения

const decisionOf = (i) => ({ status: i.status, reply: i.reply, releasedIn: i.releasedIn, mergedInto: i.mergedInto });

// Saves the moderator's decision about an idea. `announce` is the toast; `undoable` adds «Отменить»; `after` runs
// once it's saved, and again after an undo.
async function moderate(id, patch, { announce = "", undoable = true, after = null, actions = [] } = {}) {
  const i = ideaById(id);
  if (!i || !user || saving.has(id)) return false;
  const before = decisionOf(i);
  const next = { ...before, ...patch };
  if (Object.keys(next).every((k) => next[k] === before[k])) return false;
  Object.assign(i, next);
  saving.add(id);
  render();
  try {
    i.statusTag = await backend.saveModeration(i, next);
    saving.delete(id);
    render();
    flash(id);
    if (after) after();
    if (announce) {
      const undo = undoable ? [{ label: "Отменить", run: () => moderate(id, before, { after }) }] : [];
      toast(announce, ...undo, ...actions);
    }
    return true;
  } catch (error) {
    Object.assign(i, before);
    saving.delete(id);
    render();
    toast("Не сохранено. " + describe(error));
    return false;
  }
}

function setStatus(id, status) {
  const i = ideaById(id);
  if (!i || i.status === status) return;
  // A finished idea without a version: offer to add it, the app shows «Вышло в версии».
  const askVersion = status === "done" && !i.releasedIn
    ? [{ label: "Указать версию", run: () => { openPanel(id); const v = $("#released"); if (v) v.focus(); } }] : [];
  moderate(id, { status }, { announce: `«${i.title}» → ${statusTitle(status)}`, actions: askVersion });
}

function saveReply(form) {
  const i = ideaById(openId);
  if (!i) return;
  const reply = form.querySelector("#reply").value.trim();
  const released = form.querySelector("#released");
  const patch = { reply };
  if (released) patch.releasedIn = released.value.trim();
  moderate(i.id, patch, { announce: "Сохранено: в приложении увидят после обновления списка", undoable: false });
}

function mergeInto(sourceId, targetId) {
  const source = ideaById(sourceId), target = ideaById(targetId);
  if (!source || !target) return;
  merging = false; mergeQuery = "";
  const reply = source.reply || `${MERGED_REPLY}${target.title}»: голоса перенесены туда.`;
  // Declined for apps on older versions of the package, which don't know merges: there it stays the author's only.
  moderate(sourceId, { status: "rejected", mergedInto: targetId, reply }, {
    announce: `«${source.title}» объединена с «${target.title}»`,
    after: () => load(),
  }).then((saved) => { if (saved) openPanel(targetId); });
}

function unmerge(id) {
  const i = ideaById(id);
  if (!i) return;
  const reply = i.reply.startsWith(MERGED_REPLY) ? "" : i.reply;
  moderate(id, { status: "open", mergedInto: "", reply }, { announce: `«${i.title}» снова отдельная идея`, after: () => load() });
}

// Moves a queued idea before or after another in its column and saves the whole queue: «В работе», then «Запланировано».
async function reorder(id, targetId, after) {
  const i = ideaById(id), t = ideaById(targetId);
  if (!i || !t || id === targetId || i.status !== t.status || !QUEUED.includes(i.status) || !user) return;
  const column = (status) => ordered(onBoard().filter((x) => x.status === status), status).map((x) => x.id);
  const moved = column(i.status).filter((x) => x !== id);
  moved.splice(moved.indexOf(targetId) + (after ? 1 : 0), 0, id);
  const next = QUEUED.flatMap((status) => (status === i.status ? moved : column(status)));
  await saveQueue(next, id, true);
}

async function saveQueue(next, id, undoable) {
  const before = queue.order;
  queue = { ...queue, order: next };
  render();
  try {
    queue.tag = await backend.saveQueue(next, queue.tag);
    flash(id);
    toast("Очередь сохранена: в приложении «Запланировано» идёт в этом порядке",
      ...(undoable ? [{ label: "Отменить", run: () => saveQueue(before, id, false) }] : []));
  } catch (error) {
    queue = { ...queue, order: before };
    render();
    toast("Очередь не сохранена. " + describe(error));
  }
}

function flash(id) {
  const el = document.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
  if (el) { el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash"); }
}

async function remove(id) {
  const i = ideaById(id);
  if (!i) return;
  try {
    await backend.remove(i);
    ideas = ideas.filter((x) => x.id !== id);
    openId = null; confirmDelete = false;
    render();
    toast(`«${i.title}» удалена`);
  } catch (error) {
    confirmDelete = false;
    renderPanel();
    toast("Не удалось удалить. " + describe(error));
  }
}

// A message at the bottom with up to two actions, each { label, run }.
function toast(text, ...actions) {
  clearTimeout(toastTimer);
  $("#toast-root").innerHTML = `<div class="toast" role="status"><span>${esc(text)}</span>${actions.map((a, n) =>
    `<button data-toast="${n}">${esc(a.label)}</button>`).join("")}</div>`;
  $("#toast-root").querySelectorAll("[data-toast]").forEach((b) => {
    b.onclick = () => { $("#toast-root").innerHTML = ""; actions[Number(b.dataset.toast)].run(); };
  });
  toastTimer = setTimeout(() => ($("#toast-root").innerHTML = ""), actions.length ? 7000 : 4000);
}

// MARK: События

document.addEventListener("click", (e) => {
  const t = e.target;
  if (t.closest("[data-fold]")) { const s = t.closest("[data-fold]").dataset.fold; folded.has(s) ? folded.delete(s) : folded.add(s); render(); return; }
  const col = t.closest(".col.folded");
  if (col) { folded.delete(col.dataset.status); render(); return; }
  if (t.closest("[data-close]")) { closePanel(); return; }
  const column = t.closest("[data-column]");
  if (column) { activeColumn = column.dataset.column; store.set("ideas.column", activeColumn); render(); return; }
  const jump = t.closest("[data-jump]");
  if (jump) { showColumn(jump.dataset.jump); return; }
  const opener = t.closest("[data-open]");
  if (opener) { openPanel(opener.dataset.open); return; }
  const pick = t.closest("[data-set-status]");
  if (pick) { if (!pick.disabled) setStatus(openId, pick.dataset.setStatus); return; }
  const into = t.closest("[data-merge-into]");
  if (into) { mergeInto(openId, into.dataset.mergeInto); return; }
  const split = t.closest("[data-unmerge]");
  if (split) { unmerge(split.dataset.unmerge); return; }
  const quick = t.closest("[data-quick]");
  if (quick) { setStatus(quick.closest(".card").dataset.id, quick.dataset.quick); return; }
  if (t.id === "merge") { merging = true; mergeQuery = ""; renderPanel(); return; }
  if (t.id === "merge-cancel") { merging = false; renderPanel(); return; }
  if (t.id === "edit") { editing = true; renderPanel(); return; }
  if (t.id === "edit-cancel") { editing = false; renderPanel(); return; }
  if (t.id === "del") { confirmDelete = true; renderPanel(); return; }
  if (t.id === "del-no") { confirmDelete = false; renderPanel(); return; }
  if (t.id === "del-yes") { remove(openId); return; }
  if (t.closest("select")) return;
  const c = t.closest(".card");
  if (c) openPanel(c.dataset.id);
});
document.addEventListener("submit", (e) => {
  if (e.target.id === "edit-form") { e.preventDefault(); saveText(e.target); }
  if (e.target.id === "reply-form") { e.preventDefault(); saveReply(e.target); }
});

function showColumn(id) {
  activeColumn = id; store.set("ideas.column", id);
  folded.delete(id);
  render();
  const col = document.querySelector(`.col[data-status="${id}"]`);
  if (col) {
    col.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
    col.querySelectorAll(".card").forEach((c) => { c.classList.remove("flash"); void c.offsetWidth; c.classList.add("flash"); });
  }
}

let returnFocus = null;
function openPanel(id) {
  returnFocus = openId ? returnFocus : document.activeElement;
  openId = id; confirmDelete = false; editing = false; merging = false; mergeQuery = "";
  panelEntering = true;
  renderPanel();
  panelEntering = false;
  const close = document.querySelector(".panel .close");
  if (close) close.focus();
}
function closePanel() {
  const id = openId;
  openId = null; confirmDelete = false; editing = false; merging = false;
  renderPanel();
  const back = document.querySelector(`.card[data-id="${CSS.escape(id || "")}"]`) || returnFocus;
  if (back && back.focus) back.focus();
}
document.addEventListener("keydown", (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  if (e.key === "Escape" && openId) {
    if (editing) { editing = false; renderPanel(); } else if (merging) { merging = false; renderPanel(); } else closePanel();
    return;
  }
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && e.target.id === "reply") { e.preventDefault(); $("#reply-form").requestSubmit(); return; }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === "Enter" && e.target.classList && e.target.classList.contains("card")) { openPanel(e.target.dataset.id); return; }
  if (openId) {
    const index = Number(e.key) - 1;
    if (user && index >= 0 && index < STATUSES.length) { e.preventDefault(); setStatus(openId, STATUSES[index].id); return; }
    if (user && (e.key === "e" || e.key === "у")) { e.preventDefault(); editing = true; renderPanel(); return; }
    // Focus stays inside the open panel.
    if (e.key === "Tab") {
      const focusable = [...document.querySelectorAll(".panel button, .panel select, .panel input, .panel textarea")].filter((n) => !n.disabled);
      if (focusable.length) {
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }
    return;
  }
  if (e.key === "/") { e.preventDefault(); $("#q").focus(); }
  if (e.key === "r" || e.key === "к") load();
});
document.addEventListener("change", (e) => {
  if (e.target.dataset && e.target.dataset.move) setStatus(e.target.dataset.move, e.target.value);
});

// Dragging moves an idea to another column; within «В работе» and «Запланировано» it moves it in the queue.
const clearDropMarks = () => document.querySelectorAll(".drop-before,.drop-after").forEach((n) => n.classList.remove("drop-before", "drop-after"));
function dropSpot(e) {
  const col = e.target.closest && e.target.closest(".col");
  if (!col || !dragId) return null;
  const dragged = ideaById(dragId);
  const over = e.target.closest(".card");
  if (over && over.dataset.id !== dragId && dragged && dragged.status === col.dataset.status && QUEUED.includes(col.dataset.status)) {
    const box = over.getBoundingClientRect();
    return { col, card: over, after: e.clientY > box.top + box.height / 2 };
  }
  return { col, card: null };
}
document.addEventListener("dragstart", (e) => {
  const c = e.target.closest && e.target.closest(".card");
  if (!c || !user) return;
  dragId = c.dataset.id; c.classList.add("dragging");
  e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", dragId);
});
document.addEventListener("dragend", () => {
  dragId = null;
  clearDropMarks();
  document.querySelectorAll(".dragging,.over").forEach((n) => n.classList.remove("dragging", "over"));
});
document.addEventListener("dragover", (e) => {
  const spot = dropSpot(e);
  if (!spot) return;
  e.preventDefault();
  document.querySelectorAll(".col.over").forEach((n) => n !== spot.col && n.classList.remove("over"));
  clearDropMarks();
  if (spot.card) spot.card.classList.add(spot.after ? "drop-after" : "drop-before");
  else if (ideaById(dragId).status !== spot.col.dataset.status) spot.col.classList.add("over");
});
document.addEventListener("drop", (e) => {
  const spot = dropSpot(e);
  if (!spot) return;
  e.preventDefault();
  const id = dragId; dragId = null;
  clearDropMarks();
  if (spot.card) { reorder(id, spot.card.dataset.id, spot.after); return; }
  folded.delete(spot.col.dataset.status);
  setStatus(id, spot.col.dataset.status);
});
