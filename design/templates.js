/* Linear Design — templates.
 *
 * Templates are generated, not stored: a template is (topic, layout, variant)
 * and is laid out fresh for whatever size it's used at. That's how every
 * design comes in every format, and why "resize" on a template re-flows it
 * rather than stretching it. 95 topics × 14 layouts × 12 variants = 15,960
 * designs, each available in all 21 sizes.
 */
'use strict';
(() => {
const C = window.LDCore;

// ---------------------------------------------------------------- formats
const FORMATS = [
  { id: 'ig-post', n: 'Instagram Post', w: 1080, h: 1080, g: 'Social media' },
  { id: 'ig-story', n: 'Story / Reel', w: 1080, h: 1920, g: 'Social media' },
  { id: 'ig-portrait', n: 'Instagram Portrait', w: 1080, h: 1350, g: 'Social media' },
  { id: 'fb-post', n: 'Facebook Post', w: 1200, h: 630, g: 'Social media' },
  { id: 'fb-cover', n: 'Facebook Cover', w: 1640, h: 624, g: 'Social media' },
  { id: 'x-post', n: 'X / Twitter Post', w: 1600, h: 900, g: 'Social media' },
  { id: 'x-header', n: 'X Header', w: 1500, h: 500, g: 'Social media' },
  { id: 'li-banner', n: 'LinkedIn Banner', w: 1584, h: 396, g: 'Social media' },
  { id: 'pin', n: 'Pinterest Pin', w: 1000, h: 1500, g: 'Social media' },
  { id: 'yt-thumb', n: 'YouTube Thumbnail', w: 1280, h: 720, g: 'Video' },
  { id: 'yt-banner', n: 'YouTube Banner', w: 2560, h: 1440, g: 'Video' },
  { id: 'present', n: 'Presentation', w: 1920, h: 1080, g: 'Presentations' },
  { id: 'flyer', n: 'Flyer (Letter)', w: 1275, h: 1650, g: 'Print' },
  { id: 'poster', n: 'Poster (18×24)', w: 1800, h: 2400, g: 'Print' },
  { id: 'a4', n: 'A4 Page', w: 1240, h: 1754, g: 'Print' },
  { id: 'invite', n: 'Invitation (5×7)', w: 1050, h: 1470, g: 'Print' },
  { id: 'postcard', n: 'Postcard (6×4)', w: 1800, h: 1200, g: 'Print' },
  { id: 'bcard', n: 'Business Card', w: 1050, h: 600, g: 'Print' },
  { id: 'cert', n: 'Certificate', w: 1650, h: 1275, g: 'Print' },
  { id: 'logo', n: 'Logo', w: 1000, h: 1000, g: 'Branding' },
  { id: 'email', n: 'Email Header', w: 1200, h: 400, g: 'Branding' },
];

// ---------------------------------------------------------------- palettes
// bg, ink (text on bg), p (primary), pi (text on primary), s (secondary), a (accent)
const P = (bg, ink, p, pi, s, a) => ({ bg, ink, p, pi, s, a });
const PALETTES = {
  bold: [
    P('#111111', '#ffffff', '#ffd400', '#111111', '#ff3b30', '#ffffff'),
    P('#ff3b30', '#ffffff', '#111111', '#ffffff', '#ffd400', '#ffe3e0'),
    P('#1a1aff', '#ffffff', '#ff5ca8', '#ffffff', '#00e0b0', '#ffffff'),
    P('#ffd400', '#111111', '#111111', '#ffd400', '#ff3b30', '#111111'),
    P('#0b132b', '#ffffff', '#ff6b35', '#ffffff', '#3a86ff', '#f7f7ff'),
    P('#00c853', '#0b1f10', '#0b1f10', '#ffffff', '#ffeb3b', '#ffffff'),
  ],
  elegant: [
    P('#f7f1e8', '#2b2622', '#b08d57', '#ffffff', '#e7dccb', '#6d5d4b'),
    P('#1d2a24', '#f2ebdd', '#c9a96e', '#1d2a24', '#2f4038', '#f2ebdd'),
    P('#ffffff', '#1f1f1f', '#1f1f1f', '#ffffff', '#ececec', '#9b8a6e'),
    P('#f4ecef', '#3a2a30', '#9e6b7c', '#ffffff', '#e8d5dc', '#6b4f59'),
    P('#101820', '#f5f0e6', '#d4b483', '#101820', '#1f2c38', '#f5f0e6'),
    P('#eef1ec', '#26302a', '#6b8f71', '#ffffff', '#d7e0d6', '#3f5a45'),
  ],
  fun: [
    P('#fff4e0', '#2d1e4a', '#ff6f91', '#ffffff', '#ffc75f', '#845ec2'),
    P('#6c5ce7', '#ffffff', '#ffeaa7', '#2d3436', '#fd79a8', '#ffffff'),
    P('#00b8d9', '#ffffff', '#ffe066', '#1b1b3a', '#ff6392', '#ffffff'),
    P('#fef6e4', '#172c66', '#f582ae', '#172c66', '#8bd3dd', '#001858'),
    P('#ff8a00', '#ffffff', '#ffffff', '#ff4d00', '#ffe14d', '#5a1e00'),
    P('#e8f9fd', '#1d3557', '#ff595e', '#ffffff', '#ffca3a', '#1982c4'),
  ],
  calm: [
    P('#eaf4f4', '#1f3b4d', '#5aa9a6', '#ffffff', '#cde5e3', '#1f3b4d'),
    P('#f5f3ff', '#2e2a47', '#7b6cf6', '#ffffff', '#e2ddff', '#4a4570'),
    P('#fdf6f0', '#4a3b35', '#e3a587', '#ffffff', '#f4d8c8', '#7a5d52'),
    P('#e9f1fa', '#13315c', '#4d8fd6', '#ffffff', '#c9dcf2', '#13315c'),
    P('#f1f6ee', '#2f3e2b', '#8fb07e', '#ffffff', '#dce8d4', '#4d6343'),
    P('#fff8f0', '#3b3355', '#b8a1e3', '#2a2440', '#f5d6c6', '#3b3355'),
  ],
  pro: [
    P('#ffffff', '#0f172a', '#2563eb', '#ffffff', '#e2e8f0', '#0ea5e9'),
    P('#0f172a', '#ffffff', '#38bdf8', '#0f172a', '#1e293b', '#e2e8f0'),
    P('#f8fafc', '#111827', '#0eb37d', '#ffffff', '#d1fae5', '#065f46'),
    P('#111827', '#f9fafb', '#f59e0b', '#111827', '#1f2937', '#fde68a'),
    P('#ffffff', '#1e1b4b', '#6d28d9', '#ffffff', '#ede9fe', '#c026d3'),
    P('#00263a', '#ffffff', '#00b0ec', '#00263a', '#0a3a52', '#9fe3ff'),
  ],
  natural: [
    P('#f3efe6', '#2e3b2c', '#5b7f4a', '#ffffff', '#d9cfb8', '#a0522d'),
    P('#2e3b2c', '#f3efe6', '#e4b363', '#2e3b2c', '#44573f', '#f3efe6'),
    P('#fbf4e9', '#3c2a1e', '#c8553d', '#ffffff', '#f2d0a4', '#588b8b'),
    P('#e6efe9', '#1b3a2f', '#2d6a4f', '#ffffff', '#b7d7c3', '#d08c60'),
    P('#fff9ef', '#4b3621', '#8c5e3c', '#ffffff', '#ead7bd', '#607744'),
    P('#1f2d24', '#eae2cf', '#a3b18a', '#1f2d24', '#344e41', '#dad7cd'),
  ],
};

// ---------------------------------------------------------------- type pairings
const F = (h, hw, b, bw, up, ls, hi) => ({ h, hw, b, bw, up, ls, hi });
const FONTPAIRS = {
  bold: [F('Anton', 400, 'Montserrat', 700, true, .01), F('Archivo Black', 400, 'Inter', 700, false, -.01), F('Montserrat', 900, 'Montserrat', 700, true, .01), F('Bebas Neue', 400, 'Poppins', 600, true, .04), F('Oswald', 700, 'Roboto', 400, true, .01)],
  elegant: [F('Playfair Display', 400, 'Lato', 400, false, 0), F('Cormorant Garamond', 500, 'Raleway', 400, false, 0, true), F('Great Vibes', 400, 'Cormorant Garamond', 500, false, 0), F('Cinzel', 400, 'Lora', 400, true, .08), F('DM Serif Display', 400, 'Josefin Sans', 400, false, 0)],
  fun: [F('Fredoka', 700, 'Nunito', 400, false, 0), F('Pacifico', 400, 'Poppins', 400, false, 0), F('Righteous', 400, 'Rubik', 400, false, 0), F('Lobster', 400, 'Open Sans', 400, false, 0), F('Permanent Marker', 400, 'Work Sans', 400, false, 0)],
  calm: [F('Lora', 400, 'Nunito', 400, false, 0, true), F('Josefin Sans', 700, 'Lato', 400, true, .12), F('Comfortaa', 700, 'Nunito', 400, false, 0), F('Raleway', 700, 'Open Sans', 400, false, .01)],
  pro: [F('Inter', 700, 'Inter', 400, false, -.02), F('Poppins', 800, 'Poppins', 400, false, -.01), F('Space Grotesk', 700, 'Inter', 400, false, -.02), F('Montserrat', 700, 'Open Sans', 400, false, 0)],
  natural: [F('Alfa Slab One', 400, 'Work Sans', 400, false, 0), F('Merriweather', 700, 'Lato', 400, false, 0), F('Caveat', 700, 'Raleway', 400, false, 0), F('Libre Baskerville', 700, 'Josefin Sans', 400, false, 0), F('Amatic SC', 700, 'Josefin Sans', 400, true, .02)],
};

// ---------------------------------------------------------------- topics
// n name, c category, k keywords, i icon, m moods, h headlines, s sublines,
// d detail lines, t call to action, b big number/word, l three list items, e emoji
const T = (n, c, k, i, m, h, s, d, t, b, l, e) => ({ n, c, k, i, m, h, s, d, t, b, l, e });
const DATE = 'Saturday, June 14 · 10 AM – 4 PM';
const ADDR = '123 Main Street, Your Town';
const WEB = 'www.yourbusiness.com';
const TOPICS = [
  T('Big Sale', 'Marketing', 'sale discount offer shop retail deal', 'tag', ['bold', 'fun'], ['Big Sale', 'Mega Sale', 'Flash Sale'], ['Up to 50% off everything', 'This weekend only', 'Our biggest sale of the year'], [DATE, 'In store and online'], 'Shop now', '50%', ['Storewide savings', 'New styles added', 'Free shipping over $50'], '🛍️'),
  T('Black Friday', 'Marketing', 'black friday sale discount holiday shopping', 'bag', ['bold', 'pro'], ['Black Friday', 'Black Friday Deals'], ['Doors open at 6 AM', 'Deals you won’t see again'], ['Friday, November 27', ADDR], 'Shop the deals', '70%', ['Doorbusters', 'Online exclusives', 'Gift cards'], '🏷️'),
  T('Grand Opening', 'Business', 'grand opening launch new store business ribbon', 'store', ['bold', 'elegant', 'fun'], ['Grand Opening', 'We’re Open!', 'Now Open'], ['Come celebrate with us', 'Free treats for the first 100 guests'], [DATE, ADDR], 'Join us', 'NEW', ['Live music', 'Giveaways', 'Special offers'], '🎉'),
  T('New Arrivals', 'Marketing', 'new arrivals collection fashion product launch', 'sparkle', ['elegant', 'pro', 'calm'], ['New Arrivals', 'Just Landed', 'The New Collection'], ['Fresh styles for the new season', 'Discover what’s new'], ['Available now', WEB], 'Shop the collection', 'NEW', ['Limited pieces', 'Sustainable fabrics', 'Sizes XS–3XL'], '✨'),
  T('Product Launch', 'Marketing', 'product launch announcement new startup tech', 'rocket', ['pro', 'bold'], ['Introducing Nova', 'It’s Here', 'Meet the Future'], ['The simplest way to get more done', 'Designed for the way you work'], ['Available today', WEB], 'Learn more', '1.0', ['Twice as fast', 'Works offline', 'Private by design'], '🚀'),
  T('Giveaway', 'Social', 'giveaway contest win prize social instagram', 'gift', ['fun', 'bold'], ['Giveaway!', 'Win It!', 'Giveaway Time'], ['Enter to win a $100 gift card', 'Three lucky winners'], ['Like · Follow · Tag a friend', 'Ends Friday at midnight'], 'Enter now', 'WIN', ['Follow our page', 'Like this post', 'Tag two friends'], '🎁'),
  T('Birthday Party', 'Events', 'birthday party celebration invitation kids', 'cake', ['fun', 'calm'], ['Birthday Party', 'Let’s Celebrate!', 'Party Time'], ['Join us for Emma’s 7th birthday', 'Cake, games and fun'], [DATE, ADDR], 'RSVP by June 7', '7', ['Cake & ice cream', 'Games & prizes', 'Face painting'], '🎂'),
  T('Happy Birthday', 'Social', 'happy birthday card greeting wish', 'balloon', ['fun', 'calm', 'elegant'], ['Happy Birthday', 'Happy Birthday, Sam!', 'Cheers to You'], ['Wishing you the best year yet', 'Hope your day is as great as you are'], ['With love from all of us'], 'Make a wish', '30', ['Laugh a lot', 'Eat cake', 'Celebrate you'], '🎈'),
  T('Wedding', 'Events', 'wedding invitation save the date marriage ceremony', 'heart', ['elegant', 'calm'], ['Together with their families', 'We’re Getting Married', 'The Wedding Of'], ['Olivia & James', 'Request the pleasure of your company'], ['Saturday, the fourteenth of June', 'Rose Garden Estate · Five o’clock'], 'Kindly reply by May 1', '&', ['Ceremony at 5 PM', 'Dinner & dancing', 'Black tie optional'], '💍'),
  T('Save the Date', 'Events', 'save the date wedding event announcement', 'calendar', ['elegant', 'calm'], ['Save the Date', 'Mark Your Calendar'], ['Olivia & James', 'Our big day is coming'], ['06.14.2026', 'Rose Garden Estate'], 'Invitation to follow', '06.14', ['Ceremony', 'Reception', 'After party'], '📅'),
  T('Baby Shower', 'Events', 'baby shower invitation newborn party', 'balloon', ['calm', 'fun'], ['Baby Shower', 'Oh Baby!', 'A Little One Is Coming'], ['Please join us for a shower honoring Mia', 'Celebrating the mom-to-be'], [DATE, ADDR], 'RSVP to Anna', 'BABY', ['Brunch', 'Games', 'Gift opening'], '🍼'),
  T('Graduation', 'Events', 'graduation class of 2026 grad party school', 'cap', ['elegant', 'bold', 'pro'], ['Congrats, Grad!', 'Class of 2026', 'Graduation Party'], ['Join us in celebrating Alex', 'The tassel was worth the hassle'], [DATE, ADDR], 'Come celebrate', '2026', ['Open house', 'Food & drinks', 'Photo booth'], '🎓'),
  T('Anniversary', 'Events', 'anniversary celebration company years milestone', 'medal', ['elegant', 'pro'], ['10 Years Together', 'Happy Anniversary', 'A Decade of Thanks'], ['Thank you for being part of our story', 'Celebrating a milestone'], ['Est. 2016', WEB], 'Celebrate with us', '10', ['10 years', '5,000 customers', '1 great team'], '🥂'),
  T('Party Night', 'Events', 'party night club dj music celebration', 'music', ['bold', 'fun'], ['Party Night', 'Friday Night Live', 'The Big Night'], ['DJ · Drinks · Dancing', 'Dress to impress'], ['Friday, 9 PM – late', 'The Warehouse, Downtown'], 'Get tickets', '9PM', ['Live DJ', 'Photo booth', 'Late-night bites'], '🎶'),
  T('Concert', 'Events', 'concert live music band tour gig festival', 'mic', ['bold', 'fun', 'pro'], ['Live in Concert', 'The Summer Tour', 'One Night Only'], ['The Midnight Echoes', 'With special guests'], ['July 22 · Doors 7 PM', 'City Amphitheater'], 'Tickets on sale now', 'LIVE', ['Opening act 7:30', 'Headliner 9:00', 'All ages'], '🎸'),
  T('Music Festival', 'Events', 'festival music outdoor summer lineup', 'music', ['fun', 'bold'], ['Summer Fest', 'Sound Waves Festival'], ['Three days · Two stages · Forty artists', 'The lineup is here'], ['August 7–9', 'Riverside Park'], 'Get your pass', '3', ['Food trucks', 'Art village', 'Camping'], '🎪'),
  T('Conference', 'Business', 'conference summit event speakers business tech', 'users', ['pro', 'bold'], ['Future Forward Summit', 'The Leadership Conference', 'Tech Summit 2026'], ['Two days of ideas that move industries', 'Learn from 30+ speakers'], ['October 12–13', 'Convention Center'], 'Register today', '2026', ['30 speakers', '12 workshops', 'Networking'], '🎤'),
  T('Webinar', 'Business', 'webinar online event live training zoom', 'video', ['pro', 'calm'], ['Free Webinar', 'Live Online Training', 'Join the Webinar'], ['How to protect your business from cyber attacks', 'Practical tips in 45 minutes'], ['Thursday · 1 PM ET', 'Online · Free'], 'Save your seat', 'LIVE', ['Common threats', 'Simple defenses', 'Live Q&A'], '💻'),
  T('Workshop', 'Education', 'workshop class hands on learn course', 'pencil', ['calm', 'natural', 'pro'], ['Hands-On Workshop', 'Learn Something New', 'Creative Workshop'], ['Watercolor for beginners', 'All materials included'], [DATE, 'The Studio, 45 Oak Ave'], 'Book a spot', '12', ['Small groups', 'All skill levels', 'Take home your work'], '🎨'),
  T('Podcast', 'Social', 'podcast episode audio show interview', 'headphones', ['bold', 'pro', 'fun'], ['New Episode', 'The Weekly Podcast', 'Listen Now'], ['Episode 42: Building from zero', 'With guest Maya Chen'], ['Available on all platforms'], 'Listen now', 'EP 42', ['Interviews', 'Stories', 'Big ideas'], '🎙️'),
  T('YouTube Video', 'Social', 'youtube video thumbnail vlog channel', 'play', ['bold', 'fun'], ['I Tried It For 30 Days', 'You Won’t Believe This', 'Watch This First'], ['Here’s what happened', 'New video out now'], ['Subscribe for more'], 'Watch now', '30 DAYS', ['Day 1', 'Day 15', 'Day 30'], '▶️'),
  T('Quote', 'Social', 'quote inspiration motivation saying', 'quote', ['elegant', 'calm', 'bold'], ['Start where you are. Use what you have. Do what you can.', 'Small steps every day add up to big results.', 'Done is better than perfect.'], ['— Arthur Ashe', '— Unknown'], ['@yourhandle'], 'Share this', '“', ['Believe', 'Begin', 'Become'], '💬'),
  T('Motivation', 'Social', 'motivation monday inspiration goals mindset', 'bolt', ['bold', 'fun', 'pro'], ['Monday Motivation', 'You’ve Got This', 'Keep Going'], ['Every expert was once a beginner', 'Progress, not perfection'], ['@yourhandle'], 'Tag a friend', '100%', ['Set a goal', 'Make a plan', 'Show up daily'], '💪'),
  T('Tips List', 'Social', 'tips list how to guide advice carousel', 'bulb', ['pro', 'calm', 'fun'], ['3 Tips to Save Time', 'Quick Tips', 'Do This, Not That'], ['Simple habits that make a big difference', 'Save this for later'], ['@yourhandle'], 'Save & share', '3', ['Plan tomorrow tonight', 'Batch similar tasks', 'Turn off notifications'], '💡'),
  T('Announcement', 'Business', 'announcement news update notice', 'megaphone', ['pro', 'bold', 'calm'], ['Big News!', 'Announcement', 'Important Update'], ['We’re moving to a bigger space', 'Something exciting is coming'], ['Starting July 1', WEB], 'Learn more', 'NEWS', ['New location', 'Longer hours', 'Same great team'], '📣'),
  T('We’re Hiring', 'Business', 'hiring job career recruit join team work', 'briefcase', ['pro', 'bold', 'fun'], ['We’re Hiring!', 'Join Our Team', 'Now Hiring'], ['Front desk · Technicians · Sales', 'Grow your career with us'], ['Apply at ' + WEB + '/jobs'], 'Apply today', 'JOBS', ['Great pay', 'Flexible hours', 'Health benefits'], '💼'),
  T('Thank You', 'Social', 'thank you gratitude customers card', 'heart', ['elegant', 'calm', 'fun'], ['Thank You', 'Thank You So Much', 'With Gratitude'], ['For supporting our small business', 'We couldn’t do it without you'], ['— The team at Linear'], 'See you soon', '♥', ['Our customers', 'Our community', 'Our team'], '🙏'),
  T('Restaurant', 'Food', 'restaurant menu food dinner special chef', 'utensils', ['elegant', 'natural', 'bold'], ['Tonight’s Special', 'Taste the Difference', 'Dinner is Served'], ['Fresh, local and made from scratch', 'Chef’s tasting menu'], ['Open daily 5 – 10 PM', ADDR], 'Reserve a table', '$29', ['Seasonal starters', 'Wood-fired mains', 'House-made desserts'], '🍽️'),
  T('Menu', 'Food', 'menu restaurant cafe food price list', 'utensils', ['natural', 'elegant', 'pro'], ['Our Menu', 'Lunch Menu', 'The Daily Menu'], ['Made fresh every morning', 'Served 11 AM – 3 PM'], [ADDR], 'Order ahead', 'MENU', ['Garden Salad — $9', 'Grilled Chicken Wrap — $12', 'Tomato Basil Soup — $7'], '🥗'),
  T('Coffee Shop', 'Food', 'coffee cafe latte espresso breakfast', 'coffee', ['natural', 'calm', 'elegant'], ['But First, Coffee', 'Fresh Brew Daily', 'Coffee & Co.'], ['Small-batch roasts and fresh pastries', 'Your new favorite corner'], ['Open 7 AM – 6 PM', ADDR], 'Buy one, get one', '2 FOR 1', ['Espresso bar', 'Fresh pastries', 'Free Wi-Fi'], '☕'),
  T('Bakery', 'Food', 'bakery bread cake pastry dessert sweets', 'cake', ['natural', 'fun', 'calm'], ['Fresh From the Oven', 'Sweet Treats', 'Baked with Love'], ['Artisan breads and pastries daily', 'Custom cakes for every occasion'], ['Open Tue – Sun', ADDR], 'Order a cake', 'FRESH', ['Sourdough', 'Croissants', 'Custom cakes'], '🥐'),
  T('Pizza Night', 'Food', 'pizza pizzeria italian takeout delivery', 'pizza', ['bold', 'fun'], ['Pizza Night', 'Hot & Fresh Pizza', 'Two Large Pizzas'], ['Stone-baked, loaded with flavor', 'Delivery in 30 minutes'], ['Call (555) 123-4567'], 'Order now', '$19.99', ['Hand-tossed dough', 'Real mozzarella', 'Fresh toppings'], '🍕'),
  T('Food Truck', 'Food', 'food truck street food tacos burgers', 'truck', ['bold', 'fun', 'natural'], ['Street Eats', 'Taco Tuesday', 'The Food Truck is Here'], ['Find us downtown every week', 'Fresh, fast, delicious'], ['Tuesdays 11 AM – 2 PM', 'Corner of 5th & Pine'], 'Follow for location', '$3', ['Tacos', 'Burritos', 'Horchata'], '🌮'),
  T('Farmers Market', 'Food', 'farmers market fresh produce local organic', 'apple', ['natural', 'calm'], ['Farmers Market', 'Fresh & Local', 'Market Day'], ['Every Saturday morning', 'Local produce, bread, flowers and more'], ['Saturdays 8 AM – 1 PM', 'Town Square'], 'Come hungry', 'LOCAL', ['Seasonal produce', 'Local honey', 'Live music'], '🥕'),
  T('Fitness', 'Health', 'fitness gym workout training personal trainer', 'dumbbell', ['bold', 'pro'], ['Get Fit Now', 'Train Harder', 'Your Best Shape'], ['First week free for new members', 'Classes for every level'], ['Open 24/7', ADDR], 'Start today', '7 DAYS', ['Strength', 'HIIT', 'Personal training'], '🏋️'),
  T('Yoga', 'Health', 'yoga meditation wellness class calm studio', 'flower', ['calm', 'natural', 'elegant'], ['Find Your Balance', 'Morning Yoga', 'Breathe & Flow'], ['Gentle classes for every body', 'Your first class is on us'], ['Mon · Wed · Fri — 7 AM', 'The Quiet Studio'], 'Book a class', 'OM', ['Vinyasa', 'Restorative', 'Meditation'], '🧘'),
  T('Running Race', 'Health', 'run race 5k marathon charity fun run', 'medal', ['bold', 'fun', 'pro'], ['Charity Fun Run', 'Run the City', 'Race Day'], ['All ages welcome · Walkers too', 'Every mile makes a difference'], ['Sunday, May 3 · 8 AM', 'Riverside Park'], 'Register now', '5K', ['Medal for all', 'Kids dash', 'After party'], '🏃'),
  T('Healthcare', 'Health', 'doctor clinic medical health care dental', 'medical', ['pro', 'calm'], ['Your Health Matters', 'Caring for Your Family', 'Now Accepting Patients'], ['Same-day appointments available', 'Friendly, experienced care'], ['Call (555) 123-4567', ADDR], 'Book a visit', '24/7', ['Checkups', 'Vaccinations', 'Telehealth'], '🩺'),
  T('Dental', 'Health', 'dentist dental smile teeth whitening', 'smile', ['calm', 'pro'], ['Smile Brighter', 'Healthy Smiles', 'Your Smile, Our Care'], ['New patient special: cleaning & X-rays', 'Gentle care for the whole family'], ['Call (555) 123-4567'], 'Book now', '$99', ['Cleanings', 'Whitening', 'Emergency care'], '😁'),
  T('Beauty Salon', 'Business', 'salon beauty hair nails spa makeup', 'scissors', ['elegant', 'calm', 'fun'], ['Beauty Studio', 'New Season, New Look', 'Treat Yourself'], ['Hair · Nails · Skin', '20% off your first visit'], ['By appointment', ADDR], 'Book online', '20%', ['Cut & color', 'Manicures', 'Facials'], '💇'),
  T('Spa Day', 'Health', 'spa massage relax wellness self care', 'drop', ['calm', 'elegant', 'natural'], ['Relax & Unwind', 'Spa Day', 'Time for You'], ['Massage, facials and more', 'Gift cards available'], ['Open 9 AM – 8 PM', ADDR], 'Book a treatment', '60 MIN', ['Massage', 'Facials', 'Aromatherapy'], '🌿'),
  T('Real Estate', 'Real estate', 'real estate house home for sale listing realtor', 'home', ['pro', 'elegant', 'natural'], ['Just Listed', 'Your Dream Home', 'For Sale'], ['4 bed · 3 bath · 2,400 sq ft', 'Modern living in a quiet neighborhood'], ['42 Maple Lane', 'Call Jordan (555) 123-4567'], 'Schedule a viewing', '$549K', ['Renovated kitchen', 'Large backyard', 'Top-rated schools'], '🏡'),
  T('Open House', 'Real estate', 'open house real estate viewing tour home', 'key', ['pro', 'calm', 'bold'], ['Open House', 'Come Take a Look', 'Open House Sunday'], ['Tour this beautiful family home', 'Refreshments provided'], ['Sunday 1 – 4 PM', '42 Maple Lane'], 'See you there', 'SUN', ['3 bedrooms', 'Updated kitchen', 'Big backyard'], '🔑'),
  T('Sold', 'Real estate', 'sold real estate realtor success', 'checkcircle', ['bold', 'pro', 'elegant'], ['Sold!', 'Just Sold', 'Another One Sold'], ['Congratulations to the new owners', 'Over asking in 5 days'], ['Thinking of selling? Let’s talk.'], 'Get a free valuation', 'SOLD', ['Priced right', 'Marketed well', 'Closed fast'], '🏠'),
  T('IT Services', 'Tech', 'it support tech computer network managed services', 'monitor', ['pro'], ['IT That Just Works', 'Tech Support You Can Trust', 'Your IT Team'], ['Managed IT for small businesses', 'Fast, friendly, local support'], ['(555) 123-4567 · ' + WEB], 'Get a free assessment', '24/7', ['Help desk', 'Cloud & email', 'Backups'], '💻'),
  T('Cybersecurity', 'Tech', 'cybersecurity security protect hacker phishing', 'shieldcheck', ['pro', 'bold'], ['Stay Secure', 'Is Your Business Protected?', 'Think Before You Click'], ['Phishing is the #1 way attackers get in', 'Security that fits your business'], [WEB], 'Book a security check', '#1', ['Turn on MFA', 'Update everything', 'Back up daily'], '🔒'),
  T('App Launch', 'Tech', 'app mobile launch download software saas', 'mobile', ['pro', 'fun', 'bold'], ['Download the App', 'Now on Your Phone', 'The App is Live'], ['Everything you need, in your pocket', 'Free on iPhone and Android'], ['Search “YourApp”'], 'Get the app', '4.9★', ['Fast', 'Simple', 'Secure'], '📱'),
  T('Travel', 'Travel', 'travel vacation trip holiday adventure tour', 'plane', ['fun', 'natural', 'calm'], ['Explore the World', 'Adventure Awaits', 'Your Next Getaway'], ['7 days in the Greek islands', 'Flights, hotels and tours included'], ['From $1,299 per person', WEB], 'Book your trip', '7 DAYS', ['Island hopping', 'Local food tours', 'Sunset cruise'], '✈️'),
  T('Summer', 'Seasonal', 'summer beach sun vacation pool season', 'sun', ['fun', 'bold'], ['Hello Summer', 'Summer Vibes', 'Summer Kickoff'], ['Sun, sand and good times', 'Our summer collection is here'], ['June 21', WEB], 'Dive in', 'SUMMER', ['Beach days', 'Ice cream', 'Long nights'], '🏖️'),
  T('Autumn', 'Seasonal', 'fall autumn leaves harvest season cozy', 'leaf', ['natural', 'elegant'], ['Hello Autumn', 'Fall Harvest', 'Cozy Season'], ['Warm drinks and crisp air', 'Our fall menu is back'], ['Starting September 22'], 'Come on in', 'FALL', ['Apple cider', 'Pumpkin bread', 'Cozy sweaters'], '🍂'),
  T('Winter', 'Seasonal', 'winter snow season cold holiday cozy', 'snowflake', ['calm', 'elegant', 'pro'], ['Winter Wonderland', 'Hello Winter', 'Snow Day'], ['Warm up with our winter specials', 'The season of cozy'], ['December 21'], 'Stay warm', 'WINTER', ['Hot cocoa', 'Warm blankets', 'Snow days'], '❄️'),
  T('Spring', 'Seasonal', 'spring flowers bloom fresh season easter garden', 'flower', ['calm', 'fun', 'natural'], ['Hello Spring', 'Spring Into Savings', 'In Full Bloom'], ['Fresh starts and new colors', 'Our spring line has arrived'], ['March 20'], 'Shop spring', 'SPRING', ['Fresh flowers', 'Light layers', 'Garden days'], '🌷'),
  T('Happy New Year', 'Seasonal', 'new year celebration countdown eve party resolution', 'sparkle', ['bold', 'elegant'], ['Happy New Year', 'Cheers to 2027', 'New Year’s Eve'], ['Here’s to new beginnings', 'Ring in the new year with us'], ['December 31 · 9 PM'], 'Join the party', '2027', ['Countdown', 'Live music', 'Midnight toast'], '🎆'),
  T('Thanksgiving', 'Seasonal', 'thanksgiving grateful harvest dinner family', 'leaf', ['natural', 'elegant'], ['Happy Thanksgiving', 'Grateful & Thankful', 'Give Thanks'], ['Wishing you a warm holiday', 'Closed Thursday — see you Friday'], ['November 26'], 'With gratitude', 'THANKS', ['Family', 'Food', 'Gratitude'], '🦃'),
  T('Back to School', 'Education', 'back to school students supplies education class', 'book', ['fun', 'bold', 'pro'], ['Back to School', 'Ready, Set, Learn!', 'School’s In'], ['Everything you need for a great year', 'Supplies up to 30% off'], ['Starting August 15'], 'Get ready', 'A+', ['Notebooks', 'Backpacks', 'Laptops'], '🎒'),
  T('Kids Camp', 'Education', 'kids summer camp children activities fun', 'sun', ['fun', 'calm'], ['Summer Camp', 'Camp Adventure', 'Fun All Summer'], ['Ages 5–12 · Weekly sessions', 'Arts, sports, science and more'], ['June 22 – August 14', 'Sign up at ' + WEB], 'Enroll today', '5–12', ['Swimming', 'Crafts', 'Field trips'], '⛺'),
  T('Online Course', 'Education', 'course online class learning education lesson', 'cap', ['pro', 'calm', 'fun'], ['Learn to Code', 'Master Excel in 30 Days', 'Start Learning Today'], ['A beginner-friendly online course', 'Lifetime access · Certificate included'], ['Enroll at ' + WEB], 'Enroll now', '30 DAYS', ['Video lessons', 'Real projects', 'Certificate'], '📚'),
  T('Certificate', 'Education', 'certificate award achievement diploma recognition', 'medal', ['elegant', 'pro'], ['Certificate of Achievement', 'Certificate of Completion', 'Award of Excellence'], ['This certificate is proudly presented to', 'In recognition of outstanding performance'], ['Jordan Taylor', 'June 14, 2026'], 'Signature', '★', ['Dedication', 'Excellence', 'Achievement'], '🏆'),
  T('Book Club', 'Education', 'book club reading library literature', 'book', ['elegant', 'natural', 'calm'], ['Book Club', 'Read With Us', 'This Month’s Read'], ['All readers welcome', 'Coffee, cake and good conversation'], ['First Tuesday · 7 PM', 'Main Street Library'], 'Join us', 'VOL. 12', ['Discussion', 'Coffee', 'New friends'], '📖'),
  T('Pet Care', 'Business', 'pet dog cat grooming vet adoption animals', 'paw', ['fun', 'calm', 'natural'], ['Happy Pets', 'Pamper Your Pet', 'Adopt, Don’t Shop'], ['Grooming, walking and daycare', 'Loving care for your best friend'], ['(555) 123-4567 · ' + WEB], 'Book a visit', '🐾', ['Grooming', 'Daycare', 'Dog walking'], '🐶'),
  T('Cleaning Service', 'Business', 'cleaning maid house office janitorial service', 'spray', ['calm', 'pro', 'fun'], ['Sparkling Clean', 'Cleaning Service', 'We Clean, You Relax'], ['Homes and offices · Eco-friendly products', 'Book a spotless clean'], ['Call (555) 123-4567'], 'Get a quote', '15%', ['Deep cleans', 'Move-in / move-out', 'Weekly service'], '🧼'),
  T('Home Services', 'Business', 'plumbing handyman repair contractor landscaping construction', 'wrench', ['bold', 'pro', 'natural'], ['Fast, Reliable Repairs', 'Your Local Handyman', 'We Fix It Right'], ['Licensed · Insured · 20 years’ experience', 'No job too small'], ['Call (555) 123-4567'], 'Free estimate', '24/7', ['Plumbing', 'Electrical', 'Carpentry'], '🛠️'),
  T('Fundraiser', 'Events', 'fundraiser charity donate nonprofit community cause', 'heart', ['calm', 'fun', 'pro'], ['Community Fundraiser', 'Help Us Reach Our Goal', 'Give Back'], ['Every dollar helps local families', 'Join us for a good cause'], [DATE, 'Community Center'], 'Donate today', '$10K', ['Silent auction', 'Bake sale', 'Raffle'], '🤝'),
  T('Garage Sale', 'Events', 'garage sale yard sale moving sale bargains', 'tag', ['fun', 'bold', 'natural'], ['Yard Sale', 'Garage Sale', 'Moving Sale'], ['Furniture, toys, books, tools and more', 'Everything must go!'], ['Saturday 8 AM – 2 PM', '42 Maple Lane'], 'Early birds welcome', '$1', ['Furniture', 'Kids stuff', 'Tools'], '🏷️'),
  T('Sports', 'Events', 'sports game tournament team league match soccer basketball', 'ball', ['bold', 'fun', 'pro'], ['Game Day', 'Championship', 'Tryouts'], ['Come cheer on the home team', 'Spring league registration is open'], ['Saturday · 2 PM', 'City Stadium'], 'Get tickets', 'VS', ['Kickoff 2 PM', 'Halftime show', 'Family zone'], '⚽'),
  T('Data Backup', 'Tech', 'backup data recovery cloud ransomware disaster it', 'shield', ['pro', 'bold'], ['Back It Up', 'Is Your Data Safe?', 'Don’t Lose a Thing'], ['Automatic, encrypted, off-site backups', 'Recover in minutes, not days'], ['(555) 123-4567 · ' + WEB], 'Get protected', '3-2-1', ['Daily backups', 'Tested restores', 'Ransomware ready'], '💾'),
  T('Cloud Migration', 'Tech', 'cloud migration microsoft 365 email move server it', 'cloud', ['pro', 'calm'], ['Move to the Cloud', 'Work From Anywhere', 'Goodbye, Server Closet'], ['We move your email and files — no downtime', 'Microsoft 365 and Google Workspace experts'], [WEB], 'Plan your move', '0', ['Email', 'Files', 'Teams & chat'], '☁️'),
  T('Tech Tip', 'Tech', 'tech tip password security computer help it how to', 'bulb', ['pro', 'fun'], ['Tech Tip Tuesday', 'Quick Tech Tip', 'Did You Know?'], ['Use a password manager — one strong password to rule them all', 'Restart your computer once a week'], [WEB], 'More tips', 'TIP', ['Use a password manager', 'Turn on MFA', 'Update software'], '💡'),
  T('Phishing Alert', 'Tech', 'phishing scam email alert warning security awareness', 'bell', ['bold', 'pro'], ['Phishing Alert', 'Don’t Take the Bait', 'Spot the Scam'], ['Check the sender before you click', 'When in doubt, call — don’t click'], [WEB], 'Report it', '!', ['Urgent tone', 'Odd sender', 'Unexpected links'], '🎣'),
  T('Accounting', 'Business', 'accounting bookkeeping tax cpa finance small business', 'chart', ['pro', 'calm'], ['Tax Season Made Simple', 'Books Done Right', 'Your Numbers, Sorted'], ['Bookkeeping, payroll and tax returns', 'Stress-free filing for small businesses'], ['(555) 123-4567 · ' + WEB], 'Book a consultation', 'TAX', ['Bookkeeping', 'Payroll', 'Tax returns'], '📊'),
  T('Law Firm', 'Business', 'law lawyer attorney legal firm counsel', 'scale', ['elegant', 'pro'], ['Experienced Counsel', 'Legal Help You Can Trust', 'We Fight for You'], ['Free initial consultation', 'Over 20 years of experience'], ['(555) 123-4567 · ' + WEB], 'Call today', '20+', ['Business law', 'Estate planning', 'Real estate'], '⚖️'),
  T('Insurance', 'Business', 'insurance agent coverage home auto life policy quote', 'shieldcheck', ['pro', 'calm'], ['Protect What Matters', 'Coverage You Can Count On', 'Get a Better Rate'], ['Home, auto and business insurance', 'Compare quotes in minutes'], ['(555) 123-4567'], 'Get a free quote', '15%', ['Home', 'Auto', 'Business'], '🛡️'),
  T('Plumbing', 'Home services', 'plumber plumbing leak drain water heater emergency', 'drop', ['bold', 'pro'], ['Leaky Pipes?', 'Plumbing Pros', 'We Fix It Fast'], ['24/7 emergency service', 'Licensed, insured and local'], ['(555) 123-4567'], 'Call now', '24/7', ['Drains', 'Water heaters', 'Leak repair'], '🔧'),
  T('HVAC', 'Home services', 'hvac heating cooling air conditioning furnace tune up', 'snowflake', ['bold', 'pro'], ['Stay Cool This Summer', 'Heating & Cooling', 'Tune-Up Special'], ['Book your seasonal tune-up today', 'Same-day repairs'], ['(555) 123-4567 · ' + WEB], 'Schedule service', '$79', ['A/C repair', 'Furnaces', 'Maintenance plans'], '❄️'),
  T('Electrician', 'Home services', 'electrician electrical wiring lighting panel repair', 'bolt', ['bold', 'pro'], ['Powered by Pros', 'Licensed Electricians', 'Bright Ideas'], ['Wiring, panels, lighting and EV chargers', 'Safe, code-compliant work'], ['(555) 123-4567'], 'Get an estimate', 'EV', ['Panels', 'Lighting', 'EV chargers'], '⚡'),
  T('Auto Repair', 'Home services', 'auto repair mechanic car garage oil change tires', 'car', ['bold', 'pro'], ['Auto Repair', 'Honest Mechanics', 'Oil Change Special'], ['All makes and models', 'Fast, fair and guaranteed'], [ADDR, '(555) 123-4567'], 'Book service', '$29', ['Oil changes', 'Brakes', 'Tires'], '🚗'),
  T('Construction', 'Home services', 'construction contractor remodel renovation builder', 'building', ['bold', 'pro', 'natural'], ['Built to Last', 'Dream Remodel', 'Quality Construction'], ['Kitchens, baths, additions', 'Free estimates, fixed prices'], ['(555) 123-4567 · ' + WEB], 'Get a free estimate', '25 yrs', ['Kitchens', 'Bathrooms', 'Additions'], '🏗️'),
  T('Landscaping', 'Home services', 'landscaping lawn garden yard mowing gardening', 'sprout', ['natural', 'calm'], ['Lawn Care Pros', 'Your Yard, Transformed', 'Spring Clean-Up'], ['Mowing, planting and design', 'Weekly and one-time service'], ['(555) 123-4567'], 'Get a quote', 'GREEN', ['Mowing', 'Planting', 'Clean-ups'], '🌿'),
  T('Moving Company', 'Home services', 'moving movers relocation packing truck', 'truck', ['bold', 'fun'], ['Moving Made Easy', 'We’ve Got You Covered', 'Let’s Move'], ['Local and long-distance moves', 'Packing, loading and delivery'], ['(555) 123-4567 · ' + WEB], 'Get a quote', '5★', ['Packing', 'Loading', 'Storage'], '📦'),
  T('Photography', 'Business', 'photography photographer portrait session photoshoot', 'camera', ['elegant', 'calm', 'pro'], ['Capture the Moment', 'Portrait Sessions', 'Book Your Shoot'], ['Family, headshots and events', 'Mini sessions available'], [WEB], 'Book now', 'SAVE', ['Headshots', 'Families', 'Events'], '📷'),
  T('Daycare', 'Education', 'daycare childcare preschool kids nursery enrolment', 'smile', ['fun', 'calm'], ['Now Enrolling', 'Where Little Ones Grow', 'Happy Kids Daycare'], ['Ages 6 weeks to 5 years', 'Caring, qualified teachers'], [ADDR, '(555) 123-4567'], 'Book a tour', 'ABC', ['Play-based learning', 'Healthy meals', 'Small classes'], '🧸'),
  T('Tutoring', 'Education', 'tutoring tutor math reading homework test prep', 'pencil', ['fun', 'pro'], ['Tutoring That Works', 'Ace That Test', 'Homework Help'], ['Math, reading and science', 'One-on-one or small groups'], [WEB], 'Book a free session', 'A+', ['Math', 'Reading', 'Test prep'], '📚'),
  T('Music Lessons', 'Education', 'music lessons piano guitar voice teacher learn', 'music', ['fun', 'elegant'], ['Music Lessons', 'Learn to Play', 'Find Your Sound'], ['Piano, guitar and voice', 'All ages and levels'], [WEB], 'Book a trial lesson', '♪', ['Piano', 'Guitar', 'Voice'], '🎹'),
  T('Veterinary', 'Health', 'vet veterinary clinic animal hospital pet checkup', 'heartpulse', ['calm', 'fun'], ['Caring for Your Pets', 'Your Neighbourhood Vet', 'Annual Checkup Time'], ['Wellness exams, vaccines and dental care', 'New patients welcome'], [ADDR, '(555) 123-4567'], 'Book a visit', '♥', ['Checkups', 'Vaccines', 'Dental care'], '🐾'),
  T('Customer Review', 'Social', 'review testimonial customer feedback rating stars', 'star', ['pro', 'calm', 'elegant'], ['What Our Customers Say', '5-Star Service', 'Loved by Locals'], ['“Fast, friendly and fair. Highly recommend!”', '“They went above and beyond.”'], ['— Jamie R., happy customer'], 'Read more reviews', '5★', ['Fast', 'Friendly', 'Fair'], '⭐'),
  T('Holiday Hours', 'Business', 'holiday hours closed schedule opening times notice', 'clock', ['calm', 'pro'], ['Holiday Hours', 'We’re Closed', 'Updated Hours'], ['Closed Thursday and Friday', 'Back to normal hours on Monday'], [WEB], 'Plan ahead', 'OPEN', ['Mon–Wed: 9–5', 'Thu–Fri: Closed', 'Sat: 10–2'], '🕒'),
  T('Referral Program', 'Marketing', 'referral refer a friend reward program bonus', 'users', ['fun', 'bold'], ['Refer a Friend', 'Share the Love', 'Give $25, Get $25'], ['Tell a friend and you both save', 'No limit on rewards'], [WEB], 'Start referring', '$25', ['Share your link', 'They sign up', 'You both save'], '🤝'),
  T('Newsletter', 'Marketing', 'newsletter email subscribe updates signup', 'mail', ['pro', 'calm'], ['Join Our Newsletter', 'Stay in the Loop', 'Monthly Updates'], ['Tips, news and offers — once a month', 'No spam, ever'], [WEB], 'Subscribe', 'NEW', ['Tips', 'News', 'Offers'], '📬'),
  T('Cyber Monday', 'Marketing', 'cyber monday online sale deals shopping', 'laptop', ['bold', 'pro'], ['Cyber Monday', 'Online Only Deals', 'Click. Save. Repeat.'], ['24 hours of online-only savings', 'Free shipping on every order'], [WEB], 'Shop online', '40%', ['Tech', 'Home', 'Gifts'], '🖥️'),
  T('Halloween', 'Seasonal', 'halloween costume party trick or treat spooky october', 'moon', ['fun', 'bold'], ['Halloween Party', 'Spooky Season', 'Trick or Treat'], ['Costume contest and treats', 'Frightfully fun for all ages'], ['October 31 · 6 PM', ADDR], 'Join the fun', '31', ['Costumes', 'Treats', 'Games'], '🎃'),
  T('Holiday Sale', 'Seasonal', 'holiday sale december gifts winter shopping', 'gift', ['bold', 'elegant', 'fun'], ['Holiday Sale', 'Gifts for Everyone', 'Season’s Savings'], ['Wrap up your shopping early', 'Free gift wrapping in store'], [ADDR, WEB], 'Shop gifts', '30%', ['Gift sets', 'Stocking fillers', 'Gift cards'], '🎁'),
  T('Job Fair', 'Business', 'job fair career hiring recruitment employment expo', 'briefcase', ['pro', 'bold'], ['Job Fair', 'Careers Start Here', 'Meet Your Next Employer'], ['Over 40 local employers hiring now', 'Bring your résumé'], [DATE, ADDR], 'Register free', '40+', ['On-the-spot interviews', 'Résumé help', 'Free entry'], '💼'),
  T('Volunteer', 'Events', 'volunteer community nonprofit help charity cleanup', 'hand', ['calm', 'fun', 'natural'], ['Volunteers Needed', 'Lend a Hand', 'Make a Difference'], ['Join our community clean-up', 'Every hour helps'], [DATE, ADDR], 'Sign up', '100', ['Meet neighbours', 'Give back', 'Have fun'], '🙌'),
  T('Business Card', 'Business', 'business card contact personal brand professional', 'user', ['pro', 'elegant', 'natural'], ['Jordan Taylor', 'Alex Morgan', 'Sam Rivera'], ['Founder & Designer', 'Managing Director', 'IT Consultant'], ['(555) 123-4567', 'hello@yourbusiness.com', WEB], WEB, 'JT', ['Branding', 'Strategy', 'Design'], '📇'),
  T('Logo', 'Business', 'logo brand identity monogram emblem', 'sparkle', ['pro', 'bold', 'elegant', 'natural'], ['Northwind', 'Lumen & Co.', 'Bright Studio'], ['Est. 2026', 'Design Studio', 'Coffee Roasters'], [''], '', 'N', ['', '', ''], '⭐'),
];

// ---------------------------------------------------------------- builders
function txt(text, font, weight, size, color, o) {
  return Object.assign({ id: C.uid(), type: 'text', x: 0, y: 0, w: 100, h: 10, rot: 0, opacity: 1, text, font, weight, size, color, align: 'center', lh: 1.15, ls: 0 }, o || {});
}
function shp(shape, x, y, w, h, fill, o) { return Object.assign({ id: C.uid(), type: 'shape', shape, x, y, w, h, rot: 0, opacity: 1, fill }, o || {}); }
function icon(name, x, y, sz, color, o) { return Object.assign({ id: C.uid(), type: 'icon', icon: name, x, y, w: sz, h: sz, rot: 0, opacity: 1, color, sw: 1.8 }, o || {}); }
function photo(x, y, w, h, mask, ph, o) { return Object.assign({ id: C.uid(), type: 'image', src: null, x, y, w, h, rot: 0, opacity: 1, mask: mask || 'none', ph, zoom: 1, px: 0, py: 0 }, o || {}); }
// Lay text elements out top-to-bottom inside a region, centred vertically.
function stack(items, x, y, w, h, align, valign) {
  const total = items.reduce((a, it) => a + (it.el ? it.el.h : 0) + (it.gap || 0), 0);
  let cy = valign === 'top' ? y : valign === 'bottom' ? y + h - total : y + (h - total) / 2;
  for (const it of items) {
    cy += it.gap || 0;
    if (!it.el) continue;
    const el = it.el;
    el.x = align === 'center' ? x + (w - el.w) / 2 : align === 'right' ? x + w - el.w : x;
    el.y = cy; cy += el.h;
  }
  return items.filter(i => i.el).map(i => i.el);
}
function pill(label, cx, y, s, fill, color, font, weight, o) {
  const t = txt(label, font, weight || 700, s * .032, color, { lh: 1.1 });
  t.w = 1e4; C.syncText(t); t.w = Math.ceil(C.textWidth(t)) + 2;
  C.syncText(t);
  const padX = t.size * 1.3, padY = t.size * .75;
  const r = shp('rect', cx - t.w / 2 - padX, y, t.w + padX * 2, t.h + padY * 2, fill, { radius: (o && o.square) ? t.size * .2 : (t.h + padY * 2) / 2 });
  t.x = r.x + padX; t.y = y + padY;
  return [r, t];
}
const pick = (arr, i) => arr[((i % arr.length) + arr.length) % arr.length];

// ---------------------------------------------------------------- layouts
// Each layout gets a context and returns {bg, els}. Coordinates are page pixels.
function ctxFor(topic, vi, layoutIdx, W, H) {
  const mood = pick(topic.m, vi + layoutIdx);
  const pal = pick(PALETTES[mood], vi * 5 + layoutIdx * 3 + topic.n.length);
  const fp = pick(FONTPAIRS[mood], vi + layoutIdx * 2 + (topic.n.charCodeAt(0) || 0));
  const R = C.rng(vi * 7919 + layoutIdx * 104729 + topic.n.length * 31 + 17);
  const a = W / H, s = Math.min(W, H) * (a > 2.4 || a < .42 ? 1.25 : 1);   // very thin banners get larger type
  return {
    W, H, s, a, wide: a > 1.35, tall: a < .8, banner: a > 2.4, R, mood, pal, fp, topic, vi,
    head: pick(topic.h, vi), sub: pick(topic.s, vi + 1), det: topic.d.filter(Boolean), cta: topic.t, big: topic.b,
    H1: (text, size, color, o) => txt(text, fp.h, fp.hw, size, color, Object.assign({ upper: fp.up, ls: fp.ls, italic: !!fp.hi, lh: 1.05 }, o)),
    B: (text, size, color, o) => txt(text, fp.b, fp.bw, size, color, Object.assign({ lh: 1.35 }, o)),
    L: (text, size, color, o) => txt(text, fp.b, 600, size, color, Object.assign({ upper: true, ls: .18, lh: 1.2 }, o)),
  };
}
const fit = (el, w, h, lines, min) => C.fitText(el, w, h, lines, min);

const LAYOUTS = [
  { n: 'Centered bold', f(c) {
    const { W, H, s, pal, R } = c;
    const els = [];
    els.push(shp('blob', -s * .18, -s * .2, s * .62, s * .6, pal.s, { opacity: .9, seed: 3 + c.vi }));
    els.push(shp('blob', W - s * .38, H - s * .36, s * .6, s * .58, pal.p, { opacity: .85, seed: 9 + c.vi }));
    els.push(shp('ring', W - s * .26, s * .08, s * .16, s * .16, pal.a, { opacity: .5, sw: s * .012 }));
    const pad = s * (c.banner ? .06 : .12), bw = W - pad * 2;
    const lab = c.L(c.topic.c === 'Social' ? 'Today' : c.det[0] || '', s * .03, pal.ink, { opacity: .8 });
    fit(lab, bw, s * .1, 1);
    const h1 = fit(c.H1(c.head, s * .19, pal.ink), bw, H * (c.banner ? .45 : .42), 3, 10);
    const sub = fit(c.B(c.sub, s * .045, pal.ink, { opacity: .85 }), Math.min(bw, s * 1.1), H * .15, 2);
    const items = [{ el: lab }, { el: h1, gap: s * .03 }, { el: sub, gap: s * .03 }];
    const st = stack(items, pad, pad * .6, bw, H - pad * 1.2 - (c.banner ? 0 : s * .12), 'center');
    els.push(...st);
    if (!c.banner && c.cta) { const [r, t] = pill(c.cta, W / 2, st[st.length - 1].y + st[st.length - 1].h + s * .05, s, pal.p, pal.pi, c.fp.b); if (r.y + r.h < H - s * .03) els.push(r, t); }
    return { bg: { fill: pal.bg, pattern: R() < .5 ? { kind: pick(['dots', 'plus', 'diagonal'], c.vi), color: pal.ink, opacity: .06, scale: 1 } : null }, els };
  } },
  { n: 'Split photo', f(c) {
    const { W, H, s, pal } = c;
    const els = [];
    let tx, ty, tw, th;
    if (c.wide) {
      const pw = W * (c.banner ? .38 : .46);
      els.push(photo(W - pw, 0, pw, H, 'none', C.mix(pal.s, '#ffffff', .2)));
      els.push(shp('rect', W - pw - s * .02, 0, s * .02, H, pal.p));
      tx = s * .09; ty = 0; tw = W - pw - s * .18; th = H;
    } else {
      const ph = H * .5;
      els.push(photo(0, 0, W, ph, 'none', C.mix(pal.s, '#ffffff', .2)));
      els.push(shp('rect', 0, ph, W, s * .02, pal.p));
      tx = s * .09; ty = ph + s * .02; tw = W - s * .18; th = H - ph - s * .02;
    }
    const lab = fit(c.L(c.big && c.big.length < 8 ? c.topic.c : c.topic.c, s * .028, pal.p, { align: 'left' }), tw, s * .1, 1);
    const h1 = fit(c.H1(c.head, s * .13, pal.ink, { align: 'left' }), tw, th * .45, 3, 10);
    const sub = fit(c.B(c.sub, s * .04, pal.ink, { align: 'left', opacity: .8 }), tw, th * .2, 3);
    const det = c.det.length && !c.banner ? fit(c.B(c.det.join('\n'), s * .03, pal.ink, { align: 'left', weight: 600 }), tw, th * .18, 3) : null;
    els.push(...stack([{ el: lab }, { el: h1, gap: s * .025 }, { el: sub, gap: s * .03 }, { el: det, gap: s * .04 }], tx, ty + s * .06, tw, th - s * .12, 'left'));
    return { bg: { fill: pal.bg }, els };
  } },
  { n: 'Elegant frame', f(c) {
    const { W, H, s, pal } = c;
    const els = [];
    const m = s * .05;
    els.push(shp('rect', m, m, W - m * 2, H - m * 2, 'none', { stroke: pal.p, sw: Math.max(2, s * .004) }));
    els.push(shp('rect', m * 1.35, m * 1.35, W - m * 2.7, H - m * 2.7, 'none', { stroke: pal.p, sw: Math.max(1, s * .0015) }));
    const iw = W - m * 5, ih = H - m * 5;
    const ic = c.banner ? null : icon(c.topic.i, 0, 0, s * .08, pal.p, { sw: 1.2 });
    const lab = fit(c.L(c.sub, s * .028, pal.ink, { opacity: .75 }), iw, ih * .14, 2);
    const h1 = fit(c.H1(c.head, s * .12, pal.ink, { upper: false, lh: 1.1 }), iw, ih * .42, 3, 10);
    const line = shp('line', 0, 0, s * .16, s * .02, pal.p, { sw: Math.max(1, s * .003) });
    line.x = (W - line.w) / 2;
    const det = c.det.length ? fit(c.B(c.det.join('\n'), s * .032, pal.ink, { lh: 1.5 }), iw, ih * .22, 3) : null;
    const lineHolder = { el: null, gap: s * .035 };
    const items = [{ el: ic ? Object.assign(ic, { h: ic.h }) : null }, { el: lab, gap: ic ? s * .03 : 0 }, { el: h1, gap: s * .03 }, lineHolder, { el: det, gap: s * .035 }];
    const st = stack(items, m * 2.5, m * 2.5, iw, ih, 'center');
    // place the divider between the headline and details
    line.y = h1.y + h1.h + s * .035 / 2 - line.h / 2 + s * .005;
    els.push(...st, line);
    return { bg: { fill: pal.bg }, els };
  } },
  { n: 'Circle photo', f(c) {
    const { W, H, s, pal } = c;
    const els = [];
    const d = c.banner ? H * .74 : s * (c.wide ? .62 : .5);
    let px, py;
    if (c.wide) { px = W - d - s * .1; py = (H - d) / 2; } else { px = (W - d) / 2; py = s * .1; }
    els.push(shp('ellipse', px + d * .08, py + d * .06, d, d, pal.s));
    els.push(photo(px, py, d, d, 'ellipse', C.mix(pal.p, '#ffffff', .55)));
    els.push(shp('ring', px - d * .06, py - d * .06, d * .3, d * .3, pal.p, { sw: s * .01 }));
    let tx, ty, tw, th, al;
    if (c.wide) { tx = s * .1; ty = s * .06; tw = px - s * .2; th = H - s * .12; al = 'left'; }
    else { tx = s * .09; ty = py + d + s * .05; tw = W - s * .18; th = H - ty - s * .06; al = 'center'; }
    const h1 = fit(c.H1(c.head, s * .12, pal.ink, { align: al }), tw, th * .5, 3, 10);
    const sub = fit(c.B(c.sub, s * .038, pal.ink, { align: al, opacity: .8 }), tw, th * .25, 2);
    const cta = c.cta && !c.banner ? fit(c.L(c.cta, s * .03, pal.p, { align: al, weight: 800 }), tw, th * .12, 1) : null;
    els.push(...stack([{ el: h1 }, { el: sub, gap: s * .025 }, { el: cta, gap: s * .035 }], tx, ty, tw, th, al));
    return { bg: { fill: pal.bg }, els };
  } },
  { n: 'Diagonal band', f(c) {
    const { W, H, s, pal } = c;
    const els = [];
    const bh = c.banner ? H * .62 : H * .36;
    const band = shp('rect', -W * .2, (H - bh) / 2, W * 1.4, bh, pal.p, { rot: c.banner ? -2 : -8 });
    els.push(shp('rect', -W * .2, (H - bh) / 2 + s * .03, W * 1.4, bh, pal.s, { rot: c.banner ? -2 : -8, opacity: .9 }));
    els.push(band);
    const tw = W * (c.banner ? .8 : .78);
    const h1 = fit(c.H1(c.head, s * .16, pal.pi, { rot: c.banner ? -2 : -8 }), tw, bh * .6, 2, 10);
    h1.x = (W - h1.w) / 2; h1.y = H / 2 - h1.h / 2;
    els.push(h1);
    if (!c.banner) {
      const sub = fit(c.B(c.sub, s * .042, pal.ink, { weight: 600 }), W * .8, H * .18, 2);
      sub.x = (W - sub.w) / 2; sub.y = H * .06 + (H * .26 - sub.h) / 2 - s * .02;
      const det = fit(c.L(c.det.join('  ·  ') || c.cta, s * .03, pal.ink), W * .84, H * .2, 2);
      det.x = (W - det.w) / 2; det.y = H - H * .07 - det.h - (H * .22 - det.h) / 2 + s * .03;
      els.push(sub, det);
    }
    return { bg: { fill: pal.bg, pattern: { kind: 'stripes', color: pal.ink, opacity: .04, scale: .6 } }, els };
  } },
  { n: 'Big badge', f(c) {
    const { W, H, s, pal } = c;
    const els = [];
    const d = c.banner ? H * .8 : s * .42;
    const bx = c.wide ? W - d - s * .1 : (W - d) / 2, by = c.wide ? (H - d) / 2 : H * .08;
    els.push(shp('burst', bx, by, d, d, pal.p, { rot: -12, points: 18 }));
    const big = fit(c.H1(c.big, d * .34, pal.pi, { upper: true, rot: -12, lh: 1 }), d * .7, d * .5, 1, 10);
    big.x = bx + (d - big.w) / 2; big.y = by + (d - big.h) / 2;
    els.push(big);
    els.push(shp('star4', bx - d * .1, by + d * .7, d * .18, d * .18, pal.s), shp('star4', bx + d * .95, by + d * .05, d * .12, d * .12, pal.a, { opacity: .8 }));
    let tx, ty, tw, th, al;
    if (c.wide) { tx = s * .1; ty = s * .06; tw = bx - s * .2; th = H - s * .12; al = 'left'; }
    else { tx = s * .08; ty = by + d + s * .03; tw = W - s * .16; th = H - ty - s * .05; al = 'center'; }
    const h1 = fit(c.H1(c.head, s * .13, pal.ink, { align: al }), tw, th * .48, 2, 10);
    const sub = fit(c.B(c.sub, s * .04, pal.ink, { align: al, opacity: .85 }), tw, th * .22, 2);
    const parts = [{ el: h1 }, { el: sub, gap: s * .02 }];
    els.push(...stack(parts, tx, ty, tw, th * (c.banner ? 1 : .78), al));
    if (!c.banner && c.cta) {
      const [r, t] = pill(c.cta, al === 'center' ? W / 2 : 0, 0, s, pal.ink, pal.bg, c.fp.b);
      const lastEl = els[els.length - 1];
      const dy = lastEl.y + lastEl.h + s * .045 - r.y;
      if (al === 'left') { const dx = tx - r.x; r.x += dx; t.x += dx; }
      r.y += dy; t.y += dy;
      if (r.y + r.h < H - s * .02) els.push(r, t);
    }
    return { bg: { fill: pal.bg, pattern: { kind: pick(['halftone', 'confetti', 'dots'], c.vi), color: pal.p, opacity: .12, scale: 1, seed: c.vi + 3 } }, els };
  } },
  { n: 'Minimal type', f(c) {
    const { W, H, s, pal } = c;
    const els = [];
    const m = s * .08;
    const tw = W - m * 2;
    els.push(shp('rect', m, m, s * .09, s * .014, pal.p));
    const tag = fit(c.L(c.topic.c, s * .026, pal.ink, { align: 'left', opacity: .7 }), tw * .6, s * .06, 1);
    tag.x = m; tag.y = m + s * .04;
    els.push(tag, icon(c.topic.i, W - m - s * .08, m - s * .01, s * .08, pal.p));
    const h1 = fit(c.H1(c.head, s * .17, pal.ink, { align: 'left', lh: 1 }), tw * (c.banner ? .7 : .95), H * (c.banner ? .5 : .46), 4, 10);
    h1.x = m; h1.y = c.banner ? (H - h1.h) / 2 : m + s * .16;
    els.push(h1);
    const foot = fit(c.B([c.sub, ...c.det].slice(0, c.banner ? 1 : 3).join('\n'), s * .032, pal.ink, { align: c.banner ? 'right' : 'left', opacity: .85, lh: 1.45 }), c.banner ? W * .26 : tw * .8, H * .24, 4);
    foot.x = c.banner ? W - m - foot.w : m; foot.y = c.banner ? (H - foot.h) / 2 : H - m - foot.h;
    if (!c.banner && foot.y < h1.y + h1.h + s * .04) foot.y = h1.y + h1.h + s * .04;
    els.push(foot);
    return { bg: { fill: pal.bg }, els };
  } },
  { n: 'Wave footer', f(c) {
    const { W, H, s, pal } = c;
    const els = [];
    const wh = H * (c.banner ? .4 : .3);
    els.push(shp('wave', 0, H - wh * 1.15, W, wh * 1.15, pal.s, { points: c.wide ? 3 : 2 }));
    els.push(shp('wave', 0, H - wh, W, wh, pal.p, { points: c.wide ? 2 : 1, flipX: true }));
    els.push(shp('ellipse', W * .82, H * .07, s * .12, s * .12, pal.s, { opacity: .7 }), shp('ellipse', W * .08, H * .12, s * .05, s * .05, pal.p, { opacity: .6 }));
    const tw = W - s * .2, th = H - wh * 1.2 - s * .08;
    const ic = c.banner ? null : icon(c.topic.i, 0, 0, s * .09, pal.p);
    const h1 = fit(c.H1(c.head, s * .15, pal.ink), tw, th * .55, 3, 10);
    const sub = fit(c.B(c.sub, s * .04, pal.ink, { opacity: .8 }), tw, th * .22, 2);
    els.push(...stack([{ el: ic }, { el: h1, gap: ic ? s * .03 : 0 }, { el: sub, gap: s * .025 }], s * .1, s * .06, tw, th, 'center'));
    const det = fit(c.L(c.det[0] || c.cta, s * .028, pal.pi, { weight: 700 }), W * .8, wh * .4, 1);
    det.x = (W - det.w) / 2; det.y = H - wh * .45 - det.h / 2;
    els.push(det);
    return { bg: { fill: pal.bg }, els };
  } },
  { n: 'Arch photo', f(c) {
    const { W, H, s, pal } = c;
    const els = [];
    let aw, ah, ax, ay;
    if (c.wide) { ah = H * .8; aw = Math.min(ah * .72, W * .4); ax = W - aw - s * .1; ay = H - ah; }
    else { aw = W * .58; ah = Math.min(aw * 1.25, H * .52); ax = (W - aw) / 2; ay = s * .08; }
    els.push(shp('arch', ax + s * .03, ay - s * .03, aw, ah + (c.wide ? s * .03 : 0), pal.s));
    els.push(photo(ax, ay, aw, ah, 'arch', C.mix(pal.p, '#ffffff', .5)));
    els.push(shp('star4', ax - s * .06, ay + ah * .1, s * .08, s * .08, pal.p));
    let tx, ty, tw, th, al;
    if (c.wide) { tx = s * .1; ty = s * .06; tw = ax - s * .2; th = H - s * .12; al = 'left'; }
    else { tx = s * .1; ty = ay + ah + s * .04; tw = W - s * .2; th = H - ty - s * .05; al = 'center'; }
    const lab = fit(c.L(c.sub, s * .026, pal.p, { align: al }), tw, th * .18, 2);
    const h1 = fit(c.H1(c.head, s * .11, pal.ink, { align: al }), tw, th * .5, 3, 10);
    const det = c.det.length && !c.banner ? fit(c.B(c.det[0], s * .032, pal.ink, { align: al, opacity: .8 }), tw, th * .15, 2) : null;
    els.push(...stack([{ el: lab }, { el: h1, gap: s * .02 }, { el: det, gap: s * .03 }], tx, ty, tw, th, al));
    return { bg: { fill: pal.bg }, els };
  } },
  { n: 'Checklist', f(c) {
    const { W, H, s, pal } = c;
    const els = [];
    const m = s * .09;
    const list = (c.topic.l || []).filter(Boolean);
    const hw = c.wide ? W * .46 : W - m * 2;
    els.push(shp('rect', 0, 0, c.wide ? W * .52 : W, c.wide ? H : H * .36, pal.p));
    const h1 = fit(c.H1(c.head, s * .13, pal.pi, { align: 'left' }), hw - (c.wide ? m : 0), (c.wide ? H : H * .36) * .55, 3, 10);
    const sub = fit(c.B(c.sub, s * .036, pal.pi, { align: 'left', opacity: .85 }), hw - (c.wide ? m : 0), s * .14, 2);
    els.push(...stack([{ el: h1 }, { el: sub, gap: s * .02 }], m, 0, hw, c.wide ? H : H * .36, 'left'));
    const lx = c.wide ? W * .52 + m * .7 : m, ly = c.wide ? m : H * .36 + m * .7;
    const lw = c.wide ? W * .48 - m * 1.4 : W - m * 2, lh = c.wide ? H - m * 2 : H * .64 - m * 1.4;
    const rowH = Math.min(lh / Math.max(1, list.length), s * .16);
    const startY = ly + (lh - rowH * list.length) / 2;
    list.forEach((item, i) => {
      const y = startY + i * rowH;
      const d = rowH * .56;
      els.push(shp('ellipse', lx, y + (rowH - d) / 2, d, d, pal.s));
      els.push(icon('check', lx + d * .2, y + (rowH - d) / 2 + d * .2, d * .6, pal.ink, { sw: 3 }));
      const t = fit(c.B(item, rowH * .3, pal.ink, { align: 'left', weight: 600 }), lw - d * 1.4, rowH * .9, 2, 8);
      t.x = lx + d * 1.4; t.y = y + (rowH - t.h) / 2;
      els.push(t);
    });
    return { bg: { fill: pal.bg }, els };
  } },
  { n: 'Gradient glow', f(c) {
    const { W, H, s, pal, R } = c;
    const els = [];
    const dark = C.lum(pal.bg) < .3;
    const base = dark ? pal.bg : C.mix(pal.p, '#000000', .55);
    els.push(shp('blob', W * .55, -s * .25, s * .8, s * .75, pal.p, { opacity: .55, seed: 21 + c.vi, shadow: { color: pal.p, blur: s * .1, alpha: .8 } }));
    els.push(shp('blob', -s * .25, H - s * .5, s * .75, s * .7, pal.s, { opacity: .5, seed: 5 + c.vi, shadow: { color: pal.s, blur: s * .1, alpha: .8 } }));
    const cw = c.banner ? W * .7 : W * .8, chh = c.banner ? H * .74 : H * .56;
    const card = shp('rect', (W - cw) / 2, (H - chh) / 2, cw, chh, 'rgba(255,255,255,0.12)', { radius: s * .04, stroke: 'rgba(255,255,255,0.35)', sw: Math.max(1, s * .002) });
    els.push(card);
    const iw = cw - s * .12;
    const lab = fit(c.L(c.det[0] || c.topic.c, s * .026, '#ffffff', { opacity: .75 }), iw, chh * .12, 1);
    const h1 = fit(c.H1(c.head, s * .13, '#ffffff'), iw, chh * .5, 3, 10);
    const sub = fit(c.B(c.sub, s * .036, '#ffffff', { opacity: .85 }), iw, chh * .2, 2);
    els.push(...stack([{ el: lab }, { el: h1, gap: s * .025 }, { el: sub, gap: s * .025 }], card.x + s * .06, card.y, iw, chh, 'center'));
    return { bg: { fill: { g: 'linear', a: 60 + R() * 60, c: [base, C.mix(base, pal.s, .35)] } }, els };
  } },
  { n: 'Ribbon retro', f(c) {
    const { W, H, s, pal } = c;
    const els = [];
    const rw = W * (c.banner ? .6 : .86), rh = c.banner ? H * .34 : s * .16;
    const ry = c.banner ? H * .33 : H * .44;
    els.push(shp('ribbon', (W - rw) / 2 - s * .05, ry + rh * .25, rw + s * .1, rh, C.mix(pal.p, '#000000', .25)));
    els.push(shp('rect', (W - rw) / 2, ry, rw, rh, pal.p));
    const rt = fit(c.H1(c.head, rh * .6, pal.pi, { lh: 1 }), rw * .88, rh * .72, 1, 8);
    rt.x = (W - rt.w) / 2; rt.y = ry + (rh - rt.h) / 2;
    els.push(rt);
    if (!c.banner) {
      const topT = fit(c.L(c.topic.c, s * .032, pal.ink, { ls: .3 }), W * .7, s * .06, 1);
      const bigT = fit(c.H1(c.big, s * .2, pal.s, { lh: 1, outline: { w: 3, color: pal.ink } }), W * .8, ry - s * .2, 1, 10);
      stack([{ el: topT }, { el: bigT, gap: s * .02 }], 0, s * .06, W, ry - s * .1, 'center');
      const sub = fit(c.B(c.sub, s * .04, pal.ink, { weight: 600 }), W * .78, H * .14, 2);
      const det = fit(c.B(c.det.join('\n'), s * .03, pal.ink, { opacity: .8 }), W * .78, H * .14, 3);
      els.push(topT, bigT, ...stack([{ el: sub }, { el: det, gap: s * .025 }], 0, ry + rh + s * .08, W, H - ry - rh - s * .14, 'center'));
      els.push(shp('star', W * .1, ry - s * .1, s * .06, s * .06, pal.s), shp('star', W * .84, ry - s * .12, s * .06, s * .06, pal.s));
    } else {
      els.push(shp('star', W * .1, H * .38, s * .2, s * .2, pal.s), shp('star', W * .86, H * .38, s * .2, s * .2, pal.s));
    }
    return { bg: { fill: pal.bg, pattern: { kind: 'rings', color: pal.ink, opacity: .05, scale: 1.4 } }, els };
  } },
  { n: 'Echo type', f(c) {
    const { W, H, s, pal } = c;
    const els = [];
    const word = (c.big && c.big.length <= 7 && /^[A-Za-z0-9%$.+/–-]+$/.test(c.big) ? c.big : c.head.replace(/[^A-Za-z0-9’' ]/g, '').split(' ')[0]).toUpperCase();
    const tw = W * .9;
    const proto = fit(c.H1(word, s * .3, pal.p, { upper: true, lh: .95 }), tw, H * (c.banner ? .5 : .2), 1, 10);
    const n = c.banner ? 1 : c.tall ? 5 : 3;
    const gap = proto.h * .96;
    const topY = c.banner ? (H - proto.h) / 2 - H * .12 : H * .08;
    for (let i = 0; i < n; i++) {
      const e = Object.assign({}, proto, { id: C.uid(), y: topY + i * gap, x: (W - proto.w) / 2, opacity: 1 - i * (0.7 / n) });
      if (i > 0) { e.outline = { w: 2, color: pal.p, only: true }; }
      els.push(e);
    }
    const ty = topY + n * gap + s * .03;
    const h1 = fit(c.H1(c.head, s * .07, pal.ink, { upper: true, ls: .08 }), W * .84, (H - ty) * .35, 2, 10);
    const sub = fit(c.B([c.sub, c.det[0]].filter(Boolean).join(' — '), s * .032, pal.ink, { opacity: .8 }), W * .78, (H - ty) * .3, 3);
    els.push(...stack([{ el: h1 }, { el: sub, gap: s * .02 }], 0, ty, W, H - ty - s * .05, 'center'));
    return { bg: { fill: pal.bg }, els };
  } },
  { n: 'Geometric', f(c) {
    const { W, H, s, pal, R } = c;
    const els = [];
    const g = s * .3;
    els.push(shp('quarter', 0, 0, g, g, pal.p, { flipY: true }));
    els.push(shp('rtriangle', W - g * .9, 0, g * .9, g * .9, pal.s, { flipX: true, flipY: true }));
    els.push(shp('ellipse', W - g * .6, H - g * .6, g * .9, g * .9, pal.p));
    els.push(shp('rect', -g * .2, H - g * .5, g * .7, g * .7, pal.s, { rot: 20 }));
    els.push(shp('dashed', W * .1, H * .14, g * .7, s * .02, pal.a, { sw: Math.max(2, s * .006), opacity: .7 }));
    const cw = W - g * (c.banner ? 1.6 : .9), ch = H - g * (c.banner ? .4 : .9);
    const card = shp('rect', (W - cw) / 2, (H - ch) / 2, cw, ch, pal.bg === '#ffffff' ? '#f7f7f7' : '#ffffff', { radius: s * .02, shadow: { color: '#000000', blur: s * .04, y: s * .01, alpha: .18 } });
    els.push(card);
    const ink = C.lum(card.fill) > .5 ? (C.lum(pal.ink) < .5 ? pal.ink : '#1a1a1a') : '#ffffff';
    const accent = C.lum(pal.p) > .75 ? ink : pal.p;
    const iw = cw - s * .12;
    const ic = c.banner ? null : icon(c.topic.i, 0, 0, s * .07, accent);
    const h1 = fit(c.H1(c.head, s * .12, ink), iw, ch * .42, 3, 10);
    const sub = fit(c.B(c.sub, s * .036, ink, { opacity: .8 }), iw, ch * .18, 2);
    const cta = c.cta && !c.banner ? fit(c.L(c.cta, s * .028, accent, { weight: 800 }), iw, ch * .1, 1) : null;
    els.push(...stack([{ el: ic }, { el: h1, gap: ic ? s * .025 : 0 }, { el: sub, gap: s * .02 }, { el: cta, gap: s * .03 }], card.x + s * .06, card.y, iw, ch, 'center'));
    return { bg: { fill: pal.bg, pattern: R() < .5 ? { kind: 'grid', color: pal.ink, opacity: .05, scale: .8 } : null }, els };
  } },
];

// ---------------------------------------------------------------- public API
const VARIANTS = 12;
const COUNT = TOPICS.length * LAYOUTS.length * VARIANTS;
// index -> (topic, layout, variant). Interleaved so browsing mixes layouts.
function decode(i) {
  const v = Math.floor(i / (TOPICS.length * LAYOUTS.length));
  const r = i % (TOPICS.length * LAYOUTS.length);
  return { t: r % TOPICS.length, l: (r + v * 5) % LAYOUTS.length, v };
}
function build(tpl, W, H) {
  const topic = TOPICS[tpl.t], L = LAYOUTS[tpl.l];
  const c = ctxFor(topic, tpl.v, tpl.l, W, H);
  const page = L.f(c);
  page.els = page.els.filter(Boolean);
  page.tpl = { t: tpl.t, l: tpl.l, v: tpl.v };
  return page;
}
function describe(tpl) { const t = TOPICS[tpl.t]; return `${t.n} · ${LAYOUTS[tpl.l].n}`; }
// Search: all words must match the topic's name, category, keywords or layout.
function search(q, category) {
  const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  const ok = TOPICS.map(t => {
    if (category && t.c !== category) return false;
    const hay = (t.n + ' ' + t.c + ' ' + t.k).toLowerCase();
    return words.every(w => hay.includes(w) || LAYOUTS.some(l => l.n.toLowerCase().includes(w)));
  });
  const out = [];
  for (let i = 0; i < COUNT; i++) {
    const d = decode(i);
    if (!ok[d.t]) continue;
    if (words.length && !words.every(w => (TOPICS[d.t].n + ' ' + TOPICS[d.t].c + ' ' + TOPICS[d.t].k + ' ' + LAYOUTS[d.l].n).toLowerCase().includes(w))) continue;
    out.push(d);
  }
  return out;
}
const CATEGORIES = [...new Set(TOPICS.map(t => t.c))];

function faces() { const out = []; for (const m in FONTPAIRS) for (const f of FONTPAIRS[m]) { out.push([f.h, f.hw, !!f.hi], [f.b, f.bw, false], [f.b, 600, false], [f.b, 700, false]); } return out; }
window.LDTemplates = { faces, FORMATS, TOPICS, LAYOUTS, PALETTES, FONTPAIRS, COUNT, VARIANTS, CATEGORIES, decode, build, describe, search };
})();
