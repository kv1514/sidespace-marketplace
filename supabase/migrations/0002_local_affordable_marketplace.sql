insert into public.profiles (
  id, auth_user_id, role, display_name, handle, bio, city, categories,
  followers, avg_views, audience_age, website, avatar_url, verified, is_demo,
  onboarding_complete
)
values
  (
    '11111111-1111-4111-8111-111111111111', null, 'creator',
    'Maya Alvarez', '@mayaonfilm',
    'Thrift finds, art walks, and honest recommendations for people who spend their weekends around Bisbee.',
    'Bisbee, AZ', array['Instagram', 'Vintage', 'Local'], 4200, 1900,
    '68% ages 18-34', '', '/photos/market-creator.jpg', true, true, true
  ),
  (
    '22222222-2222-4222-8222-222222222222', null, 'creator',
    'Drew Kim', '@drew.eats',
    'No-frills food reviews and weekly West Texas roundups for people deciding what is worth the drive.',
    'Marfa, TX', array['TikTok', 'Food', 'Local'], 3800, 4100,
    '61% ages 21-39', '', '/photos/drew-kitchen.jpg', true, true, true
  ),
  (
    '33333333-3333-4333-8333-333333333333', null, 'space_owner',
    'Jay Morrison', 'Silver 84 Volvo',
    'A restored wagon parked near the farmers market and driven through town on weekday delivery routes.',
    'Livingston, MT', array['Vehicle', 'Physical', 'Local'], 0, 8400,
    'Locals + Yellowstone traffic', '', '/photos/jay-volvo.jpg', true, true, true
  ),
  (
    '44444444-4444-4444-8444-444444444444', null, 'space_owner',
    'Athens Corner Co-op', 'Cafe + community window',
    'A cafe window, sidewalk sign, and counter card spot on the walk between campus and Court Street.',
    'Athens, OH', array['Cafe', 'Storefront', 'Students'], 0, 6200,
    '76% ages 18-29', '', '/photos/small-town-coffee.jpg', true, true, true
  ),
  (
    '55555555-5555-4555-8555-555555555555', null, 'business',
    'Driftless Coffee Roasters', '@driftlesscoffee',
    'A small-town roaster looking for affordable local launch partners, window space, and community voices.',
    'Decorah, IA', array['Coffee', 'Local', 'Launch'], 2100, 1300,
    'College, families, weekend visitors', 'driftless.example', '/photos/small-town-coffee.jpg', true, true, true
  ),
  (
    '66666666-6666-4666-8666-666666666666', null, 'business',
    'Greenbrier Print House', '@greenbrierprints',
    'Independent prints, trail maps, and postcards made for small shops across the Alleghenies.',
    'Thomas, WV', array['Art', 'Main Street', 'Product'], 2900, 1700,
    'Locals, hikers, weekend visitors', 'greenbrier.example', '/photos/rural-main-street.jpg', false, true, true
  ),
  (
    '77777777-7777-4777-8777-777777777777', null, 'space_owner',
    'Redwood Produce Stand', 'Highway 201 farm stand',
    'A family produce stand with bright roadside visibility during the Central Valley growing season.',
    'Dinuba, CA', array['Farm stand', 'Roadside', 'Food'], 0, 3600,
    'Families + farm traffic', '', '/photos/roadside-farm-stand.jpg', true, true, true
  ),
  (
    '88888888-8888-4888-8888-888888888888', null, 'space_owner',
    'Waller''s Market', 'Main Street grocery',
    'A rural market with two front windows, a checkout counter, and a loyal weekly customer base.',
    'Mercer, WI', array['Market', 'Storefront', 'Community'], 0, 2200,
    'Year-round locals + lake visitors', '', '/photos/rural-market.jpg', true, true, true
  ),
  (
    '99999999-9999-4999-8999-999999999999', null, 'space_owner',
    'Maple Street Barber', 'Two-chair neighborhood shop',
    'A classic barbershop with a waiting bench, mirror cards, and steady small-town conversation.',
    'Lanesboro, MN', array['Barber', 'Counter', 'Community'], 0, 900,
    'Adults 25-64 + families', '', '/photos/small-town-barber.jpg', true, true, true
  ),
  (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', null, 'space_owner',
    'Little River Bakery', 'Main Street bake shop',
    'A sunny bakery window and pickup counter serving commuters, families, and Saturday visitors.',
    'Abingdon, VA', array['Bakery', 'Window', 'Food'], 0, 1800,
    'Families + downtown foot traffic', '', '/photos/small-town-bakery.jpg', true, true, true
  ),
  (
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', null, 'creator',
    'Main Street Makers', '@mainstreetmakers',
    'A weekly email and social roundup featuring makers, shops, and events across North Georgia towns.',
    'Dahlonega, GA', array['Newsletter', 'Instagram', 'Makers'], 3600, 2400,
    'Local shoppers ages 25-54', 'mainstreetmakers.example', '/photos/rural-main-street.jpg', true, true, true
  ),
  (
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc', null, 'business',
    'Cedar Coffee House', '@cedarcoffeehouse',
    'A porch-front coffee shop testing low-cost partnerships with nearby makers, guides, and events.',
    'Eureka Springs, AR', array['Coffee', 'Tourism', 'Community'], 1700, 1100,
    'Locals + weekend travelers', 'cedarcoffee.example', '/photos/small-town-coffee.jpg', true, true, true
  )
on conflict (id) do update set
  role = excluded.role,
  display_name = excluded.display_name,
  handle = excluded.handle,
  bio = excluded.bio,
  city = excluded.city,
  categories = excluded.categories,
  followers = excluded.followers,
  avg_views = excluded.avg_views,
  audience_age = excluded.audience_age,
  website = excluded.website,
  avatar_url = excluded.avatar_url,
  verified = excluded.verified,
  is_demo = excluded.is_demo,
  onboarding_complete = excluded.onboarding_complete;

insert into public.listings (
  id, owner_profile_id, title, channel, format, price, price_unit,
  description, demographics, image_url, status
)
values
  (
    'a1111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111',
    'Local story + saved highlight', 'Instagram', '3 frames - 48 hr highlight', 18, 'story set',
    'A natural three-frame recommendation for a local shop, event, or service, saved for 48 hours.',
    '68% ages 18-34 - Bisbee area', '/photos/market-creator.jpg', 'active'
  ),
  (
    'a2222222-2222-4222-8222-222222222222', '22222222-2222-4222-8222-222222222222',
    'West Texas food stop feature', 'TikTok', '30-45 sec - town tag included', 28, 'video',
    'One useful food or roadside-stop feature filmed on location and posted when local viewers are active.',
    '61% ages 21-39 - West Texas', '/photos/drew-kitchen.jpg', 'active'
  ),
  (
    'a3333333-3333-4333-8333-333333333333', '33333333-3333-4333-8333-333333333333',
    'Rear-window local route', 'Vehicle', '18 x 24 in - weather-safe', 12, 'day',
    'Rear-window placement on a vintage wagon moving between downtown, the market, and local deliveries.',
    '8.4K monthly looks - local route', '/photos/jay-volvo.jpg', 'active'
  ),
  (
    'a4444444-4444-4444-8444-444444444444', '44444444-4444-4444-8444-444444444444',
    'Cafe window + sidewalk sign', 'Cafe window', '2 small placements - weekly proof', 15, 'week',
    'A letter-size window poster plus a small sidewalk-sign panel between campus and downtown.',
    '6.2K weekly looks - 76% ages 18-29', '/photos/small-town-coffee.jpg', 'active'
  ),
  (
    'a5555555-5555-4555-8555-555555555555', '55555555-5555-4555-8555-555555555555',
    'Local coffee launch partners', 'Business brief', 'Story - tasting - counter card', 35, 'partner',
    'A small paid brief for creators and counter spaces with a real connection to Driftless-area coffee culture.',
    'College, families, and weekend visitors', '/photos/small-town-coffee.jpg', 'active'
  ),
  (
    'a6666666-6666-4666-8666-666666666666', '66666666-6666-4666-8666-666666666666',
    'Main Street postcard swap', 'Main Street', '50 cards - 3 local counters', 24, 'run',
    'A tiny cross-promotion placing your card beside our trail maps and art prints in three nearby shops.',
    'Locals, hikers, and weekend visitors', '/photos/rural-main-street.jpg', 'active'
  ),
  (
    'a7777777-7777-4777-8777-777777777777', '77777777-7777-4777-8777-777777777777',
    'Farm-stand umbrella panel', 'Farm stand', 'One 12 x 18 in panel', 8, 'day',
    'A weather-safe sign beside the produce table where drivers already slow down and pull over.',
    '3.6K monthly stops - families', '/photos/roadside-farm-stand.jpg', 'active'
  ),
  (
    'a8888888-8888-4888-8888-888888888888', '88888888-8888-4888-8888-888888888888',
    'Checkout counter card', 'Storefront', '5 x 7 in card - front counter', 12, 'week',
    'A simple counter card seen by regular grocery shoppers and lake visitors while they check out.',
    '2.2K weekly shoppers - all ages', '/photos/rural-market.jpg', 'active'
  ),
  (
    'a9999999-9999-4999-8999-999999999999', '99999999-9999-4999-8999-999999999999',
    'Waiting-bench card holder', 'Counter card', 'A6 card - mirror + waiting bench', 10, 'week',
    'A small card holder where customers have time to read about a nearby service or event.',
    '900 monthly visits - local households', '/photos/small-town-barber.jpg', 'active'
  ),
  (
    'b1111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'Bakery pickup-window card', 'Bakery window', 'Letter-size poster - pickup window', 14, 'week',
    'A clean poster beside the pastry case for a local event, class, maker, or family-friendly service.',
    '1.8K weekly visits - families', '/photos/small-town-bakery.jpg', 'active'
  ),
  (
    'b2222222-2222-4222-8222-222222222222', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'Weekly local-maker mention', 'Newsletter', 'One feature - email + Instagram', 16, 'mention',
    'A concise recommendation in our Friday local-maker roundup with a photo, link, and town tag.',
    '2.4K local readers - ages 25-54', '/photos/rural-main-street.jpg', 'active'
  ),
  (
    'b3333333-3333-4333-8333-333333333333', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    'Porch board + receipt footer', 'Community board', '2 small placements - 2 weeks', 30, 'partner',
    'A porch notice-board spot plus a short receipt message for a nearby event, maker, or guide.',
    'Locals + weekend travelers', '/photos/small-town-coffee.jpg', 'active'
  )
on conflict (id) do update set
  owner_profile_id = excluded.owner_profile_id,
  title = excluded.title,
  channel = excluded.channel,
  format = excluded.format,
  price = excluded.price,
  price_unit = excluded.price_unit,
  description = excluded.description,
  demographics = excluded.demographics,
  image_url = excluded.image_url,
  status = excluded.status;
