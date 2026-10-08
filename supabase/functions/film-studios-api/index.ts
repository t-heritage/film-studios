import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Film studios worksheet API (t-heritage/film-studios on GitHub Pages).
// Covers the Wonder Local catalogue only: films with hf_we 'we' or 'both',
// the same set the site lists.
// Every action is POST {action, ...}. Sign-in uses the shared staff logins
// (public.staff_users); the browser never touches the database directly.
//
//   login {username, password}            -> {token, name}
//   load  {token}                         -> {films, studios}
//   save  {token, changes: [{id, studio_id?, new_studio?, archived?}]}
//                                         -> {saved, created, films, studios}
//
// A token is "<staff id>.<expiry>.<hmac>", signed over the staff user's
// password hash, so switching the login off or changing its password ends
// every worksheet session.

const ALLOWED_ORIGINS = [/^https:\/\/t-heritage\.github\.io$/, /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/];
const SESSION_HOURS = 12;
const MAX_STUDIO_NAME = 120;
const CATALOGUE = ["we", "both"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const sb = () => createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

class UserError extends Error {}

Deno.serve(async (req) => {
  const origin = req.headers.get("Origin") ?? "";
  const cors = {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.some((r) => r.test(origin)) ? origin : "https://t-heritage.github.io",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    switch (body.action) {
      case "login": return json(await login(body));
      case "load": await staffFromToken(body.token); return json(await load());
      case "save": return json(await save(await staffFromToken(body.token), body.changes));
      default: throw new UserError("Unknown action");
    }
  } catch (e) {
    if (e instanceof UserError) return json({ error: e.message }, e.message === "Unauthorized" ? 401 : 400);
    console.error(e);
    return json({ error: "Something went wrong" }, 500);
  }
});

// ------------------------------------------------------------------ actions

async function login(body: { username?: string; password?: string }) {
  const username = String(body.username ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  if (!username || !password) throw new UserError("Enter your username and password");
  const { data } = await sb().from("staff_users")
    .select("id, username, name, active, password_hash")
    .eq(username.includes("@") ? "email" : "username", username).maybeSingle();
  if (!data || !data.active || !(await verifyPassword(password, data.password_hash))) {
    throw new UserError("That username and password don't match");
  }
  await sb().from("staff_users").update({ last_login_at: new Date().toISOString() }).eq("id", data.id);
  const exp = Date.now() + SESSION_HOURS * 3600_000;
  return { token: `${data.id}.${exp}.${await sign(`${data.id}.${exp}`, data.password_hash)}`, name: data.name || data.username };
}

async function load() {
  const supabase = sb();
  const [films, studios] = await Promise.all([
    supabase.from("films").select("id, title, studio_id, archived_at").in("hf_we", CATALOGUE).order("title"),
    supabase.from("studios").select("id, name").eq("is_test", false).order("name"),
  ]);
  if (films.error || studios.error) throw new Error(films.error?.message ?? studios.error?.message);
  return {
    films: films.data.map((f) => ({ id: f.id, title: f.title, studio_id: f.studio_id, archived: !!f.archived_at })),
    studios: studios.data,
  };
}

type Change = { id: string; studio_id?: string | null; new_studio?: string; archived?: boolean };

async function save(staff: { username: string }, raw: unknown) {
  if (!Array.isArray(raw) || !raw.length) throw new UserError("Nothing to save");
  if (raw.length > 1000) throw new UserError("Too many changes at once");
  const supabase = sb();

  const { data: studioRows, error: sErr } = await supabase.from("studios").select("id, name").eq("is_test", false);
  if (sErr) throw new Error(sErr.message);
  const studioIds = new Set(studioRows.map((s) => s.id));
  const byName = new Map(studioRows.map((s) => [s.name.trim().toLowerCase(), s.id]));

  const ids = raw.map((c: any) => c?.id).filter((id: unknown) => typeof id === "string" && UUID.test(id));
  const { data: allowed, error: fErr } = await supabase.from("films").select("id").in("id", ids).in("hf_we", CATALOGUE);
  if (fErr) throw new Error(fErr.message);
  const filmIds = new Set(allowed.map((f) => f.id));

  const changes: Change[] = raw.map((c: any) => {
    if (!c || typeof c.id !== "string" || !UUID.test(c.id)) throw new UserError("A change is missing its film");
    if (!filmIds.has(c.id)) throw new UserError("A film isn't in the Wonder Local catalogue. Reload and try again.");
    const out: Change = { id: c.id };
    if (typeof c.new_studio === "string") {
      const name = c.new_studio.trim().replace(/\s+/g, " ");
      if (!name || name.length > MAX_STUDIO_NAME) throw new UserError("A new studio name is empty or too long");
      out.new_studio = name;
    } else if ("studio_id" in c) {
      if (c.studio_id !== null && !studioIds.has(c.studio_id)) throw new UserError("A studio no longer exists. Reload and try again.");
      out.studio_id = c.studio_id;
    }
    if (typeof c.archived === "boolean") out.archived = c.archived;
    return out;
  });

  // New studios typed as "Other": reuse a studio with the same name, else create it once.
  const created: string[] = [];
  for (const c of changes) {
    if (!c.new_studio) continue;
    const key = c.new_studio.toLowerCase();
    let id = byName.get(key);
    if (!id) {
      const { data, error } = await supabase.from("studios")
        .insert({ name: c.new_studio, country: "AU", is_test: false }).select("id").single();
      if (error) throw new Error(error.message);
      id = data.id;
      byName.set(key, id);
      created.push(c.new_studio);
    }
    c.studio_id = id;
  }

  const now = new Date().toISOString();
  let saved = 0;
  for (let i = 0; i < changes.length; i += 20) {
    const results = await Promise.all(changes.slice(i, i + 20).map(async (c) => {
      const patch: Record<string, unknown> = {};
      if (c.studio_id !== undefined) patch.studio_id = c.studio_id;
      if (c.archived === false) Object.assign(patch, { archived_at: null, archived_by: null });
      if (Object.keys(patch).length) {
        const { error } = await supabase.from("films").update({ ...patch, updated_at: now }).eq("id", c.id);
        if (error) throw new Error(error.message);
      }
      // Keep the original archive time when a film is already archived.
      if (c.archived === true) {
        const { error } = await supabase.from("films")
          .update({ archived_at: now, archived_by: staff.username, updated_at: now })
          .eq("id", c.id).is("archived_at", null);
        if (error) throw new Error(error.message);
      }
      return 1;
    }));
    saved += results.length;
  }

  return { saved, created, ...(await load()) };
}

// ------------------------------------------------------------------ auth

async function staffFromToken(token: unknown): Promise<{ id: string; username: string }> {
  const [id, exp, sig] = typeof token === "string" ? token.split(".") : [];
  if (!id || !UUID.test(id) || !exp || !sig || Number(exp) < Date.now()) throw new UserError("Unauthorized");
  const { data } = await sb().from("staff_users").select("id, username, active, password_hash").eq("id", id).maybeSingle();
  if (!data || !data.active || !data.password_hash) throw new UserError("Unauthorized");
  if (!timingSafeEqual(sig, await sign(`${id}.${exp}`, data.password_hash))) throw new UserError("Unauthorized");
  return { id: data.id, username: data.username };
}

async function sign(payload: string, passwordHash: string): Promise<string> {
  const secret = `${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}:film-studios`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${payload}.${passwordHash}`));
  return b64(new Uint8Array(mac)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, key, 256);
  return new Uint8Array(bits);
}

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [scheme, iterStr, saltB64, hashB64] = stored.split("$");
  if (scheme !== "pbkdf2") return false;
  return timingSafeEqual(b64(await pbkdf2(password, unb64(saltB64), parseInt(iterStr, 10))), hashB64);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
