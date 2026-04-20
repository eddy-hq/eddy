-- Phase 5: seed topic list (~65 topics)
-- INSERT OR IGNORE so re-running this migration on an existing DB is safe.

-- ── Gaming ────────────────────────────────────────────────────────────────────
INSERT OR IGNORE INTO topics (id, label, emoji, category, age_gate, source, search_terms) VALUES
('minecraft',      'Minecraft',   '⛏️',  'Gaming', 0, 'seed', '["minecraft tutorial","minecraft survival guide","minecraft builds","minecraft tips beginners"]'),
('roblox',         'Roblox',      '🟥',  'Gaming', 0, 'seed', '["roblox games","best roblox games to play","roblox how to play","roblox tips tricks"]'),
('pokemon',        'Pokémon',     '⚡',  'Gaming', 0, 'seed', '["pokemon guide","pokemon tips tricks","pokemon gameplay","how to catch pokemon"]'),
('zelda',          'Zelda',       '🗡️', 'Gaming', 0, 'seed', '["legend of zelda guide","zelda tips walkthrough","zelda breath of wild","zelda tears of kingdom"]'),
('mario',          'Mario',       '🍄',  'Gaming', 0, 'seed', '["super mario gameplay","mario tips tricks","mario kart guide","super mario world"]'),
('fortnite',       'Fortnite',    '🎯',  'Gaming', 0, 'seed', '["fortnite tips beginners","fortnite building guide","fortnite strategy","fortnite gameplay"]'),
('gaming_general', 'Gaming',      '🎮',  'Gaming', 0, 'seed', '["best games to play","game review","video game tips","gaming guide 2024"]'),
('chess',          'Chess',       '♟️',  'Gaming', 0, 'seed', '["chess beginner tutorial","chess opening strategy","chess tips improve","chess endgame basics"]');

-- ── Sport ─────────────────────────────────────────────────────────────────────
INSERT OR IGNORE INTO topics (id, label, emoji, category, age_gate, source, search_terms) VALUES
('football',      'Football',    '⚽',  'Sport', 0, 'seed', '["football skills tutorial","football tactics explained","football training drills","football tips beginners"]'),
('basketball',    'Basketball',  '🏀',  'Sport', 0, 'seed', '["basketball skills tutorial","how to play basketball","basketball training drills","basketball tips"]'),
('cricket',       'Cricket',     '🏏',  'Sport', 0, 'seed', '["cricket batting tips","cricket skills tutorial","cricket explained beginners","how to bowl cricket"]'),
('running',       'Running',     '🏃',  'Sport', 0, 'seed', '["running tips beginners","how to run faster","running form technique","5k training plan"]'),
('cycling',       'Cycling',     '🚴',  'Sport', 0, 'seed', '["cycling tips beginners","road cycling training","bike maintenance guide","cycling for fitness"]'),
('tennis',        'Tennis',      '🎾',  'Sport', 0, 'seed', '["tennis tips beginners","tennis technique tutorial","how to improve tennis","tennis serve how to"]'),
('swimming',      'Swimming',    '🏊',  'Sport', 0, 'seed', '["swimming technique tutorial","how to swim faster","swimming tips beginners","freestyle swimming stroke"]'),
('formula1',      'Formula 1',   '🏎️', 'Sport', 0, 'seed', '["formula 1 explained","f1 race highlights","how f1 cars work","formula 1 guide beginners"]'),
('skateboarding', 'Skateboarding','🛹', 'Sport', 0, 'seed', '["skateboarding tricks beginners","how to skateboard","skateboard ollie tutorial","skating tips"]');

-- ── Science ───────────────────────────────────────────────────────────────────
INSERT OR IGNORE INTO topics (id, label, emoji, category, age_gate, source, search_terms) VALUES
('space',         'Space & Astronomy', '🚀', 'Science', 0, 'seed', '["space documentary","astronomy for beginners","how the universe works","NASA explained"]'),
('biology',       'Biology',           '🧬', 'Science', 0, 'seed', '["biology explained simply","how the human body works","evolution explained","biology facts interesting"]'),
('physics',       'Physics',           '⚛️', 'Science', 0, 'seed', '["physics explained simply","how things work physics","physics experiments at home","physics for beginners"]'),
('chemistry',     'Chemistry',         '🧪', 'Science', 0, 'seed', '["chemistry experiments","how chemistry works","chemistry for beginners","interesting chemistry reactions"]'),
('nature',        'Nature & Wildlife', '🌿', 'Science', 0, 'seed', '["wildlife documentary","nature explained","animal behaviour","nature facts amazing"]'),
('maths',         'Mathematics',       '🔢', 'Science', 0, 'seed', '["math explained visually","interesting mathematics","math tips tricks","math problem solving"]'),
('environment',   'Environment',       '🌍', 'Science', 0, 'seed', '["climate change explained","environmental science","sustainability explained","how ecosystems work"]');

-- ── Technology ────────────────────────────────────────────────────────────────
INSERT OR IGNORE INTO topics (id, label, emoji, category, age_gate, source, search_terms) VALUES
('programming',   'Programming',   '💻', 'Technology', 0, 'seed', '["learn to code beginners","programming tutorial","coding projects beginners","how programming works"]'),
('ai_ml',         'AI & Machine Learning', '🤖', 'Technology', 0, 'seed', '["artificial intelligence explained","machine learning beginner","how AI works","AI technology explained"]'),
('electronics',   'Electronics',   '🔧', 'Technology', 0, 'seed', '["electronics projects beginners","how to build circuits","Arduino tutorial","electronics for beginners"]'),
('robotics',      'Robotics',      '🦾', 'Technology', 0, 'seed', '["robotics for beginners","how robots work","robot building tutorial","robotics project"]'),
('web_dev',       'Web Development','🌐', 'Technology', 0, 'seed', '["web development tutorial","how websites work","HTML CSS tutorial","web design beginners"]'),
('linux',         'Linux & Open Source','🐧','Technology', 0, 'seed', '["linux tutorial beginners","how to use linux","linux tips tricks","open source tools"]'),
('cybersecurity', 'Cybersecurity', '🔐', 'Technology', 0, 'seed', '["cybersecurity explained","how hacking works explained","online safety tips","cybersecurity for beginners"]');

-- ── Arts & Creativity ─────────────────────────────────────────────────────────
INSERT OR IGNORE INTO topics (id, label, emoji, category, age_gate, source, search_terms) VALUES
('drawing',           'Drawing',            '✏️', 'Arts', 0, 'seed', '["drawing tutorial beginners","how to draw","art tips for beginners","sketching techniques"]'),
('music_production',  'Music Production',   '🎛️', 'Arts', 0, 'seed', '["music production tutorial beginners","how to make beats","beat making guide","music production tips"]'),
('photography',       'Photography',        '📷', 'Arts', 0, 'seed', '["photography tips beginners","how to take better photos","camera settings explained","photography techniques"]'),
('animation',         'Animation',          '🎬', 'Arts', 0, 'seed', '["animation tutorial beginners","how to animate","2D animation basics","stop motion animation"]'),
('crafts',            'Crafts & Making',    '✂️', 'Arts', 0, 'seed', '["DIY crafts tutorial","craft ideas","how to make crafts","paper crafts easy"]'),
('creative_writing',  'Creative Writing',   '📝', 'Arts', 0, 'seed', '["creative writing tips","how to write stories","storytelling techniques","writing for beginners"]'),
('design',            'Design',             '🎨', 'Arts', 0, 'seed', '["graphic design tutorial","design principles explained","UI design basics","colour theory design"]');

-- ── Music ─────────────────────────────────────────────────────────────────────
INSERT OR IGNORE INTO topics (id, label, emoji, category, age_gate, source, search_terms) VALUES
('guitar',        'Guitar',         '🎸', 'Music', 0, 'seed', '["guitar lessons beginners","how to play guitar","guitar chords tutorial","acoustic guitar tips"]'),
('piano',         'Piano',          '🎹', 'Music', 0, 'seed', '["piano lessons beginners","how to play piano","piano tutorial","keyboard piano tips"]'),
('music_theory',  'Music Theory',   '🎼', 'Music', 0, 'seed', '["music theory explained","how music works","music theory for beginners","understanding rhythm harmony"]');

-- ── Food ─────────────────────────────────────────────────────────────────────
INSERT OR IGNORE INTO topics (id, label, emoji, category, age_gate, source, search_terms) VALUES
('cooking', 'Cooking', '🍳', 'Food', 0, 'seed', '["cooking basics tutorial","easy recipes to cook","how to cook","cooking tips beginners"]'),
('baking',  'Baking',  '🍰', 'Food', 0, 'seed', '["baking recipes easy","how to bake bread","baking for beginners","baking tips tricks"]');

-- ── Fitness ───────────────────────────────────────────────────────────────────
INSERT OR IGNORE INTO topics (id, label, emoji, category, age_gate, source, search_terms) VALUES
('yoga',         'Yoga',          '🧘', 'Fitness', 0, 'seed', '["yoga for beginners","yoga tutorial routine","yoga benefits explained","morning yoga practice"]'),
('gym',          'Gym & Fitness', '💪', 'Fitness', 0, 'seed', '["gym workout beginners","how to start gym","weight training basics","home workout routine"]'),
('martial_arts', 'Martial Arts',  '🥋', 'Fitness', 0, 'seed', '["martial arts basics","karate tutorial beginners","judo technique introduction","martial arts for beginners"]');

-- ── Outdoors ─────────────────────────────────────────────────────────────────
INSERT OR IGNORE INTO topics (id, label, emoji, category, age_gate, source, search_terms) VALUES
('hiking',   'Hiking',   '🥾', 'Outdoors', 0, 'seed', '["hiking tips beginners","trail hiking guide","how to hike","hiking gear essentials"]'),
('camping',  'Camping',  '⛺', 'Outdoors', 0, 'seed', '["camping tips beginners","how to camp","camping hacks","camping survival skills"]'),
('fishing',  'Fishing',  '🎣', 'Outdoors', 0, 'seed', '["fishing tips beginners","how to fish","fishing techniques","fishing for beginners guide"]');

-- ── History & Culture ─────────────────────────────────────────────────────────
INSERT OR IGNORE INTO topics (id, label, emoji, category, age_gate, source, search_terms) VALUES
('history',     'History',    '🏛️', 'History', 0, 'seed', '["history explained simply","interesting history facts","historical events documentary","ancient history explained"]'),
('geography',   'Geography',  '🗺️', 'History', 0, 'seed', '["geography facts interesting","world geography explained","countries of the world","maps and geography"]'),
('languages',   'Languages',  '🗣️', 'History', 0, 'seed', '["language learning tips","how to learn a language","linguistics explained","language facts interesting"]'),
('philosophy',  'Philosophy', '🤔', 'History', 0, 'seed', '["philosophy explained simply","great philosophers explained","ethics for beginners","philosophical ideas"]');

-- ── Film & Media ──────────────────────────────────────────────────────────────
INSERT OR IGNORE INTO topics (id, label, emoji, category, age_gate, source, search_terms) VALUES
('film',    'Film & Cinema',  '🎥', 'Film', 0, 'seed', '["film analysis video essay","how movies are made","filmmaking tutorial","movie history explained"]'),
('books',   'Books & Reading','📚', 'Film', 0, 'seed', '["book recommendations","best books to read","book review analysis","reading guide"]');

-- ── Travel ────────────────────────────────────────────────────────────────────
INSERT OR IGNORE INTO topics (id, label, emoji, category, age_gate, source, search_terms) VALUES
('travel', 'Travel', '✈️', 'Travel', 0, 'seed', '["travel guide","hidden travel destinations","budget travel tips","travel tips advice"]');

-- ── Health ────────────────────────────────────────────────────────────────────
INSERT OR IGNORE INTO topics (id, label, emoji, category, age_gate, source, search_terms) VALUES
('health',         'Health & Wellness', '❤️', 'Health', 0, 'seed', '["health and wellness tips","how to stay healthy","healthy habits explained","wellness routine"]'),
('mental_health',  'Mental Health',     '🧠', 'Health', 0, 'seed', '["mental health explained","managing anxiety tips","mental wellbeing how to","psychology for beginners"]'),
('nutrition',      'Nutrition',         '🥗', 'Health', 0, 'seed', '["nutrition basics explained","healthy eating guide","how to eat well","nutrition tips beginners"]');

-- ── Vehicles ─────────────────────────────────────────────────────────────────
INSERT OR IGNORE INTO topics (id, label, emoji, category, age_gate, source, search_terms) VALUES
('cars',      'Cars',       '🚗', 'Vehicles', 0, 'seed', '["how cars work","car maintenance tips","car review","interesting car facts explained"]'),
('aviation',  'Aviation',   '✈️', 'Vehicles', 0, 'seed', '["how planes fly explained","aviation for beginners","pilot training explained","aircraft facts"]');

-- ── Age-gated (adults only) ───────────────────────────────────────────────────
INSERT OR IGNORE INTO topics (id, label, emoji, category, age_gate, source, search_terms) VALUES
('politics',       'Politics & Current Affairs', '🏛️', 'Society', 1, 'seed', '["political science explained","how government works","political history","democracy explained"]'),
('economics',      'Economics',                  '📈', 'Society', 1, 'seed', '["economics explained","how economy works","microeconomics basics","economic history"]'),
('business',       'Business',                   '💼', 'Society', 1, 'seed', '["business ideas explained","entrepreneurship tips","startup story","business strategy explained"]'),
('investing',      'Investing',                  '💹', 'Society', 1, 'seed', '["investing for beginners","how stock market works","personal finance tips","investment strategy"]'),
('news_analysis',  'News & Analysis',            '📰', 'Society', 1, 'seed', '["news analysis explained","current events context","world news background","journalism explained"]'),
('combat_sports',  'Combat Sports',              '🥊', 'Sport',   1, 'seed', '["boxing technique tutorial","MMA explained","UFC fighter story","combat sports training"]'),
('cocktails',      'Cocktails & Drinks',         '🍹', 'Food',    1, 'seed', '["cocktail recipes how to","mixology tutorial","how to make cocktails","bartending basics"]'),
('woodworking',    'Woodworking',                '🪵', 'Making',  0, 'seed', '["woodworking for beginners","woodworking projects easy","carpentry basics","woodworking tips tools"]');
