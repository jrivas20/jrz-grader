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
                           'photos,types,geometry,business_status,price_level'),
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
    skip      = {'point_of_interest', 'establishment', 'food', 'premise',
                 'locality', 'political', 'sublocality', 'route'}
    biz_type  = next((t for t in raw_types if t not in skip), 'establishment')

    if loc:
        try:
            nr = requests.get(
                'https://maps.googleapis.com/maps/api/place/nearbysearch/json',
                params={
                    'location': f"{loc['lat']},{loc['lng']}",
                    'radius':   8000,
                    'type':     biz_type,
                    'key':      GOOGLE_KEY,
                    'rankby':   'prominence'
                },
                timeout=8
            )
            nearby      = nr.json().get('results', [])
            competitors = [
                r for r in nearby
                if r.get('place_id') != place_id
                and r.get('business_status') == 'OPERATIONAL'
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

    # 4. Website Scrape
    site_data = {}
    if website:
        site_data = scrape_website(website)

    # 5. Keyword Rankings (Phase 2 — DataForSEO)
    keyword_rankings = []
    if DFS_LOGIN and DFS_PASSWORD and place.get('formatted_address'):
        city, state = parse_city_state(place['formatted_address'])
        if city:
            keyword_rankings = check_keyword_rankings(
                place.get('name', ''), biz_type, city, state
            )

    # 6. Build Report
    report = build_report(place, pagespeed, site_data, competitors, keyword_rankings, place_id)

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
#  WEBSITE SCRAPER
# ─────────────────────────────────────────────────────────────────

def scrape_website(url):
    empty = {
        'scraped': False, 'h1_exists': False, 'h1_text': '',
        'meta_title': '', 'meta_description': '', 'meta_desc_length': 0,
        'og_title': False, 'og_description': False, 'og_image': False,
        'twitter_card': False, 'favicon': False,
        'phone_on_site': False, 'address_on_site': False, 'hours_on_site': False,
        'social_links': [], 'has_contact_form': False, 'has_schema': False,
        'has_testimonials': False, 'has_cta': False, 'word_count': 0,
        'has_about': False, 'has_faq': False,
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

        # Phone number
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
            'open daily', 'open monday'
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
            'yelp.com':      'Yelp',
        }
        found_social = {}
        for a in soup.find_all('a', href=True):
            for domain, label in social_map.items():
                if domain in a['href']:
                    found_social[label] = True
        r['social_links'] = list(found_social.keys())

        # Contact form
        r['has_contact_form'] = bool(soup.find('form'))

        # Schema markup
        r['has_schema'] = bool(soup.find('script', type='application/ld+json'))

        # Testimonials
        test_kw = [
            'testimonial', 'what our clients', 'customers say',
            'client review', 'customer review', 'five-star', '5-star',
            'what people say', 'our reviews'
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

    except Exception:
        return empty

    return r


# ─────────────────────────────────────────────────────────────────
#  DATAFORSEO KEYWORD RANKINGS  (Phase 2)
# ─────────────────────────────────────────────────────────────────

def check_keyword_rankings(biz_name, biz_type, city, state):
    type_label = biz_type.replace('_', ' ')
    keywords   = [
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
#  REVENUE ESTIMATOR
# ─────────────────────────────────────────────────────────────────

def estimate_revenue_loss(issues, place):
    critical = sum(1 for i in issues if i['severity'] == 'critical')
    warning  = sum(1 for i in issues if i['severity'] == 'warning')
    if not (critical + warning):
        return 0

    base  = critical * 900 + warning * 350
    types = place.get('types', [])

    if any(t in types for t in ['restaurant', 'cafe', 'bakery', 'meal_delivery', 'meal_takeaway']):
        mult = 1.8
    elif any(t in types for t in ['doctor', 'dentist', 'physiotherapist', 'spa', 'beauty_salon', 'hair_care']):
        mult = 2.2
    elif any(t in types for t in ['lawyer', 'accounting', 'real_estate_agency', 'insurance_agency']):
        mult = 3.0
    elif any(t in types for t in ['plumber', 'electrician', 'roofing', 'contractor', 'moving_company']):
        mult = 2.5
    else:
        mult = 1.5

    return int(base * mult)


# ─────────────────────────────────────────────────────────────────
#  SCORING ENGINE
# ─────────────────────────────────────────────────────────────────

def score_google_presence(place, checklist):
    s        = 0
    items    = []
    has_web  = bool(place.get('website'))
    has_ph   = bool(place.get('formatted_phone_number'))
    has_hrs  = bool(place.get('opening_hours'))
    photos   = len(place.get('photos', []))
    reviews  = place.get('user_ratings_total', 0)
    has_price = 'price_level' in place

    items.append({'label': 'Website linked to profile',              'pass': has_web})
    if has_web:   s += 15

    items.append({'label': 'Phone number listed',                    'pass': has_ph})
    if has_ph:    s += 12

    items.append({'label': 'Business hours published',               'pass': has_hrs})
    if has_hrs:   s += 15

    items.append({'label': 'Price range configured',                 'pass': has_price})
    if has_price: s += 8

    photos_ok = photos >= 10
    items.append({'label': f'10 or more photos ({photos} uploaded)', 'pass': photos_ok})
    if photos >= 10: s += 20
    elif photos >= 5:  s += 13
    elif photos >= 1:  s += 6

    reviews_ok = reviews >= 50
    items.append({'label': f'50 or more reviews ({reviews} total)', 'pass': reviews_ok})
    if reviews >= 100: s += 20
    elif reviews >= 50:  s += 15
    elif reviews >= 20:  s += 10
    elif reviews >= 5:   s += 5

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
    items = []

    if not place.get('website'):
        for label in [
            'Website exists and is linked', 'H1 headline present',
            'Meta description configured', 'Phone number on site',
            'Address visible on site', 'Business hours on site',
            'Social media links present', 'Contact form or booking CTA',
            'Favicon configured', 'Schema markup present',
            'Open Graph tags for social sharing', 'Customer testimonials displayed'
        ]:
            items.append({'label': label, 'pass': False})
        checklist['website'] = items
        return 0

    items.append({'label': 'Website exists and is linked', 'pass': True})

    if site_data.get('scraped'):
        items.append({'label': 'H1 headline present',
                      'pass': site_data.get('h1_exists', False)})

        chars    = site_data.get('meta_desc_length', 0)
        meta_ok  = chars >= 100
        items.append({'label': f'Meta description configured ({chars} characters)',
                      'pass': meta_ok})

        items.append({'label': 'Phone number visible on site',
                      'pass': site_data.get('phone_on_site', False)})
        items.append({'label': 'Address present on site',
                      'pass': site_data.get('address_on_site', False)})
        items.append({'label': 'Business hours on site',
                      'pass': site_data.get('hours_on_site', False)})

        social    = site_data.get('social_links', [])
        social_ok = len(social) > 0
        soc_label = ', '.join(social) if social_ok else 'none detected'
        items.append({'label': f'Social media links ({soc_label})', 'pass': social_ok})

        has_cta = site_data.get('has_cta', False) or site_data.get('has_contact_form', False)
        items.append({'label': 'Contact form or booking CTA present', 'pass': has_cta})
        items.append({'label': 'Favicon configured',
                      'pass': site_data.get('favicon', False)})
        items.append({'label': 'Schema markup (structured data)',
                      'pass': site_data.get('has_schema', False)})

        og_ok = site_data.get('og_title', False) and site_data.get('og_image', False)
        items.append({'label': 'Open Graph tags for social sharing', 'pass': og_ok})
        items.append({'label': 'Customer testimonials displayed',
                      'pass': site_data.get('has_testimonials', False)})

        words = site_data.get('word_count', 0)
        items.append({'label': f'Sufficient page content ({words} words)',
                      'pass': words >= 300})
    else:
        items.append({'label': 'Site scan unavailable (bot-protected or timeout)',
                      'pass': None})

    if not pagespeed or 'lighthouseResult' not in pagespeed:
        items.append({'label': 'Mobile performance (scan unavailable)', 'pass': None})
        checklist['website'] = items
        return 28

    cats = pagespeed['lighthouseResult']['categories']
    perf = int((cats.get('performance', {}).get('score') or 0) * 100)
    seo  = int((cats.get('seo',         {}).get('score') or 0) * 100)

    items.append({'label': f'Mobile performance score: {perf}/100', 'pass': perf >= 70})
    items.append({'label': f'SEO technical score: {seo}/100',       'pass': seo  >= 80})

    checklist['website'] = items
    return min(int(perf * 0.65 + seo * 0.35), 100)


def score_local_seo(place, site_data, checklist):
    s       = 0
    items   = []
    has_web = bool(place.get('website'))
    has_ph  = bool(place.get('formatted_phone_number'))
    has_hrs = bool(place.get('opening_hours'))
    photos  = len(place.get('photos', []))
    reviews = place.get('user_ratings_total', 0)

    items.append({'label': 'Website linked to Google profile', 'pass': has_web})
    if has_web:  s += 20

    items.append({'label': 'Phone number on Google profile', 'pass': has_ph})
    if has_ph:   s += 12

    items.append({'label': 'Business hours configured', 'pass': has_hrs})
    if has_hrs:  s += 15

    photos_ok = photos >= 5
    items.append({'label': f'5 or more profile photos ({photos})', 'pass': photos_ok})
    if photos >= 5:  s += 18
    elif photos >= 1: s += 8

    reviews_ok = reviews >= 50
    items.append({'label': f'50 or more reviews for local authority ({reviews})',
                  'pass': reviews_ok})
    if reviews >= 50:  s += 20
    elif reviews >= 20: s += 10
    elif reviews >= 5:  s += 5

    if site_data.get('scraped'):
        has_schema = site_data.get('has_schema', False)
        items.append({'label': 'Schema markup on website', 'pass': has_schema})
        if has_schema: s += 15

    checklist['local_seo'] = items
    return min(s, 100)


def score_lead_capture(place, site_data, checklist):
    s       = 0
    items   = []
    has_web = bool(place.get('website'))
    has_ph  = bool(place.get('formatted_phone_number'))
    has_hrs = bool(place.get('opening_hours'))

    items.append({'label': 'Website for online lead capture', 'pass': has_web})
    if has_web:  s += 35

    items.append({'label': 'Phone number for direct contact', 'pass': has_ph})
    if has_ph:   s += 25

    items.append({'label': 'Business hours visible to reduce friction', 'pass': has_hrs})
    if has_hrs:  s += 15

    if site_data.get('scraped'):
        has_form = site_data.get('has_contact_form', False) or site_data.get('has_cta', False)
        items.append({'label': 'Contact form or booking CTA on website', 'pass': has_form})
        if has_form: s += 15

        social_ok = len(site_data.get('social_links', [])) >= 2
        items.append({'label': '2 or more social media channels active', 'pass': social_ok})
        if social_ok: s += 10

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

def build_report(place, pagespeed, site_data, competitors, keyword_rankings, place_id):
    name    = place.get('name', '')
    rating  = place.get('rating', 0)
    reviews = place.get('user_ratings_total', 0)
    website = place.get('website', '')
    phone   = place.get('formatted_phone_number', '')
    photos  = len(place.get('photos', []))
    has_hrs = bool(place.get('opening_hours'))
    address = place.get('formatted_address', '')

    checklist = {}
    gp  = score_google_presence(place, checklist)
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

    revenue_loss = estimate_revenue_loss(issues, place)
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
        'free_tip':          free_tip
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
