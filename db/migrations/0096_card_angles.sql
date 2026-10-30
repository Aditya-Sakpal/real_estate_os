-- ===========================================================================
-- 0096: a card is written for an angle.
--
-- A card used to be one per language and buyer, leading on the strongest
-- selling point, and nothing matched it to the template it was drawn in: an
-- Offer template with no offer, a Construction update with no site photo, a
-- Festive greeting that sold. Each card now names what it is written for
-- (`card-angle-rules.ts`): GENERAL for any ad, or one kind of template. The
-- studio writes one card per language for every angle the project can
-- support, so every template has a card and every card a template.
--
-- One card per language, buyer AND angle. Existing cards are GENERAL, which
-- is what each of them was.
-- ===========================================================================

ALTER TABLE campaign_copy
  ADD COLUMN angle text NOT NULL DEFAULT 'GENERAL';

ALTER TABLE campaign_copy
  ADD CONSTRAINT campaign_copy_angle_known CHECK (angle IN (
    'GENERAL', 'LOCATION', 'AMENITY', 'PRICE', 'OFFER', 'VISIT',
    'CONSTRUCTION', 'POSSESSION', 'GREETING', 'NRI'));

DROP INDEX campaign_copy_block;
CREATE UNIQUE INDEX campaign_copy_block ON campaign_copy (brief_id, language, segment, angle);
