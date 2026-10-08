# Film studios worksheet

One static page (`index.html`, served by GitHub Pages) for checking which studio licenses each Wonder Local film (`films.hf_we` is `we` or `both`), and archiving films.
Sign in with your staff login (the same one as the dashboard).

- Each film has a studio dropdown. "Other…" adds a new studio name, which every other film can then pick.
- "Archive" marks a film as archived (`films.archived_at`).
- Nothing is saved until you press **Done**. New studio names are created in Supabase then.

Backend: Supabase edge function `film-studios-api` (source in `supabase/functions/`), project `nwchcduhlhhppvyhxbpo`.
Redeploy it with `verify_jwt: false`, since it does its own auth against `public.staff_users`.

`?demo` runs the page on fake data with no backend.
