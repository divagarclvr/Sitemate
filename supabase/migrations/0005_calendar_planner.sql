-- Phase 5: calendar (published-calendar link + meetings added by hand), day plans, reminders.
-- No Microsoft/Google sign-in needed: the server reads a read-only "published calendar" (ICS) link.

alter table calendar_accounts drop constraint if exists calendar_accounts_provider_check;
alter table calendar_accounts add constraint calendar_accounts_provider_check
  check (provider in ('microsoft','google','ics'));
alter table calendar_accounts add column if not exists feed_url        text;   -- secret link; never sent to the app
alter table calendar_accounts add column if not exists last_synced_at  timestamptz;
alter table calendar_accounts add column if not exists last_error      text;
create unique index if not exists calendar_accounts_one_ics on calendar_accounts (user_id) where provider = 'ics';

-- Meetings typed in by hand have no calendar account.
alter table calendar_events_cache alter column account_id drop not null;
alter table calendar_events_cache add column if not exists source  text    not null default 'ics'
  check (source in ('ics','manual','microsoft','google'));
alter table calendar_events_cache add column if not exists all_day boolean not null default false;
