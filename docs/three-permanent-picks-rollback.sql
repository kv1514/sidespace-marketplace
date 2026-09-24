-- Rollback for migration 20260924093000_three_permanent_picks_not_ten.sql
--
-- Captured 2026-09-24T07:20Z, immediately before the migration cleared
-- featured_rank 4..10. Ranks 1-3 (Dylan's YouTube segment, Aiden's campus run,
-- Room 114's wall) were not touched and are not listed here.
--
-- To restore the old ten-pin order you must FIRST widen the check constraint
-- back, because the migration tightened it to 1..3 and these are all > 3:
--
--   alter table public.listings
--     drop constraint if exists listings_featured_rank_is_a_small_position;
--   alter table public.listings
--     add constraint listings_featured_rank_is_a_small_position
--     check (featured_rank is null or featured_rank between 1 and 99);
--
-- Then:

update public.listings set featured_rank = 4 where id = 'd4bea840-3b59-49d1-80f4-e678518748fd'; -- Instagram story from a Pan Am junior champion (Youshi Chen)
update public.listings set featured_rank = 5 where id = '0d969b8e-16ee-4d3c-9a12-b8ec12f6555c'; -- Instagram post or story on my account, Berkeley (Bruce)
update public.listings set featured_rank = 6 where id = 'de1b07a4-7cb0-46c6-a692-b30ea460a59d'; -- Dorm Room Door - Floor 4 Corner, by the Stairwell (Kausthubh Veldanda)
update public.listings set featured_rank = 7 where id = 'c63deeb9-15a8-485a-bc07-54b14c307eb1'; -- Sponsorship Posts (Troy VEX Robotics)
update public.listings set featured_rank = 8 where id = '476ada3c-f8bb-4443-a000-183b4e5911ba'; -- Troy Academic Decathlon Instagram Story sponsorship
update public.listings set featured_rank = 9 where id = '86b8e144-4952-45d8-8b5d-807932a4810c'; -- Instagram story for local businesses (Aidan Chen)
update public.listings set featured_rank = 10 where id = '5c1925b4-00b4-49c3-937a-bcae7299eda7'; -- Bruce - wall or mural in Berkeley, CA
