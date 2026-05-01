import os
import time
import hashlib
import requests
from flask import Flask, request, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

GOOGLE_KEY  = os.environ.get('GOOGLE_API_KEY', '')
GHL_WEBHOOK = os.environ.get('GHL_WEBHOOK',
    'https://services.leadconnectorhq.com/hooks/d7iUPfamAaPlSBNj6IhT/webhook-trigger/jrz-grader')

# Simple in-memory cache — 10-minute TTL per place_id
CACHE = {}


# ─────────────────────────────────────────────────────────────────
#  ROUTES
# ─────────────────────────────────────────────────────────────────

@app.route('/health')
def health():
    return jsonify({'status': 'ok', 'key_set': bool(GOOGLE_KEY)})


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

    # Cache check
    cache_key = hashlib.md5(place_id.encode()).hexdigest()
    if cache_key in CACHE and time.time() - CACHE[cache_key]['ts'] < 600:
        return jsonify(CACHE[cache_key]['data'])

    # ── 1. Place Details ─────────────────────────────────────────
    try:
        pr = requests.get(
            'https://maps.googleapis.com/maps/api/place/details/json',
            params={
                'place_id': place_id,
                'fields': ('name,rating,user_ratings_total,formatted_address,'
                           'website,formatted_phone_number,opening_hours,'
                           'photos,types,geometry,business_status'),
                'key': GOOGLE_KEY
            },
            timeout=8
        )
        place = pr.json().get('result', {})
    except Exception as e:
        return jsonify({'error': f'Google Places error: {e}'}), 502

    if not place:
        return jsonify({'error': 'Business not found'}), 404

    # ── 2. Nearby Competitors ────────────────────────────────────
    competitors = []
    loc = place.get('geometry', {}).get('location', {})
    raw_types = place.get('types', [])
    skip = {'point_of_interest', 'establishment', 'food', 'premise',
            'locality', 'political', 'sublocality', 'route'}
    biz_type = next((t for t in raw_types if t not in skip), 'establishment')

    if loc:
        try:
            nr = requests.get(
                'https://maps.googleapis.com/maps/api/place/nearbysearch/json',
                params={
                    'location': f"{loc['lat']},{loc['lng']}",
                    'radius': 8000,
                    'type': biz_type,
                    'key': GOOGLE_KEY,
                    'rankby': 'prominence'
                },
                timeout=8
            )
            nearby = nr.json().get('results', [])
            competitors = [
                r for r in nearby
                if r.get('place_id') != place_id
                and r.get('business_status') == 'OPERATIONAL'
            ][:3]
        except:
            competitors = []

    # ── 3. PageSpeed Insights ────────────────────────────────────
    website = place.get('website', '')
    pagespeed = {}
    if website:
        try:
            ps = requests.get(
                'https://www.googleapis.com/pagespeedonline/v5/runPagespeed',
                params={'url': website, 'strategy': 'mobile', 'key': GOOGLE_KEY},
                timeout=20
            )
            pagespeed = ps.json()
        except:
            pagespeed = {}

    # ── 4. Build Report ──────────────────────────────────────────
    report = build_report(place, pagespeed, competitors, place_id)

    # Cache it
    CACHE[cache_key] = {'ts': time.time(), 'data': report}

    # ── 5. GHL Lead Capture ──────────────────────────────────────
    try:
        fire_ghl(report)
    except:
        pass

    return jsonify(report)


# ─────────────────────────────────────────────────────────────────
#  SCORING ENGINE
# ─────────────────────────────────────────────────────────────────

def score_google_presence(place):
    """Score 0-100 based on GMB profile completeness."""
    s = 0
    if place.get('website'):                        s += 20
    if place.get('formatted_phone_number'):         s += 15
    if place.get('opening_hours'):                  s += 20
    photos = len(place.get('photos', []))
    if   photos >= 10: s += 25
    elif photos >= 5:  s += 18
    elif photos >= 1:  s += 10
    reviews = place.get('user_ratings_total', 0)
    if   reviews >= 100: s += 20
    elif reviews >= 50:  s += 15
    elif reviews >= 20:  s += 10
    elif reviews >= 5:   s += 5
    return min(s, 100)


def score_reputation(place):
    """Score 0-100 based on rating and review volume."""
    s = 0
    rating  = place.get('rating', 0)
    reviews = place.get('user_ratings_total', 0)
    if   rating >= 4.8: s += 48
    elif rating >= 4.5: s += 40
    elif rating >= 4.0: s += 30
    elif rating >= 3.5: s += 18
    elif rating > 0:    s += 8
    if   reviews >= 200: s += 52
    elif reviews >= 100: s += 42
    elif reviews >= 50:  s += 30
    elif reviews >= 25:  s += 20
    elif reviews >= 10:  s += 12
    elif reviews >= 1:   s += 5
    return min(s, 100)


def score_website(place, pagespeed):
    """Score 0-100 based on PageSpeed mobile performance + SEO."""
    if not place.get('website'):
        return 0
    if not pagespeed or 'lighthouseResult' not in pagespeed:
        return 28  # Has website but couldn't scan
    try:
        cats  = pagespeed['lighthouseResult']['categories']
        perf  = int((cats.get('performance', {}).get('score') or 0) * 100)
        seo   = int((cats.get('seo',         {}).get('score') or 0) * 100)
        return min(int(perf * 0.65 + seo * 0.35), 100)
    except:
        return 28


def score_local_seo(place):
    """Score 0-100 based on signals that affect local search ranking."""
    s = 0
    if place.get('website'):                       s += 25
    if place.get('formatted_phone_number'):        s += 15
    if place.get('opening_hours'):                 s += 20
    if len(place.get('photos', [])) >= 5:          s += 20
    if place.get('user_ratings_total', 0) >= 50:   s += 20
    return min(s, 100)


def score_lead_capture(place):
    """Score 0-100 based on ability to capture leads from profile."""
    s = 0
    if place.get('website'):                       s += 45
    if place.get('formatted_phone_number'):        s += 35
    if place.get('opening_hours'):                 s += 20
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
    'A':  'Excellent — your online presence is firing on all cylinders.',
    'B':  'Solid foundation. A few tweaks away from dominating your market.',
    'C+': "You're average — and average means competitors are winning.",
    'C':  "Significant gaps. You're losing leads you don't even know about.",
    'D+': 'Your online presence is actively working against you.',
    'D':  "Customers can't find you or trust what they see online.",
    'F':  'Critical — your business is essentially invisible online.'
}


# ─────────────────────────────────────────────────────────────────
#  REPORT BUILDER
# ─────────────────────────────────────────────────────────────────

def build_report(place, pagespeed, competitors, place_id):
    name     = place.get('name', '')
    rating   = place.get('rating', 0)
    reviews  = place.get('user_ratings_total', 0)
    website  = place.get('website', '')
    phone    = place.get('formatted_phone_number', '')
    photos   = len(place.get('photos', []))
    has_hrs  = bool(place.get('opening_hours'))
    address  = place.get('formatted_address', '')

    # Scores
    gp  = score_google_presence(place)
    rep = score_reputation(place)
    ws  = score_website(place, pagespeed)
    seo = score_local_seo(place)
    lc  = score_lead_capture(place)

    overall = int(gp * 0.22 + rep * 0.28 + ws * 0.22 + seo * 0.18 + lc * 0.10)
    grade   = letter_grade(overall)

    # PageSpeed detail metrics
    lcp = fcp = tbt = ''
    if pagespeed and 'lighthouseResult' in pagespeed:
        audits = pagespeed['lighthouseResult'].get('audits', {})
        lcp = audits.get('largest-contentful-paint', {}).get('displayValue', '')
        fcp = audits.get('first-contentful-paint',   {}).get('displayValue', '')
        tbt = audits.get('total-blocking-time',       {}).get('displayValue', '')

    # Issues
    issues = []

    if not website:
        issues.append({
            'severity': 'critical', 'category': 'Website', 'icon': '🌐',
            'title': 'No website linked to your Google profile',
            'detail': '70% of consumers visit a website before choosing a business. You have no digital home base.',
            'fix': 'JRZ can launch a high-converting landing page for you in 48 hours.'
        })
    elif ws < 50:
        speed_str = f'loading in {lcp}' if lcp else 'extremely slow on mobile'
        issues.append({
            'severity': 'critical', 'category': 'Website', 'icon': '⚡',
            'title': f'Your website is {speed_str}',
            'detail': '53% of mobile visitors abandon a page that takes over 3 seconds to load. Google also penalizes slow sites in local rankings.',
            'fix': 'Compress images, enable caching, upgrade hosting. JRZ fixes this in 24 hours.'
        })
    elif ws < 70:
        issues.append({
            'severity': 'warning', 'category': 'Website', 'icon': '⚡',
            'title': 'Website performance needs improvement',
            'detail': f'Mobile speed score: {ws}/100. Competitors with faster sites rank above you.',
            'fix': 'A performance audit + optimization can push this to 85+.'
        })

    if reviews < 25:
        issues.append({
            'severity': 'critical', 'category': 'Reputation', 'icon': '⭐',
            'title': f'Only {reviews} Google reviews — dangerously low',
            'detail': 'Businesses with fewer than 25 reviews lose 68% of potential customers to competitors with more social proof.',
            'fix': 'JRZ sets up an AI-powered review request system. Clients average 30+ new reviews in 90 days.'
        })
    elif reviews < 75:
        issues.append({
            'severity': 'warning', 'category': 'Reputation', 'icon': '⭐',
            'title': f'{reviews} reviews — below the local authority threshold',
            'detail': 'In most markets, 100+ reviews is the benchmark for top-of-results placement.',
            'fix': 'Automate post-visit review requests via SMS. JRZ wires this into your CRM.'
        })

    if photos < 5:
        issues.append({
            'severity': 'critical', 'category': 'Google Profile', 'icon': '📸',
            'title': f'Only {photos} photos on your Google profile',
            'detail': 'Businesses with 10+ photos get 35% more website clicks and 42% more direction requests.',
            'fix': 'Upload 10 quality photos today — exterior, interior, team, products. Free to do yourself.'
        })
    elif photos < 10:
        issues.append({
            'severity': 'warning', 'category': 'Google Profile', 'icon': '📸',
            'title': f'{photos} photos — below the optimal threshold',
            'detail': 'Google rewards complete profiles. 10+ photos is the benchmark for competitive visibility.',
            'fix': 'Add 5-6 more photos: new angles, seasonal shots, behind-the-scenes.'
        })

    if not has_hrs:
        issues.append({
            'severity': 'warning', 'category': 'Google Profile', 'icon': '🕐',
            'title': 'Business hours not set on Google',
            'detail': 'Missing hours causes Google to display "hours unknown" — a major trust failure that drives customers away.',
            'fix': 'Add hours in Google Business Profile. Takes 3 minutes.'
        })

    if not phone:
        issues.append({
            'severity': 'warning', 'category': 'Lead Capture', 'icon': '📞',
            'title': 'No phone number on your Google profile',
            'detail': 'Phone is the #1 way local customers make first contact. Missing it hands those leads to competitors.',
            'fix': 'Add your phone number to Google Business Profile immediately.'
        })

    # Competitor data + insight
    comp_list = [
        {'name': c.get('name',''), 'rating': c.get('rating', 0),
         'reviews': c.get('user_ratings_total', 0), 'address': c.get('vicinity','')}
        for c in competitors
    ]

    comp_insight = None
    if comp_list:
        active = [c for c in comp_list if c['rating']]
        if active:
            avg_rev = sum(c['reviews'] for c in active) / len(active)
            avg_rat = sum(c['rating']  for c in active) / len(active)
            if avg_rev > reviews * 1.4:
                comp_insight = (f"Your top competitors average {int(avg_rev)} reviews — "
                                f"you have {reviews}. That gap is costing you clicks every day.")
            elif avg_rat > rating + 0.15:
                comp_insight = (f"Competitors average {avg_rat:.1f}★ vs. your {rating}★. "
                                f"In local search, a 0.2-star gap shifts 20% of clicks to them.")

    # Free tip (highest-impact quick win)
    if photos < 10:
        free_tip = {
            'action': ('Go to business.google.com → Info → Photos → Add Photos. '
                       'Upload 6 images: exterior, interior, team, and your best product or dish. '
                       'Takes 15 minutes. Free.'),
            'impact': '35% average lift in profile clicks within 30 days.'
        }
    elif reviews < 25:
        free_tip = {
            'action': ('Text your last 10 customers: "Hey [Name] — would you mind leaving '
                       'us a quick Google review? Here\'s the link: [GMB link]. Takes 60 '
                       'seconds and means the world to us."'),
            'impact': 'A single request campaign averages 4-6 new reviews within 48 hours.'
        }
    else:
        free_tip = {
            'action': ('Reply to your 5 most recent Google reviews right now — '
                       'both positive and negative. Include your business name and city '
                       'naturally in each reply.'),
            'impact': 'Review responses signal activity to Google and can lift local ranking within 2 weeks.'
        }

    return {
        'place_id': place_id,
        'business': {
            'name': name, 'address': address, 'rating': rating,
            'reviews': reviews, 'website': website, 'phone': phone,
            'photos': photos, 'has_hours': has_hrs
        },
        'scores': {
            'overall': overall, 'grade': grade,
            'grade_message': GRADE_MESSAGES.get(grade, ''),
            'google_presence': gp, 'reputation': rep,
            'website': ws, 'local_seo': seo, 'lead_capture': lc
        },
        'pagespeed_detail': {'lcp': lcp, 'fcp': fcp, 'tbt': tbt},
        'issues': issues,
        'competitors': comp_list,
        'competitor_insight': comp_insight,
        'free_tip': free_tip
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
        'tags':             [f"grade:{s['grade']}", 'grader-lead', 'needs-followup']
    }, timeout=5)


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=False)
