-- 0098: the festival calendar, checked and filled in.
--
-- A scheduled post on a festival the developer observes is now a festival
-- post (festival-day-rules.ts), so the calendar is what decides it. Two
-- things were wrong with it: every lunar date was unverified, so no festival
-- ever reached a post, and Holi 2027 was a day early.
--
-- A date is marked verified only where the Government of India's list of
-- holidays (DoPT O.M. of July 2025 for 2026, of 16 July 2026 for 2027) or two
-- published panchang calendars agree (samvat.in, calendarlabs.com, Drik
-- Panchang), read on 8 October 2026. Where they disagree, or the date hangs
-- on a moon sighting, the row goes in unverified and nothing uses it until a
-- person checks it.

-- Checked: the rows already seeded.
UPDATE occasions SET verified_at = now(), source = 'DoPT holidays 2026 (restricted)'
  WHERE key = 'ganesh_chaturthi' AND year = 2026 AND on_date = '2026-09-14';
UPDATE occasions SET verified_at = now(), source = 'DoPT holidays 2026; Drik Panchang'
  WHERE key = 'navratri' AND year = 2026 AND on_date = '2026-10-11';
UPDATE occasions SET verified_at = now(), source = 'DoPT holidays 2026 (gazetted)'
  WHERE key = 'dussehra' AND year = 2026 AND on_date = '2026-10-20';
UPDATE occasions SET verified_at = now(), source = 'DoPT holidays 2026 (gazetted)'
  WHERE key = 'diwali' AND year = 2026 AND on_date = '2026-11-08';
UPDATE occasions SET verified_at = now(), source = 'samvat.in; calendarlabs.com'
  WHERE key IN ('gudi_padwa', 'ugadi') AND year = 2027 AND on_date = '2027-04-07';

-- Holi 2027 is 23 March (DoPT gazetted 2027, samvat.in), not 22 March.
UPDATE occasions SET on_date = '2027-03-23', verified_at = now(), source = 'DoPT holidays 2027 (gazetted); samvat.in'
  WHERE key = 'holi' AND year = 2027;

-- New rows. A key matches the festival catalog with underscores
-- (`festivalOf()`), so a post knows which festival to draw.
INSERT INTO occasions (key, name, year, on_date, kind, regions, solar, source, verified_at) VALUES
  ('dhanteras',          'Dhanteras',          2026, '2026-11-06', 'BUYING',   '{}',     false, 'Drik Panchang; two days before Diwali (DoPT 2026)', now()),
  ('durga_puja',         'Durga Puja',         2026, '2026-10-19', 'GREETING', '{WB}',   false, 'DoPT holidays 2026 (Mahashtami, restricted)', now()),
  ('guru_nanak_jayanti', 'Guru Nanak Jayanti', 2026, '2026-11-24', 'GREETING', '{}',     false, 'DoPT holidays 2026 (gazetted)', now()),
  ('christmas',          'Christmas',          2026, '2026-12-25', 'GREETING', '{}',     true,  'fixed date', now()),
  ('new_year',           'New Year',           2027, '2027-01-01', 'GREETING', '{}',     true,  'fixed date', now()),
  ('independence_day',   'Independence Day',   2027, '2027-08-15', 'GREETING', '{}',     true,  'fixed date', now()),
  ('raksha_bandhan',     'Raksha Bandhan',     2027, '2027-08-17', 'GREETING', '{}',     false, 'samvat.in; calendarlabs.com', now()),
  ('janmashtami',        'Janmashtami',        2027, '2027-08-25', 'GREETING', '{}',     false, 'DoPT holidays 2027 (gazetted)', now()),
  ('ganesh_chaturthi',   'Ganesh Chaturthi',   2027, '2027-09-04', 'GREETING', '{MH}',   false, 'samvat.in; calendarlabs.com', now()),
  ('onam',               'Onam',               2027, '2027-09-12', 'GREETING', '{KL}',   false, 'samvat.in; calendarlabs.com', now()),
  ('navratri',           'Navratri begins',    2027, '2027-09-30', 'BUYING',   '{}',     false, 'samvat.in; calendarlabs.com', now()),
  ('dussehra',           'Dussehra',           2027, '2027-10-09', 'BUYING',   '{}',     false, 'DoPT holidays 2027 (gazetted)', now()),
  ('dhanteras',          'Dhanteras',          2027, '2027-10-27', 'BUYING',   '{}',     false, 'samvat.in; calendarlabs.com', now()),
  ('diwali',             'Diwali',             2027, '2027-10-29', 'BUYING',   '{}',     false, 'DoPT holidays 2027 (gazetted)', now()),
  ('guru_nanak_jayanti', 'Guru Nanak Jayanti', 2027, '2027-11-14', 'GREETING', '{}',     false, 'DoPT holidays 2027 (gazetted)', now()),
  ('christmas',          'Christmas',          2027, '2027-12-25', 'GREETING', '{}',     true,  'fixed date', now())
ON CONFLICT (key, year) DO NOTHING;

-- Not agreed, or set by the moon: shown on Occasions, used by nothing until
-- somebody checks them. Akshaya Tritiya 2027 is 8 May in one calendar and
-- 9 May in another; Pongal 14 or 15 January; Eid by the sighting.
INSERT INTO occasions (key, name, year, on_date, kind, regions, solar, source, verified_at) VALUES
  ('pongal',          'Pongal',          2027, '2027-01-14', 'GREETING', '{TN}', false, 'samvat.in (calendarlabs.com says 15 January)', NULL),
  ('eid',             'Eid al-Fitr',     2027, '2027-03-10', 'GREETING', '{}',   false, 'DoPT holidays 2027, subject to the moon', NULL),
  ('akshaya_tritiya', 'Akshaya Tritiya', 2027, '2027-05-08', 'BUYING',   '{}',   false, 'samvat.in (calendarlabs.com says 9 May)', NULL)
ON CONFLICT (key, year) DO NOTHING;
