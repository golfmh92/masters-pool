-- =============================================================================
-- Masters Field Table
-- Stores the pre-announced player list for the draft picker
-- =============================================================================

create table masters_field (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  country text default '',
  created_at timestamptz default now()
);

alter table masters_field enable row level security;

-- Public read
create policy "Public read field" on masters_field for select using (true);

-- Authenticated write
create policy "Auth insert field" on masters_field for insert with check (auth.role() = 'authenticated');
create policy "Auth update field" on masters_field for update using (auth.role() = 'authenticated');
create policy "Auth delete field" on masters_field for delete using (auth.role() = 'authenticated');

create index idx_masters_field_name on masters_field(name);
