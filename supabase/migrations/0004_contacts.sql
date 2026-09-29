-- Phase 4: contacts search + call notes.

-- Fuzzy search on company too ("steel vendor", "Balaji").
create index if not exists contacts_company_trgm on contacts using gin (company gin_trgm_ops);

-- One searchable text per contact: name, company, role, aliases (kept up to date by trigger).
alter table contacts add column if not exists search_text text not null default '';

create or replace function contacts_search_text() returns trigger
language plpgsql as $$
begin
  new.search_text = lower(concat_ws(' ', new.name, new.company, new.role, array_to_string(new.name_aliases, ' ')));
  return new;
end $$;

drop trigger if exists contacts_search_text on contacts;
create trigger contacts_search_text before insert or update on contacts
  for each row execute function contacts_search_text();

update contacts set search_text = lower(concat_ws(' ', name, company, role, array_to_string(name_aliases, ' ')));
create index if not exists contacts_search_trgm on contacts using gin (search_text gin_trgm_ops);

create index if not exists notes_contact on notes (contact_id);
create index if not exists tasks_owner_contact on tasks (owner_contact_id);
