-- Shorten topic labels to one word where possible.
-- Updates existing deployments where 009 already ran.

UPDATE topics SET label = 'Astronomy'   WHERE id = 'space';
UPDATE topics SET label = 'Nature'      WHERE id = 'nature';
UPDATE topics SET label = 'AI'          WHERE id = 'ai_ml';
UPDATE topics SET label = 'Linux'       WHERE id = 'linux';
UPDATE topics SET label = 'Web'         WHERE id = 'web_dev';
UPDATE topics SET label = 'Production'  WHERE id = 'music_production';
UPDATE topics SET label = 'Crafts'      WHERE id = 'crafts';
UPDATE topics SET label = 'Writing'     WHERE id = 'creative_writing';
UPDATE topics SET label = 'Theory'      WHERE id = 'music_theory';
UPDATE topics SET label = 'Fitness'     WHERE id = 'gym';
UPDATE topics SET label = 'Martial'     WHERE id = 'martial_arts';
UPDATE topics SET label = 'F1'          WHERE id = 'formula1';
UPDATE topics SET label = 'Film'        WHERE id = 'film';
UPDATE topics SET label = 'Books'       WHERE id = 'books';
UPDATE topics SET label = 'Wellness'    WHERE id = 'health';
UPDATE topics SET label = 'Wellbeing'   WHERE id = 'mental_health';
UPDATE topics SET label = 'Politics'    WHERE id = 'politics';
UPDATE topics SET label = 'News'        WHERE id = 'news_analysis';
UPDATE topics SET label = 'Combat'      WHERE id = 'combat_sports';
UPDATE topics SET label = 'Cocktails'   WHERE id = 'cocktails';
