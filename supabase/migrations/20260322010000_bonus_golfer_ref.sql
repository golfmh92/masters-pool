-- Change bonuses to reference golfer instead of participant
alter table masters_bonuses add column golfer_id uuid references masters_golfers(id) on delete cascade;

-- Make participant_id nullable (keep for backwards compat, derive from golfer)
alter table masters_bonuses alter column participant_id drop not null;

-- Index
create index idx_mp_bonuses_golfer on masters_bonuses(golfer_id);
