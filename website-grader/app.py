import os
import re
import time
import hashlib
import requests
from flask import Flask, request, jsonify
from flask_cors import CORS
from bs4 import BeautifulSoup

app = Flask(__name__)
CORS(app)

GOOGLE_KEY    = os.environ.get('GOOGLE_API_KEY', '')
GHL_WEBHOOK   = os.environ.get('GHL_WEBHOOK',
    'https://services.leadconnectorhq.com/hooks/d7iUPfamAaPlSBNj6IhT/webhook-trigger/jrz-grader')
DFS_LOGIN     = os.environ.get('DATAFORSEO_LOGIN', '')
DFS_PASSWORD  = os.environ.get('DATAFORSEO_PASSWORD', '')

CACHE = {}


# ─────────────────────────────────────────────────────────────────
#  ROUTES
# ─────────────────────────────────────────────────────────────────

@app.route('/health')
def health():
    return jsonify({
        'status':   'ok',
        'key_set':  bool(GOOGLE_KEY),
        'dfs_set':  bool(DFS_LOGIN)
    })


@app.route('/api/autocomplete')
def autocomplete():
    query = request.args.get('input', '').strip()
    if len(query) < 2:
        return jsonify({'predictions': []})
    try:
        resp = requests.get(
            'https://maps.googleapis.com/maps/api/place/autocomplete/json',
            params={'input': query, 'types': 'establishment', 'key': GOOGLE_KEY},
            timeout=5
        )
        return jsonify(resp.json())
    except Exception as e:
        return jsonify({'predictions': [], 'error': str(e)})


@app.route('/api/grade')
def grade():
    place_id = request.args.get('place_id', '').strip()
    if not place_id:
        return jsonify({'error': 'place_id is required'}), 400

    cache_key = hashlib.md5(place_id.encode()).hexdigest()
    if cache_key in CACHE and time.time() - CACHE[cache_key]['ts'] < 600:
        return jsonify(CACHE[cache_key]['data'])

    # 1. Place Details
    try:
        pr = requests.get(
            'https://maps.googleapis.com/maps/api/place/details/json',
            params={
                'place_id': place_id,
                'fields': ('name,rating,user_ratings_total,formatted_address,'
                           'website,formatted_phone_number,opening_hours,'
                           'photos,types,geometry,business_status,price_level,'
                           'reviews,editorial_summary'),
                'key': GOOGLE_KEY
            },
            timeout=8
        )
        place = pr.json().get('result', {})
    except Exception as e:
        return jsonify({'error': f'Google Places error: {e}'}), 502

    if not place:
        return jsonify({'error': 'Business not found'}), 404

    # 2. Nearby Competitors
    competitors = []
    loc       = place.get('geometry', {}).get('location', {})
    raw_types = place.get('types', [])
    biz_type  = get_best_type(raw_types)
    type_label = infer_type_label(biz_type, place.get('name', ''))

    # Use the most specific search type available
    search_type = biz_type if biz_type != 'establishment' else 'restaurant'
    # For broad types, fall back to restaurant for food businesses
    if search_type in ('food', 'meal_delivery', 'meal_takeaway'):
        search_type = 'restaurant'

    if loc:
        try:
            nr = requests.get(
                'https://maps.googleapis.com/maps/api/place/nearbysearch/json',
                params={
                    'location': f"{loc['lat']},{loc['lng']}",
                    'radius':   8000,
                    'type':     search_type,
                    'key':      GOOGLE_KEY,
                    'rankby':   'prominence'
                },
                timeout=8
            )
            nearby = nr.json().get('results', [])
            competitors = [
                r for r in nearby
                if r.get('place_id') != place_id
                and r.get('business_status') == 'OPERATIONAL'
                and is_valid_competitor(r, raw_types)
            ][:5]
        except Exception:
            competitors = []

    # 3. PageSpeed Insights
    website   = place.get('website', '')
    pagespeed = {}
    if website:
        try:
            ps = requests.get(
                'https://www.googleapis.com/pagespeedonline/v5/runPagespeed',
                params={'url': website, 'strategy': 'mobile', 'key': GOOGLE_KEY},
                timeout=20
            )
            pagespeed = ps.json()
        except Exception:
            pagespeed = {}

    # Review intelligence — from Places API review objects (up to 5)
    raw_reviews    = place.get('reviews', []) or []
    review_intel   = analyze_reviews(raw_reviews)
    gbp_description = (place.get('editorial_summary') or {}).get('overview', '')

    # Parse city/state once — reused by scrape and keyword ranking
    city, state = parse_city_state(place.get('formatted_address', ''))

    # 4. Website Scrape
    site_data = {}
    if website:
        site_data = scrape_website(
            website,
            biz_name=place.get('name', ''),
            biz_city=city
        )

    # 5. Keyword Rankings (Phase 2 — DataForSEO)
    keyword_rankings = []
    if DFS_LOGIN and DFS_PASSWORD and city:
        keyword_rankings = check_keyword_rankings(
            place.get('name', ''), type_label, city, state
        )

    # 6. Backlinks (Phase 2 — DataForSEO)
    backlink_data = {}
    if DFS_LOGIN and DFS_PASSWORD and website:
        try:
            backlink_data = check_backlinks(website)
        except Exception:
            backlink_data = {}

    # 7. Map Pack Visibility (Phase 2 — DataForSEO)
    map_pack_data = []
    if DFS_LOGIN and DFS_PASSWORD and city:
        try:
            map_pack_data = check_map_pack(
                place.get('name', ''), type_label, city, state
            )
        except Exception:
            map_pack_data = []

    # 8. Build Report
    report = build_report(place, pagespeed, site_data, competitors, keyword_rankings,
                          place_id, type_label, backlink_data,
                          review_intel, gbp_description, map_pack_data)

    CACHE[cache_key] = {'ts': time.time(), 'data': report}

    try:
        fire_ghl(report)
    except Exception:
        pass

    return jsonify(report)


# ─────────────────────────────────────────────────────────────────
#  HELPERS
# ─────────────────────────────────────────────────────────────────

def parse_city_state(address):
    parts = [p.strip() for p in address.split(',')]
    city = state = ''
    if len(parts) >= 3:
        city      = parts[-3]
        state_zip = parts[-2].strip()
        state     = state_zip.split()[0] if state_zip else ''
    return city, state


# ─────────────────────────────────────────────────────────────────
#  REVIEW INTELLIGENCE
# ─────────────────────────────────────────────────────────────────

def analyze_reviews(reviews):
    """Compute review velocity + owner response rate from Places API review objects."""
    if not reviews:
        return {
            'velocity': 'No data', 'velocity_score': 0,
            'recent_30': 0, 'recent_90': 0,
            'response_rate': 0, 'responded': 0,
            'total_sampled': 0, 'newest_review_days': None,
        }

    now   = time.time()
    d30   = 30  * 86400
    d90   = 90  * 86400

    recent_30 = sum(1 for r in reviews if (now - r.get('time', 0)) < d30)
    recent_90 = sum(1 for r in reviews if (now - r.get('time', 0)) < d90)

    newest_ts   = max((r.get('time', 0) for r in reviews), default=0)
    newest_days = int((now - newest_ts) / 86400) if newest_ts else None

    responded     = sum(1 for r in reviews if r.get('author_reply'))
    total         = len(reviews)
    response_rate = int(responded / total * 100) if total else 0

    if newest_days is not None and newest_days <= 14:
        velocity = 'Active';       velocity_score = 100
    elif newest_days is not None and newest_days <= 60:
        velocity = 'Moderate';     velocity_score = 65
    elif newest_days is not None and newest_days <= 180:
        velocity = 'Slow';         velocity_score = 35
    else:
        velocity = 'Stagnant';     velocity_score = 10

    return {
        'velocity': velocity, 'velocity_score': velocity_score,
        'recent_30': recent_30, 'recent_90': recent_90,
        'response_rate': response_rate, 'responded': responded,
        'total_sampled': total, 'newest_review_days': newest_days,
    }


# ─────────────────────────────────────────────────────────────────
#  MAP PACK VISIBILITY  (Phase 2 — DataForSEO)
# ─────────────────────────────────────────────────────────────────

def check_map_pack(biz_name, type_label, city, state):
    """Check if the business appears in the Google Local 3-Pack for key queries."""
    if not (DFS_LOGIN and DFS_PASSWORD):
        return []

    keywords  = [
        f'{type_label} {city}',
        f'best {type_label} in {city}',
    ]
    biz_words = [w for w in biz_name.lower().split() if len(w) > 3]
    results   = []

    for kw in keywords:
        try:
            resp = requests.post(
                'https://api.dataforseo.com/v3/serp/google/local_pack/live/advanced',
                auth=(DFS_LOGIN, DFS_PASSWORD),
                json=[{
                    'keyword':       kw,
                    'location_name': f'{city},{state},United States' if state else f'{city},United States',
                    'language_name': 'English',
                }],
                timeout=15
            )
            data       = resp.json()
            result_obj = (((data.get('tasks') or [{}])[0].get('result') or [{}])[0])
            items      = result_obj.get('items') or []
            pack_items = [i for i in items if i.get('type') == 'local_pack']

            in_pack    = False
            position   = None
            pack_biz   = []

            for item in pack_items:
                title_lower = (item.get('title') or '').lower()
                rank        = item.get('rank_group') or item.get('rank_absolute')
                rating_obj  = item.get('rating') or {}
                rating_val  = rating_obj.get('value')    if isinstance(rating_obj, dict) else None
                review_cnt  = rating_obj.get('votes_count') if isinstance(rating_obj, dict) else None

                pack_biz.append({
                    'name':    item.get('title', ''),
                    'rating':  rating_val,
                    'reviews': review_cnt,
                    'address': item.get('address', ''),
                    'is_target': any(w in title_lower for w in biz_words),
                })
                if any(w in title_lower for w in biz_words):
                    in_pack  = True
                    position = rank

            results.append({
                'keyword':          kw,
                'in_pack':          in_pack,
                'position':         position,
                'pack_size':        len(pack_items),
                'pack_businesses':  pack_biz,
            })
        except Exception:
            results.append({
                'keyword': kw, 'in_pack': False,
                'position': None, 'pack_size': 0, 'pack_businesses': []
            })

    return results


# ─────────────────────────────────────────────────────────────────
#  INDUSTRY TYPE INTELLIGENCE
# ─────────────────────────────────────────────────────────────────

# Cuisine / specific restaurant subtypes Google may return
CUISINE_TYPES = {
    'sushi_restaurant', 'japanese_restaurant', 'chinese_restaurant',
    'mexican_restaurant', 'italian_restaurant', 'american_restaurant',
    'seafood_restaurant', 'pizza_restaurant', 'fast_food_restaurant',
    'hamburger_restaurant', 'sandwich_restaurant', 'thai_restaurant',
    'indian_restaurant', 'korean_restaurant', 'french_restaurant',
    'mediterranean_restaurant', 'greek_restaurant', 'spanish_restaurant',
    'latin_american_restaurant', 'barbecue_restaurant', 'vegetarian_restaurant',
    'vegan_restaurant', 'breakfast_restaurant', 'brunch_restaurant',
    'steak_house', 'ramen_restaurant',
}

# Food / dining category types
FOOD_TYPES = {
    'restaurant', 'cafe', 'bakery', 'bar', 'meal_delivery',
    'meal_takeaway', 'food', 'night_club',
} | CUISINE_TYPES

# Types that should never appear as competitors for food businesses
NON_FOOD_EXCLUDE = {
    'grocery_or_supermarket', 'supermarket', 'convenience_store',
    'gas_station', 'pharmacy', 'drugstore', 'liquor_store',
    'hardware_store', 'home_goods_store', 'furniture_store',
    'clothing_store', 'department_store', 'shopping_mall',
    'bank', 'atm', 'hospital', 'school', 'university', 'church',
    'car_dealer', 'car_repair', 'parking', 'lodging', 'hotel',
    'gym', 'beauty_salon', 'hair_care',
}

# Human-readable labels for Google Place types
TYPE_LABELS = {
    'sushi_restaurant':         'sushi restaurant',
    'japanese_restaurant':      'Japanese restaurant',
    'chinese_restaurant':       'Chinese restaurant',
    'mexican_restaurant':       'Mexican restaurant',
    'italian_restaurant':       'Italian restaurant',
    'american_restaurant':      'American restaurant',
    'seafood_restaurant':       'seafood restaurant',
    'pizza_restaurant':         'pizza restaurant',
    'fast_food_restaurant':     'fast food restaurant',
    'hamburger_restaurant':     'burger restaurant',
    'sandwich_restaurant':      'sandwich restaurant',
    'thai_restaurant':          'Thai restaurant',
    'indian_restaurant':        'Indian restaurant',
    'korean_restaurant':        'Korean restaurant',
    'french_restaurant':        'French restaurant',
    'mediterranean_restaurant': 'Mediterranean restaurant',
    'greek_restaurant':         'Greek restaurant',
    'spanish_restaurant':       'Spanish restaurant',
    'latin_american_restaurant':'Latin restaurant',
    'barbecue_restaurant':      'BBQ restaurant',
    'vegetarian_restaurant':    'vegetarian restaurant',
    'vegan_restaurant':         'vegan restaurant',
    'steak_house':              'steakhouse',
    'ramen_restaurant':         'ramen restaurant',
    'restaurant':               'restaurant',
    'cafe':                     'cafe',
    'bakery':                   'bakery',
    'bar':                      'bar',
    'meal_delivery':            'food delivery',
    'meal_takeaway':            'takeout restaurant',
    'hair_care':                'hair salon',
    'beauty_salon':             'beauty salon',
    'spa':                      'spa',
    'gym':                      'gym',
    'fitness_center':           'fitness center',
    'dentist':                  'dentist',
    'doctor':                   'doctor',
    'lawyer':                   'law firm',
    'accounting':               'accounting firm',
    'real_estate_agency':       'real estate agency',
    'plumber':                  'plumber',
    'electrician':              'electrician',
    'roofing_contractor':       'roofing contractor',
    'general_contractor':       'contractor',
    'moving_company':           'moving company',
    'car_repair':               'auto repair shop',
    'car_dealer':               'car dealership',
    'hotel':                    'hotel',
    'lodging':                  'hotel',
}

# Name keywords → inferred type label (used when Google type is too generic)
NAME_CUISINE_MAP = [
    (['sushi', 'omakase', 'maki', 'nigiri'],            'sushi restaurant'),
    (['ramen', 'noodle', 'udon', 'pho', 'bun'],         'noodle restaurant'),
    (['pizza', 'pizzeria', 'pie'],                       'pizza restaurant'),
    (['taco', 'burrito', 'mexican', 'cantina', 'tex-mex'], 'Mexican restaurant'),
    (['burger', 'smash', 'grill'],                       'burger restaurant'),
    (['chinese', 'dim sum', 'wok', 'szechuan', 'cantonese'], 'Chinese restaurant'),
    (['thai'],                                           'Thai restaurant'),
    (['indian', 'curry', 'tandoor', 'masala'],           'Indian restaurant'),
    (['korean', 'bbq', 'bulgogi', 'k-'],                 'Korean restaurant'),
    (['italian', 'trattoria', 'osteria', 'pasta'],       'Italian restaurant'),
    (['latin', 'colombian', 'peruvian', 'salvadoran', 'cuban', 'dominican'], 'Latin restaurant'),
    (['asian', 'pan-asian', 'fusion'],                   'Asian fusion restaurant'),
    (['seafood', 'crab', 'lobster', 'oyster', 'shrimp'], 'seafood restaurant'),
    (['steak', 'steakhouse', 'churrasco', 'chophouse'],  'steakhouse'),
    (['vegan', 'plant-based'],                           'vegan restaurant'),
    (['vegetarian'],                                     'vegetarian restaurant'),
    (['bbq', 'barbecue', 'smokehouse', 'brisket'],       'BBQ restaurant'),
    (['french', 'brasserie', 'bistro'],                  'French restaurant'),
    (['mediterranean', 'greek', 'hummus', 'falafel'],    'Mediterranean restaurant'),
    (['cafe', 'coffee', 'espresso', 'roastery'],         'cafe'),
    (['bakery', 'pastry', 'patisserie', 'boulangerie'],  'bakery'),
    (['bar', 'pub', 'tavern', 'lounge'],                 'bar'),
]


def get_best_type(raw_types):
    """Return the most specific Google Place type for the business."""
    skip = {'point_of_interest', 'establishment', 'food', 'premise',
            'locality', 'political', 'sublocality', 'route'}
    # Prefer cuisine-specific types first
    for t in raw_types:
        if t in CUISINE_TYPES:
            return t
    # Then any non-generic type
    for t in raw_types:
        if t not in skip:
            return t
    return 'establishment'


def infer_type_label(biz_type, biz_name=''):
    """Convert a Google Place type to the best human-readable label,
    using business name as fallback for generic types."""
    label = TYPE_LABELS.get(biz_type, biz_type.replace('_', ' '))

    # If still generic, infer from name keywords
    if label in ('restaurant', 'food', 'establishment', 'meal takeaway', 'meal delivery'):
        name_lower = biz_name.lower()
        for keywords, inferred in NAME_CUISINE_MAP:
            if any(kw in name_lower for kw in keywords):
                return inferred

    return label


def is_valid_competitor(nearby_result, target_raw_types):
    """True if the nearby business is in the same industry as the target."""
    result_types = set(nearby_result.get('types', []))
    target_types = set(target_raw_types)

    target_is_food = bool(target_types & FOOD_TYPES)

    if target_is_food:
        # Exclude anything that is clearly not a dining establishment
        if result_types & NON_FOOD_EXCLUDE:
            return False
        # Must have at least one food-related type
        if not (result_types & FOOD_TYPES):
            return False

    return True


# ─────────────────────────────────────────────────────────────────
#  WEBSITE SCRAPER
# ─────────────────────────────────────────────────────────────────

def scrape_website(url, biz_name='', biz_city=''):
    empty = {
        'scraped': False, 'h1_exists': False, 'h1_text': '',
        'meta_title': '', 'meta_description': '', 'meta_desc_length': 0,
        'meta_title_length': 0,
        'og_title': False, 'og_description': False, 'og_image': False,
        'twitter_card': False, 'favicon': False,
        'phone_on_site': False, 'address_on_site': False, 'hours_on_site': False,
        'social_links': [], 'has_contact_form': False, 'has_schema': False,
        'has_testimonials': False, 'has_cta': False, 'word_count': 0,
        'has_about': False, 'has_faq': False,
        'has_booking_widget': False, 'has_online_menu': False,
        'has_live_chat': False, 'has_ssl': False,
        'city_in_content': False, 'name_in_title': False,
        'directory_links': [], 'delivery_links': [],
        # SEO audit fields
        'h1_count': 0, 'h2_count': 0, 'h3_count': 0,
        'h2_texts': [], 'h3_texts': [],
        'heading_hierarchy_ok': False, 'multiple_h1': False,
        'keyword_in_h1': False,
        'images_total': 0, 'images_missing_alt': 0,
        'internal_links': 0, 'external_links': 0,
        'canonical_tag': False, 'meta_robots_noindex': False,
        'has_viewport_meta': False,
        'robots_txt_found': False, 'sitemap_found': False,
    }
    try:
        headers = {
            'User-Agent': (
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
                'AppleWebKit/537.36 (KHTML, like Gecko) '
                'Chrome/122.0.0.0 Safari/537.36'
            )
        }
        resp = requests.get(url, headers=headers, timeout=8, allow_redirects=True)
        if resp.status_code >= 400:
            return empty

        soup = BeautifulSoup(resp.text, 'lxml')
        r    = dict(empty)
        r['scraped'] = True

        # SSL — check the final URL after redirects
        r['has_ssl'] = resp.url.startswith('https://')

        # H1
        h1 = soup.find('h1')
        if h1:
            r['h1_exists'] = True
            r['h1_text']   = h1.get_text(strip=True)[:120]

        # Title
        t = soup.find('title')
        if t:
            r['meta_title'] = t.get_text(strip=True)[:120]

        # Meta description
        d = soup.find('meta', attrs={'name': 'description'})
        if d and d.get('content'):
            r['meta_description'] = d['content'][:200]
            r['meta_desc_length'] = len(d['content'])

        # Open Graph
        r['og_title']       = bool(soup.find('meta', property='og:title'))
        r['og_description'] = bool(soup.find('meta', property='og:description'))
        r['og_image']       = bool(soup.find('meta', property='og:image'))

        # Twitter card
        r['twitter_card'] = bool(soup.find('meta', attrs={'name': 'twitter:card'}))

        # Favicon
        r['favicon'] = bool(soup.find('link', rel=re.compile('icon', re.I)))

        page_text  = soup.get_text(' ', strip=True)
        page_lower = page_text.lower()
        html_lower = resp.text.lower()

        # Phone number — regex + tel: links
        phone_re = re.compile(r'\(?\d{3}\)?[\-.\s]\d{3}[\-.\s]\d{4}')
        r['phone_on_site'] = (
            bool(phone_re.search(page_text)) or
            bool(soup.find('a', href=re.compile(r'^tel:')))
        )

        # Street address
        addr_re = re.compile(
            r'\d{2,5}\s+[A-Za-z][\w\s]*\s+'
            r'(Street|St|Avenue|Ave|Boulevard|Blvd|Road|Rd|Drive|Dr|'
            r'Way|Lane|Ln|Court|Ct|Place|Pl|Parkway|Pkwy)',
            re.IGNORECASE
        )
        r['address_on_site'] = bool(addr_re.search(page_text))

        # Business hours
        hour_kw = [
            'monday', 'tuesday', 'wednesday', 'thursday', 'friday',
            'saturday', 'sunday', 'hours of operation', 'business hours',
            'open daily', 'open monday', 'open 7 days', 'hours:'
        ]
        r['hours_on_site'] = any(k in page_lower for k in hour_kw)

        # Social links
        social_map = {
            'facebook.com':  'Facebook',
            'instagram.com': 'Instagram',
            'x.com':         'X (Twitter)',
            'twitter.com':   'X (Twitter)',
            'linkedin.com':  'LinkedIn',
            'tiktok.com':    'TikTok',
            'youtube.com':   'YouTube',
            'pinterest.com': 'Pinterest',
        }
        # Directory platforms
        directory_map = {
            'yelp.com':         'Yelp',
            'tripadvisor.com':  'TripAdvisor',
            'bbb.org':          'BBB',
            'angi.com':         'Angi',
            'angieslist.com':   'Angi',
            'homeadvisor.com':  'HomeAdvisor',
            'houzz.com':        'Houzz',
            'thumbtack.com':    'Thumbtack',
            'yellowpages.com':  'Yellow Pages',
            'google.com/maps':  'Google Maps',
        }
        # Delivery / ordering platforms
        delivery_map = {
            'doordash.com':  'DoorDash',
            'grubhub.com':   'Grubhub',
            'ubereats.com':  'Uber Eats',
            'postmates.com': 'Postmates',
            'chownow.com':   'ChowNow',
            'toasttab.com':  'Toast',
            'opentable.com': 'OpenTable',
            'resy.com':      'Resy',
        }

        found_social    = {}
        found_directory = {}
        found_delivery  = {}

        for a in soup.find_all('a', href=True):
            href = a.get('href', '')
            for domain, label in social_map.items():
                if domain in href:
                    found_social[label] = True
            for domain, label in directory_map.items():
                if domain in href:
                    found_directory[label] = True
            for domain, label in delivery_map.items():
                if domain in href:
                    found_delivery[label] = True

        r['social_links']    = list(found_social.keys())
        r['directory_links'] = list(found_directory.keys())
        r['delivery_links']  = list(found_delivery.keys())

        # Contact form
        r['has_contact_form'] = bool(soup.find('form'))

        # Schema markup
        r['has_schema'] = bool(soup.find('script', type='application/ld+json'))

        # Testimonials
        test_kw = [
            'testimonial', 'what our clients', 'customers say',
            'client review', 'customer review', 'five-star', '5-star',
            'what people say', 'our reviews', 'rated 5', 'rated us',
            'google review', 'left us a review'
        ]
        r['has_testimonials'] = any(k in page_lower for k in test_kw)

        # CTA / booking intent
        cta_kw = [
            'book now', 'book a', 'schedule', 'get started', 'contact us',
            'call us', 'order now', 'reserve', 'appointment', 'free quote',
            'get a quote', 'free consultation', 'request a', 'get in touch',
            'call today', 'get estimate'
        ]
        btn_text = ' '.join([
            e.get_text(strip=True).lower()
            for e in soup.find_all(['a', 'button'])
        ])
        r['has_cta'] = any(k in btn_text for k in cta_kw)

        # About section
        r['has_about'] = any(k in page_lower for k in [
            'about us', 'our story', 'who we are', 'meet the team', 'about the'
        ])

        # FAQ
        r['has_faq'] = any(k in page_lower for k in [
            'faq', 'frequently asked', 'common questions'
        ])

        # Word count
        r['word_count'] = len(page_text.split())

        # Business name in page title
        if biz_name and r['meta_title']:
            name_words = [w for w in biz_name.split() if len(w) > 3]
            r['name_in_title'] = any(
                w.lower() in r['meta_title'].lower() for w in name_words
            ) if name_words else False
        else:
            r['name_in_title'] = False

        # City/location keyword in website content
        if biz_city:
            r['city_in_content'] = biz_city.lower() in page_lower
        else:
            r['city_in_content'] = False

        # Online booking widget / reservation system
        booking_domains = [
            'calendly.com', 'acuityscheduling.com', 'squareup.com', 'square.site',
            'mindbodyonline.com', 'schedulicity.com', 'setmore.com', 'booksy.com',
            'opentable.com', 'resy.com', 'tock.com', 'chownow.com',
            'toasttab.com', 'order.online', 'yelp.com/reservations',
        ]
        booking_kw_btn = [
            'book now', 'book a table', 'book an appointment', 'reserve a table',
            'make a reservation', 'reserve now', 'schedule online', 'order online',
            'online booking', 'book online', 'request appointment',
        ]
        has_booking_link = any(
            domain in a.get('href', '').lower()
            for a in soup.find_all('a', href=True)
            for domain in booking_domains
        )
        has_booking_kw = any(kw in btn_text for kw in booking_kw_btn)
        r['has_booking_widget'] = has_booking_link or has_booking_kw

        # Online menu (restaurants / food businesses)
        menu_kw = ['our menu', 'view menu', 'full menu', 'menu pdf', 'see menu',
                   'food menu', 'drink menu', 'browse menu']
        r['has_online_menu'] = any(k in page_lower for k in menu_kw)

        # Live chat widget
        chat_signals = [
            'intercom', 'drift.com', 'tidio', 'livechat', 'crisp.chat',
            'zendesk', 'freshchat', 'tawk.to', 'hubspot', 'olark',
            'chaport', '__lc_', 'chatbot', 'chat-widget', 'lc2',
        ]
        r['has_live_chat'] = any(sig in html_lower for sig in chat_signals)

        # ── SEO AUDIT SIGNALS ────────────────────────────────────────

        # Heading structure (H1 / H2 / H3)
        h1_tags = soup.find_all('h1')
        h2_tags = soup.find_all('h2')
        h3_tags = soup.find_all('h3')
        r['h1_count']   = len(h1_tags)
        r['h2_count']   = len(h2_tags)
        r['h3_count']   = len(h3_tags)
        r['multiple_h1'] = len(h1_tags) > 1
        r['h2_texts']   = [h.get_text(strip=True)[:80] for h in h2_tags[:8]]
        r['h3_texts']   = [h.get_text(strip=True)[:80] for h in h3_tags[:8]]

        # Heading hierarchy: H1 appears before H2 in document order
        h1_pos = h2_pos = None
        for i, tag in enumerate(soup.find_all(['h1', 'h2', 'h3'])):
            if tag.name == 'h1' and h1_pos is None:
                h1_pos = i
            elif tag.name == 'h2' and h2_pos is None:
                h2_pos = i
        r['heading_hierarchy_ok'] = (
            h1_pos is not None and h2_pos is not None and h1_pos < h2_pos
        )

        # Keyword in H1 (city or business name signals geographic relevance)
        if h1_tags and (biz_name or biz_city):
            h1_lower = h1_tags[0].get_text(strip=True).lower()
            city_in_h1 = biz_city.lower() in h1_lower if biz_city else False
            name_in_h1 = any(
                w.lower() in h1_lower
                for w in biz_name.split() if len(w) > 3
            ) if biz_name else False
            r['keyword_in_h1'] = city_in_h1 or name_in_h1

        # Image alt text coverage
        images = soup.find_all('img')
        r['images_total']       = len(images)
        r['images_missing_alt'] = sum(
            1 for img in images
            if not (img.get('alt') or '').strip()
        )

        # Internal / external link counts
        base_domain = resp.url.split('/')[2].replace('www.', '')
        int_links = ext_links = 0
        for a in soup.find_all('a', href=True):
            href = a['href'].strip()
            if not href or href.startswith(('#', 'mailto:', 'tel:', 'javascript:')):
                continue
            if href.startswith('/') or base_domain in href:
                int_links += 1
            elif href.startswith('http'):
                ext_links += 1
        r['internal_links'] = int_links
        r['external_links'] = ext_links

        # Canonical tag
        r['canonical_tag'] = bool(soup.find('link', rel='canonical'))

        # Meta robots — detect noindex (critical: means Google ignores the page)
        meta_rob = soup.find('meta', attrs={'name': re.compile(r'^robots$', re.I)})
        r['meta_robots_noindex'] = (
            'noindex' in (meta_rob.get('content', '') or '').lower()
            if meta_rob else False
        )

        # Meta title length (ideal: 50–60 chars)
        r['meta_title_length'] = len(r['meta_title'])

        # Viewport meta (mobile-friendliness signal)
        r['has_viewport_meta'] = bool(soup.find('meta', attrs={'name': 'viewport'}))

        # robots.txt — check at domain root
        base_url = f"{resp.url.split('//')[0]}//{resp.url.split('/')[2]}"
        try:
            rb = requests.get(f'{base_url}/robots.txt', timeout=5, headers=headers)
            r['robots_txt_found'] = rb.status_code == 200 and len(rb.text) > 5
        except Exception:
            r['robots_txt_found'] = False

        # sitemap.xml — check at domain root
        try:
            sm = requests.get(f'{base_url}/sitemap.xml', timeout=5, headers=headers)
            r['sitemap_found'] = (
                sm.status_code == 200 and
                ('xml' in sm.headers.get('content-type', '').lower()
                 or sm.text.strip().startswith('<?xml'))
            )
        except Exception:
            r['sitemap_found'] = False

    except Exception:
        return empty

    return r


# ─────────────────────────────────────────────────────────────────
#  DATAFORSEO KEYWORD RANKINGS  (Phase 2)
# ─────────────────────────────────────────────────────────────────

def check_keyword_rankings(biz_name, type_label, city, state):
    keywords = [
        f"best {type_label} in {city}",
        f"{type_label} {city}",
        f"{type_label} near {city}",
        f"{type_label} {city} {state}",
        f"{biz_name} {city}",
    ]
    results = []
    for keyword in keywords:
        try:
            resp = requests.post(
                'https://api.dataforseo.com/v3/serp/google/organic/live/advanced',
                auth=(DFS_LOGIN, DFS_PASSWORD),
                json=[{
                    'keyword':       keyword,
                    'location_name': f'{city},{state},United States',
                    'language_name': 'English',
                    'depth':         30,
                }],
                timeout=12
            )
            data        = resp.json()
            task_result = (data.get('tasks') or [{}])[0].get('result') or []
            items       = (task_result[0].get('items') or []) if task_result else []

            rank      = None
            biz_lower = biz_name.lower()[:12]
            for item in items:
                if item.get('type') == 'organic':
                    title  = (item.get('title')  or '').lower()
                    domain = (item.get('domain') or '').lower()
                    if biz_lower in title or biz_lower in domain:
                        rank = item.get('rank_absolute')
                        break

            results.append({
                'keyword': keyword,
                'rank':    rank,
                'ranked':  rank is not None
            })
        except Exception:
            results.append({'keyword': keyword, 'rank': None, 'ranked': False})

    return results


# ─────────────────────────────────────────────────────────────────
#  DATAFORSEO BACKLINKS  (Phase 2)
# ─────────────────────────────────────────────────────────────────

def check_backlinks(website):
    """Pull backlink summary from DataForSEO Backlinks API."""
    if not (DFS_LOGIN and DFS_PASSWORD) or not website:
        return {}
    try:
        from urllib.parse import urlparse
        parsed = urlparse(website)
        target = parsed.netloc or website
    except Exception:
        target = website
    try:
        resp = requests.post(
            'https://api.dataforseo.com/v3/backlinks/summary/live',
            auth=(DFS_LOGIN, DFS_PASSWORD),
            json=[{'target': target, 'include_subdomains': True}],
            timeout=12
        )
        data   = resp.json()
        result = ((data.get('tasks') or [{}])[0].get('result') or [{}])
        r      = result[0] if result else {}
        return {
            'backlinks':         int(r.get('backlinks', 0) or 0),
            'referring_domains': int(r.get('referring_domains', 0) or 0),
            'rank':              int(r.get('rank', 0) or 0),
            'spam_score':        int(r.get('backlinks_spam_score', 0) or 0),
        }
    except Exception:
        return {}


# ─────────────────────────────────────────────────────────────────
#  REVENUE ESTIMATOR
# ─────────────────────────────────────────────────────────────────

# Issue-specific revenue impact (monthly $ at risk per issue type)
ISSUE_REVENUE = {
    'no website':          2800,
    'slow':                1400,
    'performance':          800,
    'schema':               450,
    'open graph':           280,
    'testimonial':          350,
    'meta description':     320,
    'review':              1200,
    'photo':                550,
    'hours':                400,
    'phone':                480,
    'default_critical':     900,
    'default_warning':      380,
}

def get_issue_impact(issue):
    title = issue['title'].lower()
    for key, val in ISSUE_REVENUE.items():
        if key in title:
            return val
    return ISSUE_REVENUE['default_critical'] if issue['severity'] == 'critical' else ISSUE_REVENUE['default_warning']


def estimate_revenue_loss(issues, place, overall_score=50):
    if not issues:
        return 0

    types   = place.get('types', [])
    reviews = place.get('user_ratings_total', 0)

    # Industry base monthly revenue (conservative estimate)
    if any(t in types for t in ['restaurant', 'cafe', 'bakery', 'meal_delivery', 'meal_takeaway']):
        industry_base = 18000
    elif any(t in types for t in ['doctor', 'dentist', 'physiotherapist', 'spa', 'beauty_salon', 'hair_care']):
        industry_base = 25000
    elif any(t in types for t in ['lawyer', 'accounting', 'real_estate_agency', 'insurance_agency']):
        industry_base = 45000
    elif any(t in types for t in ['plumber', 'electrician', 'roofing', 'contractor', 'moving_company']):
        industry_base = 30000
    else:
        industry_base = 15000

    # Business size multiplier based on review count (proxy for volume)
    if   reviews >= 500: size_mult = 2.4
    elif reviews >= 200: size_mult = 1.8
    elif reviews >= 100: size_mult = 1.4
    elif reviews >= 50:  size_mult = 1.1
    elif reviews >= 20:  size_mult = 0.85
    else:                size_mult = 0.6

    # Score gap factor — how far below optimal
    gap_pct = max(0, 100 - overall_score) / 100.0

    # Sum issue-specific impacts
    raw_impact = sum(get_issue_impact(i) for i in issues)

    # Weight: issue severity × size of business × how far below benchmark
    estimated = int(raw_impact * size_mult * (0.6 + gap_pct * 0.8))

    # Cap at 20% of industry base (realistic upper bound)
    cap = int(industry_base * 0.20)
    return min(estimated, cap)


# ─────────────────────────────────────────────────────────────────
#  SCORING ENGINE
# ─────────────────────────────────────────────────────────────────

def score_google_presence(place, checklist, review_intel=None, gbp_description=''):
    s        = 0
    items    = []
    has_web  = bool(place.get('website'))
    has_ph   = bool(place.get('formatted_phone_number'))
    has_hrs  = bool(place.get('opening_hours'))
    photos   = len(place.get('photos', []))
    reviews  = place.get('user_ratings_total', 0)
    has_price = 'price_level' in place
    ri        = review_intel or {}

    items.append({'label': 'Website linked to profile', 'pass': has_web})
    if has_web:   s += 12

    items.append({'label': 'Phone number listed', 'pass': has_ph})
    if has_ph:    s += 10

    items.append({'label': 'Business hours published', 'pass': has_hrs})
    if has_hrs:   s += 10

    items.append({'label': 'Price range configured', 'pass': has_price})
    if has_price: s += 6

    # Business description (editorial_summary)
    has_desc = bool(gbp_description)
    items.append({'label': 'Business description written', 'pass': has_desc})
    if has_desc: s += 10

    photos_ok = photos >= 10
    items.append({'label': f'10 or more photos ({photos} uploaded)', 'pass': photos_ok})
    if photos >= 10: s += 16
    elif photos >= 5:  s += 10
    elif photos >= 1:  s += 5

    reviews_ok = reviews >= 50
    items.append({'label': f'50 or more reviews ({reviews} total)', 'pass': reviews_ok})
    if reviews >= 100: s += 18
    elif reviews >= 50:  s += 14
    elif reviews >= 20:  s += 9
    elif reviews >= 5:   s += 4

    # Review response rate
    rr  = ri.get('response_rate', 0)
    rr_ok = rr >= 50
    items.append({'label': f'Review response rate ({rr}% of reviews replied to)', 'pass': rr_ok})
    if rr >= 75: s += 10
    elif rr >= 50: s += 7
    elif rr >= 25: s += 3

    # Review velocity
    vel   = ri.get('velocity', '')
    vel_s = ri.get('velocity_score', 0)
    vel_ok = vel_s >= 65
    vel_days = ri.get('newest_review_days')
    vel_label = (f'{vel} — last review {vel_days}d ago' if vel_days is not None else vel) if vel else 'No data'
    items.append({'label': f'Review velocity: {vel_label}', 'pass': vel_ok})
    if vel_s >= 100: s += 8
    elif vel_s >= 65: s += 5
    elif vel_s >= 35: s += 2

    checklist['google_profile'] = items
    return min(s, 100)


def score_reputation(place, checklist):
    s       = 0
    items   = []
    rating  = place.get('rating', 0)
    reviews = place.get('user_ratings_total', 0)

    items.append({'label': f'Rating 4.5 stars or above ({rating} stars)', 'pass': rating >= 4.5})
    if rating >= 4.8:   s += 48
    elif rating >= 4.5: s += 40
    elif rating >= 4.0: s += 30
    elif rating >= 3.5: s += 18
    elif rating > 0:    s += 8

    items.append({'label': f'100 or more reviews ({reviews} total)', 'pass': reviews >= 100})
    if reviews >= 200:  s += 52
    elif reviews >= 100: s += 42
    elif reviews >= 50:  s += 30
    elif reviews >= 25:  s += 20
    elif reviews >= 10:  s += 12
    elif reviews >= 1:   s += 5

    checklist['reputation'] = items
    return min(s, 100)


def score_website(place, pagespeed, site_data, checklist):
    items       = []
    scraped_pts = 0   # quality points from content scan (max 100)

    if not place.get('website'):
        for label in [
            'Website exists and is linked', 'H1 headline present',
            'Meta description configured', 'Phone number on site',
            'Address visible on site', 'Business hours on site',
            'Social media links present', 'Contact form or booking CTA',
            'Online booking or scheduling widget', 'Favicon configured',
            'Schema markup present', 'Open Graph tags for social sharing',
            'Customer testimonials displayed', 'SSL certificate (HTTPS)',
        ]:
            items.append({'label': label, 'pass': False})
        checklist['website'] = items
        return 0

    items.append({'label': 'Website exists and is linked', 'pass': True})
    scraped_pts += 5

    if site_data.get('scraped'):
        # SSL
        ssl_ok = site_data.get('has_ssl', False)
        items.append({'label': 'SSL certificate (HTTPS)', 'pass': ssl_ok})
        if ssl_ok: scraped_pts += 6

        # H1
        h1_ok = site_data.get('h1_exists', False)
        items.append({'label': 'H1 headline present', 'pass': h1_ok})
        if h1_ok: scraped_pts += 6

        # Meta description
        chars   = site_data.get('meta_desc_length', 0)
        meta_ok = chars >= 100
        items.append({'label': f'Meta description configured ({chars} characters)',
                      'pass': meta_ok})
        if meta_ok: scraped_pts += 7

        # Phone on site
        ph_ok = site_data.get('phone_on_site', False)
        items.append({'label': 'Phone number visible on site', 'pass': ph_ok})
        if ph_ok: scraped_pts += 5

        # Address on site
        addr_ok = site_data.get('address_on_site', False)
        items.append({'label': 'Address present on site', 'pass': addr_ok})
        if addr_ok: scraped_pts += 4

        # Hours on site
        hrs_ok = site_data.get('hours_on_site', False)
        items.append({'label': 'Business hours on site', 'pass': hrs_ok})
        if hrs_ok: scraped_pts += 4

        # Social links
        social    = site_data.get('social_links', [])
        social_ok = len(social) > 0
        soc_label = ', '.join(social) if social_ok else 'none detected'
        items.append({'label': f'Social media links ({soc_label})', 'pass': social_ok})
        if social_ok: scraped_pts += 5

        # CTA / form
        has_cta = site_data.get('has_cta', False) or site_data.get('has_contact_form', False)
        items.append({'label': 'Contact form or booking CTA present', 'pass': has_cta})
        if has_cta: scraped_pts += 8

        # Booking widget
        booking_ok = site_data.get('has_booking_widget', False)
        items.append({'label': 'Online booking or scheduling widget', 'pass': booking_ok})
        if booking_ok: scraped_pts += 8

        # Favicon
        fav_ok = site_data.get('favicon', False)
        items.append({'label': 'Favicon configured', 'pass': fav_ok})
        if fav_ok: scraped_pts += 3

        # Schema
        schema_ok = site_data.get('has_schema', False)
        items.append({'label': 'Schema markup (structured data)', 'pass': schema_ok})
        if schema_ok: scraped_pts += 9

        # OG tags
        og_ok = site_data.get('og_title', False) and site_data.get('og_image', False)
        items.append({'label': 'Open Graph tags for social sharing', 'pass': og_ok})
        if og_ok: scraped_pts += 7

        # Testimonials
        test_ok = site_data.get('has_testimonials', False)
        items.append({'label': 'Customer testimonials displayed', 'pass': test_ok})
        if test_ok: scraped_pts += 7

        # Word count
        words = site_data.get('word_count', 0)
        items.append({'label': f'Sufficient page content ({words} words)',
                      'pass': words >= 300})
        if words >= 300: scraped_pts += 5

        scraped_pts = min(scraped_pts, 100)
    else:
        items.append({'label': 'Site scan unavailable (bot-protected or timeout)',
                      'pass': None})
        scraped_pts = 20   # partial credit — site loads but scan failed

    if not pagespeed or 'lighthouseResult' not in pagespeed:
        items.append({'label': 'Mobile performance (scan unavailable)', 'pass': None})
        checklist['website'] = items
        return min(scraped_pts, 100)

    cats = pagespeed['lighthouseResult']['categories']
    perf = int((cats.get('performance', {}).get('score') or 0) * 100)
    seo  = int((cats.get('seo',         {}).get('score') or 0) * 100)

    items.append({'label': f'Mobile performance score: {perf}/100', 'pass': perf >= 70})
    items.append({'label': f'SEO technical score: {seo}/100',       'pass': seo  >= 80})

    checklist['website'] = items

    # Combined score: PageSpeed 50% + content quality 50%
    if site_data.get('scraped'):
        return min(int(perf * 0.35 + seo * 0.15 + scraped_pts * 0.50), 100)
    return min(int(perf * 0.65 + seo * 0.35), 100)


def score_local_seo(place, site_data, checklist):
    s       = 0
    items   = []
    has_web = bool(place.get('website'))
    has_ph  = bool(place.get('formatted_phone_number'))
    scraped = site_data.get('scraped', False)

    # Schema markup — top on-site local ranking signal
    has_schema = site_data.get('has_schema', False) if scraped else False
    items.append({'label': 'Schema markup (LocalBusiness structured data)', 'pass': has_schema})
    if has_schema: s += 16

    # NAP: phone on website
    phone_ok = site_data.get('phone_on_site', False) if scraped else False
    items.append({'label': 'Phone number on website (NAP consistency)', 'pass': phone_ok})
    if phone_ok: s += 10

    # NAP: address on website
    addr_ok = site_data.get('address_on_site', False) if scraped else False
    items.append({'label': 'Physical address on website (NAP consistency)', 'pass': addr_ok})
    if addr_ok: s += 8

    # City keyword in content
    city_ok = site_data.get('city_in_content', False) if scraped else False
    items.append({'label': 'City/location keyword in website content', 'pass': city_ok})
    if city_ok: s += 10

    # Business name in title tag
    name_ok = site_data.get('name_in_title', False) if scraped else False
    items.append({'label': 'Business name in website title tag', 'pass': name_ok})
    if name_ok: s += 8

    # H2 heading structure (content depth signal)
    h2_count = site_data.get('h2_count', 0)
    h2_ok    = h2_count >= 2 if scraped else False
    items.append({'label': f'H2 heading structure ({h2_count} H2 tags)', 'pass': h2_ok})
    if h2_ok: s += 8

    # Image alt text coverage
    img_total   = site_data.get('images_total', 0)
    img_missing = site_data.get('images_missing_alt', 0)
    if scraped and img_total > 0:
        alt_ok  = (img_missing / img_total) <= 0.25
        alt_lbl = f'{img_missing}/{img_total} images missing alt text'
    else:
        alt_ok  = scraped   # no images = pass; unsscanned = fail
        alt_lbl = 'No images detected' if scraped else 'Scan unavailable'
    items.append({'label': f'Image alt text ({alt_lbl})', 'pass': alt_ok})
    if alt_ok: s += 7

    # Canonical tag (duplicate content prevention)
    canonical_ok = site_data.get('canonical_tag', False) if scraped else False
    items.append({'label': 'Canonical tag configured (prevents duplicate content)', 'pass': canonical_ok})
    if canonical_ok: s += 7

    # Internal linking (site architecture)
    int_links = site_data.get('internal_links', 0)
    int_ok    = int_links >= 5 if scraped else False
    items.append({'label': f'Internal linking structure ({int_links} internal links)', 'pass': int_ok})
    if int_ok: s += 6

    # Google Business Profile trifecta
    nap_gbp = has_web and has_ph and bool(place.get('opening_hours'))
    items.append({'label': 'Google Business Profile: website + phone + hours complete', 'pass': nap_gbp})
    if nap_gbp: s += 13

    # robots.txt
    robots_ok = site_data.get('robots_txt_found', False) if scraped else False
    items.append({'label': 'robots.txt file present and accessible', 'pass': robots_ok})
    if robots_ok: s += 4

    # sitemap.xml
    sitemap_ok = site_data.get('sitemap_found', False) if scraped else False
    items.append({'label': 'XML sitemap present and accessible', 'pass': sitemap_ok})
    if sitemap_ok: s += 3

    checklist['local_seo'] = items
    return min(s, 100)


def score_lead_capture(place, site_data, checklist):
    s       = 0
    items   = []
    has_web = bool(place.get('website'))
    has_ph  = bool(place.get('formatted_phone_number'))
    has_hrs = bool(place.get('opening_hours'))
    scraped = site_data.get('scraped', False)

    # Website — primary digital lead channel
    items.append({'label': 'Website for online lead capture', 'pass': has_web})
    if has_web: s += 20

    # Phone number on Google profile
    items.append({'label': 'Phone number listed on Google profile', 'pass': has_ph})
    if has_ph: s += 12

    # Hours published — eliminates friction and missed calls
    items.append({'label': 'Business hours visible to reduce friction', 'pass': has_hrs})
    if has_hrs: s += 8

    if scraped:
        # Online booking or scheduling — highest-converting lead channel
        booking_ok = site_data.get('has_booking_widget', False)
        items.append({'label': 'Online booking or appointment scheduling widget', 'pass': booking_ok})
        if booking_ok: s += 24

        # Contact form or primary CTA
        has_form = site_data.get('has_contact_form', False) or site_data.get('has_cta', False)
        items.append({'label': 'Contact form or primary CTA on website', 'pass': has_form})
        if has_form: s += 18

        # Live chat widget
        chat_ok = site_data.get('has_live_chat', False)
        items.append({'label': 'Live chat or messaging widget installed', 'pass': chat_ok})
        if chat_ok: s += 12

        # Multiple social channels (additional discovery and lead surfaces)
        social_ok = len(site_data.get('social_links', [])) >= 2
        items.append({'label': '2 or more social media channels linked', 'pass': social_ok})
        if social_ok: s += 6

    checklist['lead_capture'] = items
    return min(s, 100)


def letter_grade(overall):
    if overall >= 90: return 'A'
    if overall >= 80: return 'B'
    if overall >= 70: return 'C+'
    if overall >= 60: return 'C'
    if overall >= 50: return 'D+'
    if overall >= 40: return 'D'
    return 'F'


GRADE_MESSAGES = {
    'A':  'Excellent. Your online presence is operating at a high level.',
    'B':  'Solid foundation. A few targeted fixes will separate you from the competition.',
    'C+': 'Below market standard. Competitors are capturing leads you should be closing.',
    'C':  'Significant gaps. You are losing customers before they ever make contact.',
    'D+': 'Your online presence is actively costing you revenue on a daily basis.',
    'D':  'Customers cannot find or trust you online. Immediate action is required.',
    'F':  'Critical. Your business is effectively invisible to local customers.'
}


# ─────────────────────────────────────────────────────────────────
#  IMPROVEMENT ROADMAP
# ─────────────────────────────────────────────────────────────────

def get_jrz_action(issue, site_data, pagespeed, place):
    title = issue['title'].lower()

    if 'no website' in title:
        return {
            'fix':      ('JRZ designs and launches your complete website — mobile-first, '
                         'conversion-optimized, with your branding, contact form, Google Analytics, '
                         'and Search Console wired up. No templates. Built specifically for your '
                         'business type and local market.'),
            'timeline': '48 to 72 hours',
            'result':   'A live, indexed website generating leads from organic and map pack traffic.',
            'service':  'Website Build'
        }

    if 'slow' in title or 'performance' in title or 'speed' in title:
        lcp = ''
        if pagespeed and 'lighthouseResult' in pagespeed:
            lcp = (pagespeed['lighthouseResult']
                   .get('audits', {})
                   .get('largest-contentful-paint', {})
                   .get('displayValue', ''))
        context = f' (current load time: {lcp})' if lcp else ''
        return {
            'fix':      (f'JRZ runs a complete performance audit{context}, compresses all images, '
                         'enables CDN delivery, removes render-blocking resources, and optimizes '
                         'your Core Web Vitals scores. You provide zero technical input.'),
            'timeline': '24 to 48 hours',
            'result':   'Mobile performance score of 80 or above. Removes this issue from future audits.',
            'service':  'Performance Optimization'
        }

    if 'review' in title and any(w in title for w in ['low', 'few', 'only', 'below', 'threshold']):
        return {
            'fix':      ('JRZ deploys an automated review request system inside your CRM. '
                         'Every customer receives a personalized SMS or email 24 hours after their '
                         'visit with a direct link to your Google review page. All responses are '
                         'monitored and flagged for you on a weekly basis.'),
            'timeline': '3 to 5 business days to configure and activate',
            'result':   'Clients average 30 to 50 new reviews within the first 90 days of activation.',
            'service':  'Review Automation'
        }

    if 'photo' in title:
        return {
            'fix':      ('JRZ provides a photography brief specific to your business category '
                         'with an exact shot list, lighting guidance, and upload instructions. '
                         'For clients in our service markets, we coordinate a professional shoot directly.'),
            'timeline': '1 week for brief delivery; 2 weeks for a coordinated shoot',
            'result':   '35 percent average increase in Google profile clicks within 30 days of uploading 10 or more photos.',
            'service':  'Profile Photography'
        }

    if 'schema' in title or 'structured data' in title:
        return {
            'fix':      ('JRZ implements LocalBusiness schema markup on your website covering '
                         'your business name, address, phone, hours, service area, and review '
                         'aggregate. We also add FAQ schema to qualifying content, which enables '
                         'enhanced Google search result features.'),
            'timeline': '24 hours',
            'result':   'Eligibility for Google rich results and local pack enhancement. Typical local CTR improvement of 15 to 25 percent.',
            'service':  'Technical SEO'
        }

    if 'open graph' in title or 'social sharing' in title:
        return {
            'fix':      ('JRZ adds all required Open Graph and Twitter Card meta tags to your '
                         'website with a custom 1200x630 branded preview image. Your links will '
                         'display correctly when shared on Facebook, Instagram, LinkedIn, and iMessage.'),
            'timeline': '24 hours',
            'result':   'Branded social previews that drive 30 to 40 percent higher click-through on shared links.',
            'service':  'On-Page SEO'
        }

    if 'testimonial' in title:
        return {
            'fix':      ('JRZ installs a live testimonials widget that automatically pulls your '
                         'highest-rated Google reviews and displays them in a branded section on '
                         'your website. No manual updates required — the widget refreshes automatically.'),
            'timeline': '24 to 48 hours',
            'result':   'Immediate trust signal for new visitors. Pages with testimonials average 34 percent higher conversion rates.',
            'service':  'Conversion Optimization'
        }

    if 'meta description' in title:
        return {
            'fix':      ('JRZ rewrites your page titles and meta descriptions for every key page '
                         'using your primary service keywords and city. Each description is crafted '
                         'to maximize click-through rate from Google search results.'),
            'timeline': '24 to 48 hours',
            'result':   'Up to 30 percent improvement in organic click-through rate from Google results pages.',
            'service':  'On-Page SEO'
        }

    if 'hours' in title:
        return {
            'fix':      ('JRZ verifies and standardizes your hours across Google Business Profile, '
                         'your website, Yelp, Apple Maps, and Bing Places. Inconsistent hours across '
                         'platforms suppress local search rankings and damage customer trust.'),
            'timeline': '24 hours',
            'result':   'Eliminates the "hours unknown" flag in Google and improves local algorithm trust signals.',
            'service':  'Profile Optimization'
        }

    if 'phone' in title:
        return {
            'fix':      ('JRZ adds a tracked phone number to your Google Business Profile and '
                         'verifies exact match across your website and all directory listings. '
                         'We also implement call tracking so you can attribute leads directly from Google.'),
            'timeline': '24 hours',
            'result':   'Phone lead channel restored with full attribution reporting enabled.',
            'service':  'Profile Optimization'
        }

    if 'booking' in title or 'scheduling' in title:
        return {
            'fix':      ('JRZ integrates an online booking or scheduling widget directly into '
                         'your website using your preferred platform (Calendly, Square, Acuity, '
                         'OpenTable, or a custom-branded solution). The system connects to your '
                         'existing calendar and sends automated confirmation messages to customers. '
                         'No technical input required from you.'),
            'timeline': '24 to 48 hours',
            'result':   ('Businesses with online booking convert 2.4x more visitors than those '
                         'requiring a phone call. Leads captured during off-hours are never lost.'),
            'service':  'Booking Integration'
        }

    if 'city' in title or 'service area' in title or 'location' in title:
        return {
            'fix':      ('JRZ rewrites key sections of your website to include your city, '
                         'neighborhood, and service area naturally throughout the content. '
                         'We add location-specific meta tags, a service area page if needed, '
                         'and update your schema markup to anchor the site geographically.'),
            'timeline': '24 to 48 hours',
            'result':   ('Stronger local relevance signal to Google. Improvement in local map '
                         'pack and organic rankings within 30 to 60 days.'),
            'service':  'Local SEO Content'
        }

    if 'business description' in title or 'no business description' in title:
        return {
            'fix':      ('JRZ writes a keyword-optimized 750-character Google Business Profile '
                         'description covering your primary services, city and service area, '
                         'years in business, and unique differentiators. Published directly to '
                         'your GBP within 24 hours after your review and approval.'),
            'timeline': '24 hours',
            'result':   ('Description appears in Google search results on your profile card. '
                         'Improves relevance for service + city keyword combinations.'),
            'service':  'GBP Optimization'
        }

    if 'response rate' in title or 'owner replies' in title:
        return {
            'fix':      ('JRZ sets up a weekly review monitoring dashboard and response workflow. '
                         'Every new review — positive or negative — receives a professionally '
                         'written, personalized reply within 48 hours that includes your business '
                         'name, city, and service naturally for local SEO benefit.'),
            'timeline': '3 to 5 business days to configure',
            'result':   ('Review response rate reaches 100 percent. Google ranks active '
                         'responders higher. 89 percent of consumers prefer businesses that '
                         'respond to all reviews.'),
            'service':  'Reputation Management'
        }

    if 'velocity' in title or 'stagnant' in title:
        return {
            'fix':      ('JRZ deploys automated post-visit review requests via SMS or email — '
                         'sent exactly 24 hours after every customer transaction. Each message '
                         'is personalized, includes a direct Google review link, and is timed '
                         'to maximize response rate based on your business type.'),
            'timeline': '3 to 5 business days to activate',
            'result':   ('Clients average 30 to 50 new reviews within 90 days of activation. '
                         'Consistent review velocity signals active business to Google and '
                         'improves local map pack position over 60 to 90 days.'),
            'service':  'Review Automation'
        }

    if 'map pack' in title or 'local 3-pack' in title or 'not appearing' in title:
        return {
            'fix':      ('JRZ runs a full Local SEO audit identifying the specific gaps '
                         'preventing map pack entry: schema markup, NAP citation consistency, '
                         'GBP completeness, review velocity, and on-page city signals. '
                         'We implement all required changes and monitor ranking shifts weekly.'),
            'timeline': '2 to 4 weeks for initial movement; 60 to 90 days for stable placement',
            'result':   ('Map pack placement captures 44 percent of all local search clicks. '
                         'A single top-3 position for a primary keyword can add 15 to 40 '
                         'qualified leads per month depending on search volume.'),
            'service':  'Local SEO'
        }

    if 'directory' in title or 'citation' in title or 'yelp' in title:
        return {
            'fix':      ('JRZ builds and verifies your business citation profile across 40+ '
                         'directories: Yelp, Apple Maps, Bing Places, TripAdvisor, Yellow Pages, '
                         'BBB, Angi, HomeAdvisor, and more. Every listing is standardized with '
                         'identical NAP data and linked back to your primary website.'),
            'timeline': '5 to 7 business days',
            'result':   ('Citation consistency is one of the top 5 local ranking factors. '
                         'Businesses with complete citation profiles rank on average 1.8 positions '
                         'higher in map pack results than those without.'),
            'service':  'Citation Building'
        }

    if 'noindex' in title or 'blocking google' in title:
        return {
            'fix':      ('JRZ locates the noindex tag, removes it from production, and forces '
                         'an immediate Google re-crawl of the affected pages via Search Console '
                         'URL Inspection. We also audit all other pages for accidental indexing '
                         'blocks before marking the fix complete.'),
            'timeline': '24 hours',
            'result':   ('Pages become eligible for Google indexing immediately after removal. '
                         'Full re-index typically completes within 3 to 7 days.'),
            'service':  'Technical SEO'
        }

    if 'multiple h1' in title or 'h1 tags' in title:
        return {
            'fix':      ('JRZ audits your full heading structure — H1, H2, H3 — and restructures '
                         'the page to follow one primary H1 (your main keyword + city) with '
                         'supporting H2 sections for each service or topic. All changes are made '
                         'directly in your CMS or HTML with no disruption to your design.'),
            'timeline': '24 to 48 hours',
            'result':   ('Cleaner keyword signal to Google. Pages with proper heading structure '
                         'rank 15 to 30 percent higher on average for their primary keyword.'),
            'service':  'On-Page SEO'
        }

    if 'alt text' in title or 'images missing' in title:
        return {
            'fix':      ('JRZ adds descriptive, keyword-optimized alt text to every image on '
                         'your site. Each alt tag includes your primary service and city naturally, '
                         'turning your image library into an additional ranking signal.'),
            'timeline': '24 to 48 hours',
            'result':   ('Images become indexable by Google Image Search. '
                         'Accessibility score improves, which Google uses as a quality ranking signal.'),
            'service':  'Technical SEO'
        }

    if 'sitemap' in title:
        return {
            'fix':      ('JRZ generates a complete XML sitemap covering all pages, submits it '
                         'to Google Search Console and Bing Webmaster Tools, and sets up '
                         'automatic regeneration whenever new content is published.'),
            'timeline': '24 hours',
            'result':   ('All pages become discoverable to Google crawlers. '
                         'New content gets indexed within days instead of weeks.'),
            'service':  'Technical SEO'
        }

    if 'title is too long' in title or 'title is too short' in title or 'page title' in title:
        return {
            'fix':      ('JRZ rewrites all page titles to 50–60 characters with your primary '
                         'keyword and city front-loaded. Format: [Primary Service] in [City] | '
                         '[Business Name]. Each title is written to maximize click-through from '
                         'Google results while staying within the character limit.'),
            'timeline': '24 hours',
            'result':   ('Full title visible in search results. '
                         'Up to 20 percent improvement in organic click-through rate.'),
            'service':  'On-Page SEO'
        }

    if 'ssl' in title or 'https' in title or 'not secure' in title:
        return {
            'fix':      ('JRZ provisions and installs your SSL certificate, enforces HTTPS across '
                         'all pages, sets up 301 redirects from HTTP to HTTPS, and updates all '
                         'internal links and canonical tags so no ranking signals are lost.'),
            'timeline': '24 hours',
            'result':   ('"Not Secure" warning eliminated. Google ranking signal restored. '
                         'Visitor trust immediately improved.'),
            'service':  'SSL / Security'
        }

    if 'live chat' in title or 'chat widget' in title or 'messaging' in title:
        return {
            'fix':      ('JRZ installs and configures a live chat widget on your website — '
                         'either a staffed solution or an AI-powered chatbot that captures '
                         'lead details, answers common questions, and routes inquiries to '
                         'your team in real time via SMS or email.'),
            'timeline': '24 hours',
            'result':   ('Live chat increases website lead conversion by an average of 40 percent. '
                         'Visitors who receive an instant response are 7x more likely to become customers.'),
            'service':  'Chat / Conversion'
        }

    return {
        'fix':      ('JRZ audits this issue, identifies the root cause, and implements a targeted '
                     'fix. All work is completed by our team with no technical input required from you.'),
        'timeline': '2 to 5 business days',
        'result':   'Issue resolved with a documented improvement logged in your next monthly report.',
        'service':  'General Optimization'
    }


def build_roadmap(issues, site_data, pagespeed, place):
    steps = []
    for i, issue in enumerate(issues, 1):
        action = get_jrz_action(issue, site_data, pagespeed, place)
        steps.append({
            'step':     i,
            'severity': issue['severity'],
            'category': issue['category'],
            'title':    issue['title'],
            'problem':  issue['detail'],
            'jrz_fix':  action['fix'],
            'timeline': action['timeline'],
            'result':   action['result'],
            'service':  action['service'],
        })
    return steps


# ─────────────────────────────────────────────────────────────────
#  REPORT BUILDER
# ─────────────────────────────────────────────────────────────────

def build_report(place, pagespeed, site_data, competitors, keyword_rankings,
                 place_id, type_label='business', backlink_data=None,
                 review_intel=None, gbp_description='', map_pack_data=None):
    name    = place.get('name', '')
    rating  = place.get('rating', 0)
    reviews = place.get('user_ratings_total', 0)
    website = place.get('website', '')
    phone   = place.get('formatted_phone_number', '')
    photos  = len(place.get('photos', []))
    has_hrs = bool(place.get('opening_hours'))
    address = place.get('formatted_address', '')

    ri  = review_intel or {}
    checklist = {}
    gp  = score_google_presence(place, checklist, review_intel, gbp_description)
    rep = score_reputation(place, checklist)
    ws  = score_website(place, pagespeed, site_data, checklist)
    seo = score_local_seo(place, site_data, checklist)
    lc  = score_lead_capture(place, site_data, checklist)

    overall = int(gp * 0.22 + rep * 0.28 + ws * 0.22 + seo * 0.18 + lc * 0.10)
    grade   = letter_grade(overall)

    # PageSpeed detail
    lcp = fcp = tbt = cls_val = speed_index = ''
    perf_score = seo_score_ps = 0
    if pagespeed and 'lighthouseResult' in pagespeed:
        audits       = pagespeed['lighthouseResult'].get('audits', {})
        cats         = pagespeed['lighthouseResult'].get('categories', {})
        lcp          = audits.get('largest-contentful-paint', {}).get('displayValue', '')
        fcp          = audits.get('first-contentful-paint',   {}).get('displayValue', '')
        tbt          = audits.get('total-blocking-time',       {}).get('displayValue', '')
        cls_val      = audits.get('cumulative-layout-shift',   {}).get('displayValue', '')
        speed_index  = audits.get('speed-index',               {}).get('displayValue', '')
        perf_score   = int((cats.get('performance', {}).get('score') or 0) * 100)
        seo_score_ps = int((cats.get('seo',         {}).get('score') or 0) * 100)

    # Issues
    issues = []

    if not website:
        issues.append({
            'severity': 'critical', 'category': 'Website',
            'title':  'No website linked to your Google profile',
            'detail': ('70 percent of consumers visit a business website before making a purchase '
                       'decision. Without one, you are invisible to the majority of potential '
                       'customers actively searching for your services.'),
            'fix':    'JRZ builds and launches a conversion-optimized website for your business in 48 hours.'
        })
    elif ws < 50:
        speed_str = f'loading in {lcp} on mobile' if lcp else 'critically slow on mobile'
        issues.append({
            'severity': 'critical', 'category': 'Website',
            'title':  f'Your website is {speed_str}',
            'detail': ('53 percent of mobile visitors abandon a page that takes over 3 seconds to load. '
                       'Google uses page speed as a direct ranking factor in local search results, '
                       'meaning slow sites rank lower regardless of other quality signals.'),
            'fix':    'Full technical optimization including image compression, CDN caching, and Core Web Vitals. JRZ handles all of it.'
        })
    elif ws < 70:
        issues.append({
            'severity': 'warning', 'category': 'Website',
            'title':  'Website performance is below competitive standard',
            'detail': (f'Mobile performance score: {ws}/100. Businesses with faster sites rank '
                       'above you in local search and convert a higher percentage of visitors into customers.'),
            'fix':    'A targeted performance audit and optimization can push your score above 80.'
        })

    if site_data.get('scraped'):
        if not site_data.get('has_schema'):
            issues.append({
                'severity': 'warning', 'category': 'Technical SEO',
                'title':  'No structured data (schema markup) on your website',
                'detail': ('Schema markup tells Google exactly what your business is, where it is, '
                           'and when it operates. Without it, you are relying on Google to infer '
                           'this information — and gaps in that inference cost you rankings.'),
                'fix':    'Implement LocalBusiness schema covering name, address, phone, hours, and service area. JRZ deploys this in 24 hours.'
            })

        if not site_data.get('og_image'):
            issues.append({
                'severity': 'warning', 'category': 'Website',
                'title':  'No Open Graph image — social shares display blank previews',
                'detail': ('When your website is shared on Facebook, Instagram, or iMessage, '
                           'no image appears in the preview. This reduces click-through by '
                           'approximately 40 percent on every shared link.'),
                'fix':    'Add og:image and Twitter Card meta tags with a branded 1200x630 image. Resolved in under 24 hours.'
            })

        if not site_data.get('has_testimonials'):
            issues.append({
                'severity': 'warning', 'category': 'Website',
                'title':  'No customer testimonials displayed on your website',
                'detail': ('88 percent of consumers trust online reviews as much as personal '
                           'recommendations. Visitors who land on your website see no social proof, '
                           'which is the primary reason they leave without contacting you.'),
                'fix':    'JRZ installs a live review widget that pulls your highest-rated Google reviews automatically.'
            })

        if site_data.get('meta_desc_length', 0) < 100:
            issues.append({
                'severity': 'warning', 'category': 'SEO',
                'title':  'Meta description missing or too short',
                'detail': ('Meta descriptions appear directly in Google search results beneath '
                           'your page title. A missing or weak description reduces click-through '
                           'rate by up to 30 percent even when your page ranks.'),
                'fix':    'JRZ writes optimized meta descriptions for all key pages with your service, city, and main benefit.'
            })

    if reviews < 25:
        issues.append({
            'severity': 'critical', 'category': 'Reputation',
            'title':  f'Only {reviews} Google reviews — below the trust threshold',
            'detail': ('Businesses with fewer than 25 reviews lose 68 percent of potential '
                       'customers to competitors with stronger social proof. Low review counts '
                       'also suppress your position in local search rankings.'),
            'fix':    'JRZ deploys an automated review request system. Average client receives 30 to 50 new reviews within 90 days.'
        })
    elif reviews < 75:
        issues.append({
            'severity': 'warning', 'category': 'Reputation',
            'title':  f'{reviews} reviews — below the local authority benchmark',
            'detail': ('In competitive local markets, 100 or more reviews is the standard for '
                       'top-of-results placement. You are operating below that threshold, '
                       'which limits your map pack visibility.'),
            'fix':    'JRZ wires automated post-visit review requests into your existing CRM workflow via SMS.'
        })

    if photos < 5:
        issues.append({
            'severity': 'critical', 'category': 'Google Profile',
            'title':  f'Only {photos} photos on your Google Business Profile',
            'detail': ('Businesses with 10 or more photos receive 35 percent more website clicks '
                       'and 42 percent more direction requests than businesses with fewer photos. '
                       'Your profile is missing one of the highest-impact free signals available.'),
            'fix':    'Upload a minimum of 10 quality photos: exterior, interior, staff, services, and signage.'
        })
    elif photos < 10:
        issues.append({
            'severity': 'warning', 'category': 'Google Profile',
            'title':  f'{photos} photos — below the recommended threshold',
            'detail': ('Google rewards active, complete profiles. 10 or more photos is the '
                       'standard for competitive visibility in your local market.'),
            'fix':    'Add 4 to 6 additional photos with variety: new product shots, team updates, and seasonal content.'
        })

    if not has_hrs:
        issues.append({
            'severity': 'warning', 'category': 'Google Profile',
            'title':  'Business hours are not set on Google',
            'detail': ('Missing hours causes Google to display "hours unknown" on your profile. '
                       'This is a direct trust failure. Customers who cannot confirm you are open '
                       'will contact a competitor who clearly displays their availability.'),
            'fix':    'Add your hours in Google Business Profile. JRZ also verifies consistency across all directory listings.'
        })

    if not phone:
        issues.append({
            'severity': 'warning', 'category': 'Lead Capture',
            'title':  'No phone number on your Google profile',
            'detail': ('Phone contact is the primary action taken by local customers after '
                       'viewing a business profile. A missing number eliminates an entire lead '
                       'channel and raises credibility concerns for potential customers.'),
            'fix':    'JRZ adds your phone number with call tracking enabled so you can measure leads from Google directly.'
        })

    # GBP Depth Issues
    if not gbp_description:
        issues.append({
            'severity': 'warning', 'category': 'Google Profile',
            'title':  'No business description on your Google profile',
            'detail': ('Google Business Profile descriptions appear in search results and on your '
                       'profile card. A missing description means Google has to guess what your '
                       'business does — which reduces the quality of leads and weakens your '
                       'relevance signal for local searches.'),
            'fix':    'JRZ writes a keyword-optimized 750-character description covering your services, city, and unique differentiators. Published in 24 hours.'
        })

    rr = ri.get('response_rate', 0)
    vel_score = ri.get('velocity_score', 0)
    if ri.get('total_sampled', 0) > 0 and rr < 50:
        issues.append({
            'severity': 'warning', 'category': 'Reputation',
            'title':  f'Low review response rate — {rr}% of reviews have owner replies',
            'detail': ('Google factors owner response rate into local ranking signals. '
                       'Businesses that respond to reviews consistently rank higher than those '
                       'that do not. More importantly, 89 percent of consumers say they are '
                       'more likely to choose a business that responds to all reviews.'),
            'fix':    'JRZ sets up a weekly review monitoring and response workflow — every review gets a professional reply within 48 hours.'
        })

    if ri.get('total_sampled', 0) > 0 and vel_score < 35:
        vel_days = ri.get('newest_review_days')
        days_str = f'{vel_days} days ago' if vel_days else 'unknown'
        issues.append({
            'severity': 'warning', 'category': 'Reputation',
            'title':  f'Review velocity is stagnant — last review posted {days_str}',
            'detail': ('Google rewards businesses that receive reviews consistently. '
                       'A stagnant review profile signals low activity to the algorithm and '
                       'causes your map pack position to drop over time as active competitors '
                       'accumulate more recent reviews.'),
            'fix':    'JRZ activates automated review requests sent by SMS after every transaction. Clients average 30 to 50 new reviews within the first 90 days.'
        })

    # Map pack issues
    if map_pack_data:
        not_in_pack = [m for m in map_pack_data if not m.get('in_pack')]
        if not_in_pack:
            missing_kws = ', '.join(f'"{m["keyword"]}"' for m in not_in_pack[:2])
            issues.append({
                'severity': 'critical', 'category': 'Local SEO',
                'title':  f'Not appearing in Google Map Pack for {missing_kws}',
                'detail': ('The Google Map Pack (the 3 businesses shown above organic results) '
                           'captures 44 percent of all local search clicks. If you are not in the '
                           'top 3 for your primary keywords, you are invisible to nearly half of '
                           'all local searchers — regardless of your website ranking.'),
                'fix':    'JRZ runs a full Local SEO audit and implements the specific signals needed to enter and maintain map pack placement: schema, citations, GBP optimization, and review velocity.'
            })

    # Directory citation issues
    dir_links = site_data.get('directory_links', [])
    if website and not dir_links:
        issues.append({
            'severity': 'warning', 'category': 'Local SEO',
            'title':  'No directory listings detected (Yelp, TripAdvisor, BBB, etc.)',
            'detail': ('Directory citations — consistent Name, Address, Phone listings across '
                       'the web — are one of the top local ranking factors. Businesses with '
                       'strong citation profiles rank higher in map pack results and are more '
                       'trusted by Google as established, legitimate businesses.'),
            'fix':    'JRZ builds and verifies your citation profile across 40+ directories including Yelp, Apple Maps, Bing Places, TripAdvisor, Yellow Pages, and BBB.'
        })

    # SEO-specific issues (only when site was successfully scanned)
    if site_data.get('scraped') and website:
        if site_data.get('meta_robots_noindex'):
            issues.append({
                'severity': 'critical', 'category': 'Technical SEO',
                'title':  'Website is blocking Google — noindex tag detected',
                'detail': ('A "noindex" meta robots tag is present on your site. This instructs '
                           'Google to not index the page, meaning it will not appear in any search '
                           'results. This is often a staging configuration left live by mistake, '
                           'but it is actively preventing your site from being found.'),
                'fix':    'JRZ removes the noindex directive and submits the affected pages to Google for re-indexing within 24 hours.'
            })

        if site_data.get('multiple_h1'):
            issues.append({
                'severity': 'warning', 'category': 'Technical SEO',
                'title':  f'Multiple H1 tags detected ({site_data.get("h1_count", 0)} H1s on page)',
                'detail': ('A page should have exactly one H1 tag. Multiple H1 tags dilute '
                           'the primary keyword signal sent to Google and indicate a structural '
                           'content issue that can limit your ranking potential.'),
                'fix':    'JRZ restructures your heading hierarchy — one H1, supporting H2s, and H3 subsections — following Google SEO best practices.'
            })

        title_len = site_data.get('meta_title_length', 0)
        if title_len > 60:
            issues.append({
                'severity': 'warning', 'category': 'SEO',
                'title':  f'Page title is too long ({title_len} characters — Google truncates above 60)',
                'detail': ('Titles over 60 characters are cut off in Google search results with "..." '
                           'This hides your key information from searchers and reduces click-through rate.'),
                'fix':    'JRZ rewrites all page titles to 50–60 characters with your primary keyword and city front-loaded.'
            })
        elif website and title_len < 30 and title_len > 0:
            issues.append({
                'severity': 'warning', 'category': 'SEO',
                'title':  f'Page title is too short ({title_len} characters — underutilized keyword space)',
                'detail': ('Short page titles waste valuable keyword real estate. '
                           'Google allows up to 60 characters — every unused character is a '
                           'missed opportunity to rank for an additional service or location term.'),
                'fix':    'JRZ rewrites titles to maximize keyword coverage: [Primary Service] in [City] | [Business Name].'
            })

        img_total   = site_data.get('images_total', 0)
        img_missing = site_data.get('images_missing_alt', 0)
        if img_total > 0 and img_missing > 0 and (img_missing / img_total) > 0.5:
            issues.append({
                'severity': 'warning', 'category': 'Technical SEO',
                'title':  f'{img_missing} of {img_total} images missing alt text',
                'detail': ('Alt text tells Google what your images contain. Missing alt text '
                           'means Google cannot read your images for ranking purposes, and '
                           'it also fails accessibility standards — which Google uses as a '
                           'quality signal for local search ranking.'),
                'fix':    'JRZ adds descriptive, keyword-rich alt text to every image on your site with proper location and service context.'
            })

        if not site_data.get('sitemap_found'):
            issues.append({
                'severity': 'warning', 'category': 'Technical SEO',
                'title':  'No XML sitemap found',
                'detail': ('A sitemap tells Google exactly which pages exist on your site and '
                           'how frequently they are updated. Without one, Google may miss pages '
                           'entirely — especially new content, service pages, and location pages.'),
                'fix':    'JRZ generates and submits your sitemap to Google Search Console, ensuring every page gets crawled and indexed.'
            })

    # Website-level accuracy signals (only when site was successfully scanned)
    if site_data.get('scraped') and website:
        if not site_data.get('has_ssl'):
            issues.append({
                'severity': 'critical', 'category': 'Website',
                'title':  'Website is not secure — no SSL certificate (HTTP only)',
                'detail': ('Browsers display a "Not Secure" warning to every visitor on non-HTTPS sites. '
                           'Approximately 85 percent of users leave immediately after seeing that warning. '
                           'Google also uses HTTPS as a direct ranking factor in local and organic results.'),
                'fix':    'JRZ installs your SSL certificate and enforces HTTPS sitewide within 24 hours.'
            })

        if not site_data.get('has_booking_widget'):
            issues.append({
                'severity': 'warning', 'category': 'Lead Capture',
                'title':  'No online booking or scheduling system on your website',
                'detail': ('Businesses with online booking convert 2.4x more website visitors than '
                           'those that require a phone call. Every visitor who cannot book instantly '
                           'is a potential lead lost to a competitor who makes it frictionless.'),
                'fix':    'JRZ integrates an online booking widget into your website within 48 hours — no technical input needed.'
            })

        if not site_data.get('city_in_content'):
            issues.append({
                'severity': 'warning', 'category': 'Local SEO',
                'title':  'City or service area not mentioned in website content',
                'detail': ('Google reads your website content to determine geographic relevance. '
                           'A site that never mentions the city it serves sends a weak local signal, '
                           'directly limiting your visibility in local and map pack results.'),
                'fix':    'JRZ rewrites key page sections with city-specific language and adds a geo-anchored service area page.'
            })

        if not site_data.get('has_live_chat') and not site_data.get('has_booking_widget'):
            issues.append({
                'severity': 'warning', 'category': 'Lead Capture',
                'title':  'No live chat or instant contact option on your website',
                'detail': ('Visitors who receive an immediate response are 7x more likely to '
                           'convert. Without live chat or a chatbot, visitors who have questions '
                           'at 9pm or on weekends leave with no way to reach you — and contact '
                           'a competitor instead.'),
                'fix':    'JRZ installs a chat widget with AI-powered first response and SMS escalation to your team in real time.'
            })

    revenue_loss = estimate_revenue_loss(issues, place, overall_score=overall)
    roadmap      = build_roadmap(issues, site_data, pagespeed, place)

    # Competitors
    comp_list = [
        {
            'name':    c.get('name', ''),
            'rating':  c.get('rating', 0),
            'reviews': c.get('user_ratings_total', 0),
            'address': c.get('vicinity', '')
        }
        for c in competitors[:3]
    ]

    comp_insight = None
    if comp_list:
        active = [c for c in comp_list if c['rating']]
        if active:
            avg_rev = sum(c['reviews'] for c in active) / len(active)
            avg_rat = sum(c['rating']  for c in active) / len(active)
            if avg_rev > reviews * 1.4:
                comp_insight = (
                    f"Your top competitors average {int(avg_rev)} reviews compared to your {reviews}. "
                    f"That gap directly reduces your visibility in local search results."
                )
            elif avg_rat > rating + 0.15:
                comp_insight = (
                    f"Your competitors average {avg_rat:.1f} stars versus your {rating} stars. "
                    f"A 0.2-star gap shifts approximately 20 percent of clicks to competing businesses."
                )

    # Free quick win
    if photos < 10:
        free_tip = {
            'action': ('Go to business.google.com, navigate to Info, then Photos, and upload '
                       'a minimum of 6 images including your exterior, interior, best product or '
                       'service, and at least one team photo. This takes approximately 15 minutes '
                       'and requires no budget.'),
            'impact': '35 percent average lift in Google profile clicks within 30 days of uploading 10 or more photos.'
        }
    elif reviews < 25:
        free_tip = {
            'action': ('Send a personal text message to your last 10 customers individually: '
                       '"I wanted to personally thank you for your business. If you have 60 seconds, '
                       'a Google review would mean a great deal to us — here is the direct link." '
                       'Send each message individually, not as a group message.'),
            'impact': 'A single personal outreach campaign typically generates 4 to 8 new reviews within 48 hours.'
        }
    elif site_data.get('scraped') and not site_data.get('has_schema'):
        free_tip = {
            'action': ('Add a LocalBusiness schema block to the head section of your website. '
                       'Use schema.org/LocalBusiness as the type and include your name, address, '
                       'phone, and opening hours. Validate it at search.google.com/test/rich-results.'),
            'impact': 'Schema can generate rich search results and increase local click-through rate by 15 to 25 percent.'
        }
    else:
        free_tip = {
            'action': ('Reply to your 5 most recent Google reviews today — both positive and negative. '
                       'Include your business name and city naturally in the first sentence of each reply. '
                       'For negative reviews, acknowledge the feedback and provide a resolution path.'),
            'impact': 'Active review responses signal engagement to Google and can improve local pack ranking within 2 weeks.'
        }

    return {
        'place_id':   place_id,
        'business':   {
            'name': name, 'address': address, 'rating': rating,
            'reviews': reviews, 'website': website, 'phone': phone,
            'photos': photos, 'has_hours': has_hrs
        },
        'scores':     {
            'overall': overall, 'grade': grade,
            'grade_message': GRADE_MESSAGES.get(grade, ''),
            'google_presence': gp, 'reputation': rep,
            'website': ws, 'local_seo': seo, 'lead_capture': lc
        },
        'pagespeed_detail': {
            'lcp': lcp, 'fcp': fcp, 'tbt': tbt,
            'cls': cls_val, 'speed_index': speed_index,
            'performance': perf_score, 'seo': seo_score_ps
        },
        'checklists':        checklist,
        'issues':            issues,
        'revenue_loss':      revenue_loss,
        'roadmap':           roadmap,
        'keyword_rankings':  keyword_rankings,
        'competitors':       comp_list,
        'competitor_insight': comp_insight,
        'free_tip':          free_tip,
        'review_intel': {
            'velocity':          ri.get('velocity', 'No data'),
            'velocity_score':    ri.get('velocity_score', 0),
            'recent_30':         ri.get('recent_30', 0),
            'recent_90':         ri.get('recent_90', 0),
            'response_rate':     ri.get('response_rate', 0),
            'responded':         ri.get('responded', 0),
            'total_sampled':     ri.get('total_sampled', 0),
            'newest_review_days': ri.get('newest_review_days'),
        },
        'gbp_description': gbp_description,
        'map_pack':        map_pack_data or [],
        'directory_links': site_data.get('directory_links', []),
        'delivery_links':  site_data.get('delivery_links', []),
        'seo_audit': {
            'scraped':             site_data.get('scraped', False),
            'h1_count':            site_data.get('h1_count', 0),
            'h1_text':             site_data.get('h1_text', ''),
            'h2_count':            site_data.get('h2_count', 0),
            'h2_texts':            site_data.get('h2_texts', []),
            'h3_count':            site_data.get('h3_count', 0),
            'h3_texts':            site_data.get('h3_texts', []),
            'heading_hierarchy_ok': site_data.get('heading_hierarchy_ok', False),
            'multiple_h1':         site_data.get('multiple_h1', False),
            'keyword_in_h1':       site_data.get('keyword_in_h1', False),
            'meta_title':          site_data.get('meta_title', ''),
            'meta_title_length':   site_data.get('meta_title_length', 0),
            'meta_description':    site_data.get('meta_description', ''),
            'meta_desc_length':    site_data.get('meta_desc_length', 0),
            'images_total':        site_data.get('images_total', 0),
            'images_missing_alt':  site_data.get('images_missing_alt', 0),
            'internal_links':      site_data.get('internal_links', 0),
            'external_links':      site_data.get('external_links', 0),
            'canonical_tag':       site_data.get('canonical_tag', False),
            'meta_robots_noindex': site_data.get('meta_robots_noindex', False),
            'has_viewport_meta':   site_data.get('has_viewport_meta', False),
            'robots_txt_found':    site_data.get('robots_txt_found', False),
            'sitemap_found':       site_data.get('sitemap_found', False),
            'backlinks':           (backlink_data or {}).get('backlinks', 0),
            'referring_domains':   (backlink_data or {}).get('referring_domains', 0),
            'domain_rank':         (backlink_data or {}).get('rank', 0),
            'spam_score':          (backlink_data or {}).get('spam_score', 0),
        }
    }


# ─────────────────────────────────────────────────────────────────
#  GHL LEAD CAPTURE
# ─────────────────────────────────────────────────────────────────

def fire_ghl(report):
    b = report['business']
    s = report['scores']
    requests.post(GHL_WEBHOOK, json={
        'firstName':        b['name'].split()[0] if b['name'] else '',
        'name':             b['name'],
        'phone':            b.get('phone', ''),
        'website':          b.get('website', ''),
        'address1':         b.get('address', ''),
        'source':           'jrz-grader',
        'overall_score':    s['overall'],
        'grade':            s['grade'],
        'google_score':     s['google_presence'],
        'reputation_score': s['reputation'],
        'website_score':    s['website'],
        'seo_score':        s['local_seo'],
        'issues_count':     len(report['issues']),
        'revenue_loss':     report.get('revenue_loss', 0),
        'tags':             [f"grade:{s['grade']}", 'grader-lead', 'needs-followup']
    }, timeout=5)


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=False)
