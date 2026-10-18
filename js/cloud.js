import {
  getDB,
  replaceFromCloud,
  setCloudPersistHandler,
} from "./storage.js";

const SUPABASE_URL = "https://wdqqnkwzlhtjpenxjkon.supabase.co";
const SUPABASE_PUBLISHABLE_KEY =
  "sb_publishable__OAtcTA4MzVjrQJdmu36fw_L4hHq-Su";
const ROW_ID = "main";

let client;
let revision = -1;
let active = false;
let timer;
let queued;
let userId = "";

function status(message, error = "") {
  document.dispatchEvent(
    new CustomEvent("veyro:cloud-status", { detail: { message, error } }),
  );
}

function showLogin(show) {
  document.querySelector("#cloud-login")?.classList.toggle("hidden", !show);
}

async function loadCloudState() {
  status("Pobieranie wspólnych danych…");
  const { data, error } = await client
    .from("veyro_state")
    .select("data, revision, updated_at")
    .eq("id", ROW_ID)
    .maybeSingle();
  if (error) throw error;

  if (data) {
    revision = Number(data.revision);
    replaceFromCloud(data.data);
  } else {
    await saveNow(getDB());
  }
  active = true;
  status("Zapisano w chmurze");
}

async function saveNow(next) {
  const expected = revision;
  status("Zapisywanie…");
  const { data, error } = await client.rpc("veyro_save_state", {
    p_data: next,
    p_expected_revision: expected,
  });
  if (error) {
    if (error.code === "40001") {
      active = false;
      status(
        "Wymagane odświeżenie",
        "Dane zostały zmienione na drugim komputerze. Odśwież stronę, aby nie nadpisać zmian.",
      );
      return;
    }
    status("Błąd zapisu", error.message || "Nie udało się zapisać danych.");
    return;
  }
  revision = Number(data);
  status("Zapisano w chmurze");
}

function queueSave(next) {
  if (!active) return;
  queued = next;
  clearTimeout(timer);
  timer = setTimeout(async () => {
    const snapshot = queued;
    queued = null;
    await saveNow(snapshot);
  }, 450);
}

function subscribe() {
  client
    .channel("veyro-state")
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "veyro_state", filter: `id=eq.${ROW_ID}` },
      (payload) => {
        const nextRevision = Number(payload.new.revision);
        if (payload.new.updated_by !== userId && nextRevision > revision) {
          revision = nextRevision;
          replaceFromCloud(payload.new.data);
          status("Zsynchronizowano zmiany");
        }
      },
    )
    .subscribe();
}

async function startSession(session) {
  userId = session.user.id;
  showLogin(false);
  const logout = document.querySelector("#cloud-logout");
  if (logout) logout.hidden = false;
  setCloudPersistHandler(queueSave);
  await loadCloudState();
  subscribe();
}

export async function initializeCloud() {
  const form = document.querySelector("#cloud-login-form");
  if (!window.supabase?.createClient) {
    status("Brak połączenia", "Nie udało się załadować połączenia z Supabase.");
    showLogin(true);
    return;
  }
  client = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });

  document.querySelector("#cloud-logout")?.addEventListener("click", async () => {
    active = false;
    clearTimeout(timer);
    queued = null;
    setCloudPersistHandler(null);
    await client.removeAllChannels();
    await client.auth.signOut();
    userId = "";
    revision = -1;
    document.querySelector("#cloud-logout").hidden = true;
    form?.reset();
    showLogin(true);
    status("Wylogowano");
  });

  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const errorBox = document.querySelector("#cloud-login-error");
    errorBox.textContent = "";
    errorBox.classList.remove("visible");
    const fields = new FormData(form);
    const { data, error } = await client.auth.signInWithPassword({
      email: String(fields.get("email") || "").trim(),
      password: String(fields.get("password") || ""),
    });
    if (error) {
      errorBox.textContent = "Nieprawidłowy e-mail lub hasło.";
      errorBox.classList.add("visible");
      return;
    }
    await startSession(data.session);
  });

  const { data } = await client.auth.getSession();
  if (data.session) await startSession(data.session);
  else {
    status("Zaloguj się, aby otworzyć dane");
    showLogin(true);
  }
}
