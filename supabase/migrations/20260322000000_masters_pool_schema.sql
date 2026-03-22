-- =============================================================================
-- Masters Pool - Database Schema
-- Run this in the Supabase SQL Editor
-- =============================================================================

-- 1. Participants
create table masters_participants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  name text not null,
  draft_position int,
  eliminated boolean default false,
  created_at timestamptz default now()
);

-- 2. Golfers (drafted players)
create table masters_golfers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  name text not null,
  participant_id uuid references masters_participants(id) on delete cascade not null,
  draft_round int not null,
  draft_pick int not null,
  made_cut boolean default true,
  created_at timestamptz default now()
);

-- 3. Scores per golfer per round
create table masters_scores (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  golfer_id uuid references masters_golfers(id) on delete cascade not null,
  round int not null check (round between 1 and 4),
  score int not null,
  created_at timestamptz default now(),
  unique(golfer_id, round)
);

-- 4. Bonuses (Par 3 Contest)
create table masters_bonuses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  participant_id uuid references masters_participants(id) on delete cascade not null,
  bonus_type text not null check (bonus_type in ('par3_win', 'hio')),
  shots int not null default 1,
  created_at timestamptz default now()
);

-- =============================================================================
-- Row Level Security — public read, authenticated write
-- =============================================================================

alter table masters_participants enable row level security;
alter table masters_golfers enable row level security;
alter table masters_scores enable row level security;
alter table masters_bonuses enable row level security;

-- Public read for all tables
create policy "Public read participants" on masters_participants for select using (true);
create policy "Public read golfers" on masters_golfers for select using (true);
create policy "Public read scores" on masters_scores for select using (true);
create policy "Public read bonuses" on masters_bonuses for select using (true);

-- Authenticated write
create policy "Auth insert participants" on masters_participants for insert with check (auth.uid() = user_id);
create policy "Auth update participants" on masters_participants for update using (auth.uid() = user_id);
create policy "Auth delete participants" on masters_participants for delete using (auth.uid() = user_id);

create policy "Auth insert golfers" on masters_golfers for insert with check (auth.uid() = user_id);
create policy "Auth update golfers" on masters_golfers for update using (auth.uid() = user_id);
create policy "Auth delete golfers" on masters_golfers for delete using (auth.uid() = user_id);

create policy "Auth insert scores" on masters_scores for insert with check (auth.uid() = user_id);
create policy "Auth update scores" on masters_scores for update using (auth.uid() = user_id);
create policy "Auth delete scores" on masters_scores for delete using (auth.uid() = user_id);

create policy "Auth insert bonuses" on masters_bonuses for insert with check (auth.uid() = user_id);
create policy "Auth update bonuses" on masters_bonuses for update using (auth.uid() = user_id);
create policy "Auth delete bonuses" on masters_bonuses for delete using (auth.uid() = user_id);

-- =============================================================================
-- Indexes
-- =============================================================================

create index idx_mp_participants_user on masters_participants(user_id);
create index idx_mp_golfers_participant on masters_golfers(participant_id);
create index idx_mp_golfers_user on masters_golfers(user_id);
create index idx_mp_scores_golfer on masters_scores(golfer_id);
create index idx_mp_scores_round on masters_scores(round);
create index idx_mp_bonuses_participant on masters_bonuses(participant_id);
