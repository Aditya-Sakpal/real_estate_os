-- 0099: the 2027 rows 0098 found already seeded, checked the same way.
--
-- 0098 inserted with ON CONFLICT DO NOTHING, so a 2027 festival seeded before
-- kept its old, unverified row. These are those rows, verified where the
-- DoPT list or two panchang calendars agree, read on 8 October 2026. Onam
-- 2027 was seeded as 14 September; both calendars give 12 September.

UPDATE occasions SET verified_at = now(), source = 'samvat.in; calendarlabs.com'
  WHERE key = 'raksha_bandhan' AND year = 2027 AND on_date = '2027-08-17';
UPDATE occasions SET verified_at = now(), source = 'samvat.in; calendarlabs.com'
  WHERE key = 'ganesh_chaturthi' AND year = 2027 AND on_date = '2027-09-04';
UPDATE occasions SET on_date = '2027-09-12', verified_at = now(), source = 'samvat.in; calendarlabs.com'
  WHERE key = 'onam' AND year = 2027;
UPDATE occasions SET verified_at = now(), source = 'samvat.in; calendarlabs.com'
  WHERE key = 'navratri' AND year = 2027 AND on_date = '2027-09-30';
UPDATE occasions SET verified_at = now(), source = 'DoPT holidays 2027 (gazetted)'
  WHERE key = 'dussehra' AND year = 2027 AND on_date = '2027-10-09';
UPDATE occasions SET verified_at = now(), source = 'DoPT holidays 2027 (gazetted)'
  WHERE key = 'diwali' AND year = 2027 AND on_date = '2027-10-29';
