(() => {
  "use strict";

  const CFG = window.VIVA_CONFIG || {};
  const SB = String(CFG.SUPABASE_URL || "").replace(/\/+$/, "");
  const KEY = String(CFG.SUPABASE_ANON_KEY || "");
  const FN = CFG.AI_FUNCTION || "assistente";
  const AI_ENDPOINT = String(CFG.AI_ENDPOINT || "");
  let AI_SERVER = null;
  const AI_STORE = "viva.aiKey.v1";
  const AI_PROVIDERS = {
    openrouter: { label: "OpenRouter (grátis)", model: "openrouter/free", vision: true },
    openai: { label: "OpenAI", model: "gpt-4o-mini", vision: true },
    groq: { label: "Groq", model: "openai/gpt-oss-120b", vision: false },
    gemini: { label: "Google Gemini", model: "gemini-3.5-flash-lite", vision: true }
  };
  const LS_SESSION = "viva.session.v2";
  const LS_PKCE = "viva.pkce.v2";
  const LS_VIEW = "viva.view.v2";
  const VERSION = 2;
  const SAVE_DELAY = 700;
  const CHAT_MAX = 60;

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function h(tag, attrs, ...kids) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value == null || value === false) continue;
      if (key === "class") node.className = value;
      else if (key === "dataset") Object.assign(node.dataset, value);
      else if (key === "html") node.innerHTML = value;
      else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
      else node.setAttribute(key, value === true ? "" : value);
    }
    for (const kid of kids.flat(4)) {
      if (kid == null || kid === false) continue;
      node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return node;
  }

  const nowIso = () => new Date().toISOString();
  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
  const round = (n) => Math.round(n);

  function parseNum(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
    if (value == null) return NaN;
    let s = String(value).trim().toLowerCase().replace(/\s+/g, "").replace(/(kg|cm|ml|kcal|anos?|litros?|l)$/g, "");
    if (!s) return NaN;
    if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
    const n = Number(s);
    return Number.isFinite(n) ? n : NaN;
  }

  function normalize(text) {
    return String(text || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9\s,.]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function ymd(date = new Date()) {
    const d = new Date(date);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function parseYmd(key) {
    const [y, m, d] = key.split("-").map(Number);
    return new Date(y, m - 1, d);
  }

  function addDays(date, days) {
    const d = new Date(date);
    d.setDate(d.getDate() + days);
    return d;
  }

  function fmtDay(date) {
    return new Date(date).toLocaleDateString("pt-BR", { day: "2-digit", month: "short" }).replace(".", "");
  }

  function fmtLong(date) {
    return new Date(date).toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "long" });
  }

  function fmtTime(iso) {
    return new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  }

  function nf(n) {
    return Number(n || 0).toLocaleString("pt-BR", { maximumFractionDigits: 0 });
  }

  function nf1(n) {
    return Number(n || 0).toLocaleString("pt-BR", { maximumFractionDigits: 1 });
  }

  function money(n) {
    return Number(n || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // Mifflin-St Jeor com a média das constantes masculina (+5) e feminina (-161).
  const ACTIVITY = 1.5;
  const GOAL_LABELS = { lose: "Perder peso", maintain: "Manter o peso", gain: "Ganhar massa" };
  const CONFIDENCE_LABELS = { baixa: "baixa", media: "média", alta: "alta" };
  const GOAL_DELTA = { lose: -400, maintain: 0, gain: 300 };
  const PROTEIN_PER_KG = { lose: 1.6, maintain: 1.3, gain: 1.8 };
  const FAT_RATIO = 0.27;

  function calcTargets({ age, heightCm, weightKg, goal }) {
    const bmr = 10 * weightKg + 6.25 * heightCm - 5 * age - 78;
    const kcal = Math.max(1200, round((bmr * ACTIVITY + (GOAL_DELTA[goal] ?? 0)) / 10) * 10);
    const protein = round(weightKg * (PROTEIN_PER_KG[goal] ?? 1.3));
    const fat = round((kcal * FAT_RATIO) / 9);
    const carbs = Math.max(0, round((kcal - protein * 4 - fat * 9) / 4));
    const waterMl = round((weightKg * 35) / 50) * 50;
    return { kcal, protein, carbs, fat, waterMl };
  }

  function bmi(weightKg, heightCm) {
    if (!weightKg || !heightCm) return null;
    return +(weightKg / ((heightCm / 100) ** 2)).toFixed(1);
  }

  function validateProfile(p) {
    const errors = {};
    if (!(p.age >= 14 && p.age <= 100)) errors.age = "Informe uma idade entre 14 e 100 anos.";
    if (!(p.heightCm >= 120 && p.heightCm <= 230)) errors.height = "Informe uma altura entre 120 e 230 cm.";
    if (!(p.weightKg >= 30 && p.weightKg <= 300)) errors.weight = "Informe um peso entre 30 e 300 kg.";
    if (!["lose", "maintain", "gain"].includes(p.goal)) errors.goal = "Escolha um objetivo.";
    return errors;
  }

  function emptyState() {
    return {
      version: VERSION,
      profile: { name: "", age: null, heightCm: null, weightKg: null, goal: "maintain", aiEnabled: false, aiChoice: "auto", onboardedAt: null },
      targets: null,
      days: {},
      weights: [],
      chat: [],
      createdAt: nowIso()
    };
  }

  function emptyDay() {
    return { meals: [], waterMl: 0, activities: [], weightKg: null };
  }

  function migrate(raw) {
    const base = emptyState();
    if (!raw || typeof raw !== "object") return base;
    const state = {
      ...base,
      ...raw,
      profile: { ...base.profile, ...(raw.profile || {}) },
      targets: raw.targets && typeof raw.targets === "object" ? raw.targets : null,
      days: raw.days && typeof raw.days === "object" ? raw.days : {},
      weights: Array.isArray(raw.weights) ? raw.weights : [],
      chat: Array.isArray(raw.chat) ? raw.chat.slice(-CHAT_MAX) : []
    };
    for (const key of Object.keys(state.days)) {
      state.days[key] = { ...emptyDay(), ...(state.days[key] || {}) };
      state.days[key].meals = Array.isArray(state.days[key].meals) ? state.days[key].meals : [];
      state.days[key].activities = Array.isArray(state.days[key].activities) ? state.days[key].activities : [];
      state.days[key].waterMl = Number(state.days[key].waterMl) || 0;
    }
    return state;
  }

  let state = null;
  let user = null;
  let currentView = "hoje";
  let saveTimer = null;
  let saving = false;
  let dirty = false;
  let chatBusy = false;
  let deleteArmed = 0;
  let editingMealId = null;
  let installPrompt = null;
  const waterUndo = [];

  class ApiError extends Error {
    constructor(kind, status, payload) {
      super(kind);
      this.kind = kind;
      this.status = status;
      this.payload = payload;
    }
  }

  async function safeJson(res) {
    try {
      return await res.json();
    } catch {
      return null;
    }
  }

  function loadSession() {
    try {
      return JSON.parse(localStorage.getItem(LS_SESSION) || "null");
    } catch {
      return null;
    }
  }

  function storeSession(session) {
    if (session) localStorage.setItem(LS_SESSION, JSON.stringify(session));
    else localStorage.removeItem(LS_SESSION);
  }

  function normalizeSession(payload) {
    const meta = payload?.user?.user_metadata || {};
    return {
      access_token: payload.access_token,
      refresh_token: payload.refresh_token,
      expires_at: Date.now() + (Number(payload.expires_in) || 3600) * 1000,
      user: {
        id: payload?.user?.id || "",
        email: payload?.user?.email || "",
        name: meta.full_name || meta.name || "",
        avatar: meta.avatar_url || ""
      }
    };
  }

  async function tokenRequest(grant, body) {
    const res = await fetch(`${SB}/auth/v1/token?grant_type=${grant}`, {
      method: "POST",
      headers: { apikey: KEY, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new ApiError("auth", res.status, await safeJson(res));
    return normalizeSession(await res.json());
  }

  async function ensureSession() {
    let session = loadSession();
    if (!session) return null;
    if (!session.expires_at || Date.now() > session.expires_at - 60_000) {
      if (!session.refresh_token) {
        storeSession(null);
        return null;
      }
      try {
        session = await tokenRequest("refresh_token", { refresh_token: session.refresh_token });
        storeSession(session);
      } catch {
        storeSession(null);
        return null;
      }
    }
    return session;
  }

  async function apiFetch(path, options = {}, retry = true) {
    const session = await ensureSession();
    if (!session) throw new ApiError("no_session", 401);
    const headers = { ...(options.headers || {}), apikey: KEY, Authorization: `Bearer ${session.access_token}` };
    const res = await fetch(SB + path, { ...options, headers });
    if (res.status === 401 && retry && session.refresh_token) {
      try {
        const fresh = await tokenRequest("refresh_token", { refresh_token: session.refresh_token });
        storeSession(fresh);
        return apiFetch(path, options, false);
      } catch {
        storeSession(null);
        throw new ApiError("no_session", 401);
      }
    }
    return res;
  }

  function b64url(bytes) {
    let s = "";
    for (const byte of bytes) s += String.fromCharCode(byte);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function randomVerifier() {
    const bytes = new Uint8Array(48);
    crypto.getRandomValues(bytes);
    return b64url(bytes);
  }

  async function pkceChallenge(verifier) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    return b64url(new Uint8Array(digest));
  }

  async function loadRemote() {
    const res = await apiFetch(`/rest/v1/viva_data?select=user_id,data,updated_at&user_id=eq.${user.id}`, {
      headers: { Accept: "application/json" }
    });
    if (!res.ok) throw new ApiError("load", res.status, await safeJson(res));
    const rows = await res.json();
    if (!Array.isArray(rows) || !rows.length) return null;
    return rows[0].data;
  }

  function setSync(status) {
    const el = $("#sync-status");
    if (!el) return;
    const labels = { saved: "Salvo", saving: "Salvando…", error: "Não salvou", offline: "Offline" };
    el.dataset.state = status;
    el.textContent = labels[status] || "Salvo";
  }

  async function saveNow() {
    if (!user || !state) return false;
    if (!navigator.onLine) {
      dirty = true;
      setSync("offline");
      return false;
    }
    clearTimeout(saveTimer);
    saving = true;
    setSync("saving");
    const payload = { ...state, updatedAt: nowIso() };
    try {
      const res = await apiFetch("/rest/v1/viva_data?on_conflict=user_id", {
        method: "POST",
        headers: { "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ user_id: user.id, data: payload })
      });
      if (!res.ok) throw new ApiError("save", res.status, await safeJson(res));
      state.updatedAt = payload.updatedAt;
      dirty = false;
      setSync("saved");
      return true;
    } catch (err) {
      dirty = true;
      setSync("error");
      if (err.status === 401) sessionLost();
      return false;
    } finally {
      saving = false;
    }
  }

  function queueSave(delay = SAVE_DELAY) {
    dirty = true;
    setSync(navigator.onLine ? "saving" : "offline");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, delay);
  }

  let toastTimer = null;
  function toast(message) {
    const el = $("#toast");
    el.textContent = message;
    el.dataset.show = "true";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.dataset.show = "false"; }, 2800);
  }

  const SCREENS = ["boot", "screen-config", "screen-login", "screen-onboarding", "screen-main"];
  function show(id) {
    for (const name of SCREENS) {
      const el = document.getElementById(name);
      if (el) el.hidden = name !== id;
    }
    window.scrollTo({ top: 0, behavior: "instant" });
  }

  function sessionLost() {
    storeSession(null);
    state = null;
    user = null;
    show("screen-login");
    toast("Sua sessão expirou. Entre de novo.");
  }

  async function startLogin() {
    const verifier = randomVerifier();
    const challenge = await pkceChallenge(verifier);
    const redirectTo = location.origin + location.pathname;
    sessionStorage.setItem(LS_PKCE, JSON.stringify({ verifier, redirectTo, at: Date.now() }));
    const params = new URLSearchParams({
      provider: "google",
      redirect_to: redirectTo,
      code_challenge: challenge,
      code_challenge_method: "s256"
    });
    location.assign(`${SB}/auth/v1/authorize?${params.toString()}`);
  }

  async function loginAnonymous() {
    const button = $("#btn-anon");
    const error = $("#auth-error");
    if (error) error.hidden = true;
    if (button) button.disabled = true;
    try {
      const res = await fetch(`${SB}/auth/v1/signup`, {
        method: "POST",
        headers: { apikey: KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ data: {}, gotrue_meta_security: {} })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const detail = data?.msg || data?.message || "";
        const message = /anonymous.*disabled/i.test(detail)
          ? "O modo visitante ainda não está ativado no servidor."
          : "Não foi possível entrar. Tente de novo.";
        if (error) { error.textContent = message; error.hidden = false; }
        else toast(message);
        return;
      }
      const session = normalizeSession(data);
      storeSession(session);
      user = session.user;
      show("boot");
      await enterApp();
    } catch {
      show("screen-login");
      const message = "Não foi possível entrar. Verifique a conexão.";
      if (error) { error.textContent = message; error.hidden = false; }
      else toast(message);
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function handleCallback() {
    const params = new URLSearchParams(location.search);
    const code = params.get("code");
    const error = params.get("error");
    if (!code && !error) return false;

    const stored = sessionStorage.getItem(LS_PKCE);
    sessionStorage.removeItem(LS_PKCE);
    history.replaceState({}, "", location.pathname + location.hash);

    if (error) {
      show("screen-login");
      toast(params.get("error_description") || "Login cancelado.");
      return true;
    }
    if (!stored) {
      show("screen-login");
      toast("Sessão de login expirada. Tente novamente.");
      return true;
    }
    try {
      const { verifier } = JSON.parse(stored);
      const session = await tokenRequest("pkce", { auth_code: code, code_verifier: verifier });
      storeSession(session);
      user = session.user;
      show("boot");
      await enterApp();
    } catch {
      show("screen-login");
      toast("Não foi possível concluir o login. Tente de novo.");
    }
    return true;
  }

  async function enterApp() {
    const data = await loadRemote();
    if (!data || !data.profile || !data.profile.onboardedAt) {
      state = migrate(data);
      prepareOnboarding();
      show("screen-onboarding");
      return;
    }
    state = migrate(data);
    if (!state.targets && state.profile.weightKg) state.targets = calcTargets(state.profile);
    showMain();
  }

  function showMain() {
    show("screen-main");
    setView(currentView || localStorage.getItem(LS_VIEW) || "hoje");
    renderAll();
    loadAIServerConfig().then(enableAIOnce);
  }

  function setView(view) {
    const names = ["hoje", "viva", "alimentacao", "atividades", "diario", "perfil"];
    currentView = names.includes(view) ? view : "hoje";
    localStorage.setItem(LS_VIEW, currentView);
    for (const panel of $$("[data-view-panel]")) panel.hidden = panel.dataset.viewPanel !== currentView;
    for (const btn of $$("[data-view]")) {
      if (btn.dataset.view === currentView) btn.setAttribute("aria-current", "page");
      else btn.removeAttribute("aria-current");
    }
    history.replaceState({}, "", `${location.pathname}${location.search}#${currentView}`);
    if (currentView === "diario") renderDiary();
    if (currentView === "perfil") renderProfile();
    if (currentView === "viva") renderChat();
    else document.body.classList.remove("chat-typing");
    if (currentView === "hoje" || currentView === "alimentacao" || currentView === "atividades") renderToday();
  }

  async function logout() {
    const session = loadSession();
    if (session) {
      try {
        await fetch(`${SB}/auth/v1/logout`, {
          method: "POST",
          headers: { apikey: KEY, Authorization: `Bearer ${session.access_token}` }
        });
      } catch { /* sair localmente mesmo sem rede */ }
    }
    if (user) clearAIKey();
    storeSession(null);
    state = null;
    user = null;
    show("screen-login");
  }

  function prepareOnboarding() {
    const form = $("#onb-form");
    if (form) form.reset();
    $("#onb-error").hidden = true;
    for (const id of ["onb-age", "onb-height", "onb-weight"]) $("#" + id).removeAttribute("aria-invalid");
    updateOnboardingPreview();
  }

  function readOnboarding() {
    return {
      name: $("#onb-name").value.trim().slice(0, 40),
      age: parseNum($("#onb-age").value),
      heightCm: parseNum($("#onb-height").value),
      weightKg: parseNum($("#onb-weight").value),
      goal: ($("input[name=goal]:checked") || {}).value || "maintain"
    };
  }

  function updateOnboardingPreview() {
    const p = readOnboarding();
    const valid = !Object.keys(validateProfile(p)).length;
    $("#onb-preview-kcal").textContent = valid ? nf(calcTargets(p).kcal) : "—";
    $("#onb-preview-protein").textContent = valid ? nf(calcTargets(p).protein) : "—";
    $("#onb-preview-water").textContent = valid ? nf1(calcTargets(p).waterMl / 1000) : "—";
    $("#onb-preview-bmi").textContent = valid ? nf1(bmi(p.weightKg, p.heightCm)) : "—";
  }

  function markFields(errors, map) {
    for (const [key, id] of Object.entries(map)) {
      const input = $("#" + id);
      if (!input) continue;
      if (errors[key]) input.setAttribute("aria-invalid", "true");
      else input.removeAttribute("aria-invalid");
    }
  }

  async function submitOnboarding(event) {
    event.preventDefault();
    const profile = readOnboarding();
    const errors = validateProfile(profile);
    markFields(errors, { age: "onb-age", height: "onb-height", weight: "onb-weight" });
    const errorBox = $("#onb-error");
    if (Object.keys(errors).length) {
      errorBox.textContent = Object.values(errors)[0];
      errorBox.hidden = false;
      return;
    }
    errorBox.hidden = true;
    const button = $("#onb-submit");
    button.disabled = true;
    button.textContent = "Salvando…";
    await loadAIServerConfig();
    state = emptyState();
    const aiEnabled = !!(AI_SERVER || loadAIKey());
    state.profile = { ...profile, aiEnabled, aiChoice: aiEnabled ? "on" : "auto", onboardedAt: nowIso() };
    state.targets = calcTargets(profile);
    state.weights = [{ date: ymd(), kg: profile.weightKg }];
    const ok = await saveNow();
    button.disabled = false;
    button.textContent = "Criar minhas metas";
    if (!ok) {
      errorBox.textContent = "Não consegui salvar agora. Verifique a conexão e tente de novo.";
      errorBox.hidden = false;
      return;
    }
    showMain();
    toast("Metas criadas. Bom começo!");
  }

  async function submitProfile(event) {
    event.preventDefault();
    const profile = {
      ...state.profile,
      name: $("#pf-name").value.trim().slice(0, 40),
      age: parseNum($("#pf-age").value),
      heightCm: parseNum($("#pf-height").value),
      weightKg: parseNum($("#pf-weight").value),
      goal: $("#pf-goal").value
    };
    if (AI_ENDPOINT && !AI_SERVER && !loadAIKey()) await loadAIServerConfig();
    profile.aiEnabled = $("#pf-ai").checked && (!AI_ENDPOINT || !!AI_SERVER || !!loadAIKey());
    profile.aiChoice = profile.aiEnabled ? "on" : "off";
    const errors = validateProfile(profile);
    markFields(errors, { age: "pf-age", height: "pf-height", weight: "pf-weight" });
    const errorBox = $("#profile-error");
    if (Object.keys(errors).length) {
      errorBox.textContent = Object.values(errors)[0];
      errorBox.hidden = false;
      return;
    }
    errorBox.hidden = true;
    const previousWeight = state.profile.weightKg;
    state.profile = profile;
    state.targets = calcTargets(profile);
    if (profile.weightKg !== previousWeight) recordWeight(profile.weightKg);
    renderAll();
    const ok = await saveNow();
    toast(ok ? "Metas recalculadas." : "Não consegui salvar. Tente de novo.");
  }

  function uid() {
    return crypto.randomUUID ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function dayData(key = ymd()) {
    if (!state.days[key]) state.days[key] = emptyDay();
    return state.days[key];
  }

  function dayTotals(key = ymd()) {
    const d = dayData(key);
    const totals = { kcal: 0, protein: 0, carbs: 0, fat: 0, burned: 0 };
    for (const meal of d.meals) {
      totals.kcal += Number(meal.kcal) || 0;
      totals.protein += Number(meal.p) || 0;
      totals.carbs += Number(meal.c) || 0;
      totals.fat += Number(meal.f) || 0;
    }
    for (const act of d.activities) totals.burned += Number(act.kcal) || 0;
    return totals;
  }

  function addWater(ml) {
    const d = dayData();
    d.waterMl = Math.max(0, (Number(d.waterMl) || 0) + ml);
    waterUndo.push(ml);
    queueSave();
    renderToday();
  }

  function undoWater() {
    const last = waterUndo.pop();
    if (last == null) {
      toast("Nada para desfazer.");
      return;
    }
    const d = dayData();
    d.waterMl = Math.max(0, (Number(d.waterMl) || 0) - last);
    queueSave();
    renderToday();
  }

  function addMeal(items, label) {
    const totals = items.reduce((acc, item) => ({
      kcal: acc.kcal + item.kcal,
      p: acc.p + item.p,
      c: acc.c + item.c,
      f: acc.f + item.f
    }), { kcal: 0, p: 0, c: 0, f: 0 });
    const meal = {
      id: uid(),
      at: nowIso(),
      label,
      items,
      kcal: round(totals.kcal),
      p: +totals.p.toFixed(1),
      c: +totals.c.toFixed(1),
      f: +totals.f.toFixed(1)
    };
    dayData().meals.push(meal);
    queueSave();
    renderToday();
    return meal;
  }

  function addActivity(activity) {
    const entry = { id: uid(), at: nowIso(), ...activity, kcal: round(activity.kcal) };
    dayData().activities.push(entry);
    queueSave();
    renderToday();
    return entry;
  }

  function recordWeight(kg) {
    state.weights = state.weights.filter((w) => w.date !== ymd());
    state.weights.push({ date: ymd(), kg });
    state.weights.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    state.weights = state.weights.slice(-400);
    queueSave();
    renderToday();
    renderDiary();
  }

  function latestWeight() {
    const list = state.weights || [];
    return list.length ? Number(list[list.length - 1].kg) : Number(state.profile.weightKg) || null;
  }

  // Valores por 100 g. Fontes: TACO 4ª ed. (NEPA/UNICAMP) e USDA FoodData Central. "src" e "ref" identificam a origem.
  const FOODS = [
    { id: "arroz-branco", name: "Arroz branco cozido", aliases: ["arroz", "arroz branco"], portion: 100, kcal: 128.3, p: 2.5, c: 28.1, f: 0.2, src: "TACO", ref: "3" },
    { id: "arroz-integral", name: "Arroz integral cozido", aliases: ["arroz integral"], portion: 100, kcal: 123.5, p: 2.6, c: 25.8, f: 1, src: "TACO", ref: "1" },
    { id: "feijao-carioca", name: "Feijão carioca cozido", aliases: ["feijao", "feijão"], portion: 100, kcal: 76.4, p: 4.8, c: 13.6, f: 0.5, src: "TACO", ref: "561" },
    { id: "feijao-preto", name: "Feijão preto cozido", aliases: ["feijao preto"], portion: 100, kcal: 77, p: 4.5, c: 14, f: 0.5, src: "TACO", ref: "567" },
    { id: "macarrao", name: "Macarrão cozido", aliases: ["macarrao", "massa"], portion: 100, kcal: 158, p: 5.8, c: 30.9, f: 0.9, src: "USDA", ref: "169737" },
    { id: "pao-frances", name: "Pão francês", aliases: ["pao", "pão", "pao frances"], portion: 50, kcal: 299.8, p: 8, c: 58.6, f: 3.1, src: "TACO", ref: "53" },
    { id: "pao-integral", name: "Pão de forma integral", aliases: ["pao integral", "pao de forma", "pao de forma integral"], portion: 25, kcal: 253.2, p: 9.4, c: 49.9, f: 3.7, src: "TACO", ref: "52" },
    { id: "tapioca", name: "Tapioca com manteiga", aliases: ["tapioca", "goma de tapioca", "tapioca com manteiga"], portion: 60, kcal: 347.8, p: 0.1, c: 63.6, f: 10.9, src: "TACO", ref: "551" },
    { id: "cuscuz", name: "Cuscuz de milho cozido", aliases: ["cuscuz"], portion: 100, kcal: 113.5, p: 2.2, c: 25.3, f: 0.7, src: "TACO", ref: "533" },
    { id: "aveia", name: "Aveia em flocos", aliases: ["aveia"], portion: 30, kcal: 393.8, p: 13.9, c: 66.6, f: 8.5, src: "TACO", ref: "7" },
    { id: "granola", name: "Granola", aliases: ["granola"], portion: 30, kcal: 489, p: 13.7, c: 53.9, f: 24.3, src: "USDA", ref: "171646" },
    { id: "batata-doce", name: "Batata-doce cozida", aliases: ["batata doce"], portion: 100, kcal: 76.8, p: 0.6, c: 18.4, f: 0.1, src: "TACO", ref: "88" },
    { id: "batata", name: "Batata cozida", aliases: ["batata", "batata inglesa"], portion: 100, kcal: 51.6, p: 1.2, c: 11.9, f: 0, src: "TACO", ref: "91" },
    { id: "mandioca", name: "Mandioca cozida", aliases: ["mandioca", "aipim"], portion: 100, kcal: 125.4, p: 0.6, c: 30.1, f: 0.3, src: "TACO", ref: "129" },
    { id: "pure", name: "Purê de batata", aliases: ["pure", "purê"], portion: 100, kcal: 113, p: 1.9, c: 16.8, f: 4.2, src: "USDA", ref: "168555" },
    { id: "farofa", name: "Farofa de mandioca", aliases: ["farofa", "farofa de mandioca"], portion: 50, kcal: 405.7, p: 2.1, c: 80.3, f: 9.1, src: "TACO", ref: "131" },
    { id: "ovo-cozido", name: "Ovo cozido", aliases: ["ovo", "ovos", "ovo cozido", "ovo de galinha"], portion: 50, kcal: 145.7, p: 13.3, c: 0.6, f: 9.5, src: "TACO", ref: "488" },
    { id: "ovo-frito", name: "Ovo frito", aliases: ["ovo frito"], portion: 50, kcal: 240.2, p: 15.6, c: 1.2, f: 18.6, src: "TACO", ref: "490" },
    { id: "frango-peito", name: "Frango grelhado", aliases: ["frango", "peito de frango", "file de frango"], portion: 100, kcal: 159.2, p: 32, c: 0, f: 2.5, src: "TACO", ref: "410" },
    { id: "frango-coxa", name: "Frango assado (sobrecoxa sem pele)", aliases: ["coxa de frango", "sobrecoxa", "frango assado"], portion: 100, kcal: 232.9, p: 29.2, c: 0, f: 12, src: "TACO", ref: "413" },
    { id: "patinho", name: "Carne bovina grelhada", aliases: ["carne", "bife", "patinho"], portion: 100, kcal: 219.3, p: 35.9, c: 0, f: 7.3, src: "TACO", ref: "377" },
    { id: "acem", name: "Acém cozido", aliases: ["acem", "acém", "carne cozida"], portion: 100, kcal: 212.4, p: 26.7, c: 0, f: 10.9, src: "TACO", ref: "326" },
    { id: "lombo", name: "Lombo suíno", aliases: ["lombo", "carne de porco", "porco"], portion: 100, kcal: 210.2, p: 35.7, c: 0, f: 6.4, src: "TACO", ref: "432" },
    { id: "tilapia", name: "Tilápia grelhada", aliases: ["tilapia", "peixe"], portion: 100, kcal: 128, p: 26.1, c: 0, f: 2.6, src: "USDA", ref: "175177" },
    { id: "salmao", name: "Salmão grelhado", aliases: ["salmao"], portion: 100, kcal: 242.7, p: 26.1, c: 0, f: 14.5, src: "TACO", ref: "317" },
    { id: "atum", name: "Atum em água", aliases: ["atum"], portion: 100, kcal: 116, p: 25.5, c: 0, f: 0.8, src: "USDA", ref: "171986" },
    { id: "sardinha", name: "Sardinha em óleo", aliases: ["sardinha", "sardinha em óleo"], portion: 100, kcal: 285, p: 15.9, c: 0, f: 24, src: "TACO", ref: "319" },
    { id: "camarao", name: "Camarão cozido", aliases: ["camarao", "camaroes"], portion: 100, unitGrams: 10, kcal: 90, p: 19, c: 0, f: 1, src: "TACO", ref: "284" },
    { id: "linguica", name: "Linguiça de porco grelhada", aliases: ["linguica", "linguiça", "linguiça de porco"], portion: 50, kcal: 296.5, p: 23.2, c: 0, f: 21.9, src: "TACO", ref: "423" },
    { id: "presunto", name: "Presunto", aliases: ["presunto"], portion: 30, kcal: 93.7, p: 14.3, c: 2.1, f: 2.7, src: "TACO", ref: "439" },
    { id: "queijo-mucarela", name: "Queijo muçarela", aliases: ["queijo", "mucarela", "mussarela", "queijo mucarela"], portion: 30, kcal: 329.9, p: 22.6, c: 3, f: 25.2, src: "TACO", ref: "463" },
    { id: "queijo-minas", name: "Queijo minas", aliases: ["queijo minas", "queijo frescal"], portion: 30, kcal: 264.3, p: 17.4, c: 3.2, f: 20.2, src: "TACO", ref: "461" },
    { id: "requeijao", name: "Requeijão", aliases: ["requeijao", "catupiry"], portion: 30, kcal: 256.6, p: 9.6, c: 2.4, f: 23.4, src: "TACO", ref: "468" },
    { id: "iogurte", name: "Iogurte natural", aliases: ["iogurte", "iogurte natural"], portion: 170, kcal: 51.5, p: 4.1, c: 1.9, f: 3, src: "TACO", ref: "448" },
    { id: "iogurte-grego", name: "Iogurte grego zero", aliases: ["iogurte grego", "iogurtes grego", "iogurte grego zero"], portion: 170, unitGrams: 90, kcal: 59, p: 10.2, c: 3.6, f: 0.4, src: "USDA", ref: "170894" },
    { id: "leite", name: "Leite integral", aliases: ["leite", "leite integral"], portion: 200, kcal: 61, p: 3.1, c: 4.8, f: 3.2, src: "USDA", ref: "171265" },
    { id: "leite-desnatado", name: "Leite desnatado", aliases: ["leite desnatado"], portion: 200, kcal: 34, p: 3.4, c: 5, f: 0.1, src: "USDA", ref: "171269" },
    { id: "leite-aveia", name: "Leite de aveia", aliases: ["leite de aveia"], portion: 200, kcal: 45, p: 0.7, c: 5.4, f: 2.3, src: "USDA", ref: "2705412" },
    { id: "whey", name: "Whey protein", aliases: ["whey", "whey protein"], portion: 30, kcal: 352, p: 78.1, c: 6.2, f: 1.6, src: "USDA", ref: "173180" },
    { id: "banana", name: "Banana", aliases: ["banana", "banana prata"], portion: 70, kcal: 98.2, p: 1.3, c: 26, f: 0.1, src: "TACO", ref: "182" },
    { id: "maca", name: "Maçã", aliases: ["maca", "maçã"], portion: 130, kcal: 55.5, p: 0.3, c: 15.2, f: 0, src: "TACO", ref: "222" },
    { id: "laranja", name: "Laranja", aliases: ["laranja"], portion: 130, kcal: 36.8, p: 1, c: 8.9, f: 0.1, src: "TACO", ref: "214" },
    { id: "mamao", name: "Mamão", aliases: ["mamao"], portion: 150, kcal: 45.3, p: 0.8, c: 11.6, f: 0.1, src: "TACO", ref: "225" },
    { id: "manga", name: "Manga", aliases: ["manga"], portion: 130, kcal: 72.5, p: 0.4, c: 19.4, f: 0.2, src: "TACO", ref: "229" },
    { id: "melancia", name: "Melancia", aliases: ["melancia"], portion: 200, kcal: 32.6, p: 0.9, c: 8.1, f: 0, src: "TACO", ref: "235" },
    { id: "uva", name: "Uva", aliases: ["uva"], portion: 100, kcal: 52.9, p: 0.7, c: 13.6, f: 0.2, src: "TACO", ref: "256" },
    { id: "morango", name: "Morango", aliases: ["morango"], portion: 100, kcal: 30.1, p: 0.9, c: 6.8, f: 0.3, src: "TACO", ref: "239" },
    { id: "abacaxi", name: "Abacaxi", aliases: ["abacaxi"], portion: 100, kcal: 48.3, p: 0.9, c: 12.3, f: 0.1, src: "TACO", ref: "164" },
    { id: "abacate", name: "Abacate", aliases: ["abacate"], portion: 100, kcal: 96.2, p: 1.2, c: 6, f: 8.4, src: "TACO", ref: "163" },
    { id: "pera", name: "Pera", aliases: ["pera"], portion: 130, kcal: 57, p: 0.4, c: 15.2, f: 0.1, src: "USDA", ref: "169118" },
    { id: "salada", name: "Alface crespa", aliases: ["salada", "salada de folhas", "alface"], portion: 50, kcal: 10.7, p: 1.3, c: 1.7, f: 0.2, src: "TACO", ref: "78" },
    { id: "tomate", name: "Tomate", aliases: ["tomate"], portion: 100, kcal: 15.3, p: 1.1, c: 3.1, f: 0.2, src: "TACO", ref: "157" },
    { id: "cenoura", name: "Cenoura", aliases: ["cenoura"], portion: 100, kcal: 34.1, p: 1.3, c: 7.7, f: 0.2, src: "TACO", ref: "110" },
    { id: "brocolis", name: "Brócolis", aliases: ["brocolis"], portion: 100, kcal: 24.6, p: 2.1, c: 4.4, f: 0.5, src: "TACO", ref: "100" },
    { id: "abobrinha", name: "Abobrinha", aliases: ["abobrinha"], portion: 100, kcal: 15, p: 1.1, c: 3, f: 0.2, src: "TACO", ref: "70" },
    { id: "cafe", name: "Café sem açúcar", aliases: ["cafe", "café", "café sem açúcar"], portion: 50, kcal: 9.1, p: 0.7, c: 1.5, f: 0.1, src: "TACO", ref: "471" },
    { id: "suco-laranja", name: "Suco de laranja", aliases: ["suco", "suco de laranja"], portion: 200, kcal: 32.7, p: 0.7, c: 7.6, f: 0.1, src: "TACO", ref: "215" },
    { id: "refrigerante", name: "Refrigerante", aliases: ["refrigerante", "coca", "coca-cola"], portion: 350, kcal: 33.5, p: 0, c: 8.7, f: 0, src: "TACO", ref: "480" },
    { id: "agua-coco", name: "Água de coco", aliases: ["agua de coco", "água de coco"], portion: 200, kcal: 21.5, p: 0, c: 5.3, f: 0, src: "TACO", ref: "478" },
    { id: "azeite", name: "Azeite de oliva", aliases: ["azeite", "azeite de oliva"], portion: 10, kcal: 884, p: 0, c: 0, f: 100, src: "TACO", ref: "260" },
    { id: "manteiga", name: "Manteiga", aliases: ["manteiga"], portion: 10, kcal: 726, p: 0.4, c: 0.1, f: 82.4, src: "TACO", ref: "261" },
    { id: "margarina", name: "Margarina com sal", aliases: ["margarina"], portion: 10, kcal: 596.1, p: 0, c: 0, f: 67.4, src: "TACO", ref: "263" },
    { id: "creme-leite", name: "Creme de leite", aliases: ["creme de leite"], portion: 15, kcal: 221.5, p: 1.5, c: 4.5, f: 22.5, src: "TACO", ref: "447" },
    { id: "chocolate", name: "Chocolate ao leite", aliases: ["chocolate"], portion: 25, kcal: 539.6, p: 7.2, c: 59.6, f: 30.3, src: "TACO", ref: "495" },
    { id: "bolo", name: "Bolo de chocolate", aliases: ["bolo"], portion: 60, kcal: 410, p: 6.2, c: 54.7, f: 18.5, src: "TACO", ref: "16" },
    { id: "sorvete", name: "Sorvete de baunilha", aliases: ["sorvete", "sorvete de baunilha"], portion: 60, kcal: 207, p: 3.5, c: 23.6, f: 11, src: "USDA", ref: "167575" },
    { id: "biscoito", name: "Biscoito recheado", aliases: ["biscoito", "bolacha"], portion: 30, kcal: 471.8, p: 6.4, c: 70.5, f: 19.6, src: "TACO", ref: "9" },
    { id: "pao-queijo", name: "Pão de queijo", aliases: ["pao de queijo"], portion: 40, kcal: 363.1, p: 5.1, c: 34.2, f: 24.6, src: "TACO", ref: "140" },
    { id: "coxinha", name: "Coxinha", aliases: ["coxinha", "salgado"], portion: 80, kcal: 283, p: 9.6, c: 34.5, f: 11.8, src: "TACO", ref: "386" },
    { id: "pizza", name: "Pizza de muçarela", aliases: ["pizza", "pizza de muçarela", "pizza de mussarela"], portion: 100, kcal: 266, p: 11.4, c: 33.3, f: 9.7, src: "USDA", ref: "2708616" },
    { id: "hamburguer", name: "Hambúrguer bovino grelhado", aliases: ["hamburguer", "hambúrguer", "hambúrguer bovino"], portion: 120, kcal: 209.8, p: 13.2, c: 11.3, f: 12.4, src: "TACO", ref: "417" },
    { id: "sanduiche", name: "Sanduíche de frango grelhado", aliases: ["sanduiche", "sanduíche", "sanduíche de frango"], portion: 150, kcal: 226, p: 21.5, c: 19.4, f: 6.2, src: "USDA", ref: "2707005" },
    { id: "sopa", name: "Sopa de legumes", aliases: ["sopa", "sopa de legumes"], portion: 300, kcal: 27, p: 0.8, c: 5.1, f: 0.5, src: "USDA", ref: "2710113" },
    { id: "sushi", name: "Sushi de salmão", aliases: ["sushi", "sushi de salmão"], portion: 30, kcal: 103, p: 6.9, c: 15.3, f: 1.3, src: "USDA", ref: "2708963" },
    { id: "amendoim", name: "Amendoim torrado", aliases: ["amendoim", "amendoim torrado"], portion: 30, kcal: 605.8, p: 22.5, c: 18.7, f: 54, src: "TACO", ref: "558" },
    { id: "castanha-caju", name: "Castanha de caju", aliases: ["castanha", "castanha de caju"], portion: 30, kcal: 570.2, p: 18.5, c: 29.1, f: 46.3, src: "TACO", ref: "588" },
    { id: "castanha-para", name: "Castanha-do-pará", aliases: ["castanha do para", "castanha-do-pará", "castanha do brasil"], portion: 20, kcal: 643, p: 14.5, c: 15.1, f: 63.5, src: "TACO", ref: "589" },
    { id: "pasta-amendoim", name: "Pasta de amendoim", aliases: ["pasta de amendoim"], portion: 20, kcal: 598, p: 22.2, c: 22.3, f: 51.4, src: "USDA", ref: "174266" },
    { id: "barra-cereal", name: "Barra de cereal", aliases: ["barra de cereal", "barra"], portion: 25, kcal: 471, p: 10.1, c: 64.4, f: 19.8, src: "USDA", ref: "167542" },
    { id: "pipoca", name: "Pipoca", aliases: ["pipoca"], portion: 30, kcal: 448.3, p: 9.9, c: 70.3, f: 15.9, src: "TACO", ref: "61" },
    { id: "salgadinho", name: "Salgadinho de milho", aliases: ["salgadinho", "chips", "salgadinho de milho"], portion: 30, kcal: 539, p: 6.2, c: 57.3, f: 33.4, src: "USDA", ref: "167537" },
    { id: "acai", name: "Açaí (polpa)", aliases: ["acai", "açaí", "polpa de açaí"], portion: 200, kcal: 58, p: 0.8, c: 6.2, f: 3.9, src: "TACO", ref: "168" },
    { id: "doce-leite", name: "Doce de leite", aliases: ["doce de leite", "doce de leite cremoso"], portion: 30, kcal: 306.3, p: 5.5, c: 59.5, f: 6, src: "TACO", ref: "501" },
  ];

  // Preparações compostas: estimativas para pratos prontos, fora da base oficial.
  const DISHES = [
    { id: "contra-file", name: "Contra filé grelhado", aliases: ["contra file", "contra-file", "contrafile", "contra file com gordura"], portion: 100, kcal: 194, p: 32.4, c: 0, f: 7.3, src: "Estimativa TACO/USDA", ref: "composição" },
    { id: "camarao-empanado", name: "Camarão empanado com catupiry", aliases: ["camarao empanado com catupiry", "camaroes empanados com catupiry", "camarao empanado", "camaroes empanados"], portion: 15, unitGrams: 15, kcal: 280, p: 12, c: 20, f: 17, src: "Estimativa TACO/USDA", ref: "composição" },
    { id: "risoto", name: "Risoto de arroz com camarão", aliases: ["risoto de arroz com camarao", "risoto de arroz com camaroes", "risoto de arroz", "risoto"], portion: 100, kcal: 145, p: 5, c: 21, f: 4, src: "Estimativa TACO/USDA", ref: "composição" }
  ];

  // Preços médios estimados por 100 g (nov/2026). Variam por região e mercado.
  const MARKET = [
    { id: "feijao", foodId: "feijao-carioca", label: "Feijão carioca", price: 0.8, maxPerDay: 200 },
    { id: "frango", foodId: "frango-peito", label: "Peito de frango", price: 2, maxPerDay: 250 },
    { id: "ovos", foodId: "ovo-cozido", label: "Ovos", price: 1.2, maxPerDay: 200, unit: "ovos", gramsPerUnit: 50 },
    { id: "leite", foodId: "leite", label: "Leite integral", price: 0.5, maxPerDay: 300, unit: "L", gramsPerUnit: 1000 },
    { id: "iogurte", foodId: "iogurte", label: "Iogurte natural", price: 1.2, maxPerDay: 200 },
    { id: "queijo", foodId: "queijo-minas", label: "Queijo minas", price: 6, maxPerDay: 50 },
    { id: "whey", foodId: "whey", label: "Whey protein", price: 13.33, maxPerDay: 50 },
    { id: "arroz", foodId: "arroz-branco", label: "Arroz branco", price: 0.5, maxPerDay: 500 },
    { id: "aveia", foodId: "aveia", label: "Aveia", price: 2, maxPerDay: 100 },
    { id: "pao", foodId: "pao-integral", label: "Pão integral", price: 2.4, maxPerDay: 150 },
    { id: "macarrao", foodId: "macarrao", label: "Macarrão", price: 1, maxPerDay: 150 },
    { id: "tapioca", foodId: "tapioca", label: "Tapioca", price: 1, maxPerDay: 150 },
    { id: "batata-doce", foodId: "batata-doce", label: "Batata-doce", price: 0.5, maxPerDay: 300 },
    { id: "banana", foodId: "banana", label: "Banana", price: 0.6, maxPerDay: 200 },
    { id: "tomate", foodId: "tomate", label: "Tomate", price: 0.7, maxPerDay: 200 },
    { id: "cenoura", foodId: "cenoura", label: "Cenoura", price: 0.5, maxPerDay: 200 },
    { id: "salada", foodId: "salada", label: "Alface", price: 1, maxPerDay: 100, unit: "un", gramsPerUnit: 300 },
    { id: "azeite", foodId: "azeite", label: "Azeite", price: 7, maxPerDay: 30, unit: "ml", gramsPerUnit: 1 },
    { id: "amendoim", foodId: "amendoim", label: "Amendoim", price: 2.4, maxPerDay: 30 }
  ];

  const MARKET_INDEX = new Map(MARKET.map((item) => [item.id, item]));
  const MARKET_SEEDS = [
    { id: "feijao", gramsPerDay: 100 },
    { id: "banana", gramsPerDay: 100 },
    { id: "tomate", gramsPerDay: 100 },
    { id: "cenoura", gramsPerDay: 100 },
    { id: "salada", gramsPerDay: 50 },
    { id: "azeite", gramsPerDay: 10 }
  ];

  function marketFood(item) {
    return FOODS.find((food) => food.id === item.foodId) || null;
  }

  function marketQty(item, grams) {
    if (item.unit === "ovos") return `${Math.max(1, Math.round(grams / (item.gramsPerUnit || 50)))} ovos`;
    if (item.unit === "L") return `${nf1(grams / 1000)} L`;
    if (item.unit === "ml") return `${nf(grams)} ml`;
    if (item.unit === "un") return `${Math.max(1, nf1(grams / (item.gramsPerUnit || 1)))} un`;
    return grams >= 1000 ? `${nf1(grams / 1000)} kg` : `${nf(grams)} g`;
  }

  const NUMBER_WORDS = { um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10, meio: 0.5, meia: 0.5 };
  const FOOD_INDEX = [...FOODS, ...DISHES].map((food) => ({
    food,
    aliases: Array.from(new Set([food.name, ...food.aliases])).map(normalize)
  }));

  function isQuantityPrefix(prefix) {
    let rest = prefix.trim();
    if (!rest) return true;
    const amount = rest.match(new RegExp(`^${AMOUNT_TOKEN}\\s*(.*)$`));
    if (amount) rest = amount[2].trim();
    for (const unit of UNKNOWN_UNITS) {
      const match = rest.match(unit.re);
      if (!match) continue;
      rest = rest.slice(match[0].length).trim();
      break;
    }
    rest = rest.replace(/^(?:de|do|da|dos|das)\b\s*/, "").trim();
    return !rest;
  }

  function isFoodPrefix(prefix) {
    return isQuantityPrefix(prefix) || /(?:^|[\s,;+])(?:com|e|mais)\s+/.test(prefix);
  }

  function findFoodHits(text) {
    const hits = [];
    for (const entry of FOOD_INDEX) {
      for (const alias of entry.aliases) {
        let from = 0;
        let index = text.indexOf(alias, from);
        while (index !== -1) {
          const before = index === 0 ? " " : text[index - 1];
          let end = index + alias.length;
          const after = text[end] || " ";
          const plural = after === "s" && !alias.endsWith("s") && !/[a-z0-9]/.test(text[end + 1] || " ");
          if (plural) end += 1;
          if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(text[end] || " ")) {
            hits.push({ food: entry.food, index, end });
          }
          from = index + 1;
          index = text.indexOf(alias, from);
        }
      }
    }
    hits.sort((a, b) => a.index - b.index || (b.end - b.index) - (a.end - a.index));
    const chosen = [];
    for (const hit of hits) {
      if (!isFoodPrefix(text.slice(0, hit.index))) continue;
      if (chosen.some((c) => hit.index < c.end && c.index < hit.end)) continue;
      chosen.push(hit);
    }
    return chosen;
  }

  const FOOD_ONLY_FILLER = /\b(?:de|do|da|dos|das|com|e|mais|em|no|na|ao|a|um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez|meio|meia|g|grama|gramas|ml|mililitro|mililitros|l|litro|litros|colher|colheres|sopa|cha|copo|copos|xicara|xicaras|fatia|fatias|unidade|unidades|porcao|porcoes|prato|pratos|concha|conchas|scoop|scoops|barra|barras|lata|latas|pacote|pacotes|pote|potes|garrafa|garrafas|conserva|oleo|agua|natural|fresco|fresca|frito|frita|cozido|cozida|grelhado|grelhada|assado|assada|grande|grandes|pequeno|pequena|pequenos|pequenas|pate|pasta|molho)\b/g;

  function isFoodOnly(text) {
    const norm = normalize(text);
    const hits = findFoodHits(norm);
    if (!hits.length) return false;
    let rest = norm;
    for (const hit of [...hits].sort((a, b) => b.index - a.index)) {
      rest = `${rest.slice(0, hit.index)} ${rest.slice(hit.end)}`;
    }
    rest = rest.replace(/\b\d+(?:[.,]\d+)?\b/g, " ").replace(FOOD_ONLY_FILLER, " ").replace(/[^a-z]+/g, " ").trim();
    return !rest;
  }

  const AMOUNT_TOKEN = "(\\d+(?:[.,]\\d+)?|um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez|meio|meia)";

  function amountValue(token) {
    return NUMBER_WORDS[token] ?? parseNum(token);
  }

  const QUANTITY_UNITS = [
    { re: new RegExp(`${AMOUNT_TOKEN}\\s*colher(?:es)?\\s+de\\s+sopa\\s+(?:de\\s+)?$`), grams: 15 },
    { re: new RegExp(`${AMOUNT_TOKEN}\\s*colher(?:es)?\\s+de\\s+cha\\s+(?:de\\s+)?$`), grams: 5 },
    { re: new RegExp(`${AMOUNT_TOKEN}\\s*colher(?:es)?\\s+(?:de\\s+)?$`), grams: 15 },
    { re: new RegExp(`${AMOUNT_TOKEN}\\s*(?:copos?)\\s+(?:de\\s+)?$`), grams: 250 },
    { re: new RegExp(`${AMOUNT_TOKEN}\\s*(?:xicaras?)\\s+(?:de\\s+)?$`), grams: 200 },
    { re: new RegExp(`${AMOUNT_TOKEN}\\s*(?:fatias?)\\s+(?:de\\s+)?$`), grams: 30 },
    { re: new RegExp(`${AMOUNT_TOKEN}\\s*(?:gramas?|g)\\s+(?:de\\s+)?$`), grams: 1 },
    { re: new RegExp(`${AMOUNT_TOKEN}\\s*(?:ml|mililitros?)\\s+(?:de\\s+)?$`), grams: 1 },
    { re: new RegExp(`${AMOUNT_TOKEN}\\s*(?:litros?|l)\\s+(?:de\\s+)?$`), grams: 1000 },
    { re: new RegExp(`${AMOUNT_TOKEN}\\s*(?:unidades?|porcoes?|porções?)\\s+(?:de\\s+)?$`), portion: true }
  ];

  function quantityBefore(text, index, food) {
    const window = text.slice(Math.max(0, index - 40), index);
    for (const unit of QUANTITY_UNITS) {
      const match = window.match(unit.re);
      if (!match) continue;
      const qty = amountValue(match[1]);
      if (!Number.isFinite(qty)) continue;
      return unit.portion ? qty * food.portion : qty * unit.grams;
    }
    const amount = window.match(new RegExp(`${AMOUNT_TOKEN}\\s*(?:de\\s+)?$`));
    if (amount) {
      const qty = amountValue(amount[1]);
      if (Number.isFinite(qty)) return qty * (food.unitGrams || food.portion);
    }
    return food.unitGrams || food.portion;
  }

  function detectMealLabel(text) {
    if (/cafe da manha|manha/.test(text)) return "Café da manhã";
    if (/almoco/.test(text)) return "Almoço";
    if (/jantar|janta/.test(text)) return "Jantar";
    if (/lanche|merenda/.test(text)) return "Lanche";
    const hour = new Date().getHours();
    if (hour < 11) return "Café da manhã";
    if (hour < 15) return "Almoço";
    if (hour < 18) return "Lanche";
    return "Jantar";
  }

  const MEAL_SEPARATOR = /\s*(?:,|;|\+|\be\b|\bmais\b)\s*/;
  const UNKNOWN_UNITS = [
    { re: /^colher(?:es)?\s+de\s+sopa\b/, grams: 15 },
    { re: /^colher(?:es)?\s+de\s+cha\b/, grams: 5 },
    { re: /^colher(?:es)?\b/, grams: 15 },
    { re: /^copos?\b/, grams: 250 },
    { re: /^xicaras?\b/, grams: 200 },
    { re: /^fatias?\b/, grams: 30 },
    { re: /^(?:gramas?|g)\b/, grams: 1 },
    { re: /^(?:ml|mililitros?)\b/, grams: 1 },
    { re: /^(?:litros?|l)\b/, grams: 1000 },
    { re: /^pratos?\b/, grams: 300 },
    { re: /^conchas?\b/, grams: 100 },
    { re: /^scoops?\b/, grams: 30 },
    { re: /^barras?\b/, grams: 25 },
    { re: /^latas?\b/, grams: 350 },
    { re: /^pacotes?\b/, grams: 100 },
    { re: /^potes?\b/, grams: 170 },
    { re: /^(?:unidades?|porcoes|porcao|doses?)\b/, grams: null }
  ];

  function maskUnits(text) {
    return text.replace(/\bcolher(?:es)?\s+de\s+(?:sopa|cha)\b/g, (unit) => " ".repeat(unit.length));
  }

  function mealSegments(text) {
    const norm = normalize(text)
      .replace(/\b(?:no|na)\s+(?:cafe da manha|almoco|jantar|lanche)\b/g, " ")
      .replace(/^(?:(?:hoje|agora|comi|almocei|jantei|tomei|lanchei|merendei)\s+)+/, "")
      .replace(/\s+/g, " ")
      .trim();
    return norm.split(MEAL_SEPARATOR).map((part) => part.trim()).filter((part) => part.length > 1);
  }

  const IRREGULAR_PLURALS = {
    paes: "pao", feijoes: "feijao", ovos: "ovo", leites: "leite", carnes: "carne",
    nozes: "noz", hamburgueres: "hamburguer", sanduiches: "sanduiche", mcdonalds: "mcdonalds"
  };
  const FOOD_QUERY_ALIASES = {
    bigmac: "big mac",
    "big-mac": "big mac",
    "mc donalds": "mcdonalds"
  };
  const FOOD_STOPWORDS = new Set([
    "por favor", "obrigado", "obrigada", "valeu", "ok", "beleza", "certo", "ta",
    "hoje", "agora", "no almoco", "no jantar", "no cafe da manha", "de manha", "a tarde", "a noite"
  ]);

  function canonicalFoodName(value) {
    let text = normalize(value)
      .replace(/[.,]/g, " ")
      .replace(/^(?:comi|almocei|jantei|tomei|lanchei|merendei|quero|queria|gostaria|anota|adiciona|registra)\s+/, "")
      .replace(/\b(?:por favor|obrigado|obrigada|valeu|ok|beleza|certo|ta|hoje|agora|no almoco|no jantar|no cafe da manha|de manha|a tarde|a noite)\b/g, " ")
      .replace(/\b(?:um pouco de|um pouco|mais ou menos)\b/g, " ")
      .replace(/\s+\d+(?:[.,]\d+)?\s*(?:g|gramas?|ml)\s*$/, "")
      .replace(/\s+/g, " ")
      .trim();
    text = text.replace(/^(?:de|do|da|dos|das|com)\s+/, "").replace(/\s+(?:de|do|da|dos|das|com)$/, "").trim();
    text = text.replace(/\b([a-z]{3,})s\b/g, (word) => IRREGULAR_PLURALS[word] || word.slice(0, -1));
    text = FOOD_QUERY_ALIASES[text] || text;
    return FOOD_STOPWORDS.has(text) ? "" : text;
  }

  function parseUnknownSegment(segment) {
    let rest = segment.trim();
    let qty = 1;
    const amount = rest.match(new RegExp(`^${AMOUNT_TOKEN}\\s*(.*)$`));
    if (amount) {
      qty = amountValue(amount[1]);
      rest = amount[2].trim();
    }
    if (!Number.isFinite(qty) || qty <= 0) return null;

    let grams = null;
    for (const unit of UNKNOWN_UNITS) {
      const match = rest.match(unit.re);
      if (!match) continue;
      grams = unit.grams == null ? null : qty * unit.grams;
      rest = rest.slice(match[0].length).trim();
      break;
    }
    const trailing = rest.match(/\s+(\d+(?:[.,]\d+)?)\s*(?:g|gramas?|ml)\s*$/);
    if (trailing && grams == null) {
      grams = amountValue(trailing[1]);
      rest = rest.slice(0, trailing.index).trim();
    }
    rest = rest.replace(/^(?:de|do|da|dos|das)\s+/, "").trim();
    if (!rest || rest.length < 2) return null;
    if (/^(?:colher|colheres|grama|gramas|g|ml|mililitro|mililitros|litro|litros|copo|copos|xicara|xicaras|fatia|fatias|unidade|unidades|porcao|porcoes|prato|pratos|concha|conchas|scoop|scoops|barra|barras|lata|latas|pacote|pacotes|pote|potes)$/.test(rest)) return null;
    const name = canonicalFoodName(rest);
    if (!name) return null;
    return { name, rawName: rest, qty, grams };
  }

  async function lookupFood(name) {
    try {
      const session = await ensureSession();
      if (!session) return null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const res = await fetch("/api/food", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
          body: JSON.stringify({ name })
        });
        if (res.ok) {
          const data = await res.json().catch(() => null);
          return data?.food || null;
        }
        if (res.status !== 404) return null;
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 700));
      }
      return null;
    } catch {
      return null;
    }
  }

  function gramsFromTrailingUnit(segment, hit) {
    const after = segment.slice(hit.end);
    const match = after.match(/\b(\d+(?:[.,]\d+)?)\s*(?:g|gramas?|ml)\b\s*(?:cada|por\s+unidade|a\s+unidade)\b/i);
    if (!match) return null;
    const per = amountValue(match[1]);
    if (!Number.isFinite(per)) return null;
    const before = segment.slice(0, hit.index);
    const qtyMatch = before.match(new RegExp(`${AMOUNT_TOKEN}\\s*(?:de\\s+)?$`));
    const qty = qtyMatch ? amountValue(qtyMatch[1]) : 1;
    return per * (Number.isFinite(qty) ? qty : 1);
  }

  async function parseMeal(text) {
    const norm = normalize(text);
    const segments = mealSegments(text);
    const items = [];
    const unknown = [];
    for (const segment of segments) {
      const hits = findFoodHits(maskUnits(segment));
      if (hits.length) {
        for (const hit of hits) {
          const grams = gramsFromTrailingUnit(segment, hit) ?? quantityBefore(segment, hit.index, hit.food);
          const factor = grams / 100;
          items.push({
            foodId: hit.food.id,
            name: hit.food.name,
            grams: round(grams),
            kcal: +(hit.food.kcal * factor).toFixed(1),
            p: +(hit.food.p * factor).toFixed(1),
            c: +(hit.food.c * factor).toFixed(1),
            f: +(hit.food.f * factor).toFixed(1)
          });
        }
        continue;
      }
      const unknownItem = parseUnknownSegment(segment);
      if (!unknownItem) continue;
      const found = await lookupFood(unknownItem.name);
      if (!found) {
        unknown.push(unknownItem.rawName || unknownItem.name);
        continue;
      }
      const totalGrams = unknownItem.grams ?? (found.servingGrams ? unknownItem.qty * found.servingGrams : unknownItem.qty * 100);
      const factor = totalGrams / 100;
      items.push({
        foodId: `web-${found.code || found.name}`,
        name: found.name,
        grams: round(totalGrams),
        kcal: +(found.kcal * factor).toFixed(1),
        p: +(found.protein * factor).toFixed(1),
        c: +(found.carbs * factor).toFixed(1),
        f: +(found.fat * factor).toFixed(1),
        source: found.source || "Open Food Facts",
        sourceUrl: found.url || ""
      });
    }
    if (!items.length) return unknown.length ? { items: [], unknown, label: detectMealLabel(norm) } : null;
    return { items, unknown, label: detectMealLabel(norm) };
  }

  function parseWater(text) {
    const norm = normalize(text);
    if (!/agua|hidrat/.test(norm)) return null;
    if (/agua de coco/.test(norm)) return null;
    let ml = 0;
    const liters = norm.match(/(\d+(?:[.,]\d+)?)\s*(?:litros?|l)\b/);
    const millis = norm.match(/(\d+(?:[.,]\d+)?)\s*(?:ml|mililitros?)\b/);
    if (liters) ml = parseNum(liters[1]) * 1000;
    else if (millis) ml = parseNum(millis[1]);
    else {
      const glasses = norm.match(/(\d+(?:[.,]\d+)?|um|uma|dois|duas|meio|meia)\s*(?:copos?|garrafas?)\b/);
      if (glasses) {
        const qty = NUMBER_WORDS[glasses[1]] ?? parseNum(glasses[1]);
        ml = qty * (/garrafa/.test(glasses[0]) ? 500 : 250);
      }
    }
    if (!ml) ml = 250;
    if (!(ml > 0 && ml <= 5000)) return null;
    return { ml: round(ml / 10) * 10 };
  }

  function parseWeight(text) {
    const norm = normalize(text);
    const explicit = /(peso|pesando|balanca)/.test(norm);
    if (!explicit && !/(kg|quilos?)\b/.test(norm)) return null;
    const match = norm.match(/(?:peso|pesando|balanca)\D{0,14}(\d{2,3}(?:[.,]\d{1,2})?)/) ||
      norm.match(/(\d{2,3}(?:[.,]\d{1,2})?)\s*(?:kg|quilos?)\b/);
    if (!match) return null;
    const kg = parseNum(match[1]);
    if (!(kg >= 30 && kg <= 300)) return null;
    return { kg };
  }

  const ACTIVITIES = [
    { re: /corri|corrida|correr/, name: "Corrida", met: 9.8, mets: [7, 9.8, 12] },
    { re: /caminhei|caminhada|caminhar|andei/, name: "Caminhada", met: 3.5, mets: [3, 3.5, 5] },
    { re: /pedalei|bicicleta|ciclismo|bike/, name: "Bicicleta", met: 7.5, mets: [5.5, 7.5, 10] },
    { re: /nadei|natacao|nadar/, name: "Natação", met: 8.0, mets: [5, 8, 9.5] },
    { re: /musculacao|academia|treino de forca|pesos/, name: "Musculação", met: 6.0, mets: [3.5, 6, 7.5] },
    { re: /yoga/, name: "Yoga", met: 3.0, mets: [2, 3, 3.5] },
    { re: /pilates/, name: "Pilates", met: 3.0, mets: [2, 3, 3.5] },
    { re: /futebol/, name: "Futebol", met: 7.0, mets: [5, 7, 9] },
    { re: /dancei|danca/, name: "Dança", met: 5.0, mets: [3.5, 5, 7] }
  ];

  const INTENSITY = ["Leve", "Moderada", "Intensa"];
  const WORKOUT_INTENSITY = ["Leve", "Médio", "Intenso"];
  const WORKOUT_METS = { Leve: 3.5, "Médio": 6, Intenso: 7.5 };
  const WORKOUT_LABELS = {
    peito: "Peito", peitoral: "Peito", triceps: "Tríceps", biceps: "Bíceps",
    costa: "Costas", costas: "Costas", dorsal: "Costas", dorsais: "Costas",
    ombro: "Ombros", ombros: "Ombros", perna: "Pernas", pernas: "Pernas",
    gluteo: "Glúteos", gluteos: "Glúteos", coxa: "Coxas", coxas: "Coxas",
    quadriceps: "Quadríceps", posterior: "Posterior", posteriores: "Posterior",
    panturrilha: "Panturrilhas", panturrilhas: "Panturrilhas",
    abdomen: "Abdômen", abdomem: "Abdômen", core: "Core",
    superiores: "Superiores", inferior: "Inferiores", inferiores: "Inferiores",
    "full body": "Corpo inteiro", "corpo inteiro": "Corpo inteiro", corpo: "Corpo inteiro",
    cardio: "Cardio", funcional: "Funcional", crossfit: "Crossfit"
  };
  const WORKOUT_WORDS = /\b(?:treinei|treino|treinar|academia|musculacao|forca|pesos|hipertrofia)\b/;
  const MUSCLE_PATTERN = "peito|peitoral|triceps|biceps|costa|costas|dorsal|ombro|ombros|perna|pernas|gluteo|gluteos|coxa|coxas|quadriceps|posterior|panturrilha|panturrilhas|abdomen|abdomem|core|superiores|inferiores|full body|corpo inteiro|cardio|funcional|crossfit";
  const FIZ_WORKOUT = new RegExp(`\\bfiz\\b.*\\b(?:${MUSCLE_PATTERN})\\b.*\\be\\b.*\\b(?:${MUSCLE_PATTERN})\\b`);
  const TWO_MUSCLES = new RegExp(`\\b(?:${MUSCLE_PATTERN})\\b.*\\be\\b.*\\b(?:${MUSCLE_PATTERN})\\b`);
  const SIM = { activity: 1, intensity: 1, minutes: 30 };
  const PHOTO = { dataUrl: "", items: [], total: 0, state: "idle" };
  let photoBusy = false;
  const PHOTO_MAX_BYTES = 12 * 1024 * 1024;
  const PHOTO_MAX_SIDE = 1280;

  function titleCaseWorkout(text) {
    const small = new Set(["de", "da", "do", "das", "dos", "e", "com"]);
    return String(text || "").trim().split(/\s+/).map((word, index) => {
      const lower = word.toLowerCase();
      if (index > 0 && small.has(lower)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    }).join(" ");
  }

  function workoutName(value) {
    const raw = String(value || "").trim().replace(/\s+/g, " ").slice(0, 60);
    if (!raw) return "";
    const whole = WORKOUT_LABELS[normalize(raw)];
    if (whole) return whole;
    const parts = raw.split(/\s*(?:,|\+|\/| e )\s*/i).filter(Boolean);
    return parts.map((part) => WORKOUT_LABELS[normalize(part)] || titleCaseWorkout(part)).join(" e ").slice(0, 60);
  }

  function parseMinutes(norm, fallback) {
    let minutes = 0;
    let explicit = false;
    const mins = norm.match(/(\d+(?:[.,]\d+)?)\s*(?:min|minutos?)\b/);
    const hours = norm.match(/(\d+(?:[.,]\d+)?)\s*(?:h|horas?)\b/);
    if (mins) { minutes = parseNum(mins[1]); explicit = true; }
    else if (hours) { minutes = parseNum(hours[1]) * 60; explicit = true; }
    else if (/meia hora/.test(norm)) { minutes = 30; explicit = true; }
    if (!explicit) minutes = fallback;
    if (!(minutes > 0 && minutes <= 600)) return null;
    return minutes;
  }

  function parseIntensity(norm) {
    if (/\b(?:intens[oa]|forte|pesad[oa])\b/.test(norm)) return "Intenso";
    if (/\b(?:moderad[oa]|medi[oa])\b/.test(norm)) return "Médio";
    if (/\bleve\b/.test(norm)) return "Leve";
    return null;
  }

  function parseWorkout(text) {
    const norm = normalize(text);
    const bareWorkout = TWO_MUSCLES.test(norm) && (parseIntensity(norm) || /\b\d+(?:[.,]\d+)?\s*(?:min|minutos?|h|horas?)\b/.test(norm) || /meia hora/.test(norm));
    if (!WORKOUT_WORDS.test(norm) && !FIZ_WORKOUT.test(norm) && !bareWorkout) return null;
    const minutes = parseMinutes(norm, 45);
    if (!minutes) return null;
    const intensity = parseIntensity(norm) || "Médio";
    let rest = norm
      .replace(/\b(?:treinei|treino|treinar|fiz|fazer|hoje|agora|academia|musculacao|forca|pesos|hipertrofia)\b/g, " ")
      .replace(/\b(?:leve|moderado|moderada|medio|media|intenso|intensa|forte|pesado|pesada)\b/g, " ")
      .replace(/\b\d+(?:[.,]\d+)?\s*(?:min|minutos?|h|horas?)\b/g, " ")
      .replace(/\bmeia hora\b/g, " ")
      .replace(/\b(?:de|do|da|dos|das|com|por|as|um|uma|o|a|os)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const workout = workoutName(rest) || "Musculação";
    const met = WORKOUT_METS[intensity];
    const kg = latestWeight() || 70;
    return {
      name: "Musculação",
      workout,
      minutes: round(minutes),
      met,
      kcal: (met * 3.5 * kg * minutes) / 200,
      intensity
    };
  }

  function parseActivity(text) {
    const workout = parseWorkout(text);
    if (workout) return workout;
    const norm = normalize(text);
    const activity = ACTIVITIES.find((item) => item.re.test(norm));
    if (!activity) return null;
    const minutes = parseMinutes(norm, 30);
    if (!minutes) return null;
    const kg = latestWeight() || 70;
    return {
      name: activity.name,
      minutes: round(minutes),
      met: activity.met,
      kcal: (activity.met * 3.5 * kg * minutes) / 200
    };
  }

  function simulatedActivity() {
    const activity = ACTIVITIES[SIM.activity] || ACTIVITIES[0];
    const mets = activity.mets || [activity.met, activity.met, activity.met];
    const met = mets[SIM.intensity] || activity.met;
    const kg = latestWeight() || Number(state?.profile?.weightKg) || 70;
    return { activity, met, kg, kcal: (met * 3.5 * kg * SIM.minutes) / 200 };
  }

  function renderActivitySimulator() {
    const select = $("#sim-activity");
    if (!select || !state) return;
    if (!select.options.length) {
      select.innerHTML = ACTIVITIES.map((activity, index) => `<option value="${index}">${activity.name}</option>`).join("");
    }
    SIM.activity = clamp(SIM.activity, 0, ACTIVITIES.length - 1);
    SIM.intensity = clamp(SIM.intensity, 0, 2);
    SIM.minutes = clamp(SIM.minutes, 5, 180);
    select.value = String(SIM.activity);
    const intensity = $("#sim-intensity");
    if (intensity) intensity.value = String(SIM.intensity);
    const range = $("#sim-minutes");
    if (range) {
      range.value = String(SIM.minutes);
      range.setAttribute("aria-valuetext", `${SIM.minutes} minutos`);
    }
    const minutesLabel = $("#sim-minutes-label");
    if (minutesLabel) minutesLabel.textContent = `${SIM.minutes} min`;
    const { met, kg, kcal } = simulatedActivity();
    const estimate = $("#sim-kcal");
    if (estimate) estimate.textContent = `≈ ${nf(round(kcal))} kcal`;
    const detail = $("#sim-detail");
    if (detail) detail.textContent = `Peso usado: ${nf1(kg)} kg · MET ${nf1(met)} · ${nf1(kcal / SIM.minutes)} kcal/min. Metade do gasto entra no orçamento de hoje.`;
  }

  function addSimulatedActivity() {
    if (!state) return;
    const { activity, met, kcal } = simulatedActivity();
    addActivity({
      name: activity.name,
      minutes: SIM.minutes,
      met,
      kcal,
      intensity: INTENSITY[SIM.intensity] || "Moderada"
    });
    toast(`${activity.name} registrada: ${SIM.minutes} min, ≈ ${nf(round(kcal))} kcal.`);
  }

  function intensityLevel(value) {
    const key = normalize(value || "");
    if (key.startsWith("leve")) return "leve";
    if (key.startsWith("intens") || key.startsWith("forte") || key.startsWith("pesad")) return "intenso";
    return "medio";
  }

  function displayIntensity(value) {
    return { leve: "Leve", medio: "Médio", intenso: "Intenso" }[intensityLevel(value)];
  }

  function isWorkout(activity) {
    return Boolean(activity?.workout) || /musculacao|academia|treino|forca|pesos/.test(normalize(activity?.name || ""));
  }

  function workoutTitle(activity) {
    return activity.workout || activity.name;
  }

  function workoutMeta(activity, includeIntensity = true) {
    const parts = [`${nf(activity.minutes)} min`];
    if (includeIntensity) parts.push(displayIntensity(activity.intensity));
    if (activity.workout && activity.workout !== activity.name) parts.push(activity.name);
    if (Number.isFinite(Number(activity.met))) parts.push(`MET ${nf1(activity.met)}`);
    return parts.join(" · ");
  }

  function addWorkout(event) {
    event.preventDefault();
    if (!state) return;
    const nameInput = $("#workout-name");
    const name = workoutName(nameInput?.value || "");
    if (!name) {
      toast("Diga qual treino foi. Ex.: “Peito e tríceps”.");
      nameInput?.focus();
      return;
    }
    const intensitySelect = $("#workout-intensity");
    const intensity = WORKOUT_INTENSITY.includes(intensitySelect?.value) ? intensitySelect.value : "Médio";
    const minutes = clamp(parseNum($("#workout-minutes")?.value) || 45, 5, 180);
    const met = WORKOUT_METS[intensity];
    const kg = latestWeight() || 70;
    addActivity({
      name: "Musculação",
      workout: name,
      minutes,
      met,
      kcal: (met * 3.5 * kg * minutes) / 200,
      intensity
    });
    if (nameInput) nameInput.value = "";
    toast(`${name} registrado: ${minutes} min · ${intensity}.`);
  }

  function submitBudget(event) {
    event.preventDefault();
    if (!state) return;
    const budget = parseNum($("#budget-value")?.value);
    if (!(budget >= 10)) {
      toast("Informe um orçamento de pelo menos R$ 10.");
      $("#budget-value")?.focus();
      return;
    }
    const days = clamp(Number($("#budget-days")?.value) || 7, 1, 30);
    renderBudgetResult(planBudget(budget, days));
  }

  function isQuestion(text) {
    const raw = String(text || "").trim();
    if (raw.endsWith("?")) return true;
    return /^(o que|que |qual|quais|como|por que|porque|quando|quanto|quantos|quantas|posso|devo|sera|vale a pena|e bom|preciso|me explica|me ajuda)/.test(normalize(raw));
  }

  const RECORDING = /\b(comi|tomei|bebi|registra|registre|anota|anote|adiciona|adicione|peso|pesando|corri|caminhei|pedalei|nadei|treinei|fiz)\b/;

  const WELCOME = "Oi! Eu sou a Viva. Posso anotar refeições, água, treino e peso, responder perguntas com pesquisa na web quando a IA está ligada e montar uma lista de compras com orçamento. Ex.: “comi 2 ovos e um pão”, “bebi 500 ml de água”, “pesquise sobre creatina” ou “tenho R$ 150 para compras”.";

  function aiStoreKey() {
    return `${AI_STORE}:${user?.id || "local"}`;
  }

  function loadAIKey() {
    try {
      const raw = JSON.parse(localStorage.getItem(aiStoreKey()) || "null");
      if (!raw || typeof raw.key !== "string" || !raw.key) return null;
      const provider = AI_PROVIDERS[raw.provider] ? raw.provider : "openrouter";
      return { provider, model: typeof raw.model === "string" ? raw.model : "", key: raw.key };
    } catch {
      return null;
    }
  }

  function saveAIKey(value) {
    localStorage.setItem(aiStoreKey(), JSON.stringify(value));
  }

  function clearAIKey() {
    localStorage.removeItem(aiStoreKey());
  }

  function activeAIConfig() {
    const own = loadAIKey();
    if (own) {
      return {
        provider: own.provider,
        model: own.model || AI_PROVIDERS[own.provider]?.model || "",
        key: own.key,
        source: "own",
        vision: !!AI_PROVIDERS[own.provider]?.vision
      };
    }
    if (AI_SERVER) {
      return { ...AI_SERVER, source: "server", vision: !!AI_SERVER.vision };
    }
    return null;
  }

  function hasVisionAI() {
    return !!activeAIConfig()?.vision;
  }

  function enableAIOnce() {
    if (!state?.profile || state.profile.aiEnabled || state.profile.aiChoice === "off") return;
    if (!AI_SERVER && !loadAIKey()) return;
    state.profile.aiEnabled = true;
    state.profile.aiChoice = "on";
    queueSave();
    renderChat();
    renderAISettings();
  }

  async function loadAIServerConfig() {
    if (!AI_ENDPOINT) return null;
    try {
      const res = await fetch(AI_ENDPOINT, { headers: { Accept: "application/json" } });
      if (!res.ok) return AI_SERVER;
      const data = await res.json().catch(() => null);
      AI_SERVER = data?.configured
        ? { provider: data.provider || "openai", model: data.model || "", vision: !!data.vision }
        : null;
    } catch {
      return AI_SERVER;
    }
    if (AI_ENDPOINT && !AI_SERVER && !loadAIKey() && state?.profile?.aiEnabled) {
      state.profile.aiEnabled = false;
      state.profile.aiChoice = "auto";
      queueSave();
      renderChat();
    }
    if (state) renderAISettings();
    return AI_SERVER;
  }

  const AI_CONTEXT_MAX = 20000;

  function aiMeal(meal) {
    return {
      label: meal.label,
      at: meal.at,
      kcal: round(meal.kcal),
      protein: Number(meal.p) || 0,
      carbs: Number(meal.c) || 0,
      fat: Number(meal.f) || 0,
      items: (meal.items || []).map((item) => ({
        name: item.name,
        grams: Number(item.grams) || 0,
        kcal: Number(item.kcal) || 0,
        protein: Number(item.p) || 0,
        carbs: Number(item.c) || 0,
        fat: Number(item.f) || 0,
        source: item.source || undefined
      }))
    };
  }

  function aiActivity(activity) {
    return {
      at: activity.at,
      name: activity.name,
      workout: activity.workout || undefined,
      intensity: activity.intensity || undefined,
      minutes: Number(activity.minutes) || 0,
      kcal: round(activity.kcal),
      met: activity.met || undefined
    };
  }

  function aiDay(key, data, full = false, totalsOverride = null) {
    const totals = totalsOverride || dayTotals(key);
    const activities = (data.activities || []).map(aiActivity);
    return {
      date: key,
      waterMl: Number(data.waterMl) || 0,
      weightKg: data.weightKg == null ? null : Number(data.weightKg),
      totals: {
        kcal: round(totals.kcal),
        protein: +totals.protein.toFixed(1),
        carbs: +totals.carbs.toFixed(1),
        fat: +totals.fat.toFixed(1),
        burnedKcal: round(totals.burned)
      },
      meals: full ? (data.meals || []).map(aiMeal) : (data.meals || []).length,
      activities: full ? activities : activities.length
    };
  }

  function aiDaySummary(key, data) {
    const totals = dayTotals(key);
    const minutes = (data.activities || []).reduce((acc, activity) => acc + (Number(activity.minutes) || 0), 0);
    return [
      key,
      round(totals.kcal),
      +totals.protein.toFixed(1),
      +totals.carbs.toFixed(1),
      +totals.fat.toFixed(1),
      Number(data.waterMl) || 0,
      round(minutes),
      round(totals.burned),
      data.weightKg == null ? null : Number(data.weightKg)
    ];
  }

  function fitAIContext(context) {
    const copy = JSON.parse(JSON.stringify(context));
    let removed = 0;
    const tooBig = () => JSON.stringify(copy).length > AI_CONTEXT_MAX;
    while (tooBig()) {
      if (copy.chat?.length) {
        copy.chat.shift();
        removed += 1;
        continue;
      }
      if (copy.recentDays?.length) {
        copy.recentDays.shift();
        removed += 1;
        continue;
      }
      if (copy.dailyHistory?.length > 1) {
        copy.dailyHistory.shift();
        removed += 1;
        continue;
      }
      if (copy.weights?.length > 1) {
        copy.weights.shift();
        removed += 1;
        continue;
      }
      break;
    }
    if (removed) copy.meta = { truncated: true, removed };
    return copy;
  }

  function aiContext(question = "") {
    if (!state) return {};
    const target = state.targets || calcTargets(state.profile);
    const todayKey = ymd();
    const todayData = dayData(todayKey);
    const totals = dayTotals(todayKey);
    const dayKeys = Object.keys(state.days || {})
      .filter((key) => {
        const data = state.days[key];
        return data && ((data.meals || []).length || (data.activities || []).length || Number(data.waterMl) || data.weightKg != null);
      })
      .sort();
    const recentKeys = dayKeys.filter((key) => key !== todayKey).slice(-7);
    const latest = latestWeight();
    const weightHistory = (state.weights || []).map((entry) => [entry.date, Number(entry.kg)]);
    const chat = (state.chat || [])
      .filter((message) => !(message.role === "me" && message.text === question))
      .slice(-12)
      .map((message) => ({ role: message.role, text: message.text, at: message.at }));
    const context = {
      app: {
        name: "Viva",
        generatedAt: nowIso(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Sao_Paulo"
      },
      profile: {
        name: state.profile.name || "",
        age: state.profile.age == null ? null : Number(state.profile.age),
        heightCm: state.profile.heightCm == null ? null : Number(state.profile.heightCm),
        weightKg: state.profile.weightKg == null ? null : Number(state.profile.weightKg),
        goal: state.profile.goal || "maintain",
        goalLabel: GOAL_LABELS[state.profile.goal] || state.profile.goal || "Manter o peso",
        bmi: bmi(Number(state.profile.weightKg), Number(state.profile.heightCm)),
        onboardedAt: state.profile.onboardedAt || null
      },
      targets: {
        kcal: Number(target.kcal) || 0,
        protein: Number(target.protein) || 0,
        carbs: Number(target.carbs) || 0,
        fat: Number(target.fat) || 0,
        waterMl: Number(target.waterMl) || 2000
      },
      summary: {
        latestWeightKg: latest,
        bmi: bmi(Number(latest), Number(state.profile.heightCm)),
        todayKcal: round(totals.kcal),
        todayProtein: +totals.protein.toFixed(1),
        todayCarbs: +totals.carbs.toFixed(1),
        todayFat: +totals.fat.toFixed(1),
        todayBurnedKcal: round(totals.burned),
        todayWaterMl: Number(todayData.waterMl) || 0,
        todayActivityMinutes: (todayData.activities || []).reduce((acc, activity) => acc + (Number(activity.minutes) || 0), 0),
        remainingKcal: round(target.kcal - totals.kcal + totals.burned * 0.5),
        remainingProtein: +Math.max(0, target.protein - totals.protein).toFixed(1),
        daysWithData: dayKeys.length,
        weightRecords: weightHistory.length
      },
      today: aiDay(todayKey, todayData, true, totals),
      recentDays: recentKeys.map((key) => aiDay(key, state.days[key], true)),
      dailyHistory: dayKeys.map((key) => aiDaySummary(key, state.days[key])),
      historyColumns: ["date", "kcal", "protein", "carbs", "fat", "waterMl", "activityMinutes", "activityKcal", "weightKg"],
      weights: weightHistory,
      weightColumns: ["date", "kg"],
      chat
    };
    return fitAIContext(context);
  }

  function answerWithSources(answer, sources) {
    const list = Array.isArray(sources)
      ? sources.filter((source) => source && source.title && /^https?:\/\//i.test(source.url || "")).slice(0, 5)
      : [];
    if (!list.length) return answer;
    return `${answer}\n\nFontes consultadas:\n${list.map((source, index) => `[${index + 1}] ${source.title} — ${source.url}`).join("\n")}`;
  }

  async function askAI(question, options = {}) {
    if (!navigator.onLine) return "Você está offline. Tente de novo quando a conexão voltar.";
    const wantsSearch = options.search !== undefined ? !!options.search : !options.image && $("#chat-search")?.checked !== false;

    if (AI_ENDPOINT) {
      let config = activeAIConfig();
      if (!config) {
        await loadAIServerConfig();
        config = activeAIConfig();
      }
      if (!config) {
        return "A IA do app ainda não foi configurada. Enquanto isso, posso responder sobre proteína, calorias, água e sugestão de jantar.";
      }
      if (options.image && !config.vision) {
        return config.source === "own"
          ? `Sua chave do ${AI_PROVIDERS[config.provider]?.label || config.provider} não analisa fotos. Use OpenAI, Gemini ou OpenRouter, ou remova a chave para usar a IA do app.`
          : "A IA incluída no app não analisa fotos. Use uma chave própria da OpenAI, Gemini ou OpenRouter.";
      }
      try {
        const session = await ensureSession();
        if (!session) {
          sessionLost();
          return "Sua sessão expirou. Entre de novo.";
        }
        const provider = config.provider || "openai";
        const model = config.model || "";
        const payload = { question, message: question, context: aiContext(question), provider, model, search: wantsSearch };
        if (config.source === "own") payload.apiKey = config.key;
        if (options.image) payload.image = options.image;
        const res = await fetch(AI_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
          body: JSON.stringify(payload)
        });
        const data = await res.json().catch(() => null);
        if (res.status === 401) {
          if (data?.error === "provider_error") return "A IA do app foi recusada. Tente de novo em instantes.";
          sessionLost();
          return "Sua sessão expirou. Entre de novo.";
        }
        if (res.status === 503 && data?.error === "ai_not_configured") {
          return "A IA do app ainda não foi configurada. Enquanto isso, posso responder sobre proteína, calorias, água e sugestão de jantar.";
        }
        if (res.status === 400 && data?.error === "missing_api_key") return "A IA do app não tem chave configurada. Use as respostas locais ou salve uma chave em Perfil.";
        if (res.status === 429) return "Muitas perguntas em pouco tempo. Espere um minuto e tente de novo.";
        if (!res.ok) {
          if (data?.error === "provider_error" && data?.message) return `A IA recusou: ${data.message}`;
          return "Não consegui falar com a IA agora. Tente de novo em instantes.";
        }
        return answerWithSources(data?.answer || data?.reply || "A IA não retornou uma resposta.", data?.sources);
      } catch {
        return "Não consegui falar com a IA agora. Verifique a conexão.";
      }
    }

    try {
      const res = await apiFetch(`/functions/v1/${FN}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Compatível com { message, context } -> { reply } e com { question } -> { answer }.
        body: JSON.stringify({ question, message: question, context: aiContext(question), search: wantsSearch })
      });
      if (res.status === 429) return "Muitas perguntas em pouco tempo. Espere um minuto e tente de novo.";
      if (res.status === 503) return "A IA ainda não está configurada no servidor. Avise quem publicou o app.";
      if (res.status === 401) {
        sessionLost();
        return "Sua sessão expirou. Entre de novo.";
      }
      if (!res.ok) return "Não consegui falar com a IA agora. Tente de novo em instantes.";
      const data = await res.json().catch(() => null);
      return answerWithSources((data && (data.answer || data.reply)) || "A IA não retornou uma resposta.", data?.sources);
    } catch {
      return "Não consegui falar com a IA agora. Verifique a conexão.";
    }
  }

  const DINNERS = [
    { name: "Frango grelhado com arroz e brócolis", items: [["frango-peito", 1.5], ["arroz-branco", 1], ["brocolis", 1]] },
    { name: "Omelete de ovos com salada", items: [["ovo-cozido", 3], ["salada", 1.5], ["azeite", 1]] },
    { name: "Tilápia com batata-doce e salada", items: [["tilapia", 1.5], ["batata-doce", 1.5], ["salada", 1]] },
    { name: "Carne bovina com arroz e feijão", items: [["patinho", 1.2], ["arroz-branco", 1], ["feijao-carioca", 1]] },
    { name: "Iogurte com aveia e banana", items: [["iogurte", 1], ["aveia", 1], ["banana", 1]] },
    { name: "Pão integral com queijo minas e tomate", items: [["pao-integral", 2], ["queijo-minas", 1], ["tomate", 1]] }
  ];

  function dishTotals(dish) {
    return dish.items.reduce((acc, [id, qty]) => {
      const food = FOODS.find((item) => item.id === id);
      if (!food) return acc;
      const factor = (Number(qty) * Number(food.portion)) / 100;
      acc.kcal += Number(food.kcal) * factor;
      acc.p += Number(food.p) * factor;
      acc.c += Number(food.c) * factor;
      acc.f += Number(food.f) * factor;
      return acc;
    }, { kcal: 0, p: 0, c: 0, f: 0 });
  }

  function basketTotals(gramsById) {
    const totals = { kcal: 0, p: 0, c: 0, f: 0 };
    for (const [id, grams] of gramsById) {
      const item = MARKET_INDEX.get(id);
      const food = item && marketFood(item);
      if (!food) continue;
      const factor = grams / 100;
      totals.kcal += Number(food.kcal) * factor;
      totals.p += Number(food.p) * factor;
      totals.c += Number(food.c) * factor;
      totals.f += Number(food.f) * factor;
    }
    return totals;
  }

  function planBudget(budget, days = 7) {
    const totalBudget = Math.max(0, Number(budget) || 0);
    const period = clamp(Math.round(Number(days) || 7), 1, 30);
    const target = state?.targets || (state?.profile ? calcTargets(state.profile) : { kcal: 2000, protein: 100 });
    const targetKcal = Math.max(1, Number(target.kcal) * period);
    const targetProtein = Math.max(1, Number(target.protein) * period);
    const gramsById = new Map();
    let spent = 0;

    const canAdd = (item, amount) => {
      const current = gramsById.get(item.id) || 0;
      if (current + amount > item.maxPerDay * period + 0.001) return false;
      return (amount / 100) * item.price <= totalBudget - spent + 0.001;
    };
    const add = (item, amount) => {
      if (!canAdd(item, amount)) return false;
      gramsById.set(item.id, (gramsById.get(item.id) || 0) + amount);
      spent += (amount / 100) * item.price;
      return true;
    };

    // Base de variedade: feijão, fruta, salada e gordura entram antes da otimização.
    const seedCap = totalBudget * 0.35;
    let seedSpent = 0;
    for (const seed of MARKET_SEEDS) {
      const item = MARKET_INDEX.get(seed.id);
      if (!item) continue;
      const amount = Math.max(50, Math.round((seed.gramsPerDay * period) / 50) * 50);
      const cost = (amount / 100) * item.price;
      if (seedSpent + cost > seedCap + 0.001) continue;
      if (add(item, amount)) seedSpent += cost;
    }

    let totals = basketTotals(gramsById);
    let needProtein = Math.max(0, targetProtein - totals.p);
    let needKcal = Math.max(0, targetKcal - totals.kcal);
    const step = 50;

    for (let guard = 0; guard < 800 && (needProtein > 0 || needKcal > 0); guard += 1) {
      let best = null;
      for (const item of MARKET) {
        const food = marketFood(item);
        if (!food || !canAdd(item, step)) continue;
        const cost = (step / 100) * item.price;
        const proteinGain = (Number(food.p) * step) / 100;
        const kcalGain = (Number(food.kcal) * step) / 100;
        const proteinScore = needProtein > 0 ? Math.min(proteinGain, needProtein) / needProtein : 0;
        const kcalScore = needKcal > 0 ? Math.min(kcalGain, needKcal) / needKcal : 0;
        const score = needProtein > 0 ? proteinScore * 0.7 + kcalScore * 0.3 : kcalScore;
        const value = score / cost;
        if (!best || value > best.value) best = { item, proteinGain, kcalGain, value };
      }
      if (!best) break;
      add(best.item, step);
      needProtein = Math.max(0, needProtein - best.proteinGain);
      needKcal = Math.max(0, needKcal - best.kcalGain);
    }

    totals = basketTotals(gramsById);
    const items = [...gramsById.entries()]
      .map(([id, grams]) => {
        const item = MARKET_INDEX.get(id);
        const food = item && marketFood(item);
        if (!item || !food || grams <= 0) return null;
        const factor = grams / 100;
        return {
          id,
          label: item.label,
          grams,
          qty: marketQty(item, grams),
          cost: factor * item.price,
          kcal: Number(food.kcal) * factor,
          protein: Number(food.p) * factor
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.cost - a.cost);

    return {
      budget: totalBudget,
      days: period,
      spent,
      left: Math.max(0, totalBudget - spent),
      targetKcal,
      targetProtein,
      kcal: totals.kcal,
      protein: totals.p,
      proteinPct: Math.min(100, Math.round((totals.p / targetProtein) * 100)),
      kcalPct: Math.min(100, Math.round((totals.kcal / targetKcal) * 100)),
      items
    };
  }

  function budgetAnswer(parsed) {
    const plan = planBudget(parsed.budget, parsed.days);
    const period = plan.days === 1 ? "hoje" : `${plan.days} dias`;
    if (!plan.items.length) {
      return `Com R$ ${money(plan.budget)} não encontrei uma combinação de compras. Tente um valor maior ou ajuste suas metas.`;
    }
    const shown = plan.items.slice(0, 7).map((item) => `${item.label} (${item.qty}) — R$ ${money(item.cost)}`);
    const more = plan.items.length > shown.length ? `; e mais ${plan.items.length - shown.length} itens` : "";
    const left = plan.left >= 0.01 ? ` Sobram R$ ${money(plan.left)}.` : "";
    return `Sugestão de compras para ${period} com R$ ${money(plan.budget)}: ${shown.join("; ")}${more}. Total estimado: R$ ${money(plan.spent)}. Cobre ${plan.proteinPct}% da proteína e ${plan.kcalPct}% das calorias.${left} Valores estimados; confira os preços do mercado.`;
  }

  function parseBudgetQuestion(text) {
    const norm = normalize(text);
    if (!/(comprar|compra|mercado|supermercado|feira|orcamento|cesta|lista de compras)/.test(norm)) return null;
    let match = norm.match(/\b(?:r\s*)?(\d{1,5}(?:[.,]\d{1,2})?)\s*(?:reais|real|conto|pila)\b/);
    if (!match) match = norm.match(/\br\s*(\d{1,5}(?:[.,]\d{1,2})?)\b/);
    if (!match) match = norm.match(/\b(?:tenho|com|gastar|gasto|orcamento(?: de| e)?|apenas|so|somente)\s*(\d{1,5}(?:[.,]\d{1,2})?)\b/);
    if (!match) return null;
    const budget = parseNum(match[1]);
    if (!(budget >= 10 && budget <= 100000)) return null;
    const daysMatch = norm.match(/\b(\d{1,2})\s*dias?\b/);
    let days = daysMatch ? Number(daysMatch[1]) : 7;
    if (/\bhoje\b/.test(norm)) days = 1;
    if (/\bmes\b/.test(norm)) days = 30;
    return { budget, days: clamp(days, 1, 30) };
  }

  function renderBudgetResult(plan) {
    const result = $("#budget-result");
    if (!result) return;
    result.innerHTML = "";
    if (!plan.items.length) {
      result.append(h("p", { class: "targets-note" }, "Não encontrei uma combinação para esse valor. Tente um orçamento maior."));
      return;
    }
    result.append(
      h("div", { class: "budget-summary" },
        h("strong", {}, `R$ ${money(plan.spent)}`),
        h("span", {}, `de R$ ${money(plan.budget)} · ${plan.days} dia(s)`)
      ),
      h("ul", { class: "budget-list" },
        plan.items.map((item) => h("li", { class: "budget-item" },
          h("div", { class: "b-main" },
            h("strong", {}, item.label),
            h("small", {}, `${item.qty} · ${nf(item.protein)} g de proteína · ${nf(item.kcal)} kcal`)
          ),
          h("span", { class: "b-price" }, `R$ ${money(item.cost)}`)
        ))
      )
    );
    const reached = plan.proteinPct >= 100 && plan.kcalPct >= 100;
    const note = reached
      ? "A cesta atinge a meta de proteína e de calorias do período."
      : `Cobre ${plan.proteinPct}% da proteína e ${plan.kcalPct}% das calorias do período.`;
    const left = plan.left >= 0.01 ? ` Sobram R$ ${money(plan.left)}.` : "";
    result.append(h("p", { class: "targets-note" }, `${note}${left} Valores estimados; confira os preços do mercado.`));
  }

  function localAnswer(norm) {
    if (!state) return null;
    const totals = dayTotals();
    const target = state.targets || calcTargets(state.profile);
    const budget = target.kcal + Math.round(totals.burned * 0.5);
    const leftKcal = budget - totals.kcal;
    const proteinLeft = Math.max(0, target.protein - totals.protein);
    const day = dayData();
    const waterTarget = target.waterMl || 2000;
    const water = Number(day.waterMl) || 0;
    const waterPct = Math.round((water / waterTarget) * 100);
    const minutes = day.activities.reduce((acc, activity) => acc + (Number(activity.minutes) || 0), 0);

    if (/(dor|doendo|febre|tontura|cansad|exausto|fraqueza)/.test(norm)) {
      return "Se a dor for forte, persistente ou vier com outros sintomas, procure um profissional de saúde. Posso ajudar com alimentação, água e movimento, mas não faço diagnóstico.";
    }
    if (/(jantar|sugestao|sugere|sugerir|ideia|o que posso comer)/.test(norm)) {
      const best = DINNERS
        .map((dish) => ({ ...dish, ...dishTotals(dish) }))
        .map((dish) => ({
          ...dish,
          score: Math.abs(dish.p - proteinLeft) + (dish.kcal > leftKcal ? (dish.kcal - leftKcal) / 5 : 0)
        }))
        .sort((a, b) => a.score - b.score)[0];
      return `Sugestão de jantar: ${best.name} (~${nf(best.kcal)} kcal, ${nf(best.p)} g de proteína). Faltam ${nf(proteinLeft)} g de proteína e ${nf(Math.max(0, leftKcal))} kcal no seu dia.`;
    }
    if (/(proteina|protein)/.test(norm)) {
      if (proteinLeft <= 0) return `Você já bateu a meta de proteína hoje: ${nf(totals.protein)} de ${nf(target.protein)} g.`;
      return `Faltam ${nf(proteinLeft)} g de proteína hoje. Você consumiu ${nf(totals.protein)} de ${nf(target.protein)} g.`;
    }
    if (/(agua|hidrat)/.test(norm)) {
      return `Água: ${nf(water)} de ${nf(waterTarget)} ml (${waterPct}%).`;
    }
    if (/(caloria|kcal|quanto falta|quanto posso)/.test(norm)) {
      return leftKcal >= 0
        ? `Você consumiu ${nf(totals.kcal)} kcal de ${nf(budget)}. Restam ${nf(leftKcal)} kcal hoje.`
        : `Você consumiu ${nf(totals.kcal)} kcal de ${nf(budget)}. Passou ${nf(-leftKcal)} kcal da meta.`;
    }
    if (/(como estou|resumo|meu dia|como foi)/.test(norm)) {
      return `Hoje: ${nf(totals.kcal)} de ${nf(budget)} kcal, ${nf(totals.protein)} de ${nf(target.protein)} g de proteína, ${nf(water)} de ${nf(waterTarget)} ml de água e ${nf(minutes)} min de atividade.`;
    }
    if (/^(oi|ola|bom dia|boa tarde|boa noite)\b/.test(norm)) {
      return `Oi${state.profile.name ? `, ${state.profile.name}` : ""}! Posso anotar refeições, água, atividade e peso. Também respondo quanto falta de proteína, calorias, água, uma sugestão de jantar e uma lista de compras com orçamento.`;
    }
    return null;
  }

  async function handleMessage(text) {
    if (!state.profile.aiEnabled && AI_ENDPOINT && !AI_SERVER && !loadAIKey()) await loadAIServerConfig();
    enableAIOnce();
    const norm = normalize(text);
    const question = isQuestion(text);
    const shopping = parseBudgetQuestion(text);
    if (shopping) return budgetAnswer(shopping);
    if (/(o que posso comprar|o que comprar|lista de compras|cesta de compras|cesta básica|sugestão de compras|sugestao de compras|montar.*compra)/.test(norm)) {
      return "Posso montar uma cesta de compras para você. Quanto você tem para gastar e para quantos dias? Ex.: “tenho R$ 150 para 7 dias de compras”.";
    }
    if (question && !RECORDING.test(norm)) {
      const local = localAnswer(norm);
      if (!state.profile.aiEnabled) {
        if (local) return local;
        return activeAIConfig()
          ? "A IA está disponível, mas está desligada. Ligue em Perfil para conversar livremente sobre saúde."
          : "A IA está desligada. Ligue em Perfil para perguntas abertas. Enquanto isso, posso responder sobre proteína, calorias, água, resumo e sugestão de jantar.";
      }
      const answer = await askAI(text);
      if (local && /(Não consegui falar|não foi configurada|não está configurada|Configure sua chave|offline|Muitas perguntas|A IA recusou)/i.test(answer)) {
        return `${local} (A IA não respondeu agora; resposta local.)`;
      }
      return answer;
    }
    const water = parseWater(text);
    if (water) {
      addWater(water.ml);
      const d = dayData();
      const target = state.targets?.waterMl || 2000;
      return `Anotei ${nf(water.ml)} ml de água. Hoje: ${nf(d.waterMl)} ml de ${nf(target)} ml.`;
    }
    const weight = parseWeight(text);
    if (weight) {
      const before = latestWeight();
      recordWeight(weight.kg);
      const diff = before ? weight.kg - before : 0;
      const trend = Math.abs(diff) < 0.05 ? "sem mudança" : diff < 0 ? `${nf1(Math.abs(diff))} kg a menos` : `${nf1(diff)} kg a mais`;
      return `Peso registrado: ${nf1(weight.kg)} kg (${trend} desde o último registro).`;
    }
    const activity = parseActivity(text);
    if (activity) {
      const entry = addActivity(activity);
      const label = entry.workout ? `${entry.workout} (${displayIntensity(entry.intensity)})` : entry.name;
      return `${label} por ${entry.minutes} min: cerca de ${nf(entry.kcal)} kcal gastas. Bom movimento!`;
    }
    const shoppingIntent = /\b(comprar|compra|mercado|supermercado|preço|preco|onde encontrar)\b/.test(norm);
    if (shoppingIntent && !RECORDING.test(norm)) {
      if (!state.profile.aiEnabled) {
        return activeAIConfig()
          ? "A IA está disponível, mas está desligada. Ligue em Perfil para conversar sobre compras e alimentação."
          : "A IA está desligada. Ligue em Perfil para perguntas abertas. Enquanto isso, posso anotar refeições, água, atividade e peso.";
      }
      return askAI(text);
    }
    const head = text.trim().split(/\s+/).slice(0, 3).join(" ");
    const wordQuantity = /^(?:um|uma|meio|meia|dois|duas|três|tres|quatro|cinco|seis|sete|oito|nove|dez)\b/i.test(text);
    const nearFood = findFoodHits(head).length > 0 || /\b(g|gramas?|ml|colher|colheres|xícara|xícaras|fatia|fatias|unidade|unidades|porção|porcoes|prato|pratos|copo|copos|pote|potes|lata|latas|garrafa|garrafas)\b/.test(norm);
    const looksLikeMeal = /\b(comi|tomei|bebi|registra|registre|registrar|anota|anote|anotar|adiciona|adicione|adicionar)\b/.test(norm) || /^\s*(?:\d|½|1\/2)/.test(text) || (wordQuantity && nearFood) || isFoodOnly(text);
    const meal = looksLikeMeal ? await parseMeal(text) : null;
    if (meal && meal.items.length) {
      const saved = addMeal(meal.items, meal.label);
      const list = saved.items.map((item) => `${item.name} (${nf(item.kcal)} kcal)`).join(", ");
      const totals = dayTotals();
      const left = (state.targets?.kcal || 0) - totals.kcal + Math.round(totals.burned * 0.5);
      const sources = [...new Set(saved.items.map((item) => item.source).filter(Boolean))];
      const sourceNote = sources.length ? ` Fonte: ${sources.join(", ")}.` : "";
      const missing = meal.unknown?.length
        ? ` Não encontrei dados para ${meal.unknown.map((name) => `“${name}”`).join(", ")}; não anotei esses itens.`
        : "";
      return `Anotei no ${meal.label.toLowerCase()}: ${list}. Total da refeição: ${nf(saved.kcal)} kcal. Restam ${nf(left)} kcal hoje.${sourceNote}${missing}`;
    }
    if (meal?.unknown?.length) {
      return `Não encontrei dados confiáveis para ${meal.unknown.map((name) => `“${name}”`).join(", ")}. Não vou inventar valores. Informe a porção e as kcal, ou use um alimento da tabela.`;
    }
    if (state.profile.aiEnabled) return askAI(text);
    const local = localAnswer(norm);
    if (local) return local;
    if (activeAIConfig()) return "A IA está disponível, mas está desligada. Ligue em Perfil para conversar sobre qualquer assunto de saúde.";
    return "Ainda não entendi. Tente “comi 2 ovos e um pão”, “bebi 500 ml de água”, “corri 30 min” ou “peso 78,5”.";
  }

  function pushChat(role, text) {
    if (!state) return;
    state.chat.push({ role, text, at: nowIso() });
    if (state.chat.length > CHAT_MAX) state.chat = state.chat.slice(-CHAT_MAX);
    queueSave();
  }

  function messageNode(message) {
    return h(
      "div",
      { class: `msg ${message.role === "me" ? "me" : "viva"}` },
      message.text,
      h("time", { datetime: message.at || "" }, fmtTime(message.at || nowIso()))
    );
  }

  function appendThinking() {
    const searching = state?.profile?.aiEnabled && $("#chat-search")?.checked;
    const label = searching ? "Viva está pesquisando e pensando" : "Viva está pensando";
    const node = h("div", { class: "msg viva thinking", "aria-label": label }, h("i"), h("i"), h("i"));
    $("#chat-log").append(node);
    $("#chat-log").scrollTop = $("#chat-log").scrollHeight;
    return node;
  }

  function renderChat() {
    if (!state) return;
    const log = $("#chat-log");
    log.innerHTML = "";
    const messages = state.chat.length ? state.chat : [{ role: "viva", text: WELCOME, at: nowIso() }];
    for (const message of messages) log.append(messageNode(message));
    log.scrollTop = log.scrollHeight;
    const ai = !!state.profile.aiEnabled;
    const config = activeAIConfig();
    const label = AI_PROVIDERS[config?.provider]?.label || "a IA";
    $("#ai-status").textContent = ai
      ? (config?.source === "own" ? "IA ligada — sua chave" : "IA ligada — incluída no app")
      : "IA desligada — anotações e respostas locais";
    $("#ai-dot").dataset.on = String(ai);
    $("#chat-note").textContent = ai
      ? `A pergunta, seu perfil, metas, refeições, água, atividades, peso e histórico vão para ${label}. Com a pesquisa ligada, a pergunta também consulta Wikipedia e PubMed. Seus registros ficam no Supabase.`
      : "Seus registros ficam no Supabase. Nomes de alimentos fora da tabela são buscados no Open Food Facts.";
  }

  async function sendChat(text) {
    const value = String(text || "").trim();
    if (!value || chatBusy || !state) return;
    chatBusy = true;
    const input = $("#chat-input");
    input.value = "";
    input.style.height = "auto";
    pushChat("me", value);
    renderChat();
    const thinking = appendThinking();
    let reply;
    try {
      reply = await handleMessage(value);
    } catch {
      reply = "Algo deu errado por aqui. Tente de novo.";
    }
    thinking.remove();
    pushChat("viva", reply);
    renderChat();
    chatBusy = false;
    input.focus();
  }

  function setAvatar() {
    const initial = (state?.profile?.name || user?.name || user?.email || "V").trim().charAt(0).toUpperCase() || "V";
    for (const el of $$("[data-avatar]")) {
      el.textContent = "";
      if (user?.avatar && /^https:\/\//.test(user.avatar)) {
        el.append(h("img", { src: user.avatar, alt: "" }));
      } else {
        el.textContent = initial;
      }
    }
    const name = state?.profile?.name || user?.name || "Você";
    for (const el of $$("[data-user-name]")) el.textContent = name;
    for (const el of $$("[data-user-email]")) el.textContent = user?.email || "—";
  }

  function emptyBlock(title, text) {
    return h("div", { class: "empty" }, h("strong", {}, title), text);
  }

  const ICONS = {
    sun: [["circle", { cx: 12, cy: 12, r: 4 }], ["path", { d: "M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" }]],
    bowl: [["path", { d: "M4 11h16a8 8 0 0 1-16 0Z" }], ["path", { d: "M8 7c0-1 1-1.5 1-2.5M12 7c0-1 1-1.5 1-2.5M16 7c0-1 1-1.5 1-2.5" }]],
    apple: [["path", { d: "M12 7c-3-2-6 0-6 4 0 4 3 8 6 8s6-4 6-8c0-4-3-6-6-4Z" }], ["path", { d: "M12 7V4M12 4c1.5 0 3-1 3-2" }]],
    moon: [["path", { d: "M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z" }]],
    run: [["circle", { cx: 15, cy: 5, r: 2 }], ["path", { d: "M9 21l2-6-3-3 3-4 4 2 3 3M8 12l-3 2M14 15l3 6" }]],
    dumbbell: [["path", { d: "M6 8v8M18 8v8M3 10v4M21 10v4M6 12h12" }], ["path", { d: "M9 6v12M15 6v12" }]],
    scale: [["rect", { x: 3.5, y: 5, width: 17, height: 15, rx: 3 }], ["path", { d: "M8 5V4h8v1M12 10l2.5-2" }]],
    drop: [["path", { d: "M12 3s6 6.3 6 10.5a6 6 0 0 1-12 0C6 9.3 12 3 12 3Z" }]]
  };

  function icon(name) {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.8");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    for (const [tag, attrs] of ICONS[name] || []) {
      const element = document.createElementNS(ns, tag);
      for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
      svg.append(element);
    }
    return svg;
  }

  const MEAL_ICON = { "Café da manhã": "sun", "Almoço": "bowl", "Lanche": "apple", "Jantar": "moon" };

  function renderSpark(svg, values) {
    if (!svg) return;
    svg.innerHTML = "";
    if (!values || values.length < 2) return;
    const width = 300;
    const height = 56;
    const pad = 4;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const points = values.map((value, i) => [
      pad + (i * (width - pad * 2)) / (values.length - 1),
      max === min ? height / 2 : height - pad - ((value - min) / span) * (height - pad * 2)
    ]);
    const line = points.map((point, i) => `${i ? "L" : "M"}${point[0].toFixed(1)} ${point[1].toFixed(1)}`).join(" ");
    const area = `${line} L${points[points.length - 1][0].toFixed(1)} ${height - pad} L${points[0][0].toFixed(1)} ${height - pad} Z`;
    const ns = "http://www.w3.org/2000/svg";
    const areaPath = document.createElementNS(ns, "path");
    areaPath.setAttribute("d", area);
    areaPath.setAttribute("class", "area");
    const linePath = document.createElementNS(ns, "path");
    linePath.setAttribute("d", line);
    linePath.setAttribute("class", "line");
    svg.append(areaPath, linePath);
  }

  function renderTopbar() {
    const date = new Date();
    const weekday = date.toLocaleDateString("pt-BR", { weekday: "short" }).replace(".", "");
    $("#today-label").textContent = `${weekday.charAt(0).toUpperCase()}${weekday.slice(1)}, ${fmtDay(date)}`;
    $("#greet-date").textContent = fmtLong(date);
    const hour = date.getHours();
    const salute = hour < 12 ? "Bom dia" : hour < 18 ? "Boa tarde" : "Boa noite";
    const name = state?.profile?.name ? `, ${state.profile.name.split(" ")[0]}` : "";
    $("#greet-title").textContent = `${salute}${name}.`;
    setAvatar();
  }

  function renderHomeWorkouts() {
    const host = $("#home-workout-list");
    if (!host) return;
    const workouts = (dayData().activities || []).filter(isWorkout).slice().reverse();
    const count = $("#home-workout-count");
    if (count) count.textContent = workouts.length ? `${workouts.length} treino${workouts.length === 1 ? "" : "s"}` : "—";
    host.innerHTML = "";
    if (!workouts.length) {
      host.append(emptyBlock("Nenhum treino hoje.", "Registre em Atividades: “Peito e tríceps, médio”."));
      return;
    }
    for (const activity of workouts) {
      host.append(h(
        "div",
        { class: "row" },
        h("span", { class: "r-ico", "aria-hidden": "true" }, icon("dumbbell")),
        h("div", { class: "r-main" },
          h("strong", {}, workoutTitle(activity)),
          h("small", {}, workoutMeta(activity, false))
        ),
        h("span", { class: "workout-intensity" }, displayIntensity(activity.intensity))
      ));
    }
  }

  function scaleMealItem(item, grams) {
    const next = Math.max(0, round(Number(grams) || 0));
    const old = Number(item.grams) || 0;
    const ratio = old > 0 ? next / old : 0;
    return {
      ...item,
      grams: next,
      kcal: +(Number(item.kcal || 0) * ratio).toFixed(1),
      p: +(Number(item.p || 0) * ratio).toFixed(1),
      c: +(Number(item.c || 0) * ratio).toFixed(1),
      f: +(Number(item.f || 0) * ratio).toFixed(1)
    };
  }

  function recalcMeal(meal) {
    const totals = meal.items.reduce((acc, item) => ({
      kcal: acc.kcal + Number(item.kcal || 0),
      p: acc.p + Number(item.p || 0),
      c: acc.c + Number(item.c || 0),
      f: acc.f + Number(item.f || 0)
    }), { kcal: 0, p: 0, c: 0, f: 0 });
    meal.kcal = round(totals.kcal);
    meal.p = +totals.p.toFixed(1);
    meal.c = +totals.c.toFixed(1);
    meal.f = +totals.f.toFixed(1);
  }

  function readMealItems(form, meal) {
    const inputs = $$("[data-meal-item-grams]", form);
    return meal.items.map((item, index) => {
      const value = parseNum(inputs[index]?.value);
      return scaleMealItem(item, Number.isFinite(value) ? value : item.grams);
    });
  }

  function saveMealEdit(meal, form) {
    const items = readMealItems(form, meal).filter((item) => item.grams > 0);
    if (!items.length) {
      removeMeal(meal.id);
      editingMealId = null;
      return;
    }
    meal.items = items;
    recalcMeal(meal);
    editingMealId = null;
    queueSave();
    renderToday();
    renderDiary();
    toast("Quantidades atualizadas.");
  }

  function deleteMealItem(meal, form, index) {
    const items = readMealItems(form, meal);
    items.splice(index, 1);
    const kept = items.filter((item) => item.grams > 0);
    if (!kept.length) {
      removeMeal(meal.id);
      editingMealId = null;
      return;
    }
    meal.items = kept;
    recalcMeal(meal);
    queueSave();
    renderToday();
    renderDiary();
    toast("Alimento removido.");
  }

  function mealEditor(meal) {
    const form = h("form", { class: "meal-edit", dataset: { mealEdit: meal.id }, "aria-label": `Editar ${meal.label}` });
    form.append(h("div", { class: "meal-edit-head" },
      h("strong", {}, `Editar ${meal.label}`),
      h("span", { class: "sub" }, "Quantidades em gramas")
    ));
    const list = h("ul", { class: "meal-edit-list" });
    meal.items.forEach((item, index) => {
      const kcal = h("span", { class: "e-kcal" }, `${nf(item.kcal)} kcal`);
      const input = h("input", {
        type: "number",
        min: "0",
        step: "5",
        value: item.grams,
        inputmode: "numeric",
        "data-meal-item-grams": String(index),
        "aria-label": `Quantidade de ${item.name} em gramas`,
        oninput: (event) => {
          const next = scaleMealItem(item, event.target.value);
          kcal.textContent = `${nf(next.kcal)} kcal`;
        }
      });
      list.append(h("li", { class: "meal-edit-item" },
        h("div", { class: "e-top" },
          h("span", { class: "e-name" }, item.name),
          kcal
        ),
        h("div", { class: "e-controls" },
          h("label", { class: "e-qty" }, "Qtd.", input, "g"),
          h("button", {
            class: "e-del",
            type: "button",
            "data-del-meal-item": String(index),
            onclick: () => deleteMealItem(meal, form, index),
            "aria-label": `Excluir ${item.name}`
          }, "Excluir")
        )
      ));
    });
    form.append(list);
    form.append(h("div", { class: "meal-edit-actions" },
      h("button", { class: "btn btn-primary btn-sm", type: "submit" }, "Salvar"),
      h("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: () => { editingMealId = null; renderToday(); } }, "Cancelar")
    ));
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      saveMealEdit(meal, form);
    });
    return form;
  }

  function renderToday() {
    if (!state) return;
    const totals = dayTotals();
    const target = state.targets || calcTargets(state.profile);
    const consumed = round(totals.kcal);
    const burned = round(totals.burned);
    const burnedCredit = Math.round(totals.burned * 0.5);
    const budget = target.kcal + burnedCredit;
    const remaining = target.kcal - consumed + burnedCredit;
    const pct = clamp((consumed / Math.max(1, budget)) * 100, 0, 100);

    const ring = $("#kcal-ring");
    ring.style.setProperty("--p", pct.toFixed(1));
    ring.setAttribute("aria-label", `${nf(consumed)} de ${nf(budget)} kcal consumidas`);
    $("#kcal-remaining").textContent = nf(Math.abs(remaining));
    const ringLabel = $("#kcal-ring .ring-inner span");
    if (ringLabel) ringLabel.textContent = remaining >= 0 ? "kcal restantes" : "kcal acima da meta";
    $("#kcal-of").textContent = `de ${nf(budget)} kcal`;
    $("#kcal-summary").textContent = consumed || burned
      ? `${nf(consumed)} kcal consumidas · ${nf(burned)} kcal em movimento`
      : "Nenhuma refeição anotada ainda.";

    const macros = [
      ["protein", totals.protein, target.protein, "g"],
      ["carbs", totals.carbs, target.carbs, "g"],
      ["fat", totals.fat, target.fat, "g"]
    ];
    for (const [key, value, goal, unit] of macros) {
      const percent = clamp((value / Math.max(1, goal)) * 100, 0, 100);
      const bar = $(`#macro-${key}-bar`);
      if (bar) bar.style.width = `${percent.toFixed(1)}%`;
      const label = $(`#macro-${key}`);
      if (label) label.textContent = `${round(value)} / ${round(goal)} ${unit}`;
    }

    const meals = dayData().meals;
    const mealList = $("#meal-list");
    mealList.innerHTML = "";
    if (!meals.length) {
      mealList.append(emptyBlock("Nada anotado ainda.", "Diga à Viva: “comi 2 ovos e um pão”."));
    } else {
      const order = ["Café da manhã", "Almoço", "Lanche", "Jantar"];
      const labels = [...new Set([...order, ...meals.map((meal) => meal.label)])];
      for (const label of labels) {
        const group = meals.filter((meal) => meal.label === label);
        if (!group.length) continue;
        const groupKcal = group.reduce((acc, meal) => acc + (Number(meal.kcal) || 0), 0);
        const section = h("section", { class: "meal-group" }, h("h3", {}, `${label} · ${nf(groupKcal)} kcal`));
        for (const meal of [...group].reverse()) {
          section.append(h(
            "div",
            { class: "row", dataset: { mealId: meal.id } },
            h("span", { class: "r-ico", "aria-hidden": "true" }, icon(MEAL_ICON[meal.label] || "bowl")),
            h("div", { class: "r-main" },
              h("strong", {}, meal.items.map((item) => item.name).join(" + ")),
              h("small", {}, `${meal.label} · ${fmtTime(meal.at)} · ${meal.items.map((item) => `${nf(item.grams)} g`).join(", ")}`)
            ),
            h("span", { class: "r-kcal" }, `${nf(meal.kcal)} kcal`),
            h("button", {
              class: "r-edit",
              type: "button",
              "data-edit-meal": meal.id,
              "aria-label": `Editar ${meal.label}`,
              "title": "Editar quantidades",
              "aria-expanded": String(editingMealId === meal.id),
              onclick: () => {
                editingMealId = editingMealId === meal.id ? null : meal.id;
                renderToday();
              }
            }, "✎"),
            h("button", { class: "r-del", type: "button", "data-del-meal": meal.id, "aria-label": `Remover ${meal.label}` }, "✕")
          ));
          if (editingMealId === meal.id) section.append(mealEditor(meal));
        }
        mealList.append(section);
      }
    }
    const mealTotal = $("#meal-total");
    if (mealTotal) mealTotal.textContent = `${nf(consumed)} kcal`;
    const mealSummary = $("#meal-summary");
    if (mealSummary) mealSummary.textContent = meals.length
      ? `${nf(consumed)} de ${nf(budget)} kcal · ${nf(burned)} kcal em movimento`
      : "Nenhuma refeição anotada ainda.";

    const water = Number(dayData().waterMl) || 0;
    const waterTarget = target.waterMl || 2000;
    const waterPct = clamp((water / waterTarget) * 100, 0, 100);
    $("#water-total").textContent = nf(water);
    $("#water-target").textContent = nf(waterTarget);
    $("#water-pct").textContent = `${round(waterPct)}%`;
    $("#water-fill").style.width = `${waterPct.toFixed(1)}%`;
    $("#water-track").setAttribute("aria-valuenow", String(round(waterPct)));

    const weights = state.weights || [];
    const latest = latestWeight();
    $("#weight-latest").textContent = latest ? nf1(latest) : "—";
    const delta = $("#weight-delta");
    if (weights.length >= 2) {
      const diff = Number(weights[weights.length - 1].kg) - Number(weights[weights.length - 2].kg);
      delta.textContent = `${diff > 0 ? "+" : ""}${nf1(diff)} kg`;
      delta.dataset.dir = diff < 0 ? "down" : diff > 0 ? "up" : "flat";
    } else {
      delta.textContent = "primeiro registro";
      delta.dataset.dir = "flat";
    }
    renderSpark($("#weight-spark"), weights.slice(-14).map((w) => Number(w.kg)));
    $("#weight-note").textContent = weights.length
      ? `Último registro em ${fmtDay(parseYmd(weights[weights.length - 1].date))}.`
      : "Registre seu peso pelo assistente: “peso 78,5”.";

    const activities = dayData().activities;
    const activityList = $("#activity-list");
    activityList.innerHTML = "";
    if (!activities.length) {
      activityList.append(emptyBlock("Sem atividade hoje.", "Diga: “corri 30 min” ou “caminhei 20 min”."));
    } else {
      for (const activity of [...activities].reverse()) {
        const workout = isWorkout(activity);
        const title = workout ? workoutTitle(activity) : activity.name;
        const detail = workout
          ? workoutMeta(activity)
          : `${activity.minutes} min${activity.intensity ? ` · ${activity.intensity}` : ""} · MET ${nf1(activity.met)}`;
        activityList.append(h(
          "li",
          { class: "row" },
          h("span", { class: "r-ico", "aria-hidden": "true" }, icon(workout ? "dumbbell" : "run")),
          h("div", { class: "r-main" },
            h("strong", {}, title),
            h("small", {}, detail)
          ),
          h("span", { class: "r-kcal" }, `${nf(activity.kcal)} kcal`),
          h("button", { class: "r-del", type: "button", "data-del-activity": activity.id, "aria-label": `Remover ${title}` }, "✕")
        ));
      }
    }
    $("#activity-total").textContent = `${nf(burned)} kcal`;
    renderActivitySimulator();
    renderHabits();
    renderActivityWeek();
    renderHomeWorkouts();
  }

  function renderHabits() {
    const host = $("#habit-days");
    if (!host || !state) return;
    host.innerHTML = "";
    const letters = ["D", "S", "T", "Q", "Q", "S", "S"];
    let streak = 0;
    for (let i = 0; i < 84; i += 1) {
      const data = state.days[ymd(addDays(new Date(), -i))];
      if (data && (data.meals.length || data.waterMl > 0 || data.activities.length)) streak += 1;
      else break;
    }
    for (let i = 6; i >= 0; i -= 1) {
      const date = addDays(new Date(), -i);
      const data = state.days[ymd(date)];
      const level = data
        ? Math.min(3, (data.meals.length ? 1 : 0) + (data.waterMl > 0 ? 1 : 0) + (data.activities.length ? 1 : 0))
        : 0;
      host.append(h(
        "div",
        { class: "habit-day" },
        h("i", { class: `habit-dot l${level}`, title: fmtDay(date) }),
        h("span", {}, letters[date.getDay()])
      ));
    }
    const label = $("#habit-streak");
    if (label) label.textContent = streak ? `${streak} dia${streak > 1 ? "s" : ""} no ritmo` : "Comece hoje";
  }

  function renderActivityWeek() {
    const host = $("#activity-week");
    if (!host || !state) return;
    host.innerHTML = "";
    const rows = [];
    let max = 30;
    let total = 0;
    for (let i = 6; i >= 0; i -= 1) {
      const date = addDays(new Date(), -i);
      const data = state.days[ymd(date)];
      const minutes = (data?.activities || []).reduce((acc, activity) => acc + (Number(activity.minutes) || 0), 0);
      total += minutes;
      max = Math.max(max, minutes);
      rows.push({ date, minutes });
    }
    for (const row of rows) {
      host.append(h(
        "div",
        { class: "week-bar" },
        h("b", {}, row.minutes ? String(row.minutes) : ""),
        h("div", { class: "week-track" }, h("i", { style: `height:${Math.max(4, (row.minutes / max) * 100)}%` })),
        h("span", {}, row.date.toLocaleDateString("pt-BR", { weekday: "narrow" }))
      ));
    }
    const label = $("#activity-week-total");
    if (label) label.textContent = `${nf(total)} min`;
  }

  function dashboardHasData(data) {
    return !!(data && ((data.meals && data.meals.length) || Number(data.waterMl) > 0 || (data.activities && data.activities.length)));
  }

  function dashboardKeys() {
    return Object.keys(state?.days || {}).filter((key) => dashboardHasData(state.days[key])).sort().reverse();
  }

  function dashboardRange(keys) {
    const days = keys
      .map((key) => ({ key, data: state.days[key] }))
      .filter((item) => dashboardHasData(item.data))
      .map((item) => ({ ...item, totals: dayTotals(item.key) }));
    const mealDays = days.filter((item) => item.data.meals.length);
    const waterDays = days.filter((item) => Number(item.data.waterMl) > 0);
    return {
      recorded: days.length,
      avgKcal: mealDays.length ? round(mealDays.reduce((sum, item) => sum + item.totals.kcal, 0) / mealDays.length) : 0,
      avgWater: waterDays.length ? round(waterDays.reduce((sum, item) => sum + Number(item.data.waterMl), 0) / waterDays.length) : 0,
      activityMin: days.reduce((sum, item) => sum + (item.data.activities || []).reduce((acc, act) => acc + Number(act.minutes || 0), 0), 0),
      activityKcal: days.reduce((sum, item) => sum + item.totals.burned, 0)
    };
  }

  function dashboardWeightDelta(keys) {
    const allowed = new Set(keys);
    const list = (state.weights || []).filter((item) => allowed.has(item.date));
    if (list.length < 2) return null;
    return Number(list[list.length - 1].kg) - Number(list[0].kg);
  }

  function dashboardList(rows) {
    const list = h("dl", { class: "dash-list" });
    for (const [label, value] of rows) {
      list.append(h("dt", {}, label), h("dd", {}, value));
    }
    return list;
  }

  function dashboardBlock(title, content) {
    return h("section", { class: "dash-block" }, h("h3", {}, title), content);
  }

  function renderDashboard() {
    const root = $("#dashboard-body");
    if (!root || !state) return;
    root.innerHTML = "";
    const target = state.targets || calcTargets(state.profile);
    const profile = state.profile || {};
    const latest = latestWeight();
    const imc = bmi(latest, profile.heightCm);
    const today = dayTotals();
    const todayData = dayData();
    const remaining = target.kcal - today.kcal + Math.round(today.burned * 0.5);
    const keys = dashboardKeys();
    const recentKeys = keys.slice(0, 30);
    const last7 = dashboardRange(Array.from({ length: 7 }, (_, index) => ymd(addDays(new Date(), -index))));
    const last14 = dashboardRange(Array.from({ length: 14 }, (_, index) => ymd(addDays(new Date(), -index))));
    const weight7 = dashboardWeightDelta(Array.from({ length: 7 }, (_, index) => ymd(addDays(new Date(), -index))));
    const weight14 = dashboardWeightDelta(Array.from({ length: 14 }, (_, index) => ymd(addDays(new Date(), -index))));

    const grid = h("div", { class: "dash-grid" },
      dashboardBlock("Perfil", dashboardList([
        ["Nome", profile.name || "Você"],
        ["Idade", profile.age ? `${profile.age} anos` : "—"],
        ["Altura", profile.heightCm ? `${nf1(profile.heightCm)} cm` : "—"],
        ["Peso atual", latest ? `${nf1(latest)} kg` : "—"],
        ["IMC", imc ? nf1(imc) : "—"],
        ["Objetivo", GOAL_LABELS[profile.goal] || "—"],
        ["Conta", user?.email || "Visitante"]
      ])),
      dashboardBlock("Metas", dashboardList([
        ["Calorias", `${nf(target.kcal)} kcal`],
        ["Proteína", `${nf(target.protein)} g`],
        ["Carboidratos", `${nf(target.carbs)} g`],
        ["Gordura", `${nf(target.fat)} g`],
        ["Água", `${nf1(target.waterMl / 1000)} L`]
      ])),
      dashboardBlock("Hoje", dashboardList([
        ["Consumido", `${nf(today.kcal)} kcal`],
        ["Gasto em atividade", `${nf(today.burned)} kcal`],
        [remaining >= 0 ? "Restante" : "Acima da meta", `${nf(Math.abs(remaining))} kcal`],
        ["Água", `${nf(todayData.waterMl)} ml`],
        ["Refeições", String(todayData.meals.length)],
        ["Atividade", `${nf((todayData.activities || []).reduce((sum, act) => sum + Number(act.minutes || 0), 0))} min`]
      ])),
      dashboardBlock("Últimos 7 dias", dashboardList([
        ["Média de kcal", last7.avgKcal ? `${nf(last7.avgKcal)} kcal` : "—"],
        ["Dias com registro", String(last7.recorded)],
        ["Água média", last7.avgWater ? `${nf(last7.avgWater)} ml` : "—"],
        ["Atividade", `${nf(last7.activityMin)} min`],
        ["Gasto em atividade", `${nf(last7.activityKcal)} kcal`],
        ["Variação de peso", weight7 == null ? "—" : `${weight7 > 0 ? "+" : ""}${nf1(weight7)} kg`]
      ]))
    );

    const weightBlock = dashboardBlock("Peso", dashboardList([
      ["Último peso", latest ? `${nf1(latest)} kg` : "—"],
      ["Variação em 7 dias", weight7 == null ? "—" : `${weight7 > 0 ? "+" : ""}${nf1(weight7)} kg`],
      ["Variação em 14 dias", weight14 == null ? "—" : `${weight14 > 0 ? "+" : ""}${nf1(weight14)} kg`],
      ["Registros", String((state.weights || []).length)]
    ]));

    const foodCounts = new Map();
    for (const key of recentKeys) {
      for (const meal of state.days[key].meals || []) {
        for (const item of meal.items || []) {
          const name = String(item.name || "").trim();
          if (name) foodCounts.set(name, (foodCounts.get(name) || 0) + 1);
        }
      }
    }
    const topFoods = [...foodCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    const foodsBlock = dashboardBlock("Alimentos mais registrados", topFoods.length
      ? h("ol", { class: "dash-food-list" }, topFoods.map(([name, count]) => h("li", {}, h("span", {}, name), h("strong", {}, `${count}x`))))
      : h("p", { class: "targets-note" }, "Sem refeições registradas ainda."));

    const summary = h("div", { class: "dash-grid" }, weightBlock, foodsBlock);

    const table = h("table", { class: "dash-table" },
      h("thead", {}, h("tr", {},
        h("th", {}, "Dia"),
        h("th", {}, "kcal"),
        h("th", {}, "água"),
        h("th", {}, "atividade"),
        h("th", {}, "peso")
      ))
    );
    const body = h("tbody");
    const weightByDate = new Map((state.weights || []).map((item) => [item.date, item.kg]));
    for (const key of recentKeys) {
      const data = state.days[key];
      const totals = dayTotals(key);
      const activityMinutes = (data.activities || []).reduce((sum, act) => sum + Number(act.minutes || 0), 0);
      const weight = weightByDate.get(key);
      body.append(h("tr", {},
        h("td", {}, fmtDay(parseYmd(key))),
        h("td", {}, `${nf(totals.kcal)}`),
        h("td", {}, `${nf(data.waterMl)} ml`),
        h("td", {}, `${nf(activityMinutes)} min`),
        h("td", {}, weight ? `${nf1(weight)} kg` : "—")
      ));
    }
    table.append(body);

    root.append(grid, summary,
      h("p", { class: "targets-note" }, `Últimos 14 dias: ${last14.recorded} dia(s) com registro, média de ${last14.avgKcal ? `${nf(last14.avgKcal)} kcal` : "—"} e ${nf(last14.activityMin)} min de atividade.`),
      dashboardBlock("Histórico recente", recentKeys.length ? table : h("p", { class: "targets-note" }, "Ainda não há dados para montar o histórico."))
    );
  }

  function renderDiary() {
    if (!state) return;
    const target = state.targets || calcTargets(state.profile);
    const days = [];
    for (let i = 0; i < 14; i += 1) {
      const date = addDays(new Date(), -i);
      const key = ymd(date);
      days.push({ key, date, data: state.days[key] });
    }
    const withMeals = days.filter((item) => item.data && item.data.meals.length);
    const withWater = days.filter((item) => item.data && item.data.waterMl > 0);
    const recorded = days.filter((item) => item.data && (item.data.meals.length || item.data.waterMl > 0 || item.data.activities.length));
    const avgKcal = withMeals.length ? round(withMeals.reduce((acc, item) => acc + dayTotals(item.key).kcal, 0) / withMeals.length) : 0;
    const avgWater = withWater.length ? round(withWater.reduce((acc, item) => acc + Number(item.data.waterMl), 0) / withWater.length) : 0;
    $("#diary-avg").textContent = avgKcal ? nf(avgKcal) : "—";
    $("#diary-days").textContent = String(recorded.length);
    $("#diary-water").textContent = avgWater ? `${nf1(avgWater / 1000)} L` : "—";

    const list = $("#diary-days-list");
    list.innerHTML = "";
    for (const item of days) {
      const totals = item.data ? dayTotals(item.key) : { kcal: 0, burned: 0 };
      const pct = clamp((totals.kcal / Math.max(1, target.kcal)) * 100, 0, 100);
      const weekdayRaw = item.date.toLocaleDateString("pt-BR", { weekday: "short" }).replace(".", "");
      const weekday = weekdayRaw.charAt(0).toUpperCase() + weekdayRaw.slice(1);
      const hasData = !!(item.data && (item.data.meals.length || item.data.waterMl > 0 || item.data.activities.length));
      list.append(h(
        "div",
        { class: "day" },
        h("span", { class: "d-date" }, item.date.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }), h("small", {}, weekday)),
        h("div", { class: "d-bar", role: "img", "aria-label": `${nf(totals.kcal)} de ${nf(target.kcal)} kcal` }, h("i", { style: `width:${pct.toFixed(1)}%` })),
        h("span", { class: "d-kcal" }, totals.kcal ? `${nf(totals.kcal)} kcal` : "—"),
        h("div", { class: "d-meta" },
          hasData
            ? [
                h("span", {}, icon("drop"), `${nf(item.data.waterMl)} ml`),
                h("span", {}, icon("run"), `${nf(totals.burned)} kcal`)
              ]
            : h("span", {}, "sem registros")
        )
      ));
    }

    const weights = state.weights || [];
    $("#diary-weight-count").textContent = weights.length ? `${weights.length} registro${weights.length > 1 ? "s" : ""}` : "sem registros";
    renderSpark($("#diary-weight-spark"), weights.slice(-14).map((w) => Number(w.kg)));
    const weightList = $("#diary-weight-list");
    weightList.innerHTML = "";
    if (!weights.length) {
      weightList.append(emptyBlock("Nenhum peso registrado.", "Diga “peso 78,5” para começar."));
    } else {
      const recent = weights.slice(-8);
      for (let i = recent.length - 1; i >= 0; i -= 1) {
        const item = recent[i];
        const previous = recent[i - 1];
        const delta = previous ? Number(item.kg) - Number(previous.kg) : null;
        weightList.append(h(
          "div",
          { class: "row" },
          h("span", { class: "r-ico", "aria-hidden": "true" }, icon("scale")),
          h("div", { class: "r-main" }, h("strong", {}, `${nf1(item.kg)} kg`), h("small", {}, fmtDay(parseYmd(item.date)))),
          h("span", { class: "r-kcal" }, delta == null ? "início" : `${delta > 0 ? "+" : ""}${nf1(delta)} kg`)
        ));
      }
    }
    renderDashboard();
  }

  function renderAISettings() {
    const card = $("#ai-card");
    if (!card) return;
    card.hidden = false;
    const own = loadAIKey();
    const available = !AI_ENDPOINT || !!(AI_SERVER || own);
    const provider = own?.provider || AI_SERVER?.provider || "openrouter";
    const providerLabel = AI_PROVIDERS[provider]?.label || provider;
    const source = $("#ai-source");
    if (source) source.textContent = own ? "Minha chave" : (AI_SERVER || !AI_ENDPOINT) ? "Incluída no app" : "Sem IA";
    const serverStatus = $("#ai-server-status");
    if (serverStatus) {
      serverStatus.hidden = false;
      serverStatus.textContent = AI_SERVER
        ? `IA incluída no app (${providerLabel})${AI_SERVER.vision ? " · aceita fotos" : " · sem fotos"}. Você não precisa colar chave.`
        : !AI_ENDPOINT
          ? "IA via função do Supabase. Nenhuma chave necessária."
          : "A IA do app não está configurada. Você pode usar sua própria chave abaixo.";
    }
    const switchNote = $("#ai-switch-note");
    if (switchNote) {
      switchNote.textContent = own
        ? `Usando ${providerLabel} com a sua chave.`
        : (AI_SERVER || !AI_ENDPOINT)
          ? (state?.profile?.aiEnabled
              ? "Usando a IA incluída no app. Nenhuma chave necessária."
              : "Disponível. Toque para ligar as perguntas abertas.")
          : "Adicione uma chave para liberar perguntas abertas.";
    }
    const toggle = $("#pf-ai");
    if (toggle) {
      toggle.disabled = !available;
      toggle.checked = available && !!state?.profile?.aiEnabled;
    }
    const providerSelect = $("#ai-provider");
    if (providerSelect) providerSelect.value = provider;
    const modelInput = $("#ai-model");
    if (modelInput) {
      modelInput.value = own?.model || "";
      modelInput.placeholder = `padrão: ${AI_PROVIDERS[provider]?.model || ""}`;
    }
    const keyInput = $("#ai-key");
    if (keyInput) {
      keyInput.value = "";
      keyInput.placeholder = own ? "Chave salva — cole outra para trocar" : "Cole sua chave (opcional)";
    }
    const clearButton = $("#btn-ai-clear");
    if (clearButton) clearButton.hidden = !own;
    const keyStatus = $("#ai-key-status");
    if (keyStatus) {
      keyStatus.textContent = own
        ? `Chave salva neste navegador (${providerLabel}${own.model ? ` · ${own.model}` : ""}).`
        : "Nenhuma chave própria. A IA incluída no app será usada quando disponível.";
    }
    updatePhotoAvailability();
  }

  function saveAISettings() {
    const provider = $("#ai-provider")?.value || "openrouter";
    const model = ($("#ai-model")?.value || "").trim();
    const key = ($("#ai-key")?.value || "").trim();
    const existing = loadAIKey();
    if (!key && !existing) {
      toast("Cole sua chave de IA.");
      return;
    }
    if (!key && existing && existing.provider !== provider) {
      toast("Cole a chave do novo provedor.");
      return;
    }
    saveAIKey({ provider, model, key: key || existing.key });
    if (state?.profile) {
      state.profile.aiEnabled = true;
      state.profile.aiChoice = "on";
      queueSave();
    }
    renderAISettings();
    renderChat();
    toast("Chave salva só neste navegador.");
  }

  function clearAISettings() {
    clearAIKey();
    if (state?.profile) {
      state.profile.aiEnabled = !!AI_SERVER;
      state.profile.aiChoice = AI_SERVER ? "on" : "auto";
    }
    const toggle = $("#pf-ai");
    if (toggle) toggle.checked = !!state?.profile?.aiEnabled;
    if (state) queueSave();
    renderChat();
    renderAISettings();
    toast(AI_SERVER ? "Chave própria removida. A IA do app continua disponível." : "Chave removida. IA desligada.");
  }

  function updatePhotoAvailability() {
    const status = $("#photo-status");
    const analyze = $("#photo-analyze");
    const note = $("#photo-note");
    if (!status) return;
    const config = activeAIConfig();
    if (!config) {
      status.textContent = "IA não configurada";
      if (analyze) analyze.disabled = true;
      if (note) note.textContent = "Para calcular por foto, adicione uma chave de IA em Perfil ou configure a IA do app.";
      return;
    }
    if (!config.vision) {
      status.textContent = "Provedor sem fotos";
      if (analyze) analyze.disabled = true;
      if (note) note.textContent = `O ${AI_PROVIDERS[config.provider]?.label || config.provider} não analisa imagens. Use OpenAI, Gemini ou OpenRouter.`;
      return;
    }
    if (analyze) analyze.disabled = !PHOTO.dataUrl || photoBusy;
    status.textContent = photoBusy
      ? "Analisando…"
      : !PHOTO.dataUrl
        ? "Aguardando foto"
        : PHOTO.state === "ok"
          ? "Estimativa pronta"
          : PHOTO.state === "error"
            ? "Sem estimativa"
            : "Foto pronta";
    if (note) note.textContent = "A foto é enviada ao provedor de IA e não é salva no Supabase.";
  }

  function loadPhotoElement(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
      image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Não consegui abrir esta imagem.")); };
      image.src = url;
    });
  }

  async function preparePhoto(file) {
    if (!file || !String(file.type).startsWith("image/")) throw new Error("Escolha uma foto.");
    if (file.size > PHOTO_MAX_BYTES) throw new Error("A foto é grande demais. Use uma imagem de até 12 MB.");
    const image = await loadPhotoElement(file);
    const scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Seu navegador não conseguiu preparar a foto.");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.82);
  }

  async function handlePhotoFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await preparePhoto(file);
      PHOTO.dataUrl = dataUrl;
      PHOTO.items = [];
      PHOTO.total = 0;
      PHOTO.state = "idle";
      const preview = $("#photo-preview");
      if (preview) preview.src = dataUrl;
      const wrap = $("#photo-preview-wrap");
      if (wrap) wrap.hidden = false;
      const result = $("#photo-result");
      if (result) result.innerHTML = "";
      const add = $("#photo-add");
      if (add) add.hidden = true;
      updatePhotoAvailability();
    } catch (error) {
      toast(error.message || "Não consegui abrir a foto.");
      resetPhoto();
    }
  }

  function resetPhoto() {
    PHOTO.dataUrl = "";
    PHOTO.items = [];
    PHOTO.total = 0;
    PHOTO.state = "idle";
    photoBusy = false;
    const input = $("#photo-input");
    if (input) input.value = "";
    const preview = $("#photo-preview");
    if (preview) preview.removeAttribute("src");
    const wrap = $("#photo-preview-wrap");
    if (wrap) wrap.hidden = true;
    const result = $("#photo-result");
    if (result) result.innerHTML = "";
    const add = $("#photo-add");
    if (add) add.hidden = true;
    const button = $("#photo-analyze");
    if (button) button.textContent = "Analisar foto";
    updatePhotoAvailability();
  }

  function parseDishAnswer(answer) {
    const text = String(answer || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    let data;
    try {
      data = JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
    const raw = Array.isArray(data.items) ? data.items.slice(0, 10) : [];
    const items = raw.map((item) => {
      const name = String(item?.name || "").trim().slice(0, 80);
      const grams = parseNum(item?.grams);
      const kcal = parseNum(item?.kcal);
      if (!name || !(grams > 0) || !(kcal > 0)) return null;
      return {
        name,
        grams: round(clamp(grams, 1, 2000)),
        kcal: round(clamp(kcal, 1, 5000)),
        protein: +clamp(parseNum(item?.protein ?? item?.p) || 0, 0, 500).toFixed(1),
        carbs: +clamp(parseNum(item?.carbs ?? item?.c) || 0, 0, 500).toFixed(1),
        fat: +clamp(parseNum(item?.fat ?? item?.f) || 0, 0, 500).toFixed(1)
      };
    }).filter(Boolean);
    if (!items.length) return null;
    const confidence = ["baixa", "media", "alta"].includes(String(data.confidence || "").toLowerCase())
      ? String(data.confidence).toLowerCase()
      : "media";
    return {
      items,
      total: round(items.reduce((sum, item) => sum + item.kcal, 0)),
      confidence,
      note: String(data.note || "").trim().slice(0, 240)
    };
  }

  function renderDishResult(parsed) {
    const result = $("#photo-result");
    if (!result) return;
    result.innerHTML = "";
    const total = h("div", { class: "photo-total" },
      h("strong", {}, `≈ ${nf(parsed.total)} kcal`),
      h("span", { class: "sub" }, `${parsed.items.length} ${parsed.items.length === 1 ? "item" : "itens"}`)
    );
    const list = h("ul", { class: "photo-items" });
    for (const item of parsed.items) {
      list.append(h("li", {},
        h("span", {}, item.name),
        h("span", {}, `${nf(item.grams)} g · ${nf(item.kcal)} kcal`)
      ));
    }
    result.append(total, list);
    if (parsed.note) result.append(h("p", { class: "targets-note" }, `Confiança ${CONFIDENCE_LABELS[parsed.confidence] || parsed.confidence}. ${parsed.note}`));
    const add = $("#photo-add");
    if (add) {
      add.hidden = false;
      add.textContent = `Adicionar ao ${detectMealLabel("").toLowerCase()}`;
    }
  }

  async function analyzeDishPhoto() {
    if (!PHOTO.dataUrl || photoBusy) return;
    photoBusy = true;
    updatePhotoAvailability();
    const button = $("#photo-analyze");
    if (button) button.textContent = "Analisando…";
    const result = $("#photo-result");
    if (result) result.innerHTML = "";
    const add = $("#photo-add");
    if (add) add.hidden = true;
    try {
      const answer = await askAI("Analise a foto do prato e estime os alimentos, as porções e as calorias.", { image: PHOTO.dataUrl });
      const parsed = parseDishAnswer(answer);
      if (parsed) {
        PHOTO.items = parsed.items;
        PHOTO.total = parsed.total;
        PHOTO.state = "ok";
        renderDishResult(parsed);
      } else {
        PHOTO.items = [];
        PHOTO.total = 0;
        PHOTO.state = "error";
        if (result) result.textContent = answer || "Não consegui estimar esta foto. Tente outra foto ou registre pelo texto.";
      }
    } catch {
      PHOTO.state = "error";
      if (result) result.textContent = "Não consegui analisar agora. Verifique a conexão e tente de novo.";
    } finally {
      photoBusy = false;
      if (button) button.textContent = "Analisar foto";
      updatePhotoAvailability();
    }
  }

  function addPhotoMeal() {
    if (!PHOTO.items.length) return;
    const label = detectMealLabel("");
    const items = PHOTO.items.map((item) => ({
      name: item.name,
      grams: item.grams,
      kcal: item.kcal,
      p: item.protein,
      c: item.carbs,
      f: item.fat
    }));
    const saved = addMeal(items, label);
    toast(`${label}: ${nf(saved.kcal)} kcal adicionadas.`);
    resetPhoto();
  }

  function renderProfile() {
    if (!state) return;
    const target = state.targets || calcTargets(state.profile);
    const form = $("#profile-form");
    if (form && !form.contains(document.activeElement)) {
      const decimal = (value) => (value == null || value === "" ? "" : String(value).replace(".", ","));
      $("#pf-name").value = state.profile.name || "";
      $("#pf-age").value = state.profile.age ?? "";
      $("#pf-height").value = decimal(state.profile.heightCm);
      $("#pf-weight").value = decimal(state.profile.weightKg);
      $("#pf-goal").value = state.profile.goal || "maintain";
    }
    $("#pf-ai").checked = !!state.profile.aiEnabled;
    renderAISettings();
    $("#targets-summary").textContent = `${nf(target.kcal)} kcal · ${target.protein} g proteína`;
    const last = state.weights.length ? state.weights[state.weights.length - 1] : null;
    const lastText = last ? `último peso ${nf1(last.kg)} kg em ${fmtDay(parseYmd(last.date))}` : "sem registro de peso";
    $("#profile-targets-note").textContent = `IMC ${nf1(bmi(state.profile.weightKg, state.profile.heightCm))} · água ${nf1(target.waterMl / 1000)} L · ${lastText}. Salve para recalcular as metas.`;
    setAvatar();
  }

  function renderAll() {
    if (!state) return;
    renderTopbar();
    renderToday();
    renderDiary();
    renderProfile();
    renderChat();
  }

  function exportData() {
    const payload = {
      app: "Viva",
      version: VERSION,
      exportedAt: nowIso(),
      account: { email: user?.email || "" },
      data: state
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = h("a", { href: url, download: `viva-dados-${ymd()}.json` });
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast("Exportação pronta.");
  }

  function disarmDelete() {
    deleteArmed = 0;
    const button = $("#btn-delete");
    if (!button) return;
    button.dataset.armed = "false";
    button.textContent = "Apagar todos os dados";
    $("#delete-hint").textContent = "";
  }

  function armDelete() {
    const button = $("#btn-delete");
    if (Date.now() > deleteArmed) {
      deleteArmed = Date.now() + 5000;
      button.dataset.armed = "true";
      button.textContent = "Toque de novo para apagar tudo";
      $("#delete-hint").textContent = "Você tem 5 segundos para confirmar. Isso apaga o diário desta conta.";
      setTimeout(() => { if (deleteArmed && Date.now() >= deleteArmed) disarmDelete(); }, 5100);
      return;
    }
    disarmDelete();
    wipeAll();
  }

  async function wipeAll() {
    const button = $("#btn-delete");
    button.disabled = true;
    button.textContent = "Apagando…";
    try {
      const res = await apiFetch(`/rest/v1/viva_data?user_id=eq.${user.id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) throw new ApiError("delete", res.status);
      clearAIKey();
      state = emptyState();
      const form = $("#profile-form");
      if (form) form.reset();
      prepareOnboarding();
      show("screen-onboarding");
      toast("Dados apagados.");
    } catch {
      toast("Não consegui apagar agora. Tente de novo.");
    } finally {
      button.disabled = false;
      disarmDelete();
    }
  }

  function removeMeal(id) {
    const d = dayData();
    const index = d.meals.findIndex((meal) => meal.id === id);
    if (index < 0) return;
    d.meals.splice(index, 1);
    if (editingMealId === id) editingMealId = null;
    queueSave();
    renderToday();
    renderDiary();
    toast("Refeição removida.");
  }

  function removeActivity(id) {
    const d = dayData();
    const index = d.activities.findIndex((activity) => activity.id === id);
    if (index < 0) return;
    d.activities.splice(index, 1);
    queueSave();
    renderToday();
    toast("Atividade removida.");
  }

  async function toggleAI() {
    const on = $("#pf-ai").checked;
    if (AI_ENDPOINT && on && !AI_SERVER && !loadAIKey()) await loadAIServerConfig();
    const config = activeAIConfig();
    if (on && AI_ENDPOINT && !config) {
      $("#pf-ai").checked = false;
      state.profile.aiEnabled = false;
      queueSave();
      renderChat();
      renderAISettings();
      toast("Adicione sua chave ou use a IA incluída no app. Enquanto isso, as respostas locais continuam.");
      return;
    }
    state.profile.aiEnabled = on;
    state.profile.aiChoice = on ? "on" : "off";
    queueSave();
    renderChat();
    renderAISettings();
    toast(on
      ? (config?.source === "own" ? "IA ligada. Cada pergunta usa a sua chave." : "IA ligada. Nenhuma chave necessária.")
      : "IA desligada.");
  }

  function updateOnline() {
    const offline = !navigator.onLine;
    const bar = $("#offline-bar");
    if (bar) bar.hidden = !offline;
    if (offline) {
      setSync("offline");
      return;
    }
    if (dirty) saveNow();
  }

  function syncChatViewport() {
    const viewport = window.visualViewport;
    if (!viewport) return;
    document.documentElement.style.setProperty("--vv-height", `${Math.round(viewport.height)}px`);
    document.documentElement.style.setProperty("--vv-top", `${Math.round(viewport.offsetTop)}px`);
    if (!document.body.classList.contains("chat-typing")) return;
    if (document.activeElement !== $("#chat-input") && !keyboardOpen()) {
      document.body.classList.remove("chat-typing");
      return;
    }
    requestAnimationFrame(keepChatVisible);
  }

  function keyboardOpen() {
    const viewport = window.visualViewport;
    return !!viewport && window.innerHeight - viewport.height > 120;
  }

  function keepChatVisible() {
    const log = $("#chat-log");
    if (log) log.scrollTop = log.scrollHeight;
  }

  function autoGrow() {
    const input = $("#chat-input");
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
  }

  function bind() {
    if (CFG.AUTH_GOOGLE === false) $("#btn-google").hidden = true;
    $("#btn-google").addEventListener("click", startLogin);
    const anon = $("#btn-anon");
    if (anon) anon.addEventListener("click", loginAnonymous);
    $("#onb-form").addEventListener("submit", submitOnboarding);
    for (const id of ["onb-age", "onb-height", "onb-weight"]) $("#" + id).addEventListener("input", updateOnboardingPreview);
    for (const radio of $$("input[name=goal]")) radio.addEventListener("change", updateOnboardingPreview);
    $("#profile-form").addEventListener("submit", submitProfile);
    $("#pf-ai").addEventListener("change", toggleAI);
    $("#btn-ai-save")?.addEventListener("click", saveAISettings);
    $("#btn-ai-clear")?.addEventListener("click", clearAISettings);
    $("#ai-provider")?.addEventListener("change", () => {
      const model = $("#ai-model");
      if (model) model.placeholder = `padrão: ${AI_PROVIDERS[$("#ai-provider").value]?.model || ""}`;
    });
    $("#btn-water-250").addEventListener("click", () => addWater(250));
    $("#btn-water-500").addEventListener("click", () => addWater(500));
    $("#btn-water-undo").addEventListener("click", undoWater);
    $("#btn-export").addEventListener("click", exportData);
    $("#btn-delete").addEventListener("click", armDelete);
    $("#btn-logout").addEventListener("click", logout);
    $("#btn-install").addEventListener("click", async () => {
      if (!installPrompt) return;
      installPrompt.prompt();
      await installPrompt.userChoice;
      installPrompt = null;
      $("#btn-install").hidden = true;
    });
    for (const button of $$("[data-view]")) button.addEventListener("click", () => setView(button.dataset.view));
    for (const button of $$("[data-quick]")) {
      button.addEventListener("click", () => {
        const action = button.dataset.quick;
        if (action === "water") {
          addWater(250);
          toast("+250 ml de água.");
        } else if (action === "diary") {
          setView("diario");
        } else {
          setView("viva");
          const input = $("#chat-input");
          if (action === "weight") input.value = "peso ";
          input.focus();
          autoGrow();
        }
      });
    }
    for (const button of $$("[data-focus-chat]")) {
      button.addEventListener("click", () => {
        setView("viva");
        $("#chat-input").focus();
      });
    }
    for (const button of $$("[data-chat-prompt]")) {
      button.addEventListener("click", () => {
        setView("viva");
        const input = $("#chat-input");
        input.value = button.dataset.chatPrompt || "";
        input.focus();
        autoGrow();
      });
    }
    $("#chat-form").addEventListener("submit", (event) => {
      event.preventDefault();
      sendChat($("#chat-input").value);
    });
    $("#chat-input").addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        sendChat($("#chat-input").value);
      }
    });
    $("#chat-input").addEventListener("focus", () => {
      document.body.classList.add("chat-typing");
      syncChatViewport();
      requestAnimationFrame(keepChatVisible);
      setTimeout(keepChatVisible, 260);
    });
    $("#chat-input").addEventListener("blur", () => {
      setTimeout(() => {
        if (document.activeElement === $("#chat-input") || keyboardOpen()) return;
        document.body.classList.remove("chat-typing");
      }, 180);
    });
    $("#chat-input").addEventListener("input", () => {
      autoGrow();
      if (document.body.classList.contains("chat-typing")) keepChatVisible();
    });
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", syncChatViewport);
      window.visualViewport.addEventListener("scroll", syncChatViewport);
    }
    syncChatViewport();
    for (const suggestion of $$("[data-sug]")) suggestion.addEventListener("click", () => sendChat(suggestion.dataset.sug));
    $("#meal-list").addEventListener("click", (event) => {
      const button = event.target.closest("[data-del-meal]");
      if (button) removeMeal(button.dataset.delMeal);
    });
    $("#activity-list").addEventListener("click", (event) => {
      const button = event.target.closest("[data-del-activity]");
      if (button) removeActivity(button.dataset.delActivity);
    });
    const simActivity = $("#sim-activity");
    if (simActivity) simActivity.addEventListener("change", () => {
      SIM.activity = Number(simActivity.value) || 0;
      renderActivitySimulator();
    });
    const simIntensity = $("#sim-intensity");
    if (simIntensity) simIntensity.addEventListener("change", () => {
      SIM.intensity = Number(simIntensity.value) || 0;
      renderActivitySimulator();
    });
    const simMinutes = $("#sim-minutes");
    if (simMinutes) simMinutes.addEventListener("input", () => {
      SIM.minutes = Number(simMinutes.value) || 30;
      renderActivitySimulator();
    });
    const simAdd = $("#sim-add");
    if (simAdd) simAdd.addEventListener("click", addSimulatedActivity);
    const workoutForm = $("#workout-form");
    if (workoutForm) workoutForm.addEventListener("submit", addWorkout);
    const budgetForm = $("#budget-form");
    if (budgetForm) budgetForm.addEventListener("submit", submitBudget);
    const homeWorkoutAdd = $("#home-workout-add");
    if (homeWorkoutAdd) homeWorkoutAdd.addEventListener("click", () => setView("atividades"));
    $("#photo-input")?.addEventListener("change", handlePhotoFile);
    $("#photo-analyze")?.addEventListener("click", analyzeDishPhoto);
    $("#photo-clear")?.addEventListener("click", resetPhoto);
    $("#photo-add")?.addEventListener("click", addPhotoMeal);
    $("#btn-dashboard-print")?.addEventListener("click", () => window.print());
    window.addEventListener("online", updateOnline);
    window.addEventListener("offline", updateOnline);
    window.addEventListener("beforeinstallprompt", (event) => {
      event.preventDefault();
      installPrompt = event;
      $("#btn-install").hidden = false;
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && loadSession()) ensureSession();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && deleteArmed) disarmDelete();
    });
    setInterval(() => {
      if (loadSession()) ensureSession();
    }, 5 * 60 * 1000);
  }

  async function boot() {
    bind();
    if ("serviceWorker" in navigator && !/[?&]sw=0/.test(location.search) && location.protocol !== "file:") {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }
    updateOnline();

    if (!SB || !KEY || /SEU-PROJETO|SUA-CHAVE/.test(SB + KEY)) {
      show("screen-config");
      return;
    }

    const hash = location.hash.replace("#", "");
    currentView = ["hoje", "viva", "alimentacao", "atividades", "diario", "perfil"].includes(hash)
      ? hash
      : localStorage.getItem(LS_VIEW) || "hoje";

    try {
      if (await handleCallback()) return;
      const session = await ensureSession();
      if (!session) {
        show("screen-login");
        return;
      }
      storeSession(session);
      user = session.user;
      show("boot");
      await enterApp();
      if (/[?&]acao=refeicao/.test(location.search)) {
        setView("viva");
        setTimeout(() => $("#chat-input").focus(), 60);
      }
    } catch (error) {
      console.error(error);
      show("screen-login");
      toast(error && error.status === 401 ? "Sessão expirada. Entre de novo." : "Não consegui carregar seus dados. Tente de novo.");
    }
  }

  boot();
})();
