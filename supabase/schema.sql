-- À coller dans Supabase > SQL Editor, puis « Run ».
-- Le script peut être relancé sans risque (il ne recrée pas ce qui existe).

-- ------------------------------------------------------------ réglages
create table if not exists settings (
  id int primary key default 1 check (id = 1)
);
insert into settings (id) values (1) on conflict do nothing;

alter table settings
  add column if not exists name_variants    text[]  not null default '{}',
  add column if not exists youtube_channels text[]  not null default '{"https://www.youtube.com/@BFM-Marseille","https://www.youtube.com/@BFMTV"}',
  add column if not exists tiktok_accounts  text[]  not null default '{}',
  add column if not exists instagram_accounts text[] not null default '{}',
  add column if not exists max_quality      int     not null default 2160,   -- 2160 = jusqu'à 4K, 1080 = 1080p max
  add column if not exists pages            text[]  not null default '{"https://www.bfmtv.com/marseille/"}',
  add column if not exists rss_feeds        text[]  not null default '{}',
  add column if not exists lookback         int     not null default 200,
  add column if not exists max_duration_min int     not null default 20,
  add column if not exists tail_seconds     int     not null default 60,
  add column if not exists frame_interval   real    not null default 2,
  add column if not exists threshold        int     not null default 70,
  add column if not exists whisper_enabled  boolean not null default true,
  add column if not exists face_enabled     boolean not null default true,
  add column if not exists voice_enabled    boolean not null default true,
  add column if not exists updated_at       timestamptz default now();

-- ------------------------------------------------------------ vidéos
create table if not exists videos (
  id         text primary key,
  source     text not null,
  url        text not null,
  created_at timestamptz default now()
);
alter table videos
  add column if not exists channel       text,
  add column if not exists title         text,
  add column if not exists published_at  timestamptz,
  add column if not exists duration      int,
  add column if not exists thumbnail     text,
  add column if not exists match_type    text,          -- text | subtitles | speech | manual | null
  add column if not exists match_excerpt text,
  add column if not exists score         int,           -- score global 0-100
  add column if not exists score_name    int,
  add column if not exists score_face    int,
  add column if not exists score_voice   int,
  add column if not exists face_hits     int default 0,
  add column if not exists status        text not null default 'pending',  -- pending | kept | rejected
  add column if not exists other_urls    text[] default '{}',
  add column if not exists note          text,
  add column if not exists file_id        text,        -- fichier stocké (meilleure qualité)
  add column if not exists file_name      text,
  add column if not exists file_height    int,         -- 2160, 1080, 720…
  add column if not exists file_size      bigint,
  add column if not exists file_1080_id   text;

create table if not exists seen (
  id         text primary key,
  checked_at timestamptz default now()
);

create table if not exists runs (
  id          bigserial primary key,
  started_at  timestamptz default now(),
  finished_at timestamptz,
  checked     int default 0,
  found       int default 0,
  status      text default 'running',
  errors      text
);

-- liens ajoutés à la main depuis l'app (Instagram, X, Facebook…)
create table if not exists queue (
  id        bigserial primary key,
  url       text not null,
  added_at  timestamptz default now(),
  processed boolean not null default false,
  error     text
);

-- état des plateformes (mis à jour à chaque passage)
create table if not exists platforms (
  key        text primary key,   -- youtube | bfmtv | tiktok | instagram
  status     text,               -- ok | error | off
  detail     text,
  updated_at timestamptz
);

-- abonnements aux notifications de l'app installée
create table if not exists push_subscriptions (
  id           bigserial primary key,
  endpoint     text unique not null,
  subscription jsonb not null,
  user_agent   text,
  created_at   timestamptz default now()
);

-- ------------------------------------------------------------ sécurité
alter table settings enable row level security;
alter table videos   enable row level security;
alter table seen     enable row level security;
alter table runs     enable row level security;
alter table queue    enable row level security;
alter table platforms enable row level security;
alter table push_subscriptions enable row level security;

drop policy if exists "auth settings" on settings;
drop policy if exists "auth videos"   on videos;
drop policy if exists "auth runs"     on runs;
drop policy if exists "auth queue"    on queue;
drop policy if exists "auth platforms" on platforms;
drop policy if exists "auth push"      on push_subscriptions;
create policy "auth settings" on settings for all to authenticated using (true) with check (true);
create policy "auth videos"   on videos   for all to authenticated using (true) with check (true);
create policy "auth runs"     on runs     for select to authenticated using (true);
create policy "auth queue"    on queue    for all to authenticated using (true) with check (true);
create policy "auth platforms" on platforms for select to authenticated using (true);
create policy "auth push"      on push_subscriptions for all to authenticated using (true) with check (true);

-- ------------------------------------------------------------ photos et voix de référence
-- Espace de stockage PRIVÉ : seul toi (connecté) et le moteur (clé service) y accèdent.
insert into storage.buckets (id, name, public)
values ('references', 'references', false)
on conflict (id) do nothing;

drop policy if exists "auth references read"   on storage.objects;
drop policy if exists "auth references write"  on storage.objects;
drop policy if exists "auth references delete" on storage.objects;
create policy "auth references read"   on storage.objects for select to authenticated using (bucket_id = 'references');
create policy "auth references write"  on storage.objects for insert to authenticated with check (bucket_id = 'references');
create policy "auth references delete" on storage.objects for delete to authenticated using (bucket_id = 'references');
