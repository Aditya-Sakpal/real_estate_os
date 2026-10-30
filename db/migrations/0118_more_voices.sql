--  0118_more_voices  --  nine more voices an agent may speak in
--
--  The client, 27 October 2026: Zarina (recommended), Mohit, Kavya, Ishita,
--  Roopa, Shreya, Suchitra, Bhavik and Deven, beside the four of 0094.

ALTER TABLE agent_voices DROP CONSTRAINT IF EXISTS agent_voices_voice_check;
ALTER TABLE agent_voices ADD CONSTRAINT agent_voices_voice_check CHECK (voice IN (
  'zarina', 'advait', 'priya',
  'mohit', 'kavya', 'ishita', 'shubh',
  'ritu', 'roopa', 'shreya', 'suchitra', 'bhavik', 'deven'
));
