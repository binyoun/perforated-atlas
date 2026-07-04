-- Strips table: stores pattern + metadata only. NEVER the original text.
create table if not exists strips (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  city         text not null default '',
  country      text not null default '',
  locale_hint  text not null default 'unknown',
  source_length integer not null default 0,
  word_count   integer not null default 0,
  notes        jsonb not null default '[]',
  palette      jsonb not null default '["#4FBFDF","#E8C36A"]',
  strip_length_mm integer not null default 0
);

-- Enforce reasonable limits (no abuse, no giant strips)
alter table strips add constraint strips_source_length_max check (source_length <= 500);
alter table strips add constraint strips_word_count_max check (word_count <= 50);
alter table strips add constraint strips_notes_max check (jsonb_array_length(notes) <= 600);

-- Row Level Security: anonymous insert + select only. No update, no delete.
alter table strips enable row level security;

create policy "anon_select" on strips for select using (true);
create policy "anon_insert" on strips for insert with check (
  source_length <= 500 and word_count <= 50
);

-- Index for the archive view (most recent first)
create index strips_created_at_idx on strips (created_at desc);
