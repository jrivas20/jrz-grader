import os
import re
import time
import json
import hashlib
import datetime
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
FB_TOKEN      = os.environ.get('FB_ACCESS_TOKEN', '')
FB_APP_ID     = os.environ.get('FB_APP_ID', '')        # Public — used in OAuth popup URL

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


@app.route('/api/config')
def config():
    """Public config — non-sensitive values the frontend needs (App IDs, feature flags)."""
    return jsonify({
        'fb_app_id':     FB_APP_ID,
        'oauth_enabled': bool(FB_APP_ID),
        'base_url':      request.host_url.rstrip('/')
    })


@app.route('/oauth-callback')
def oauth_callback():
    """
    OAuth redirect landing page for the Meta popup flow.
    Facebook sends the user here after auth. The hash fragment (#access_token=...)
    is read by JS and posted to the parent window, then the popup closes itself.
    """
    return '''<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Connecting...</title></head>
<body style="background:#0a0a0a;color:#fff;font-family:sans-serif;
             display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
<script>
  try {
    var hash = window.location.hash.slice(1);
    var params = {};
    hash.split('&').forEach(function(p){
      var kv = p.split('=');
      params[kv[0]] = decodeURIComponent(kv[1] || '');
    });
    if (params.access_token && window.opener) {
      window.opener.postMessage({ type: 'meta_token', token: params.access_token }, '*');
    } else if (params.error && window.opener) {
      window.opener.postMessage({ type: 'meta_error', error: params.error_description || params.error }, '*');
    }
  } catch(e) {}
  setTimeout(function(){ window.close(); }, 800);
</script>
<div style="text-align:center">
  <div style="font-size:24px;margin-bottom:8px">Connecting...</div>
  <div style="font-size:13px;opacity:.5">This window will close automatically.</div>
</div>
</body></html>'''


def analyze_ig_competitive(ig_profile, media_list, competitors=None):
    """
    Deep Instagram competitive analysis from Graph API data.
    Returns posting frequency, engagement rate, content breakdown,
    bio quality score, gap analysis, and action plan.
    """
    followers = ig_profile.get('followers_count', 0) or 0

    # ── Posting frequency ─────────────────────────────────────────────
    posts_per_week = 0.0
    if len(media_list) >= 2:
        try:
            timestamps = []
            for m in media_list:
                ts_str = m.get('timestamp', '')
                if ts_str:
                    ts = datetime.datetime.fromisoformat(ts_str.replace('Z', '+00:00'))
                    timestamps.append(ts)
            if len(timestamps) >= 2:
                timestamps.sort(reverse=True)
                days_span = max((timestamps[0] - timestamps[-1]).days, 1)
                posts_per_week = round(len(timestamps) / (days_span / 7), 1)
        except Exception:
            pass

    # ── Content type breakdown ────────────────────────────────────────
    types          = [m.get('media_type', 'IMAGE') for m in media_list]
    reel_count     = types.count('VIDEO')          # Reels come back as VIDEO
    photo_count    = types.count('IMAGE')
    carousel_count = types.count('CAROUSEL_ALBUM')
    total_typed    = len(types) or 1
    reel_pct       = round((reel_count / total_typed) * 100)

    # Last post date
    last_post_days = None
    if media_list:
        try:
            ts_str = media_list[0].get('timestamp', '')
            if ts_str:
                ts = datetime.datetime.fromisoformat(ts_str.replace('Z', '+00:00'))
                now = datetime.datetime.now(datetime.timezone.utc)
                last_post_days = (now - ts).days
        except Exception:
            pass

    # ── Engagement metrics ────────────────────────────────────────────
    total_likes    = sum((m.get('like_count')    or 0) for m in media_list)
    total_comments = sum((m.get('comments_count') or 0) for m in media_list)
    n           = len(media_list) or 1
    avg_likes   = round(total_likes / n, 1)
    avg_comments = round(total_comments / n, 1)
    eng_rate    = round(((avg_likes + avg_comments) / followers) * 100, 2) if followers > 0 else 0

    # ── Best performing post ──────────────────────────────────────────
    best_post = None
    if media_list:
        best_post = max(
            media_list,
            key=lambda m: (m.get('like_count') or 0) + (m.get('comments_count') or 0)
        )

    # ── Bio quality analysis ──────────────────────────────────────────
    bio       = ig_profile.get('biography', '') or ''
    bio_lower = bio.lower()

    BOOKING_KW = ['book', 'calendly', 'vagaro', 'booksy', 'schedule', 'appointment',
                  'dm to book', 'link in bio', 'linktree', 'contact', 'inquiry',
                  'commission', 'available', 'slots', 'dms open']
    CITY_KW    = ['miami', 'orlando', 'kissimmee', 'florida', ' fl ', 'new york', ' ny ',
                  'chicago', 'houston', 'dallas', 'atlanta', 'denver', 'phoenix', ' la ',
                  'los angeles', 'austin', 'nashville', 'charlotte', 'tampa', 'jacksonville',
                  'las vegas', 'seattle', 'boston', 'san diego', 'san francisco']
    STYLE_KW   = ['realism', 'realistic', 'traditional', 'neo-trad', 'blackwork',
                  'fine line', 'fineline', 'japanese', 'geometric', 'watercolor',
                  'custom', 'portrait', 'color', 'black and grey', 'black & grey',
                  'chicano', 'tribal', 'illustrative', 'dotwork', 'minimalist', 'new school']

    bio_has_booking = any(kw in bio_lower for kw in BOOKING_KW)
    bio_has_city    = any(kw in bio_lower for kw in CITY_KW)
    bio_has_style   = any(kw in bio_lower for kw in STYLE_KW)
    bio_has_link    = bool(ig_profile.get('website', ''))
    bio_score       = (bio_has_booking * 35 + bio_has_link * 25 +
                       bio_has_city * 20 + bio_has_style * 20)

    # ── Gap analysis ──────────────────────────────────────────────────
    gaps = []

    if posts_per_week < 3:
        gaps.append({
            'category': 'Post Frequency',
            'artist_val': f'{posts_per_week}×/week',
            'benchmark':  '5–7×/week',
            'impact':     'critical',
            'action': (
                f'You\'re posting {posts_per_week}×/week — below the minimum for algorithm growth. '
                'Top booked artists post 5–7×/week. Batch-shoot this weekend: film 5 process Reels '
                '(15–30 sec each) and schedule them Mon–Fri. Consistency beats perfection.'
            )
        })
    elif posts_per_week < 5:
        gaps.append({
            'category': 'Post Frequency',
            'artist_val': f'{posts_per_week}×/week',
            'benchmark':  '5–7×/week',
            'impact':     'warning',
            'action': (
                f'Posting {posts_per_week}×/week is a start but below the top-artist benchmark. '
                'Add 2 more posts per week — prioritize Reels and before/after carousels.'
            )
        })

    if reel_pct < 40:
        gaps.append({
            'category': 'Reel Volume',
            'artist_val': f'{reel_pct}% of posts',
            'benchmark':  '60%+ Reels',
            'impact':     'critical',
            'action': (
                'Instagram sends Reels to non-followers — photos only reach people who already follow you. '
                'A 20-second tattoo process video reaches 5–10× more new clients than a photo. '
                'Start with one Reel per session: needle in, outline, shading, final reveal.'
            )
        })
    elif reel_pct < 60:
        gaps.append({
            'category': 'Reel Volume',
            'artist_val': f'{reel_pct}% of posts',
            'benchmark':  '60%+ Reels',
            'impact':     'warning',
            'action': (
                f'{reel_pct}% Reels is close — push past 60% and reach will increase within 2 weeks. '
                'Film before/after reveals as Reels, not just photo posts.'
            )
        })

    if eng_rate < 1.5 and followers > 300:
        gaps.append({
            'category': 'Engagement Rate',
            'artist_val': f'{eng_rate}%',
            'benchmark':  '2–5% (tattoo industry)',
            'impact':     'warning',
            'action': (
                f'Your {eng_rate}% engagement is below industry average (2–5%). '
                'Reply to every comment within the first hour of posting — this signals high activity '
                'to the algorithm. End captions with a question to drive responses.'
            )
        })

    if not bio_has_booking:
        gaps.append({
            'category': 'Booking Link in Bio',
            'artist_val': 'Missing',
            'benchmark':  '100% of top artists',
            'impact':     'critical',
            'action': (
                'Every visitor who can\'t find how to book you is a lost client. '
                'Add your booking link as the FIRST item in your bio right now — '
                'Calendly, Vagaro, Booksy, or Linktree. Test it on mobile to confirm it works.'
            )
        })

    if not bio_has_city:
        gaps.append({
            'category': 'City in Bio',
            'artist_val': 'Missing',
            'benchmark':  'Top artists include city',
            'impact':     'warning',
            'action': (
                'Local clients search Instagram by location. Add your city to your bio '
                '(e.g., "📍 Kissimmee, FL" or "Orlando-based tattoo artist"). '
                'This directly affects Instagram local search results.'
            )
        })

    if not bio_has_style:
        gaps.append({
            'category': 'Style in Bio',
            'artist_val': 'Missing',
            'benchmark':  'Top artists list specialty',
            'impact':     'warning',
            'action': (
                'Style-seeking clients search "fine line tattoo artist" or "realism tattoo Orlando." '
                'Add your specialty (e.g., "Fine Line Specialist" or "Realism & Black & Grey") '
                'to attract higher-value clients who specifically want your style.'
            )
        })

    # Recent posts (last 8) for display
    recent = []
    for m in media_list[:8]:
        ts_str = m.get('timestamp', '')
        ts_display = ''
        try:
            ts     = datetime.datetime.fromisoformat(ts_str.replace('Z', '+00:00'))
            days   = (datetime.datetime.now(datetime.timezone.utc) - ts).days
            ts_display = f'{days}d ago'
        except Exception:
            pass
        recent.append({
            'type':            m.get('media_type', 'IMAGE'),
            'likes':           m.get('like_count')    or 0,
            'comments':        m.get('comments_count') or 0,
            'link':            m.get('permalink', ''),
            'ts':              ts_display,
            'caption_preview': (m.get('caption') or '')[:80],
        })

    # ── Engagement per content type (Reel vs Photo vs Carousel) ──────────
    type_buckets = {}
    for m in media_list:
        mtype = m.get('media_type', 'IMAGE')
        label = 'Reels' if mtype == 'VIDEO' else ('Carousels' if mtype == 'CAROUSEL_ALBUM' else 'Photos')
        if label not in type_buckets:
            type_buckets[label] = {'likes': 0, 'comments': 0, 'count': 0}
        type_buckets[label]['likes']    += (m.get('like_count')    or 0)
        type_buckets[label]['comments'] += (m.get('comments_count') or 0)
        type_buckets[label]['count']    += 1

    type_engagement = {}
    total_posts_typed = len(media_list) or 1
    for label, stats in type_buckets.items():
        n = stats['count']
        if n > 0:
            type_engagement[label] = {
                'count':        n,
                'pct':          round(n / total_posts_typed * 100),
                'avg_likes':    round(stats['likes']    / n, 1),
                'avg_comments': round(stats['comments'] / n, 1),
                'avg_total':    round((stats['likes'] + stats['comments']) / n, 1),
            }

    # ── Best time to post (by day + hour from engagement data) ───────────
    DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
    day_eng  = {}
    hour_eng = {}
    for m in media_list:
        ts_str = m.get('timestamp', '')
        if not ts_str:
            continue
        eng = (m.get('like_count') or 0) + (m.get('comments_count') or 0)
        try:
            ts = datetime.datetime.fromisoformat(ts_str.replace('Z', '+00:00'))
            day_eng.setdefault(ts.weekday(), []).append(eng)
            hour_eng.setdefault(ts.hour, []).append(eng)
        except Exception:
            continue

    posting_patterns = {'has_data': False}
    if day_eng and len(media_list) >= 5:
        day_avgs  = {d: sum(v) / len(v) for d, v in day_eng.items()}
        best_days = sorted(day_avgs, key=lambda x: -day_avgs[x])[:2]
        hour_avgs = {h: sum(v) / len(v) for h, v in hour_eng.items()}
        best_hr   = max(hour_avgs, key=hour_avgs.get) if hour_avgs else None

        def _fmt_hr(h):
            if h is None: return ''
            ampm = 'am' if h < 12 else 'pm'
            return f'{h % 12 or 12}{ampm}'

        posting_patterns = {
            'has_data':        True,
            'best_days':       [DAYS[d] for d in best_days],
            'best_hour_start': _fmt_hr(best_hr),
            'best_hour_end':   _fmt_hr((best_hr + 2) % 24) if best_hr is not None else '',
            'all_day_avgs':    {DAYS[d]: round(avg, 1) for d, avg in day_avgs.items()},
            'posts_analyzed':  len(media_list),
        }

    # ── Posting consistency (gap analysis between posts) ─────────────────
    consistency = {'has_data': False}
    if len(media_list) >= 5:
        try:
            tss = []
            for m in media_list:
                s = m.get('timestamp', '')
                if s:
                    tss.append(datetime.datetime.fromisoformat(s.replace('Z', '+00:00')))
            tss.sort(reverse=True)
            if len(tss) >= 3:
                gaps_days = [(tss[i] - tss[i + 1]).days for i in range(len(tss) - 1)]
                avg_gap   = round(sum(gaps_days) / len(gaps_days), 1)
                max_gap   = max(gaps_days)
                std_gap   = round(_std(gaps_days), 1)
                cv        = std_gap / max(avg_gap, 1)
                score     = max(0, min(100, round(100 - cv * 60)))
                consistency = {
                    'has_data':         True,
                    'score':            score,
                    'avg_gap_days':     avg_gap,
                    'max_gap_days':     max_gap,
                    'longest_silence':  max_gap,
                    'label': (
                        'Consistent'       if score >= 70
                        else 'Inconsistent'     if score >= 40
                        else 'Very Inconsistent'
                    ),
                }
        except Exception:
            pass

    # ── Engagement quality (comment-to-like ratio) ────────────────────────
    comment_to_like = round(total_comments / max(total_likes, 1) * 100, 2)
    engagement_quality = {
        'comment_to_like_ratio': comment_to_like,
        'benchmark':             1.5,
        'label': (
            'Strong'  if comment_to_like >= 2.0
            else 'Average' if comment_to_like >= 1.0
            else 'Weak'
        ),
        'note': (
            'Your audience actively engages — tattoo clients trust artists they have a conversation with. Momentum is working in your favor.'
            if comment_to_like >= 2.0
            else 'Tattoo clients are visual lurkers — they save your work but don\'t always speak up. End captions with "Which style would you pick?" or "DM me your idea and I\'ll sketch it this week." Comments = trust = bookings.'
            if comment_to_like >= 1.0
            else 'Your posts are getting likes but no one\'s talking. Tattoo clients want to connect before they commit to a session. Ask about their idea, their story, their next piece — a comment is the first step toward a booking.'
        ),
    }

    return {
        'followers':        followers,
        'following':        ig_profile.get('follows_count', 0),
        'posts_total':      ig_profile.get('media_count', 0),
        'posts_per_week':   posts_per_week,
        'last_post_days':   last_post_days,
        'reel_count':       reel_count,
        'photo_count':      photo_count,
        'carousel_count':   carousel_count,
        'reel_pct':         reel_pct,
        'avg_likes':        avg_likes,
        'avg_comments':     avg_comments,
        'engagement_rate':  eng_rate,
        'bio':              bio,
        'bio_has_booking':  bio_has_booking,
        'bio_has_city':     bio_has_city,
        'bio_has_style':    bio_has_style,
        'bio_has_link':     bio_has_link,
        'bio_score':        bio_score,
        'best_post': {
            'type':    best_post.get('media_type', '') if best_post else '',
            'likes':   (best_post.get('like_count')    or 0) if best_post else 0,
            'comments':(best_post.get('comments_count') or 0) if best_post else 0,
            'link':    best_post.get('permalink', '')  if best_post else '',
            'caption_preview': (best_post.get('caption') or '')[:100] if best_post else '',
        } if best_post else None,
        'gaps':               gaps,
        'recent_posts':       recent,
        'competitors':        competitors or [],
        'type_engagement':    type_engagement,
        'posting_patterns':   posting_patterns,
        'consistency':        consistency,
        'engagement_quality': engagement_quality,
        # nested dicts for frontend compatibility
        'posting_frequency': {
            'posts_per_week': posts_per_week,
            'benchmark':      5.0,
            'gap_pct':        round((5.0 - posts_per_week) / 5.0 * 100) if posts_per_week < 5 else 0,
        },
        'engagement': {
            'engagement_rate':       eng_rate,
            'benchmark_engagement':  3.0,
            'avg_likes':             avg_likes,
            'avg_comments':          avg_comments,
        },
        'content_breakdown': {
            'reels_pct':    reel_pct,
            'photo_pct':    round(photo_count    / total_typed * 100),
            'carousel_pct': round(carousel_count / total_typed * 100),
        },
        'bio_score': {
            'score': bio_score,
            'checks': [
                {'label': 'Booking link or CTA in bio',  'ok': bio_has_booking},
                {'label': 'City or location mentioned',   'ok': bio_has_city},
                {'label': 'Tattoo style mentioned',       'ok': bio_has_style},
                {'label': 'Website or link in bio',       'ok': bio_has_link},
            ],
        },
    }


@app.route('/api/enhance-tattoo', methods=['POST'])
def enhance_tattoo():
    """
    Accepts a short-lived user access token from the artist's Meta OAuth.
    Returns real Instagram data + full competitive analysis.
    Token is NEVER stored. Read-only. Used in-session only.
    Required scope: instagram_basic, pages_show_list, pages_read_engagement
    """
    data = request.get_json(silent=True) or {}
    user_token  = (data.get('token') or '').strip()
    competitors = data.get('competitors', [])   # competitor list from report data
    if not user_token:
        return jsonify({'error': 'No token provided'}), 400

    enhanced = {
        'source':        'live',
        'instagram':     None,
        'facebook':      None,
        'ig_competitive': None,
    }

    try:
        # Step 1: Facebook Pages → find linked IG Business Account
        pages_resp = requests.get(
            'https://graph.facebook.com/v19.0/me/accounts',
            params={
                'access_token': user_token,
                'fields': 'id,name,fan_count,followers_count,instagram_business_account'
            },
            timeout=8
        )
        pages = pages_resp.json().get('data', [])

        ig_id = None
        for page in pages:
            ig_acct = page.get('instagram_business_account', {})
            if ig_acct and ig_acct.get('id'):
                ig_id = ig_acct['id']
                enhanced['facebook'] = {
                    'page_name': page.get('name', ''),
                    'fans':      page.get('fan_count'),
                    'followers': page.get('followers_count'),
                    'source':    'live'
                }
                break

        # Step 2: IG Business Account profile + 25 recent posts
        if ig_id:
            ig_resp = requests.get(
                f'https://graph.facebook.com/v19.0/{ig_id}',
                params={
                    'access_token': user_token,
                    'fields': (
                        'id,username,name,biography,website,profile_picture_url,'
                        'followers_count,follows_count,media_count'
                    )
                },
                timeout=8
            )
            ig_info = ig_resp.json()

            # Step 3: Get last 25 posts with full engagement + type data
            media_resp = requests.get(
                f'https://graph.facebook.com/v19.0/{ig_id}/media',
                params={
                    'access_token': user_token,
                    'fields': 'id,timestamp,media_type,like_count,comments_count,permalink,caption',
                    'limit': 25
                },
                timeout=8
            )
            media_list = media_resp.json().get('data', [])

            # Step 4: Run deep competitive analysis
            ig_competitive = analyze_ig_competitive(ig_info, media_list, competitors)

            # Basic backwards-compatible instagram block
            enhanced['instagram'] = {
                'username':       ig_info.get('username', ''),
                'followers':      ig_info.get('followers_count'),
                'following':      ig_info.get('follows_count'),
                'media_count':    ig_info.get('media_count'),
                'bio':            ig_info.get('biography', ''),
                'website':        ig_info.get('website', ''),
                'last_post_days': ig_competitive.get('last_post_days'),
                'avg_likes':      ig_competitive.get('avg_likes'),
                'avg_comments':   ig_competitive.get('avg_comments'),
                'source':         'live'
            }
            enhanced['ig_competitive'] = ig_competitive

        if not enhanced['instagram'] and not enhanced['facebook']:
            return jsonify({'error': 'No connected Instagram Business Account found. Make sure your IG is linked to a Facebook Page.'}), 404

        return jsonify(enhanced)

    except Exception as e:
        return jsonify({'error': f'Enhancement failed: {str(e)}'}), 502


@app.route('/api/autocomplete')
def autocomplete():
    query = request.args.get('input', '').strip()
    if len(query) < 2:
        return jsonify({'predictions': []})
    try:
        resp = requests.get(
            'https://maps.googleapis.com/maps/api/place/autocomplete/json',
            params={
                'input': query,
                'types': 'establishment',
                'keyword': 'restaurant food cafe bar',
                'key': GOOGLE_KEY
            },
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

    # ── RESTAURANT-ONLY GATE ─────────────────────────────────────────
    # This tool is exclusively for restaurants and food businesses.
    # If the business has no food-related Google type, reject it early.
    raw_types_check = place.get('types', [])
    if not any(t in FOOD_TYPES for t in raw_types_check):
        return jsonify({
            'error': 'not_restaurant',
            'message': (
                f"{place.get('name', 'This business')} does not appear to be a "
                "restaurant or food business. This audit tool is built exclusively "
                "for restaurants, cafes, bars, and food establishments with a "
                "physical location."
            )
        }), 422

    # 2. Nearby Competitors
    competitors = []
    loc       = place.get('geometry', {}).get('location', {})
    raw_types = raw_types_check
    biz_type  = get_best_type(raw_types)
    type_label = infer_type_label(biz_type, place.get('name', ''))

    # Use the most specific search type available
    search_type = biz_type if biz_type != 'establishment' else 'restaurant'
    # For broad types, fall back to restaurant for food businesses
    if search_type in ('food', 'meal_delivery', 'meal_takeaway'):
        search_type = 'restaurant'
    # Safety net: if Google assigned a non-food type as primary but the
    # business also has food types in its raw_types, force restaurant
    if search_type in NON_FOOD_EXCLUDE and any(t in FOOD_TYPES for t in raw_types):
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

    # 8. Social Presence (Facebook Graph API)
    social_data = {}
    if FB_TOKEN and site_data.get('scraped'):
        fb_url = site_data.get('social_urls', {}).get('Facebook', '')
        try:
            social_data = check_social_presence(fb_url)
        except Exception:
            social_data = {}

    # 9. Build Report
    report = build_report(place, pagespeed, site_data, competitors, keyword_rankings,
                          place_id, type_label, backlink_data,
                          review_intel, gbp_description, map_pack_data, social_data)

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
#  SOCIAL PRESENCE  (Facebook Graph API)
# ─────────────────────────────────────────────────────────────────

def extract_fb_page_id(fb_url):
    """Extract Facebook page ID or username from a profile URL."""
    if not fb_url:
        return ''
    try:
        from urllib.parse import urlparse, parse_qs
        parsed = urlparse(fb_url)
        path   = parsed.path.strip('/')
        # facebook.com/profile.php?id=123456
        if 'profile.php' in path:
            return parse_qs(parsed.query).get('id', [''])[0]
        parts = [p for p in path.split('/') if p]
        # facebook.com/pages/Name/123456
        if 'pages' in parts:
            idx = parts.index('pages')
            if len(parts) > idx + 2:
                return parts[idx + 2]
        # facebook.com/username
        skip = {'home', 'groups', 'events', 'marketplace', 'watch', 'gaming'}
        if parts and parts[0] not in skip:
            return parts[0]
    except Exception:
        pass
    return ''


def check_social_presence(fb_url=''):
    """
    Pull public Facebook Page metrics + connected Instagram Business Account.
    Public fields (fan_count, followers_count) work for any page.
    Posts + Instagram data work when the token has page management access.
    """
    empty = {
        'facebook_followers': None, 'facebook_fans': None,
        'facebook_page_name': None, 'facebook_last_post_days': None,
        'facebook_posts_sampled': 0,
        'instagram_followers': None, 'instagram_media_count': None,
        'instagram_username': None, 'instagram_last_post_days': None,
    }
    if not FB_TOKEN or not fb_url:
        return empty

    page_id = extract_fb_page_id(fb_url)
    if not page_id:
        return empty

    result = dict(empty)
    try:
        resp = requests.get(
            f'https://graph.facebook.com/v19.0/{page_id}',
            params={
                'fields': ('fan_count,followers_count,name,'
                           'posts.limit(5){created_time},'
                           'instagram_business_account'),
                'access_token': FB_TOKEN
            },
            timeout=10
        )
        data = resp.json()

        if 'error' in data:
            return result

        result['facebook_fans']      = data.get('fan_count', 0)
        result['facebook_followers'] = data.get('followers_count', 0)
        result['facebook_page_name'] = data.get('name', '')

        # Post recency — requires page management or public content access
        posts = data.get('posts', {}).get('data', [])
        result['facebook_posts_sampled'] = len(posts)
        if posts:
            now = time.time()
            timestamps = []
            for post in posts:
                ct = post.get('created_time', '')
                if ct:
                    try:
                        ts = datetime.datetime.strptime(ct[:19], '%Y-%m-%dT%H:%M:%S').timestamp()
                        timestamps.append(ts)
                    except Exception:
                        pass
            if timestamps:
                result['facebook_last_post_days'] = int((now - max(timestamps)) / 86400)

        # Instagram Business Account — requires page admin access
        ig_id = (data.get('instagram_business_account') or {}).get('id')
        if ig_id:
            ig_resp = requests.get(
                f'https://graph.facebook.com/v19.0/{ig_id}',
                params={
                    'fields': 'followers_count,media_count,username,media.limit(3){timestamp}',
                    'access_token': FB_TOKEN
                },
                timeout=10
            )
            ig = ig_resp.json()
            if 'followers_count' in ig:
                result['instagram_followers']   = ig.get('followers_count', 0)
                result['instagram_media_count'] = ig.get('media_count', 0)
                result['instagram_username']    = ig.get('username', '')
                media = ig.get('media', {}).get('data', [])
                if media:
                    try:
                        ts = datetime.datetime.strptime(
                            media[0].get('timestamp', '')[:19],
                            '%Y-%m-%dT%H:%M:%S'
                        ).timestamp()
                        result['instagram_last_post_days'] = int((time.time() - ts) / 86400)
                    except Exception:
                        pass

    except Exception:
        pass

    return result


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
    # 1. Prefer cuisine-specific types first (most precise)
    for t in raw_types:
        if t in CUISINE_TYPES:
            return t
    # 2. Prefer general food/dining types before any non-food type
    #    Prevents liquor_store, grocery_or_supermarket, etc. from winning
    #    when the business also has 'restaurant' or 'bar' in its types.
    for t in raw_types:
        if t in FOOD_TYPES and t not in skip:
            return t
    # 3. Then any non-generic type
    for t in raw_types:
        if t not in skip:
            return t
    return 'establishment'


def infer_type_label(biz_type, biz_name=''):
    """Convert a Google Place type to the best human-readable label,
    using business name as fallback for generic types.
    Also overrides NON_FOOD_EXCLUDE types (e.g., liquor_store) when the
    business name clearly signals a food/dining establishment."""
    label = TYPE_LABELS.get(biz_type, biz_type.replace('_', ' '))

    # Infer from name when: label is generic OR type is a non-food type
    # that likely got assigned alongside restaurant/bar (e.g., liquor_store).
    generic_labels = {'restaurant', 'food', 'establishment', 'meal takeaway', 'meal delivery'}
    if label in generic_labels or biz_type in NON_FOOD_EXCLUDE:
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
        'social_links': [], 'social_urls': {}, 'has_contact_form': False, 'has_schema': False,
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
        found_social_urls = {}
        found_directory = {}
        found_delivery  = {}

        for a in soup.find_all('a', href=True):
            href = a.get('href', '')
            for domain, label in social_map.items():
                if domain in href and label not in found_social_urls:
                    found_social[label]     = True
                    found_social_urls[label] = href
            for domain, label in directory_map.items():
                if domain in href:
                    found_directory[label] = True
            for domain, label in delivery_map.items():
                if domain in href:
                    found_delivery[label] = True

        r['social_links']    = list(found_social.keys())
        r['social_urls']     = found_social_urls
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
    # Always use cuisine-specific + generic restaurant keywords.
    # type_label is the specific cuisine (e.g. "Latin restaurant", "sushi restaurant").
    # We also always include a generic "restaurant in [city]" as baseline.
    cuisine_kw = type_label if type_label != 'restaurant' else None
    keywords = [
        f"best restaurant in {city}",
        f"restaurant {city}",
    ]
    if cuisine_kw:
        keywords += [
            f"best {cuisine_kw} in {city}",
            f"{cuisine_kw} {city}",
        ]
    keywords.append(f"{biz_name} {city}")
    # Keep to 5 max
    keywords = keywords[:5]
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

    cats     = pagespeed['lighthouseResult']['categories']
    perf     = int((cats.get('performance', {}).get('score') or 0) * 100)
    raw_seo  = cats.get('seo', {}).get('score')          # None when Lighthouse scan failed
    seo      = int(raw_seo * 100) if raw_seo is not None else None

    items.append({'label': f'Mobile performance score: {perf}/100', 'pass': perf >= 70})
    if seo is not None:
        items.append({'label': f'SEO technical score: {seo}/100', 'pass': seo >= 80})
    else:
        # Lighthouse returned null — page was likely blocked by Cloudflare / bot protection
        # or the scan timed out. Not a true 0 — don't penalize.
        items.append({'label': 'SEO technical score: scan blocked (Cloudflare / bot protection)', 'pass': None})

    checklist['website'] = items

    # Combined score: PageSpeed 50% + content quality 50%
    seo_val = seo if seo is not None else 0
    if site_data.get('scraped'):
        if seo is not None:
            return min(int(perf * 0.35 + seo_val * 0.15 + scraped_pts * 0.50), 100)
        else:
            # SEO scan unavailable — don't penalize, shift weight to perf + content
            return min(int(perf * 0.45 + scraped_pts * 0.55), 100)
    if seo is not None:
        return min(int(perf * 0.65 + seo_val * 0.35), 100)
    return min(perf, 100)


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

    if 'facebook' in title and ('follower' in title or 'not posted' in title):
        return {
            'fix':      ('JRZ takes over your Facebook Page management — optimized About section, '
                         'consistent branded content (3 to 4 posts per week), local hashtags, '
                         'and a 90-day follower growth campaign targeting your city and demographic. '
                         'All content created, scheduled, and published by our team.'),
            'timeline': '5 to 7 business days to launch full calendar',
            'result':   ('Pages with consistent posting average 4x more organic reach. '
                         'Follower growth campaigns targeting local audiences typically add '
                         '200 to 500 qualified local followers within 90 days.'),
            'service':  'Social Media Management'
        }

    if 'instagram' in title and ('follower' in title or 'not posted' in title):
        return {
            'fix':      ('JRZ manages your Instagram presence end-to-end: optimized bio with '
                         'local keyword targeting, geo-tagged content, 3 to 5 branded posts per '
                         'week, Story campaigns, and Reels creation. All content is aligned with '
                         'your brand voice and service offerings.'),
            'timeline': '5 to 7 business days to launch full calendar',
            'result':   ('Consistent posting at 3 to 5 times per week generates 3x more profile '
                         'visits and 2x more direct inquiries. Local follower growth of '
                         '300 to 800 followers in 90 days for actively managed accounts.'),
            'service':  'Social Media Management'
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
                 review_intel=None, gbp_description='', map_pack_data=None,
                 social_data=None):
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
        raw_seo_ps   = cats.get('seo', {}).get('score')
        seo_score_ps = int(raw_seo_ps * 100) if raw_seo_ps is not None else None

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

    # Social Media Issues
    sd = social_data or {}
    fb_followers = sd.get('facebook_followers')
    ig_followers = sd.get('instagram_followers')
    fb_last_post = sd.get('facebook_last_post_days')
    ig_last_post = sd.get('instagram_last_post_days')

    if fb_followers is not None and fb_followers < 500:
        issues.append({
            'severity': 'warning', 'category': 'Social Media',
            'title':  f'Facebook Page has only {fb_followers:,} followers — below local authority threshold',
            'detail': ('A Facebook Page with fewer than 500 followers signals low community '
                       'trust and reduces the effectiveness of any paid ads you run. Facebook '
                       'uses page engagement as a quality signal that affects your ad costs '
                       'and organic reach — a weak page costs you more for every campaign.'),
            'fix':    'JRZ runs a targeted local follower growth campaign and optimizes your page profile to attract qualified local followers organically.'
        })
    if fb_last_post is not None and fb_last_post > 30:
        issues.append({
            'severity': 'warning', 'category': 'Social Media',
            'title':  f'Facebook Page has not posted in {fb_last_post} days',
            'detail': ('An inactive Facebook Page signals an inactive business to both '
                       'potential customers and the Facebook algorithm. Pages that post '
                       'consistently receive 4 to 6 times more organic reach than those '
                       'that go silent for weeks at a time.'),
            'fix':    'JRZ creates and schedules 12 posts per month — branded content, promos, reviews, and local relevance posts — fully managed, no effort from you.'
        })
    if ig_followers is not None and ig_followers < 1000:
        issues.append({
            'severity': 'warning', 'category': 'Social Media',
            'title':  f'Instagram has only {ig_followers:,} followers — limited local reach',
            'detail': ('For local businesses, 1,000 to 5,000 engaged local followers is the '
                       'threshold where Instagram becomes a meaningful lead channel. Below that, '
                       'the platform has minimal impact on walk-in traffic or direct inquiries.'),
            'fix':    'JRZ builds a local Instagram growth strategy: optimized bio, geo-tagged content, targeted hashtags, and engagement sequences to grow qualified followers.'
        })
    if ig_last_post is not None and ig_last_post > 21:
        issues.append({
            'severity': 'warning', 'category': 'Social Media',
            'title':  f'Instagram has not posted in {ig_last_post} days',
            'detail': ('The Instagram algorithm deprioritizes inactive accounts in local '
                       'discovery. Accounts that post 3 to 5 times per week receive 3x more '
                       'profile visits and 2x more DMs than accounts that post sporadically.'),
            'fix':    'JRZ takes over your Instagram content calendar — 3 to 5 posts per week, Stories, and Reels — fully branded and locally targeted.'
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
        'social_presence': {
            'facebook_followers':     sd.get('facebook_followers'),
            'facebook_fans':          sd.get('facebook_fans'),
            'facebook_page_name':     sd.get('facebook_page_name'),
            'facebook_last_post_days': sd.get('facebook_last_post_days'),
            'instagram_followers':    sd.get('instagram_followers'),
            'instagram_media_count':  sd.get('instagram_media_count'),
            'instagram_username':     sd.get('instagram_username'),
            'instagram_last_post_days': sd.get('instagram_last_post_days'),
            'social_links':           site_data.get('social_links', []),
        },
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


# ═══════════════════════════════════════════════════════════════════
#  JRZ INK SYSTEMS — TATTOO ARTIST AUDIT ENGINE
# ═══════════════════════════════════════════════════════════════════

TATTOO_NAME_KEYWORDS = {'tattoo', 'ink', 'piercing', 'tat '}

TATTOO_BOOKING_MAP = {
    'vagaro.com':           'Vagaro',
    'booksy.com':           'Booksy',
    'fresha.com':           'Fresha',
    'styleseat.com':        'StyleSeat',
    'squareup.com':         'Square',
    'square.site':          'Square',
    'inkbook.io':           'Ink Book',
    'tattoodo.com':         'Tattoodo',
    'setmore.com':          'Setmore',
    'calendly.com':         'Calendly',
    'acuityscheduling.com': 'Acuity',
    'schedulicity.com':     'Schedulicity',
    'gloss.as':             'Gloss',
}

TATTOO_STYLE_KEYWORDS = [
    'realism', 'realistic', 'traditional', 'neo-traditional', 'blackwork',
    'black and grey', 'black & grey', 'watercolor', 'japanese', 'geometric',
    'minimalist', 'fine line', 'tribal', 'chicano', 'portrait', 'custom',
    'flash', 'color', 'cover up', 'sleeve', 'dotwork', 'illustrative',
]

TATTOO_CITY_BENCHMARKS = {
    'new york':     {'avg_price': 350, 'high': 520, 'monthly_sessions': 60},
    'los angeles':  {'avg_price': 320, 'high': 490, 'monthly_sessions': 55},
    'miami':        {'avg_price': 280, 'high': 420, 'monthly_sessions': 48},
    'chicago':      {'avg_price': 260, 'high': 390, 'monthly_sessions': 44},
    'houston':      {'avg_price': 230, 'high': 345, 'monthly_sessions': 40},
    'dallas':       {'avg_price': 240, 'high': 360, 'monthly_sessions': 40},
    'atlanta':      {'avg_price': 250, 'high': 370, 'monthly_sessions': 42},
    'orlando':      {'avg_price': 220, 'high': 330, 'monthly_sessions': 38},
    'phoenix':      {'avg_price': 220, 'high': 330, 'monthly_sessions': 36},
    'denver':       {'avg_price': 260, 'high': 390, 'monthly_sessions': 38},
    'default':      {'avg_price': 200, 'high': 320, 'monthly_sessions': 32},
}

GHL_INK_WEBHOOK = os.environ.get(
    'GHL_INK_WEBHOOK',
    'https://services.leadconnectorhq.com/hooks/d7iUPfamAaPlSBNj6IhT/webhook-trigger/jrz-ink-grader'
)


def _detect_styles_from_bio(bio_text):
    """Detect tattoo styles mentioned in IG bio text (used by grade-ig-only)."""
    if not bio_text:
        return []
    bio_lower = bio_text.lower()
    return [s for s in TATTOO_STYLE_KEYWORDS if s in bio_lower][:6]


def _std(lst):
    """Population std-dev — no statistics module needed."""
    n = len(lst)
    if n < 2:
        return 0.0
    mean = sum(lst) / n
    return (sum((x - mean) ** 2 for x in lst) / n) ** 0.5


def analyze_hashtags(captions, city=''):
    """Extract and score hashtag strategy from post captions."""
    all_tags = []
    posts_with_tags = 0
    for caption in captions:
        if not caption:
            continue
        tags = re.findall(r'#(\w+)', caption.lower())
        if tags:
            posts_with_tags += 1
        all_tags.extend(tags)

    if not all_tags:
        return {'has_data': False}

    from collections import Counter
    tag_counts = Counter(all_tags)
    top_tags   = tag_counts.most_common(10)
    total_posts = max(len(captions), 1)

    MEGA_TAGS = {
        'tattoo', 'tattoos', 'ink', 'tattooed', 'tattooart', 'tattoolife',
        'inked', 'tattooartist', 'bodyart', 'art', 'inklife', 'tatt',
        'tatts', 'tattooer', 'tattooist', 'tatted', 'tattoolover',
    }
    broad_used = [t for t, _ in top_tags if t in MEGA_TAGS]
    niche_used = [t for t, _ in top_tags if t not in MEGA_TAGS]

    avg_per_post = round(len(all_tags) / total_posts, 1)
    city_lower   = city.lower().replace(' ', '') if city else ''
    has_city_tag = any(city_lower in t for t in all_tags) if city_lower else False

    issues = []
    if len(broad_used) >= 5:
        issues.append('Too many mega-tags (>500M posts each) — you disappear in the feed')
    if avg_per_post < 5:
        issues.append('Tattoo artists using 10–15 targeted hashtags get 3× more profile visits from potential clients — you\'re leaving discovery on the table')
    if avg_per_post > 25:
        issues.append('Pasting 30+ hashtags under every tattoo post signals desperation — cap at 15. Niche style tags (#finelinetattoo, #realismtattoo) outperform mega-tags every time')
    if not has_city_tag and city:
        issues.append(f'No {city}-specific hashtag — local tags are the fastest path to local clients')
    if not niche_used:
        issues.append('No niche style tags — add tags for your specific style (e.g. #finelinetattoo, #realisticink)')

    return {
        'has_data':       True,
        'top_tags':       [{'tag': '#' + t, 'count': c} for t, c in top_tags],
        'avg_per_post':   avg_per_post,
        'broad_count':    len(broad_used),
        'niche_count':    len(niche_used),
        'has_city_tag':   has_city_tag,
        'issues':         issues,
        'posts_analyzed': posts_with_tags,
    }


def _fetch_single_competitor(place, exclude_handle):
    """Fetch IG data for one competitor — runs in a thread."""
    comp = {
        'name':         place.get('name', 'Unknown'),
        'rating':       place.get('rating'),
        'reviews':      place.get('user_ratings_total'),
        'ig_handle':    None,
        'ig_followers': None,
        'address':      place.get('vicinity', ''),
    }
    place_id = place.get('place_id', '')
    website  = ''
    if place_id and GOOGLE_KEY:
        try:
            det     = requests.get(
                'https://maps.googleapis.com/maps/api/place/details/json',
                params={'place_id': place_id, 'fields': 'website', 'key': GOOGLE_KEY},
                timeout=3
            )
            website = det.json().get('result', {}).get('website', '') or ''
        except Exception:
            pass

    ig_handle = None
    if website:
        try:
            wr = requests.get(
                website, timeout=4,
                headers={'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'}
            )
            for m in re.finditer(r'instagram\.com/([^/?#"\'\s\\]+)', wr.text):
                candidate = m.group(1).strip('/')
                if candidate and candidate not in (
                    'explore', 'p', 'reel', 'reels', 'stories', 'tv', 'accounts', 'share'
                ):
                    ig_handle = candidate
                    break
        except Exception:
            pass

    if ig_handle and ig_handle.lower() != (exclude_handle or '').lower():
        comp['ig_handle'] = ig_handle
        try:
            ir = requests.get(
                'https://i.instagram.com/api/v1/users/web_profile_info/',
                params={'username': ig_handle},
                headers={
                    'X-IG-App-ID': '936619743392459',
                    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15',
                },
                timeout=4
            )
            if ir.status_code == 200:
                user = ir.json().get('data', {}).get('user', {})
                comp['ig_followers'] = user.get('edge_followed_by', {}).get('count')
        except Exception:
            pass

    return comp


def find_competitor_ig_data(city, exclude_handle=''):
    """Geocode city → Google Nearby → website scrape → public IG scrape (parallel)."""
    if not city or not GOOGLE_KEY:
        return []
    try:
        geo = requests.get(
            'https://maps.googleapis.com/maps/api/geocode/json',
            params={'address': city, 'key': GOOGLE_KEY},
            timeout=5
        ).json()
        loc = geo.get('results', [{}])[0].get('geometry', {}).get('location', {})
        if not loc:
            return []
        lat, lng = loc['lat'], loc['lng']
    except Exception:
        return []

    try:
        nearby = requests.get(
            'https://maps.googleapis.com/maps/api/place/nearbysearch/json',
            params={
                'location': f'{lat},{lng}',
                'radius':   10000,
                'type':     'tattoo_parlor',
                'key':      GOOGLE_KEY,
            },
            timeout=5
        ).json().get('results', [])[:4]
    except Exception:
        return []

    if not nearby:
        return []

    from concurrent.futures import ThreadPoolExecutor, as_completed
    results = []
    with ThreadPoolExecutor(max_workers=4) as ex:
        futures = {ex.submit(_fetch_single_competitor, p, exclude_handle): p for p in nearby}
        for fut in as_completed(futures, timeout=9):
            try:
                results.append(fut.result())
                if len(results) >= 3:
                    break
            except Exception:
                pass
    return results[:3]


def generate_content_calendar(posting_patterns, type_engagement, city, styles):
    """Build a personalised 4-week content calendar from this artist's performance data."""
    best_days = (posting_patterns.get('best_days') or ['Tuesday', 'Thursday'])[:2]
    best_time = posting_patterns.get('best_hour_start') or '7pm'

    best_type = 'Reel'
    if type_engagement:
        ranked = sorted(type_engagement.items(), key=lambda x: -x[1].get('avg_total', 0))
        if ranked:
            best_type = ranked[0][0]

    style_str = ', '.join(styles[:2]) if styles else 'custom tattoo'
    city_tag  = f' in {city}' if city else ''
    book_cta  = f'DM to book your {style_str} piece{city_tag}'

    week_themes = [
        [
            ('Process Reel',      'Reel',     'Needle in → outline → shading → finished piece. 15–20 sec. No music needed — the sound is the hook.'),
            ('Portfolio Carousel','Carousel',  '5 best recent pieces. First slide = most impressive. Caption: "Which is your favourite?"'),
        ],
        [
            ('Before/After Reveal','Reel',    'Cover-up or transformation. Split screen or swipe-reveal. These get shared the most.'),
            ('Style Showcase',    'Carousel',  f'Close-ups of your {style_str} work. Let the detail sell itself.'),
        ],
        [
            ('Behind the Scenes', 'Reel',     'Your setup, tools, prepping a stencil. Humanises you — clients book artists they trust.'),
            ('Healed Check-in',   'Carousel',  'Fresh vs. healed side by side. Proof of quality no other content delivers.'),
        ],
        [
            ('Client Reaction',   'Reel',     'First look reaction (with permission). Authentic emotion — algorithm loves it.'),
            ('Flash Drop',        'Carousel',  f'4–6 available designs with price. Creates urgency{city_tag}.'),
        ],
    ]

    weeks = []
    for i, (theme1, theme2) in enumerate(week_themes):
        posts = []
        for day, theme in zip(best_days, [theme1, theme2]):
            posts.append({
                'day':        day,
                'time':       best_time,
                'type':       theme[1],
                'title':      theme[0],
                'brief':      theme[2],
                'caption_cta': book_cta,
            })
        weeks.append({'week': i + 1, 'posts': posts})

    return {
        'weeks':     weeks,
        'best_days': best_days,
        'best_time': best_time,
        'best_type': best_type,
    }

# ── CITY AUDIT LOG ───────────────────────────────────────────────────
# In-memory city audit log. Accumulates real market data as artists
# run Guest City Audits. Resets on server restart — view at /api/city-insights.
# Over 50+ audits this data updates TATTOO_CITY_BENCHMARKS with live figures.
CITY_AUDIT_LOG = []   # [{city, state, artist_count, avg_reviews, avg_price, opp_score, ts}]


# ── ROUTES ───────────────────────────────────────────────────────────

@app.route('/api/autocomplete-tattoo')
def autocomplete_tattoo():
    query = request.args.get('input', '').strip()
    if len(query) < 2:
        return jsonify({'predictions': []})
    try:
        resp = requests.get(
            'https://maps.googleapis.com/maps/api/place/autocomplete/json',
            params={
                'input':   query + ' tattoo',
                'types':   'establishment',
                'key':     GOOGLE_KEY,
            },
            timeout=5
        )
        return jsonify(resp.json())
    except Exception as e:
        return jsonify({'predictions': [], 'error': str(e)})


@app.route('/api/find-tattoo-by-name')
def find_tattoo_by_name():
    """
    Multi-query text search for tattoo artists by Instagram handle OR real name.
    Tries 3 query variations and merges de-duped results so handles like 'tattoos.ap'
    still surface their Google listing even when the GMB name differs from the IG handle.
    Accepts: tattoo_parlor type, art_studio type (for private/freelance artists),
    or any result whose name/editorial mentions tattoo keywords.
    """
    name = request.args.get('name', '').strip()
    city = request.args.get('city', '').strip()
    if not name:
        return jsonify({'results': []})

    # Clean handle: replace dots/underscores/dashes with spaces for alternate search
    clean_name = re.sub(r'[._\-]', ' ', name).strip()

    # Build query list (ordered by specificity — most specific first)
    queries = []
    if city:
        queries.append(f'tattoo artist {name} {city}')
        if clean_name.lower() != name.lower():
            queries.append(f'{clean_name} tattoo {city}')
        queries.append(f'{name} tattoo {city}')
        queries.append(f'tattoo studio {city}')        # broad city fallback
    else:
        queries.append(f'tattoo artist {name}')
        if clean_name.lower() != name.lower():
            queries.append(f'{clean_name} tattoo')
        queries.append(f'{name} tattoo')

    TATTOO_KW = {'tattoo', 'ink', 'piercing', 'tattooing'}
    seen_ids  = set()
    filtered  = []

    for query in queries:
        if len(filtered) >= 6:
            break
        try:
            resp = requests.get(
                'https://maps.googleapis.com/maps/api/place/textsearch/json',
                params={'query': query, 'key': GOOGLE_KEY},
                timeout=8
            )
            raw = resp.json().get('results', [])
            for r in raw:
                pid = r.get('place_id', '')
                if not pid or pid in seen_ids:
                    continue
                types          = r.get('types', [])
                biz_name_lower = r.get('name', '').lower()
                editorial      = (r.get('editorial_summary') or {}).get('overview', '').lower()

                # Accept if any of these are true:
                is_tattoo = (
                    'tattoo_parlor' in types or
                    any(kw in biz_name_lower for kw in TATTOO_KW) or
                    any(kw in editorial for kw in TATTOO_KW) or
                    # Freelance/private artists often show as art_studio or point_of_interest
                    ('art_studio' in types and 'tattoo' in query.lower()) or
                    ('point_of_interest' in types and
                        any(kw in biz_name_lower for kw in TATTOO_KW))
                )
                if is_tattoo:
                    seen_ids.add(pid)
                    filtered.append({
                        'place_id': pid,
                        'name':     r.get('name', ''),
                        'address':  r.get('formatted_address', ''),
                        'rating':   r.get('rating', 0),
                        'reviews':  r.get('user_ratings_total', 0),
                    })
                    if len(filtered) >= 6:
                        break
        except Exception:
            pass

    return jsonify({'results': filtered})


def _grade_tattoo_internal(place_id):
    """
    Core tattoo audit logic — shared by /api/grade-tattoo and /api/grade-tattoo-by-ig.
    Returns (report_dict, None, None) on success,
    or (None, error_dict, http_status) on failure.
    """
    cache_key = hashlib.md5(('tattoo:' + place_id).encode()).hexdigest()
    if cache_key in CACHE and time.time() - CACHE[cache_key]['ts'] < 600:
        return CACHE[cache_key]['data'], None, None

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
        return None, {'error': f'Google Places error: {e}'}, 502

    if not place:
        return None, {'error': 'Business not found'}, 404

    # ── TATTOO-ONLY GATE ─────────────────────────────────────────────
    raw_types = place.get('types', [])
    biz_name_lower = place.get('name', '').lower()
    is_tattoo = (
        'tattoo_parlor' in raw_types or
        any(kw in biz_name_lower for kw in TATTOO_NAME_KEYWORDS)
    )
    if not is_tattoo:
        return None, {
            'error': 'not_tattoo',
            'message': (
                f"{place.get('name', 'This business')} does not appear to be a "
                "tattoo studio or artist. This audit is built exclusively for "
                "tattoo artists and private studios."
            )
        }, 422

    city, state = parse_city_state(place.get('formatted_address', ''))

    # 2. Competitors (nearby tattoo parlors)
    competitors = []
    loc = place.get('geometry', {}).get('location', {})
    if loc:
        try:
            nr = requests.get(
                'https://maps.googleapis.com/maps/api/place/nearbysearch/json',
                params={
                    'location': f"{loc['lat']},{loc['lng']}",
                    'radius':   8000,
                    'type':     'tattoo_parlor',
                    'keyword':  'tattoo',
                    'key':      GOOGLE_KEY,
                },
                timeout=8
            )
            nearby = nr.json().get('results', [])
            TATTOO_FILTER = {'tattoo', 'ink', 'piercing', 'tat '}
            competitors = [
                r for r in nearby
                if r.get('place_id') != place_id
                and r.get('business_status') == 'OPERATIONAL'
                and (
                    'tattoo_parlor' in r.get('types', []) or
                    any(kw in r.get('name', '').lower() for kw in TATTOO_FILTER)
                )
                # Hard exclude known non-tattoo categories
                and not any(xt in (r.get('types') or []) for xt in [
                    'lodging', 'hotel', 'restaurant', 'gas_station',
                    'grocery_or_supermarket', 'bank', 'hospital',
                ])
            ][:5]
        except Exception:
            competitors = []

    # 3. PageSpeed
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
        except Exception:
            pagespeed = {}

    # 4. Reviews
    raw_reviews  = place.get('reviews', []) or []
    review_intel = analyze_reviews(raw_reviews)
    gbp_desc     = (place.get('editorial_summary') or {}).get('overview', '')

    # 5. Website scrape
    site_data = {}
    if website:
        site_data = scrape_website(website, biz_name=place.get('name', ''), biz_city=city)

    # 6. Tattoo-specific extras
    tattoo_extras = scrape_tattoo_extras(website, site_data)

    # 7. Keyword rankings — tattoo specific
    keyword_rankings = []
    if DFS_LOGIN and DFS_PASSWORD and city:
        keyword_rankings = check_tattoo_rankings(place.get('name', ''), city, state)

    # 8. Backlinks
    backlink_data = {}
    if DFS_LOGIN and DFS_PASSWORD and website:
        try:
            backlink_data = check_backlinks(website)
        except Exception:
            backlink_data = {}

    # 9. Map Pack
    map_pack_data = []
    if DFS_LOGIN and DFS_PASSWORD and city:
        try:
            map_pack_data = check_map_pack(place.get('name', ''), 'tattoo artist', city, state)
        except Exception:
            map_pack_data = []

    # 2b. Enrich each competitor with Facebook page data
    if FB_TOKEN and competitors:
        for comp in competitors:
            try:
                fb_data = search_facebook_page(comp.get('name', ''), city)
                comp.update(fb_data)
            except Exception:
                pass

    # 10. Social
    social_data = {}
    if FB_TOKEN and site_data.get('scraped'):
        fb_url = site_data.get('social_urls', {}).get('Facebook', '')
        try:
            social_data = check_social_presence(fb_url)
        except Exception:
            social_data = {}

    # 11. Meta Ad Library — competitor ads (public, no artist auth needed)
    ad_library = []
    if FB_TOKEN and city:
        try:
            ad_library = check_ad_library(city, state)
        except Exception:
            ad_library = []

    # 12. Build report
    report = build_tattoo_report(
        place, pagespeed, site_data, tattoo_extras, competitors,
        keyword_rankings, place_id, backlink_data,
        review_intel, gbp_desc, map_pack_data, social_data, city, state,
        ad_library=ad_library
    )

    CACHE[cache_key] = {'ts': time.time(), 'data': report}

    try:
        fire_ghl_ink(report)
    except Exception:
        pass

    return report, None, None


@app.route('/api/grade-tattoo')
def grade_tattoo():
    place_id = request.args.get('place_id', '').strip()
    if not place_id:
        return jsonify({'error': 'place_id is required'}), 400
    report, err, status = _grade_tattoo_internal(place_id)
    if err:
        return jsonify(err), status
    return jsonify(report)


@app.route('/api/list-ig-pages', methods=['POST'])
def list_ig_pages():
    """
    Returns ALL Facebook Pages managed by this token (follows pagination cursors),
    each enriched with the connected Instagram Business Account info.
    Used by the IG-mode page selector in the frontend.
    """
    data  = request.get_json(silent=True) or {}
    token = (data.get('token') or '').strip()
    if not token:
        return jsonify({'error': 'No token provided'}), 400

    # Fetch ALL pages — follow paging.next until exhausted
    raw_pages = []
    next_url  = 'https://graph.facebook.com/v19.0/me/accounts'
    params    = {
        'access_token': token,
        'fields':       'id,name,fan_count,followers_count,instagram_business_account',
        'limit':        100   # max allowed per call
    }
    try:
        while next_url and len(raw_pages) < 500:   # safety cap at 500
            resp      = requests.get(next_url, params=params, timeout=10)
            body      = resp.json()
            batch     = body.get('data', [])
            raw_pages.extend(batch)
            # FB embeds params in the next URL, so clear params after first call
            next_url  = body.get('paging', {}).get('next')
            params    = {}
    except Exception as e:
        return jsonify({'error': f'Could not fetch pages: {e}'}), 502

    pages = []
    for page in raw_pages:
        ig_acct = page.get('instagram_business_account', {}) or {}
        ig_id   = ig_acct.get('id', '')

        ig_info = {}
        if ig_id:
            try:
                ig_r = requests.get(
                    f'https://graph.facebook.com/v19.0/{ig_id}',
                    params={
                        'access_token': token,
                        'fields': 'id,username,name,biography,followers_count,media_count,profile_picture_url'
                    },
                    timeout=6
                )
                ig_info = ig_r.json()
            except Exception:
                ig_info = {}

        pages.append({
            'page_id':      page.get('id', ''),
            'page_name':    page.get('name', ''),
            'page_fans':    page.get('fan_count'),
            'page_followers': page.get('followers_count'),
            'ig_id':        ig_id or None,
            'ig_username':  ig_info.get('username', ''),
            'ig_name':      ig_info.get('name', ''),
            'ig_followers': ig_info.get('followers_count'),
            'ig_bio':       ig_info.get('biography', ''),
        })

    if not pages:
        return jsonify({
            'error': 'no_pages',
            'message': (
                'No Facebook Pages found for this account. '
                'You need at least one Facebook Page to connect Instagram. '
                'Create a Facebook Page and link your Instagram account to it.'
            )
        }), 404

    # If none have IG connected, still return them all with a flag
    has_ig = any(p['ig_id'] for p in pages)
    return jsonify({
        'pages':  pages,
        'has_ig': has_ig
    })


@app.route('/api/grade-ig-only', methods=['POST'])
def grade_ig_only():
    """
    Pure Instagram analytics audit — zero Google data.
    Artist has authenticated via Meta OAuth and selected their FB Page.
    Returns deep IG metrics: posting frequency, engagement, content mix,
    bio quality score, gap analysis, and revenue opportunity from low post frequency.
    Personal IG accounts (not linked to a FB Page) cannot be reached by this API.
    """
    data    = request.get_json(silent=True) or {}
    token   = (data.get('token')   or '').strip()
    city    = (data.get('city')    or '').strip()
    handle  = (data.get('handle')  or '').strip().lstrip('@')
    page_id = (data.get('page_id') or '').strip()

    if not token:
        return jsonify({'error': 'No token provided'}), 400

    try:
        # ── Step 1: Resolve IG Business Account ──────────────────────
        pages_resp = requests.get(
            'https://graph.facebook.com/v19.0/me/accounts',
            params={
                'access_token': token,
                'fields': 'id,name,fan_count,followers_count,instagram_business_account'
            },
            timeout=8
        )
        pages = pages_resp.json().get('data', [])

        ig_id   = None
        fb_page = {}
        for page in pages:
            if page_id and page.get('id') != page_id:
                continue
            ig_acct = page.get('instagram_business_account', {})
            if ig_acct and ig_acct.get('id'):
                ig_id = ig_acct['id']
                fb_page = {
                    'page_name': page.get('name', ''),
                    'fans':      page.get('fan_count'),
                    'followers': page.get('followers_count'),
                }
                break

        if not ig_id:
            return jsonify({
                'error':   'no_ig_account',
                'message': 'No Instagram Business Account found on this page.'
            }), 404

        # ── Step 2: IG Profile ────────────────────────────────────────
        ig_resp = requests.get(
            f'https://graph.facebook.com/v19.0/{ig_id}',
            params={
                'access_token': token,
                'fields': (
                    'id,username,name,biography,website,'
                    'profile_picture_url,followers_count,follows_count,media_count'
                )
            },
            timeout=8
        )
        ig_info = ig_resp.json()

        # ── Step 3: Last 25 posts with full engagement data ───────────
        media_resp = requests.get(
            f'https://graph.facebook.com/v19.0/{ig_id}/media',
            params={
                'access_token': token,
                'fields': 'id,timestamp,media_type,like_count,comments_count,permalink,caption',
                'limit': 25
            },
            timeout=8
        )
        media_list = media_resp.json().get('data', [])

        # ── Step 4: Deep IG analysis ──────────────────────────────────
        ig_competitive = analyze_ig_competitive(ig_info, media_list, [])

        # ── Step 5: Revenue opportunity from posting frequency gap ────
        ig_username   = ig_info.get('username', '') or handle
        city_key      = city.lower().strip() if city else 'default'
        bench         = TATTOO_CITY_BENCHMARKS.get(city_key, TATTOO_CITY_BENCHMARKS['default'])
        avg_price     = bench['avg_price']

        posts_per_week       = ig_competitive.get('posts_per_week', 0)
        benchmark_ppw        = 5.0
        missing_ppw          = max(0.0, benchmark_ppw - posts_per_week)
        # Model: every 4 posts → ~1 booking inquiry → ~25% convert
        # So posts → sessions/month = posts_per_week * 0.25 * 4
        current_sessions_mo  = round(posts_per_week * 0.25 * 4, 1)
        optimal_sessions_mo  = round(benchmark_ppw  * 0.25 * 4, 1)
        missing_sessions_mo  = round(missing_ppw    * 0.25 * 4, 1)
        revenue_gap          = int(missing_sessions_mo * avg_price)
        current_revenue_est  = int(current_sessions_mo * avg_price)
        optimal_revenue_est  = int(optimal_sessions_mo * avg_price)

        # ── Step 6: Bio + hashtag analysis ───────────────────────────────
        ig_bio           = ig_info.get('biography', '') or ''
        detected_styles  = _detect_styles_from_bio(ig_bio)
        has_booking_link = bool(ig_info.get('website', ''))

        captions         = [m.get('caption', '') or '' for m in media_list]
        hashtag_analysis = analyze_hashtags(captions, city)

        fake_place = {
            'name':                   ig_info.get('name', '') or f'@{ig_username}',
            'website':                ig_info.get('website', ''),
            'formatted_phone_number': '',
            'rating': 0, 'user_ratings_total': 0,
        }
        fake_extras = {
            'detected_styles':    detected_styles,
            'has_tattoo_booking': has_booking_link,
            'booking_platform':   '',
        }
        bio_recs = generate_bio_recommendations(fake_place, {}, fake_extras, {}, city)

        # ── Step 7: TikTok gap ────────────────────────────────────────────
        bio_and_site = (ig_bio + ' ' + (ig_info.get('website', '') or '')).lower()
        tiktok_gap   = 'tiktok' not in bio_and_site

        # ── Step 8: Competitor IG lookup (non-blocking) ───────────────────
        competitor_ig = []
        if city:
            try:
                competitor_ig = find_competitor_ig_data(city, ig_username)
            except Exception:
                competitor_ig = []

        # ── Step 9: 30-day content calendar ──────────────────────────────
        content_calendar = generate_content_calendar(
            ig_competitive.get('posting_patterns', {}),
            ig_competitive.get('type_engagement', {}),
            city,
            detected_styles,
        )

        return jsonify({
            'ig_only':     True,
            'report_type': 'instagram',
            'ig_mode':     True,
            'username':    ig_username,
            'city':        city,
            'profile': {
                'username':    ig_username,
                'name':        ig_info.get('name', ''),
                'biography':   ig_info.get('biography', ''),
                'website':     ig_info.get('website', ''),
                'followers':   ig_info.get('followers_count', 0),
                'following':   ig_info.get('follows_count', 0),
                'media_count': ig_info.get('media_count', 0),
            },
            'facebook':        fb_page,
            'ig_competitive':  ig_competitive,
            'revenue_gap': {
                'posts_per_week':           round(posts_per_week, 1),
                'benchmark_posts_per_week': benchmark_ppw,
                'missing_posts_per_week':   round(missing_ppw, 1),
                'missing_sessions_month':   missing_sessions_mo,
                'revenue_gap':              revenue_gap,
                'avg_session_price':        avg_price,
                'current_sessions_month':   current_sessions_mo,
                'current_revenue_est':      current_revenue_est,
                'optimal_sessions_month':   optimal_sessions_mo,
                'optimal_revenue_est':      optimal_revenue_est,
                'city':                     city or 'your market',
            },
            'bio_recommendations':  bio_recs,
            'hashtag_analysis':     hashtag_analysis,
            'tiktok_gap':           tiktok_gap,
            'competitor_ig':        competitor_ig,
            'content_calendar':     content_calendar,
        })

    except Exception as e:
        return jsonify({'error': f'Instagram audit failed: {str(e)}'}), 502


@app.route('/api/grade-ig-public', methods=['POST'])
def grade_ig_public():
    """
    Public Instagram profile scraper — no OAuth required.
    Used for personal IG accounts (not Business/Creator) that cannot be reached
    through the Meta Graph API's /me/accounts → instagram_business_account chain.
    Returns limited data: followers, bio, post count — no engagement/frequency.
    Two attempts: Instagram's internal web API, then HTML page parse.
    """
    data   = request.get_json(silent=True) or {}
    handle = (data.get('handle') or '').strip().lstrip('@')
    city   = (data.get('city')   or '').strip()

    if not handle:
        return jsonify({'error': 'Handle is required'}), 400

    profile_data = {}

    # ── Method 1: Instagram internal web API ────────────────────────
    try:
        resp = requests.get(
            'https://i.instagram.com/api/v1/users/web_profile_info/',
            params={'username': handle},
            headers={
                'X-IG-App-ID':    '936619743392459',
                'User-Agent':     (
                    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) '
                    'AppleWebKit/605.1.15 (KHTML, like Gecko) '
                    'CriOS/120.0.6099.119 Mobile/15E148 Safari/604.1'
                ),
                'Accept':         '*/*',
                'Accept-Language':'en-US,en;q=0.9',
                'Referer':        'https://www.instagram.com/',
                'Origin':         'https://www.instagram.com',
            },
            timeout=10
        )
        if resp.status_code == 200:
            jd   = resp.json()
            user = jd.get('data', {}).get('user', {})
            if user:
                bio_links = user.get('bio_links', []) or []
                website   = (user.get('external_url', '') or
                             (bio_links[0].get('url', '') if bio_links else ''))
                profile_data = {
                    'username':    user.get('username', handle),
                    'full_name':   user.get('full_name', ''),
                    'biography':   user.get('biography', ''),
                    'website':     website,
                    'followers':   user.get('edge_followed_by', {}).get('count', 0),
                    'following':   user.get('edge_follow', {}).get('count', 0),
                    'media_count': user.get('edge_owner_to_timeline_media', {}).get('count', 0),
                    'is_private':  user.get('is_private', False),
                    'is_business': (user.get('is_business', False) or
                                   user.get('is_professional_account', False)),
                }
    except Exception:
        pass

    # ── Method 2: HTML page parse (ld+json schema) ──────────────────
    if not profile_data:
        try:
            resp2 = requests.get(
                f'https://www.instagram.com/{handle}/',
                headers={
                    'User-Agent': (
                        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
                        'AppleWebKit/537.36 (KHTML, like Gecko) '
                        'Chrome/122.0.0.0 Safari/537.36'
                    ),
                    'Accept':         'text/html,application/xhtml+xml',
                    'Accept-Language':'en-US,en;q=0.9',
                },
                timeout=10
            )
            if resp2.status_code == 200:
                soup = BeautifulSoup(resp2.text, 'lxml')
                for script in soup.find_all('script', type='application/ld+json'):
                    try:
                        jd = json.loads(script.string or '{}')
                        if '@type' in jd:
                            interactions = jd.get('interactionStatistic', [])
                            follower_obj = next(
                                (s for s in interactions
                                 if 'FollowAction' in s.get('interactionType', '')), {}
                            )
                            profile_data = {
                                'username':    handle,
                                'full_name':   jd.get('name', ''),
                                'biography':   jd.get('description', ''),
                                'website':     jd.get('url', ''),
                                'followers':   follower_obj.get('userInteractionCount', 0),
                                'following':   0,
                                'media_count': 0,
                                'is_private':  False,
                                'is_business': False,
                            }
                            break
                    except Exception:
                        continue
        except Exception:
            pass

    if not profile_data:
        return jsonify({
            'error': 'could_not_fetch',
            'message': (
                f'Could not load public profile for @{handle}. '
                'Instagram may have blocked the request, or the account is private. '
                'Ask the artist to convert to a Business/Creator account and link to a Facebook Page '
                'to unlock the full OAuth-based audit.'
            )
        }), 404

    if profile_data.get('is_private'):
        return jsonify({
            'error': 'private_account',
            'message': f'@{handle} is a private account — public audit is not available.'
        }), 403

    # ── Bio analysis ────────────────────────────────────────────────
    ig_username     = profile_data.get('username', handle)
    bio_text        = profile_data.get('biography', '') or ''
    detected_styles = _detect_styles_from_bio(bio_text)
    has_booking_link = bool(profile_data.get('website', ''))
    bio_lower       = bio_text.lower()

    BOOKING_KW = ['book', 'calendly', 'vagaro', 'booksy', 'schedule', 'appointment',
                  'dm to book', 'link in bio', 'linktree', 'contact', 'inquiry', 'commission']
    CITY_KW    = ['miami', 'orlando', 'kissimmee', 'florida', ' fl ', 'new york', ' ny ',
                  'chicago', 'houston', 'dallas', 'atlanta', 'denver', 'phoenix', ' la ',
                  'los angeles', 'austin', 'nashville', 'charlotte', 'tampa', 'jacksonville']
    bio_has_booking = any(kw in bio_lower for kw in BOOKING_KW)
    bio_has_city    = any(kw in bio_lower for kw in CITY_KW)
    bio_has_style   = bool(detected_styles)
    bio_has_link    = has_booking_link
    bio_score       = (bio_has_booking * 35 + bio_has_link * 25 +
                       bio_has_city * 20 + bio_has_style * 20)

    gaps = []
    if not bio_has_booking:
        gaps.append({
            'category': 'Booking Link in Bio', 'artist_val': 'Missing',
            'benchmark': '100% of top artists', 'impact': 'critical',
            'action': ('Add your booking link as the FIRST item in your bio — '
                       'Calendly, Vagaro, Booksy, or a Linktree that links to your booking page.')
        })
    if not bio_has_city:
        gaps.append({
            'category': 'City in Bio', 'artist_val': 'Missing',
            'benchmark': 'Top artists include city', 'impact': 'warning',
            'action': ('Add your city to your bio (e.g., "📍 Kissimmee, FL"). '
                       'This directly affects Instagram local search discovery.')
        })
    if not bio_has_style:
        gaps.append({
            'category': 'Style in Bio', 'artist_val': 'Missing',
            'benchmark': 'Top artists list specialty', 'impact': 'warning',
            'action': ('Add your specialty style (e.g., "Fine Line Specialist" or '
                       '"Realism & Black & Grey") — clients search by style.')
        })
    if not bio_has_link:
        gaps.append({
            'category': 'Website Link', 'artist_val': 'Missing',
            'benchmark': 'Top artists link website or booking page', 'impact': 'warning',
            'action': ('Add a link to your booking page or portfolio website. '
                       'Without a link, interested clients have to DM — and most won\'t.')
        })

    # ── Bio AI recommendations ───────────────────────────────────────
    fake_place = {
        'name':                   profile_data.get('full_name', '') or f'@{ig_username}',
        'website':                profile_data.get('website', ''),
        'formatted_phone_number': '',
        'rating': 0, 'user_ratings_total': 0,
    }
    fake_extras = {
        'detected_styles':    detected_styles,
        'has_tattoo_booking': has_booking_link,
        'booking_platform':   '',
    }
    bio_recs = generate_bio_recommendations(fake_place, {}, fake_extras, {}, city)

    return jsonify({
        'ig_only':     True,
        'report_type': 'instagram',
        'ig_mode':     True,
        'public_mode': True,       # limited data — no engagement or post frequency
        'username':    ig_username,
        'city':        city,
        'profile': {
            'username':    ig_username,
            'name':        profile_data.get('full_name', ''),
            'biography':   bio_text,
            'website':     profile_data.get('website', ''),
            'followers':   profile_data.get('followers', 0),
            'following':   profile_data.get('following', 0),
            'media_count': profile_data.get('media_count', 0),
            'is_business': profile_data.get('is_business', False),
        },
        'facebook':    {},
        'ig_competitive': {
            'followers':       profile_data.get('followers', 0),
            'following':       profile_data.get('following', 0),
            'posts_total':     profile_data.get('media_count', 0),
            'posts_per_week':  None,   # not available from public data
            'last_post_days':  None,
            'reel_pct':        None,
            'engagement_rate': None,
            'bio':             bio_text,
            'bio_score':       bio_score,
            'bio_has_booking': bio_has_booking,
            'bio_has_city':    bio_has_city,
            'bio_has_style':   bio_has_style,
            'bio_has_link':    bio_has_link,
            'gaps':            gaps,
            'recent_posts':    [],
        },
        'revenue_gap': None,   # not computable without post frequency
        'bio_recommendations': bio_recs,
        'note': (
            f'@{ig_username} is a personal Instagram account — not connected to a Facebook Page '
            'as a Business or Creator account. Post frequency, engagement rate, and content mix '
            'are not available without Business account access. '
            'Bio analysis and gap checklist are based on public profile data only.'
        )
    })


@app.route('/api/grade-tattoo-by-ig', methods=['POST'])
def grade_tattoo_by_ig():
    """
    Instagram-first audit path. Artist authenticates via Meta OAuth.
    We pull their real IG profile + media, find their Google listing
    using their real name, run the full audit, and inject live IG data.
    No need for the artist to know their GMB listing name.
    """
    data    = request.get_json(silent=True) or {}
    token   = (data.get('token')   or '').strip()
    city    = (data.get('city')    or '').strip()
    handle  = (data.get('handle')  or '').strip().lstrip('@')
    page_id = (data.get('page_id') or '').strip()  # specific page selected by artist

    if not token:
        return jsonify({'error': 'No token provided'}), 400

    try:
        # ── Step 1: Find the correct IG Business Account ──────────────
        # If page_id is supplied (artist selected from page list), use it directly.
        # Otherwise fall back to first page with IG connected.
        ig_id   = None
        fb_page = {}

        pages_resp = requests.get(
            'https://graph.facebook.com/v19.0/me/accounts',
            params={
                'access_token': token,
                'fields': 'id,name,fan_count,followers_count,instagram_business_account'
            },
            timeout=8
        )
        pages = pages_resp.json().get('data', [])

        for page in pages:
            # If artist picked a specific page, only use that one
            if page_id and page.get('id') != page_id:
                continue
            ig_acct = page.get('instagram_business_account', {})
            if ig_acct and ig_acct.get('id'):
                ig_id = ig_acct['id']
                fb_page = {
                    'page_name': page.get('name', ''),
                    'fans':      page.get('fan_count'),
                    'followers': page.get('followers_count'),
                    'source':    'live'
                }
                break

        if not ig_id:
            return jsonify({
                'error': 'no_ig_account',
                'message': (
                    'No Instagram Business Account found on this page. '
                    'Make sure your IG account is linked to a Facebook Page and '
                    'converted to a Business or Creator account.'
                )
            }), 404

        # ── Step 2: IG Profile + 25 recent posts ─────────────────────
        ig_resp = requests.get(
            f'https://graph.facebook.com/v19.0/{ig_id}',
            params={
                'access_token': token,
                'fields': (
                    'id,username,name,biography,website,'
                    'profile_picture_url,followers_count,follows_count,media_count'
                )
            },
            timeout=8
        )
        ig_info = ig_resp.json()

        media_resp = requests.get(
            f'https://graph.facebook.com/v19.0/{ig_id}/media',
            params={
                'access_token': token,
                'fields': 'id,timestamp,media_type,like_count,comments_count,permalink,caption',
                'limit': 25
            },
            timeout=8
        )
        media_list = media_resp.json().get('data', [])

        # Deep competitive analysis from real IG data
        ig_competitive = analyze_ig_competitive(ig_info, media_list, [])

        # ── Step 3: Find their Google listing via real name ───────────
        ig_real_name = ig_info.get('name', '').strip()
        ig_username  = ig_info.get('username', '').strip() or handle

        TATTOO_KW = {'tattoo', 'ink', 'piercing', 'tattooing'}

        # Build ordered search queries — most specific first
        search_queries = []
        if ig_real_name and city:
            search_queries.append(f'{ig_real_name} tattoo {city}')
        if ig_username and city:
            clean = re.sub(r'[._\-]', ' ', ig_username).strip()
            search_queries.append(f'{clean} tattoo {city}')
            if handle and handle != ig_username:
                search_queries.append(f'{re.sub(r"[._-]", " ", handle).strip()} tattoo {city}')
        if ig_real_name:
            search_queries.append(f'{ig_real_name} tattoo')
        if city:
            search_queries.append(f'tattoo artist {city}')

        place_id = None
        for q in search_queries:
            if place_id:
                break
            try:
                r = requests.get(
                    'https://maps.googleapis.com/maps/api/place/textsearch/json',
                    params={'query': q, 'key': GOOGLE_KEY},
                    timeout=8
                )
                for res in r.json().get('results', []):
                    pid  = res.get('place_id', '')
                    if not pid:
                        continue
                    types      = res.get('types', [])
                    name_lower = res.get('name', '').lower()
                    is_tattoo  = (
                        'tattoo_parlor' in types or
                        any(kw in name_lower for kw in TATTOO_KW) or
                        'art_studio' in types
                    )
                    if is_tattoo:
                        place_id = pid
                        break
            except Exception:
                pass

        # ── Step 4: Full report + inject live IG data ─────────────────
        if place_id:
            report, err, status = _grade_tattoo_internal(place_id)
            if report:
                # Override social_presence with real live IG data
                sp = report.setdefault('social_presence', {})
                sp['instagram_followers']    = ig_info.get('followers_count')
                sp['instagram_media_count']  = ig_info.get('media_count')
                sp['instagram_username']     = ig_info.get('username', '')
                sp['instagram_last_post_days'] = ig_competitive.get('last_post_days')
                sp['instagram_bio']          = ig_info.get('biography', '')
                sp['instagram_website']      = ig_info.get('website', '')
                sp['instagram_source']       = 'live'
                # Facebook data from the linked page
                if fb_page:
                    sp['facebook_page_name'] = fb_page.get('page_name', '')
                    sp['facebook_fans']      = fb_page.get('fans')
                    sp['facebook_followers'] = fb_page.get('followers')
                    sp['facebook_source']    = 'live'
                report['ig_competitive'] = ig_competitive
                report['ig_mode']        = True   # tells frontend data is live, no enhance needed
                return jsonify(report)

        # ── Step 5: No Google listing found — IG-only partial report ──
        # Artist has IG but no GMB. Still give them a partial audit.
        followers = ig_info.get('followers_count', 0) or 0
        return jsonify({
            'ig_only':  True,
            'ig_mode':  True,
            'business': {
                'name':    ig_info.get('name', '') or f'@{ig_username}',
                'address': city or 'Location unknown',
                'rating':  None, 'reviews': 0,
                'website': ig_info.get('website', ''),
                'phone':   None, 'photos': 0, 'has_hours': False
            },
            'instagram': {
                'username':       ig_username,
                'followers':      followers,
                'following':      ig_info.get('follows_count', 0),
                'media_count':    ig_info.get('media_count', 0),
                'bio':            ig_info.get('biography', ''),
                'website':        ig_info.get('website', ''),
                'source':         'live'
            },
            'ig_competitive':  ig_competitive,
            'facebook':        fb_page,
            'social_presence': {
                'instagram_followers':     followers,
                'instagram_username':      ig_username,
                'instagram_media_count':   ig_info.get('media_count', 0),
                'instagram_last_post_days': ig_competitive.get('last_post_days'),
                'instagram_source':        'live',
                'facebook_page_name':      fb_page.get('page_name', ''),
                'facebook_fans':           fb_page.get('fans'),
                'facebook_source':         'live',
            },
            'no_gmb':  True,
            'message': (
                f'No Google Business listing found for @{ig_username}. '
                'Your Instagram data is live — Google presence is not yet set up.'
            )
        })

    except Exception as e:
        return jsonify({'error': f'Instagram grade failed: {str(e)}'}), 502


# ── TATTOO EXTRAS SCRAPER ─────────────────────────────────────────────

def scrape_tattoo_extras(url, site_data):
    extras = {
        'has_tattoo_booking': False,
        'booking_platform':   None,
        'has_portfolio':      False,
        'has_flash_page':     False,
        'detected_styles':    [],
        'has_consultation':   False,
        'has_deposit_info':   False,
        'has_aftercare':      False,
        'has_artist_bio':     False,
        'has_pricing_info':   False,
    }
    if not url or not site_data.get('scraped'):
        return extras
    try:
        headers = {'User-Agent': (
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
            'AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36'
        )}
        resp = requests.get(url, headers=headers, timeout=8, allow_redirects=True)
        if resp.status_code >= 400:
            return extras
        soup      = BeautifulSoup(resp.text, 'lxml')
        text_low  = resp.text.lower()

        # Booking platforms
        for a in soup.find_all('a', href=True):
            href = a.get('href', '').lower()
            for domain, name in TATTOO_BOOKING_MAP.items():
                if domain in href:
                    extras['has_tattoo_booking'] = True
                    extras['booking_platform']   = name
                    break
            if extras['has_tattoo_booking']:
                break

        extras['has_portfolio']   = any(k in text_low for k in
            ['portfolio', 'our work', 'gallery', 'recent work', 'featured work'])
        extras['has_flash_page']  = any(k in text_low for k in
            ['flash', 'available flash', 'flash designs', 'ready to tattoo'])
        extras['detected_styles'] = [s for s in TATTOO_STYLE_KEYWORDS if s in text_low][:6]
        extras['has_consultation']= any(k in text_low for k in
            ['consultation', 'consult', 'book a consult'])
        extras['has_deposit_info']= any(k in text_low for k in
            ['deposit', 'non-refundable', 'booking fee'])
        extras['has_aftercare']   = any(k in text_low for k in
            ['aftercare', 'healing', 'care instructions', 'tattoo care'])
        extras['has_artist_bio']  = any(k in text_low for k in
            ['about me', 'about the artist', 'my story', 'meet the artist', 'artist bio'])
        extras['has_pricing_info']= any(k in text_low for k in
            ['starting at', 'pricing', 'rates', 'minimum', 'price list', 'hourly rate'])
    except Exception:
        pass
    return extras


# ── TATTOO KEYWORD RANKINGS ─────────────────────────────────────────

def check_tattoo_rankings(biz_name, city, state):
    keywords = [
        f'tattoo shop {city}',
        f'tattoo artist {city}',
        f'best tattoo {city}',
        f'tattoo studio {city}',
        f'{biz_name} {city}',
    ]
    results = []
    for keyword in keywords:
        try:
            resp = requests.post(
                'https://api.dataforseo.com/v3/serp/google/organic/live/advanced',
                auth=(DFS_LOGIN, DFS_PASSWORD),
                json=[{
                    'keyword':       keyword,
                    'location_name': f'{city},{state},United States' if state else f'{city},United States',
                    'language_name': 'English',
                    'depth':         30,
                }],
                timeout=12
            )
            data        = resp.json()
            task_result = (data.get('tasks') or [{}])[0].get('result') or []
            items       = (task_result[0].get('items') or []) if task_result else []
            rank        = None
            biz_lower   = biz_name.lower()[:12]
            for item in items:
                if item.get('type') == 'organic':
                    title  = (item.get('title') or '').lower()
                    domain = (item.get('domain') or '').lower()
                    if biz_lower in title or biz_lower in domain:
                        rank = item.get('rank_absolute')
                        break
            results.append({'keyword': keyword, 'rank': rank, 'ranked': rank is not None})
        except Exception:
            results.append({'keyword': keyword, 'rank': None, 'ranked': False})
    return results


# ── META AD LIBRARY — COMPETITOR ADS ────────────────────────────────
# Public API — no artist auth required. Uses the existing FB_TOKEN.
# Returns up to 8 active or recent tattoo-related ads in the artist's city.
# Docs: https://www.facebook.com/ads/library/api/

def check_ad_library(city, state):
    """
    Query Meta Ad Library for competitor tattoo ads near the artist's city.
    Filters to only return ads that are:
    1. Tattoo-related (page_name or body contains tattoo keywords)
    2. Geographically relevant (city name appears in body, OR ad_reached_countries = US with city search)
    """
    if not FB_TOKEN or not city:
        return []

    TATTOO_AD_KEYWORDS = {'tattoo', 'ink', 'inking', 'tattooed', 'tattooist', 'tattoo artist',
                          'tattoo studio', 'tattoo shop', 'piercing', 'body art'}
    city_lower = city.lower()

    try:
        resp = requests.get(
            'https://graph.facebook.com/v19.0/ads_archive',
            params={
                'access_token':        FB_TOKEN,
                'ad_type':             'ALL',
                'search_terms':        f'tattoo {city}',
                'ad_reached_countries':'US',
                'fields': (
                    'id,page_name,ad_snapshot_url,'
                    'ad_creative_bodies,ad_delivery_start_time,'
                    'impressions,spend,currency'
                ),
                'limit': 20,   # fetch more, then post-filter
            },
            timeout=10
        )
        data = resp.json()
        if 'error' in data:
            return []

        ads = data.get('data', [])
        results = []

        for ad in ads:
            page_name  = (ad.get('page_name') or '').lower()
            bodies     = ad.get('ad_creative_bodies') or []
            body_text  = ' '.join(bodies).lower()
            combined   = page_name + ' ' + body_text

            # ── Filter 1: Must be tattoo-related ──────────────────────────
            is_tattoo = any(kw in combined for kw in TATTOO_AD_KEYWORDS)
            if not is_tattoo:
                continue

            # ── Filter 2: Must be city-relevant ───────────────────────────
            # Accept if city appears in the ad copy, OR if the page name contains
            # any part of the city name (e.g. "Orlando Ink" for city=Orlando),
            # OR if we got here via a city-specific search (all results are US-targeted).
            # We allow all US-targeted tattoo ads from the city search to pass if the
            # ad copy doesn't mention a different specific city.
            city_parts = [c.strip() for c in city_lower.split() if len(c.strip()) > 3]
            city_in_ad = any(cp in combined for cp in city_parts)
            # If city isn't in the ad but the ad is clearly tattoo-related from a
            # city-specific search, we still include it (it's a US-wide tattoo ad
            # shown in that market, still relevant competitive intelligence)
            # But exclude ads that mention completely unrelated cities explicitly
            # (heuristic: skip if a major city is in body but NOT our city)
            MAJOR_CITIES = {'new york', 'los angeles', 'chicago', 'houston', 'dallas',
                            'phoenix', 'seattle', 'boston', 'denver', 'portland',
                            'atlanta', 'miami', 'las vegas', 'san diego', 'austin'}
            other_city_mentioned = any(mc in body_text for mc in MAJOR_CITIES if mc != city_lower)
            if other_city_mentioned and not city_in_ad:
                continue   # skip ads clearly for a different city

            spend = ad.get('spend', {})
            imps  = ad.get('impressions', {})
            body_preview = bodies[0][:120] if bodies else ''

            results.append({
                'page_name':    ad.get('page_name', 'Unknown'),
                'snapshot_url': ad.get('ad_snapshot_url', ''),
                'started':      (ad.get('ad_delivery_start_time') or '')[:10],
                'spend_low':    spend.get('lower_bound', ''),
                'spend_high':   spend.get('upper_bound', ''),
                'imps_low':     imps.get('lower_bound', ''),
                'imps_high':    imps.get('upper_bound', ''),
                'currency':     ad.get('currency', 'USD'),
                'body':         body_preview,
            })

            if len(results) >= 6:
                break

        return results
    except Exception:
        return []


# ── FACEBOOK PAGE SEARCH — COMPETITOR ENRICHMENT ────────────────────
# Searches Facebook Pages API for a business by name + city.
# Returns followers/fans for the best-matching result.

def search_facebook_page(biz_name, city):
    """Find a competitor's Facebook Page and return follower/fan data."""
    if not FB_TOKEN or not biz_name:
        return {}
    try:
        # Try name + city first, fall back to name only
        for q in [f'{biz_name} {city}', biz_name]:
            resp = requests.get(
                'https://graph.facebook.com/v19.0/pages/search',
                params={
                    'access_token': FB_TOKEN,
                    'q':            q,
                    'fields':       'id,name,fan_count,followers_count',
                    'limit':        3,
                },
                timeout=6
            )
            data  = resp.json()
            pages = data.get('data', [])
            if pages:
                break
        if not pages:
            return {}
        page = pages[0]
        return {
            'fb_page_name': page.get('name', ''),
            'fb_fans':      page.get('fan_count'),
            'fb_followers': page.get('followers_count'),
        }
    except Exception:
        return {}


# ── TATTOO SCORING ENGINE ────────────────────────────────────────────

def score_ink_visibility(place, site_data, keyword_rankings, checklist):
    s     = 0
    items = []

    has_web = bool(place.get('website'))
    items.append({'label': 'Website exists and linked to Google profile', 'pass': has_web})
    if has_web: s += 4

    has_ph = bool(place.get('formatted_phone_number'))
    items.append({'label': 'Phone number on Google profile', 'pass': has_ph})
    if has_ph: s += 3

    has_hrs = bool(place.get('opening_hours'))
    items.append({'label': 'Business hours published on Google', 'pass': has_hrs})
    if has_hrs: s += 3

    photos = len(place.get('photos', []))
    photos_ok = photos >= 10
    items.append({'label': f'10+ photos on Google profile ({photos} uploaded)', 'pass': photos_ok})
    if photos >= 10: s += 3
    elif photos >= 5: s += 2
    elif photos >= 1: s += 1

    ig_found = 'Instagram' in site_data.get('social_links', []) if site_data.get('scraped') else False
    items.append({'label': 'Instagram linked from website', 'pass': ig_found})
    if ig_found: s += 4

    ranked_any = any(r.get('ranked') for r in keyword_rankings) if keyword_rankings else False
    items.append({'label': 'Ranking for at least one "tattoo [city]" keyword', 'pass': ranked_any})
    if ranked_any: s += 3

    checklist['visibility'] = items
    return min(s, 20)


def score_ink_trust(place, site_data, checklist):
    s       = 0
    items   = []
    rating  = place.get('rating', 0)
    reviews = place.get('user_ratings_total', 0)
    scraped = site_data.get('scraped', False)

    # Rating
    items.append({'label': f'Google rating 4.5 or above ({rating} stars)', 'pass': rating >= 4.5})
    if rating >= 4.8:   s += 8
    elif rating >= 4.5: s += 6
    elif rating >= 4.0: s += 4
    elif rating > 0:    s += 2

    # Reviews
    items.append({'label': f'50 or more Google reviews ({reviews} total)', 'pass': reviews >= 50})
    if reviews >= 100:  s += 8
    elif reviews >= 50: s += 6
    elif reviews >= 25: s += 4
    elif reviews >= 10: s += 2

    # Portfolio
    has_portfolio = site_data.get('has_testimonials', False) or (scraped and any(
        k in site_data.get('meta_title', '').lower() for k in ['portfolio', 'gallery', 'work']
    ))
    items.append({'label': 'Portfolio or gallery visible on website', 'pass': has_portfolio})
    if has_portfolio: s += 2

    # Testimonials
    has_test = site_data.get('has_testimonials', False) if scraped else False
    items.append({'label': 'Client testimonials displayed', 'pass': has_test})
    if has_test: s += 2

    checklist['trust'] = items
    return min(s, 20)


def score_ink_booking(place, site_data, tattoo_extras, checklist):
    s       = 0
    items   = []
    scraped = site_data.get('scraped', False)

    # Tattoo booking platform (highest value)
    has_booking = tattoo_extras.get('has_tattoo_booking') or site_data.get('has_booking_widget', False)
    bp_name     = tattoo_extras.get('booking_platform', '')
    bp_label    = f'Online booking via {bp_name}' if bp_name else 'Online booking / scheduling widget'
    items.append({'label': bp_label, 'pass': has_booking})
    if has_booking: s += 9

    # Phone on site
    ph_ok = site_data.get('phone_on_site', False) if scraped else False
    items.append({'label': 'Phone number on website', 'pass': ph_ok})
    if ph_ok: s += 4

    # CTA / contact form
    has_cta = (site_data.get('has_cta') or site_data.get('has_contact_form')) if scraped else False
    items.append({'label': 'Contact form or booking CTA on website', 'pass': has_cta})
    if has_cta: s += 4

    # Deposit info
    dep_ok = tattoo_extras.get('has_deposit_info', False)
    items.append({'label': 'Deposit / booking fee info published', 'pass': dep_ok})
    if dep_ok: s += 2

    # Consultation info
    con_ok = tattoo_extras.get('has_consultation', False)
    items.append({'label': 'Consultation process explained', 'pass': con_ok})
    if con_ok: s += 1

    checklist['booking_funnel'] = items
    return min(s, 20)


def score_ink_followup(site_data, review_intel, checklist):
    s    = 0
    items = []
    ri    = review_intel or {}

    # Response rate
    rr    = ri.get('response_rate', 0)
    rr_ok = rr >= 50
    items.append({'label': f'Owner responds to Google reviews ({rr}%)', 'pass': rr_ok})
    if rr >= 75:  s += 6
    elif rr >= 50: s += 4
    elif rr >= 25: s += 2

    # Review velocity
    vel   = ri.get('velocity', '')
    vel_s = ri.get('velocity_score', 0)
    vel_days = ri.get('newest_review_days')
    vel_label = (f'{vel} — last review {vel_days}d ago' if vel_days is not None else vel) if vel else 'No data'
    items.append({'label': f'Review velocity: {vel_label}', 'pass': vel_s >= 65})
    if vel_s >= 100:  s += 5
    elif vel_s >= 65: s += 3
    elif vel_s >= 35: s += 1

    # Live chat
    chat_ok = site_data.get('has_live_chat', False) if site_data.get('scraped') else False
    items.append({'label': 'Live chat or instant messaging on website', 'pass': chat_ok})
    if chat_ok: s += 2

    # Email capture signal (CRM / newsletter)
    scraped = site_data.get('scraped', False)
    email_ok = site_data.get('has_contact_form', False) if scraped else False
    items.append({'label': 'Email capture or CRM form present', 'pass': email_ok})
    if email_ok: s += 2

    checklist['followup'] = items
    return min(s, 15)


def score_ink_content(social_data, site_data, tattoo_extras, checklist):
    s     = 0
    items = []
    sd    = social_data or {}

    # Instagram followers
    ig_fol = sd.get('instagram_followers')
    ig_fol_ok = ig_fol is not None and ig_fol >= 1000
    ig_fol_lbl = f'Instagram: {ig_fol:,} followers' if ig_fol is not None else 'Instagram followers: no data'
    items.append({'label': ig_fol_lbl, 'pass': ig_fol_ok})
    if ig_fol is not None:
        if ig_fol >= 5000:   s += 5
        elif ig_fol >= 2000: s += 4
        elif ig_fol >= 1000: s += 3
        elif ig_fol >= 500:  s += 1

    # Instagram recency
    ig_last = sd.get('instagram_last_post_days')
    ig_rec_ok = ig_last is not None and ig_last <= 7
    ig_rec_lbl = (f'Last Instagram post: {ig_last} days ago' if ig_last is not None
                  else 'Instagram last post: no data')
    items.append({'label': ig_rec_lbl, 'pass': ig_rec_ok})
    if ig_last is not None:
        if ig_last <= 3:    s += 5
        elif ig_last <= 7:  s += 4
        elif ig_last <= 14: s += 2

    # Portfolio on website
    port_ok = tattoo_extras.get('has_portfolio', False)
    items.append({'label': 'Portfolio / gallery on website', 'pass': port_ok})
    if port_ok: s += 3

    # Flash or style pages
    flash_ok   = tattoo_extras.get('has_flash_page', False)
    styles     = tattoo_extras.get('detected_styles', [])
    style_ok   = bool(styles)
    content_ok = flash_ok or style_ok
    lbl        = f'Style content detected: {", ".join(styles[:3])}' if styles else 'No style / flash content found'
    items.append({'label': lbl, 'pass': content_ok})
    if content_ok: s += 2

    checklist['content'] = items
    return min(s, 15)


def score_ink_competitor(map_pack_data, place, competitors, checklist):
    s     = 0
    items = []

    # Map pack
    in_pack = any(m.get('in_pack') for m in map_pack_data) if map_pack_data else False
    items.append({'label': 'Appearing in Google Map Pack for "tattoo [city]"', 'pass': in_pack})
    if in_pack: s += 5

    # Reviews vs competitors
    my_reviews = place.get('user_ratings_total', 0)
    my_rating  = place.get('rating', 0)
    active_comps = [c for c in competitors if c.get('user_ratings_total', 0) > 0]
    if active_comps:
        avg_rev = sum(c.get('user_ratings_total', 0) for c in active_comps) / len(active_comps)
        avg_rat = sum(c.get('rating', 0) for c in active_comps) / len(active_comps)
        rev_win = my_reviews >= avg_rev
        rat_win = my_rating >= avg_rat
        items.append({'label': f'More reviews than avg competitor ({int(avg_rev)} avg)', 'pass': rev_win})
        if rev_win: s += 3
        items.append({'label': f'Higher rating than avg competitor ({avg_rat:.1f} avg)', 'pass': rat_win})
        if rat_win: s += 2
    else:
        items.append({'label': 'Competitor data unavailable', 'pass': None})

    checklist['competitor'] = items
    return min(s, 10)


# ── TATTOO REVENUE ESTIMATOR ─────────────────────────────────────────
#
# Two live adjustment layers applied on top of city benchmarks:
#   1. SEASONAL MULTIPLIER — booking demand shifts by month (sourced from
#      industry seasonality data + JRZ historical client performance)
#   2. STYLE PREMIUM — specialized styles command significantly higher
#      average session prices than generic/flash work
#
# These replace the flat static benchmark so every estimate reflects
# the actual market conditions the artist is operating in right now.

SEASONAL_MULTIPLIERS = {
    # Month → (demand_mult, label, reasoning)
    1:  (0.85, 'Winter',       'Post-holiday slowdown — slower booking month industry-wide'),
    2:  (0.85, 'Winter',       'Post-holiday slowdown — slower booking month industry-wide'),
    3:  (1.08, 'Spring',       'Pre-summer rush begins — clients book spring/summer looks'),
    4:  (1.08, 'Spring',       'Pre-summer rush — tax refund season drives discretionary spending'),
    5:  (1.10, 'Late Spring',  'Peak booking ramp-up — outdoor season, festival prep'),
    6:  (1.20, 'Peak Summer',  'Highest demand month — outdoor events, travel, weddings'),
    7:  (1.20, 'Peak Summer',  'Highest demand month — outdoor events, travel, weddings'),
    8:  (1.18, 'Late Summer',  'Strong demand continues — back-to-school, end-of-summer energy'),
    9:  (1.00, 'Fall',         'Solid baseline — cooler temps = better healing, pre-holiday bookings'),
    10: (1.00, 'Fall',         'Solid baseline — Halloween proximity drives flash and themed work'),
    11: (0.95, 'Late Fall',    'Slight pre-holiday dip — clients start pausing discretionary spend'),
    12: (0.85, 'December',     'Slowest month — holiday obligations, gift spend over personal spend'),
}

STYLE_PREMIUMS = {
    # Detected style keyword → (price_mult, label)
    'realism':        (1.50, 'Realism'),
    'realistic':      (1.50, 'Realism'),
    'portrait':       (1.55, 'Portrait'),
    'japanese':       (1.30, 'Japanese'),
    'black and grey': (1.20, 'Black & Grey'),
    'black & grey':   (1.20, 'Black & Grey'),
    'watercolor':     (1.25, 'Watercolor'),
    'geometric':      (1.15, 'Geometric'),
    'neo-traditional':(1.20, 'Neo-Traditional'),
    'fine line':      (1.18, 'Fine Line'),
    'minimalist':     (1.15, 'Minimalist'),
    'chicano':        (1.20, 'Chicano'),
    'illustrative':   (1.15, 'Illustrative'),
    'dotwork':        (1.15, 'Dotwork'),
    'blackwork':      (1.10, 'Blackwork'),
    'tribal':         (1.05, 'Tribal'),
    'traditional':    (1.00, 'Traditional'),
    'custom':         (1.00, 'Custom'),
    'flash':          (0.85, 'Flash'),        # shorter sessions, lower avg
    'cover up':       (1.25, 'Cover-Up'),     # complexity premium
    'sleeve':         (1.40, 'Sleeve work'),  # large piece = higher avg
    'color':          (1.10, 'Color work'),
}


def estimate_tattoo_revenue(place, city, overall_score, social_data, tattoo_extras=None):
    reviews   = place.get('user_ratings_total', 0)
    city_key  = city.lower().strip() if city else 'default'
    bench     = TATTOO_CITY_BENCHMARKS.get(city_key, TATTOO_CITY_BENCHMARKS['default'])
    te        = tattoo_extras or {}
    styles    = te.get('detected_styles', [])

    # ── 1. Base session volume (review count → proxy for business size) ──
    if   reviews >= 200: sessions = bench['monthly_sessions']
    elif reviews >= 100: sessions = int(bench['monthly_sessions'] * 0.75)
    elif reviews >= 50:  sessions = int(bench['monthly_sessions'] * 0.55)
    elif reviews >= 25:  sessions = int(bench['monthly_sessions'] * 0.40)
    else:                sessions = int(bench['monthly_sessions'] * 0.25)

    avg_price  = bench['avg_price']
    high_price = bench['high']

    # ── 2. Seasonal multiplier — live month-based adjustment ─────────────
    month         = datetime.datetime.now().month
    s_mult, s_label, s_reason = SEASONAL_MULTIPLIERS.get(month, (1.00, 'Standard', ''))
    sessions_adj  = max(1, int(sessions * s_mult))

    # ── 3. Style premium — detected specialty commands higher $/session ──
    style_mult  = 1.00
    style_label = 'Standard mix'
    for sty in styles:
        sty_lower = sty.lower()
        for kw, (mult, lbl) in STYLE_PREMIUMS.items():
            if kw in sty_lower or sty_lower in kw:
                if mult > style_mult:      # use the highest applicable premium
                    style_mult  = mult
                    style_label = lbl
                break

    # Apply style premium to base price (not high_price — keeps ceiling honest)
    adj_avg_price  = int(avg_price  * style_mult)
    adj_high_price = int(high_price * style_mult)

    # ── 4. Final revenue math ─────────────────────────────────────────────
    current_base       = sessions_adj * adj_avg_price
    potential_sessions = int(sessions_adj * 1.45)
    potential_base     = potential_sessions * adj_high_price
    opportunity_base   = potential_base - current_base

    return {
        'current_conservative':      int(current_base * 0.75),
        'current_base':              int(current_base),
        'potential_base':            int(potential_base * 0.85),
        'potential_upside':          int(potential_base),
        'opportunity_conservative':  int(opportunity_base * 0.50),
        'opportunity_base':          int(opportunity_base * 0.70),
        'opportunity_upside':        int(opportunity_base),
        'avg_tattoo_value':          adj_avg_price,
        'est_sessions_month':        sessions_adj,
        'city_benchmark':            city or 'your market',
        'confidence':                'ESTIMATED',
        # Adjustment signals — displayed in revenue breakdown UI
        'seasonal_mult':    round(s_mult, 2),
        'seasonal_label':   s_label,
        'seasonal_reason':  s_reason,
        'style_mult':       round(style_mult, 2),
        'style_label':      style_label,
        'style_premium_pct': int((style_mult - 1.0) * 100),
        'base_avg_price':   avg_price,     # pre-adjustment (for transparency)
        'adj_avg_price':    adj_avg_price, # post-adjustment (what's shown)
    }


# ── TATTOO ISSUES + ROADMAP ──────────────────────────────────────────

def build_tattoo_issues(place, site_data, tattoo_extras, social_data,
                         review_intel, map_pack_data, scores):
    issues = []
    sd     = social_data or {}
    ri     = review_intel or {}
    te     = tattoo_extras or {}

    # Booking system
    if not te.get('has_tattoo_booking') and not site_data.get('has_booking_widget'):
        issues.append({
            'severity': 'critical', 'category': 'Booking System',
            'title':  'No online booking system — clients can\'t book without calling',
            'detail': ('Every artist with a booking link converts 2.4x more profile visitors '
                       'into paying clients. Right now, anyone who finds you and wants to book '
                       'has to DM, call, or email — and most of them won\'t bother. '
                       'That\'s walk-in revenue you\'re handing to a competitor.'),
            'fix': 'JRZ Ink Systems sets up and integrates a booking system (Vagaro, Booksy, or Calendly) in 48 hours.'
        })

    # Map pack
    if map_pack_data and not any(m.get('in_pack') for m in map_pack_data):
        issues.append({
            'severity': 'critical', 'category': 'Local Visibility',
            'title':  'Not showing in Google Map Pack for "tattoo [city]"',
            'detail': ('The Google Map Pack captures 44% of all local search clicks. '
                       'If a client searches "tattoo shop near me" and you\'re not in the top 3, '
                       'you effectively do not exist to that searcher. '
                       'Competitors with weaker portfolios are getting those bookings.'),
            'fix': 'JRZ Ink Systems runs a full Local SEO audit and implements the signals required to enter and hold map pack position.'
        })

    # Instagram inactive
    ig_last = sd.get('instagram_last_post_days')
    if ig_last is not None and ig_last > 14:
        issues.append({
            'severity': 'critical', 'category': 'Content',
            'title':  f'Instagram inactive — last post {ig_last} days ago',
            'detail': ('For tattoo artists, Instagram IS the portfolio. '
                       'An account that hasn\'t posted in two weeks signals to potential clients '
                       'that you\'re not taking bookings, the studio closed, or you don\'t care. '
                       'The algorithm also kills your reach when you go silent.'),
            'fix': 'JRZ Ink Systems builds and manages your content calendar — portfolio posts, Reels, Stories — consistently published, no effort from you.'
        })
    elif not sd.get('instagram_followers'):
        issues.append({
            'severity': 'warning', 'category': 'Content',
            'title':  'Instagram data unavailable — profile may not be connected or public',
            'detail': ('Your Instagram presence could not be verified. '
                       'For tattoo artists, Instagram is the #1 discovery channel. '
                       'If your profile is not optimized and consistently active, '
                       'you are invisible to the majority of clients who search for artists.'),
            'fix': 'JRZ Ink Systems audits and optimizes your Instagram profile, bio, and content strategy.'
        })

    # Low Instagram followers
    ig_fol = sd.get('instagram_followers')
    if ig_fol is not None and ig_fol < 1000:
        issues.append({
            'severity': 'warning', 'category': 'Content',
            'title':  f'Instagram has only {ig_fol:,} followers — below authority threshold',
            'detail': ('In the tattoo industry, Instagram follower count is a direct trust signal. '
                       'Potential clients use it to validate quality before reaching out. '
                       'Below 1,000 followers, most prospects assume you\'re new or not in demand.'),
            'fix': 'JRZ Ink Systems runs a targeted growth campaign and content strategy to build local and style-specific followers.'
        })

    # No website
    if not place.get('website'):
        issues.append({
            'severity': 'critical', 'category': 'Website',
            'title':  'No website — your portfolio exists in one place only',
            'detail': ('Relying entirely on Instagram is a single point of failure. '
                       'Algorithm changes, account restrictions, or a platform outage can cut '
                       'your visibility overnight. A website gives you a permanent booking hub, '
                       'portfolio, and Google presence that you own.'),
            'fix': 'JRZ Ink Systems builds a conversion-optimized artist website with portfolio, booking widget, and local SEO wiring in 48–72 hours.'
        })

    # No portfolio on website
    if place.get('website') and not te.get('has_portfolio') and site_data.get('scraped'):
        issues.append({
            'severity': 'warning', 'category': 'Website',
            'title':  'No portfolio or gallery detected on your website',
            'detail': ('Your website exists but does not show your work. '
                       'A client who lands on your site and does not see tattoo photos '
                       'immediately has no reason to trust you or inquire. '
                       'Portfolio visibility is the #1 conversion factor for tattoo websites.'),
            'fix': 'JRZ Ink Systems builds or upgrades your website gallery with categorized portfolio sections by style.'
        })

    # Low reviews
    reviews = place.get('user_ratings_total', 0)
    if reviews < 25:
        issues.append({
            'severity': 'critical', 'category': 'Reputation',
            'title':  f'Only {reviews} Google reviews — below the trust threshold',
            'detail': ('Fewer than 25 reviews makes clients nervous. '
                       'Your Google profile is being compared against artists with 50, 100, 200+ reviews. '
                       'Clients always choose the artist with more proof. This is the single '
                       'easiest revenue gap to close.'),
            'fix': 'JRZ Ink Systems deploys an automated post-appointment review request via SMS. Clients average 20–40 new reviews within 60 days.'
        })
    elif reviews < 75:
        issues.append({
            'severity': 'warning', 'category': 'Reputation',
            'title':  f'{reviews} reviews — below the local authority benchmark',
            'detail': ('In competitive markets, 75–100+ reviews is the standard for top map pack placement. '
                       'You are operating below that threshold, which limits both your Google ranking '
                       'and client confidence before they reach out.'),
            'fix': 'JRZ Ink Systems activates automated post-appointment review requests. Average 20–40 new reviews in 60 days.'
        })

    # Low response rate
    rr = ri.get('response_rate', 0)
    if ri.get('total_sampled', 0) > 0 and rr < 50:
        issues.append({
            'severity': 'warning', 'category': 'Reputation',
            'title':  f'Only {rr}% of Google reviews have an owner reply',
            'detail': ('Potential clients read how you respond to feedback before deciding '
                       'to reach out. A low response rate signals you don\'t engage with clients '
                       'after the appointment — which raises concerns about the overall experience.'),
            'fix': 'JRZ Ink Systems sets up a review monitoring and response workflow — every review gets a reply within 48 hours.'
        })

    # No deposit info
    if place.get('website') and not te.get('has_deposit_info') and site_data.get('scraped'):
        issues.append({
            'severity': 'warning', 'category': 'Booking System',
            'title':  'No deposit or booking policy published on your website',
            'detail': ('Artists who clearly state their deposit policy upfront attract serious clients '
                       'and reduce no-shows by 60–80%. Without this information, '
                       'inquiries come from people who are not committed — wasting your calendar slots.'),
            'fix': 'JRZ Ink Systems writes and adds a clear deposit policy and booking process page to your website.'
        })

    # Schema
    if site_data.get('scraped') and not site_data.get('has_schema'):
        issues.append({
            'severity': 'warning', 'category': 'Local SEO',
            'title':  'No schema markup on website — Google can\'t fully read your business',
            'detail': ('Schema markup tells Google exactly what your business is, where it is, '
                       'and what you do. Without it, your website sends weaker signals to local '
                       'search — directly impacting your map pack and organic rankings.'),
            'fix': 'JRZ Ink Systems implements LocalBusiness schema markup in 24 hours.'
        })

    return issues


def get_jrz_ink_action(issue):
    title = issue['title'].lower()

    if 'booking' in title or 'book online' in title or 'scheduling' in title:
        return {
            'fix': ('JRZ Ink Systems integrates Vagaro, Booksy, or Calendly directly into your '
                    'website and Instagram bio — with automated confirmation messages, deposit collection, '
                    'and calendar sync. You wake up to bookings already confirmed.'),
            'timeline': '24 to 48 hours',
            'result':   'Artists with booking systems average 2.4x more monthly clients with zero additional outreach.',
            'service':  'Booking System Setup'
        }
    if 'map pack' in title or 'local visibility' in title:
        return {
            'fix': ('JRZ Ink Systems implements the exact signals required for tattoo shop map pack ranking: '
                    'GBP optimization, schema markup, NAP citation consistency, review velocity, '
                    'and on-site local keyword wiring. All monitored weekly.'),
            'timeline': '2–4 weeks for initial movement; 60–90 days for stable placement',
            'result':   'Map pack position captures 44% of all "tattoo near me" search clicks in your city.',
            'service':  'Local SEO'
        }
    if 'instagram' in title:
        return {
            'fix': ('JRZ Ink Systems manages your Instagram end-to-end — portfolio posts, Reels, '
                    'Stories, and local geo-targeted content. 4–5 posts per week, '
                    'fully branded to your style. You keep creating the art. We build the audience.'),
            'timeline': '5 to 7 business days to launch full content calendar',
            'result':   'Consistent posting at 4x/week generates 3x more profile visits and 2x more booking inquiries.',
            'service':  'Social Media Management'
        }
    if 'website' in title:
        return {
            'fix': ('JRZ Ink Systems builds your complete artist website — portfolio gallery by style, '
                    'booking integration, Google Analytics, Search Console, and local SEO wiring. '
                    'Mobile-first, no templates, built specifically for tattoo artists.'),
            'timeline': '48 to 72 hours',
            'result':   'A permanent, Google-indexed booking hub you own — immune to algorithm changes.',
            'service':  'Website Build'
        }
    if 'review' in title or 'reputation' in title:
        return {
            'fix': ('JRZ Ink Systems deploys automated post-appointment SMS review requests — '
                    'sent 24 hours after every session with a direct Google review link. '
                    'Response monitoring and owner replies handled weekly.'),
            'timeline': '3 to 5 business days to activate',
            'result':   'Artists average 20 to 40 new reviews within 60 days of activation.',
            'service':  'Review Automation'
        }
    if 'schema' in title or 'seo' in title:
        return {
            'fix': ('JRZ Ink Systems implements LocalBusiness schema, optimizes meta titles and '
                    'descriptions for tattoo + city keywords, and submits to Google Search Console.'),
            'timeline': '24 hours',
            'result':   'Stronger local keyword signal to Google. Typical local ranking improvement within 30–60 days.',
            'service':  'Technical SEO'
        }
    if 'deposit' in title or 'policy' in title:
        return {
            'fix': ('JRZ Ink Systems writes and adds your deposit policy, consultation process, '
                    'and booking FAQ to your website. Clients arrive prepared and committed.'),
            'timeline': '24 hours',
            'result':   'No-show rate drops 60–80% when deposit policy is clearly communicated upfront.',
            'service':  'Booking System Setup'
        }
    return {
        'fix': ('JRZ Ink Systems audits this issue, identifies the root cause, and implements '
                'a targeted fix. All work is done by our team — no technical input required from you.'),
        'timeline': '2 to 5 business days',
        'result':   'Issue resolved and documented in your monthly performance report.',
        'service':  'General Optimization'
    }


def build_tattoo_roadmap(issues):
    steps = []
    for i, issue in enumerate(issues, 1):
        action = get_jrz_ink_action(issue)
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


# ── INSTAGRAM BIO AI RECOMMENDATIONS ─────────────────────────────────
# Rule-based smart copy — no external AI API required.
# Generates 3 bio variants + a scored breakdown of what's missing.

def generate_bio_recommendations(place, site_data, tattoo_extras, social_data, city):
    """
    Analyzes the artist's current signals and generates:
    - 3 ready-to-paste Instagram bio templates
    - A scored checklist of what an optimized bio should have
    - Specific copy recommendations per gap
    """
    name     = place.get('name', '')
    styles   = tattoo_extras.get('detected_styles', [])
    has_bk   = tattoo_extras.get('has_tattoo_booking', False) or site_data.get('has_booking_widget', False)
    bk_plat  = tattoo_extras.get('booking_platform', '')
    website  = place.get('website', '')
    phone    = place.get('formatted_phone_number', '')
    rating   = place.get('rating', 0)
    reviews  = place.get('user_ratings_total', 0)
    ig_fol   = (social_data or {}).get('instagram_followers')
    city_str = city or 'your city'

    # ── Derive artist short name ──────────────────────────────────────
    # Extract first word if studio name; else use full name
    short_name = name.split()[0] if name else 'Artist'

    # ── Primary style phrase ─────────────────────────────────────────
    if styles:
        top_style = styles[0].title()
        style_phrase = f'{top_style} Tattoo Artist'
    else:
        style_phrase = 'Custom Tattoo Artist'

    # ── Booking CTA line ─────────────────────────────────────────────
    if has_bk and bk_plat:
        booking_line = f'Book via {bk_plat} — link below ↓'
    elif has_bk:
        booking_line = 'Online booking — link below ↓'
    elif website:
        booking_line = f'DM to book · full portfolio at {website.replace("https://","").replace("http://","").split("/")[0]}'
    elif phone:
        booking_line = f'DM or call to book · {phone}'
    else:
        booking_line = 'DM to book your consultation'

    # ── Review social proof ───────────────────────────────────────────
    if reviews >= 100:
        proof_line = f'⭐ {rating}/5 · {reviews}+ Google reviews'
    elif reviews >= 25:
        proof_line = f'⭐ {rating}/5 on Google'
    else:
        proof_line = ''

    # ── Multi-style line ─────────────────────────────────────────────
    if len(styles) >= 2:
        style_list = ' · '.join(s.title() for s in styles[:3])
    elif styles:
        style_list = styles[0].title()
    else:
        style_list = 'Custom Work · All Styles Welcome'

    # ── Generate 3 bio variants ───────────────────────────────────────
    bios = []

    # Variant 1: Clean + Local
    v1_lines = [
        f'{style_phrase}',
        f'📍 {city_str}',
        style_list,
        booking_line,
    ]
    if proof_line:
        v1_lines.insert(2, proof_line)
    bios.append({
        'label': 'Clean + Local (recommended)',
        'bio':   '\n'.join(v1_lines),
        'why':   'Shows your style, city, and booking path in under 5 seconds. Local clients know immediately you\'re near them.',
    })

    # Variant 2: Personality-forward
    v2_lines = [
        f'Custom ink. Serious art.',
        f'{style_list}',
        f'📍 {city_str} · DM for availability',
        booking_line,
    ]
    if proof_line:
        v2_lines.insert(2, proof_line)
    bios.append({
        'label': 'Bold + Direct',
        'bio':   '\n'.join(v2_lines),
        'why':   'Works well for artists with strong visual portfolios. The hook leads with attitude, not job title.',
    })

    # Variant 3: Conversion-maxed
    v3_lines = [
        f'🎨 {style_phrase} — {city_str}',
        f'Specializing in: {style_list}',
        f'Limited slots available',
        booking_line,
    ]
    if proof_line:
        v3_lines.append(proof_line)
    bios.append({
        'label': 'Urgency + Booking',
        'bio':   '\n'.join(v3_lines),
        'why':   'Creates urgency with "limited slots" and leads every line toward a booking action.',
    })

    # ── Bio gap checklist ─────────────────────────────────────────────
    gaps = []
    if not styles:
        gaps.append({
            'issue': 'No tattoo style mentioned in bio',
            'impact': 'Clients don\'t know your specialty — they skip to the next artist',
            'fix':    f'Add your primary style: "Realism · Black & Grey · Traditional" — this alone increases profile-to-DM conversion.',
        })
    if not city:
        gaps.append({
            'issue': 'No location in bio',
            'impact': 'Local clients don\'t know you\'re near them. Instagram shows you in local results but your bio doesn\'t confirm it.',
            'fix':    f'Add "📍 [Your City]" on its own line. This is the #1 thing missing from most tattoo artist bios.',
        })
    if not has_bk:
        gaps.append({
            'issue': 'No booking link or clear booking CTA',
            'impact': 'Clients who want to book have to DM and wait — most won\'t. You\'re losing warm leads hourly.',
            'fix':    'Add a Calendly, Booksy, or Vagaro link as your link-in-bio. "Book now — link below ↓" on the last line.',
        })
    if not proof_line:
        gaps.append({
            'issue': 'No social proof or credibility signal',
            'impact': 'New visitors have no reason to trust you over other artists with visible reviews.',
            'fix':    f'Once you hit 25+ Google reviews, add "⭐ {rating}/5 on Google" to your bio.',
        })
    if not website:
        gaps.append({
            'issue': 'No website linked',
            'impact': 'Instagram link-in-bio is your only lead channel — one algorithm change and it\'s gone.',
            'fix':    'JRZ Ink Systems builds your artist website in 48h and wires it to your booking system and Google profile.',
        })

    return {
        'bio_variants':   bios,
        'bio_gaps':       gaps,
        'style_detected': styles,
        'city_used':      city_str,
        'has_booking':    has_bk,
    }


# ── TATTOO REPORT BUILDER ─────────────────────────────────────────────

def build_tattoo_report(place, pagespeed, site_data, tattoo_extras, competitors,
                         keyword_rankings, place_id, backlink_data,
                         review_intel, gbp_desc, map_pack_data, social_data, city, state,
                         ad_library=None):
    name    = place.get('name', '')
    rating  = place.get('rating', 0)
    reviews = place.get('user_ratings_total', 0)
    website = place.get('website', '')
    phone   = place.get('formatted_phone_number', '')
    photos  = len(place.get('photos', []))
    address = place.get('formatted_address', '')

    checklist = {}
    vis  = score_ink_visibility(place, site_data, keyword_rankings, checklist)
    tr   = score_ink_trust(place, site_data, checklist)
    bk   = score_ink_booking(place, site_data, tattoo_extras, checklist)
    fu   = score_ink_followup(site_data, review_intel, checklist)
    cnt  = score_ink_content(social_data, site_data, tattoo_extras, checklist)
    comp = score_ink_competitor(map_pack_data, place, competitors, checklist)

    overall = vis + tr + bk + fu + cnt + comp
    grade   = letter_grade(overall)

    # PageSpeed detail
    lcp = fcp = tbt = cls_val = speed_index = ''
    perf_score = seo_score_ps = 0
    if pagespeed and 'lighthouseResult' in pagespeed:
        audits      = pagespeed['lighthouseResult'].get('audits', {})
        cats        = pagespeed['lighthouseResult'].get('categories', {})
        lcp         = audits.get('largest-contentful-paint', {}).get('displayValue', '')
        fcp         = audits.get('first-contentful-paint',   {}).get('displayValue', '')
        tbt         = audits.get('total-blocking-time',       {}).get('displayValue', '')
        cls_val     = audits.get('cumulative-layout-shift',   {}).get('displayValue', '')
        perf_score  = int((cats.get('performance', {}).get('score') or 0) * 100)
        raw_seo     = cats.get('seo', {}).get('score')
        seo_score_ps = int(raw_seo * 100) if raw_seo is not None else None

    scores = {
        'overall':          overall,
        'grade':            grade,
        'grade_message':    GRADE_MESSAGES.get(grade, ''),
        'visibility':       vis,
        'trust':            tr,
        'booking_funnel':   bk,
        'followup':         fu,
        'content':          cnt,
        'competitor':       comp,
    }

    issues = build_tattoo_issues(
        place, site_data, tattoo_extras, social_data,
        review_intel, map_pack_data, scores
    )
    roadmap  = build_tattoo_roadmap(issues)
    revenue  = estimate_tattoo_revenue(place, city, overall, social_data, tattoo_extras)
    bio_recs = generate_bio_recommendations(place, site_data, tattoo_extras, social_data, city)

    # Competitor insight — include FB data + ad library cross-reference
    ad_lib = ad_library or []
    ad_advertisers = {a.get('page_name', '').lower() for a in ad_lib}
    comp_list = []
    for c in competitors[:4]:
        c_name = c.get('name', '')
        # Check if this competitor appears in the Meta Ad Library
        running_ads = any(
            c_name.lower() in adv or adv in c_name.lower()
            for adv in ad_advertisers
        )
        comp_list.append({
            'name':         c_name,
            'rating':       c.get('rating', 0),
            'reviews':      c.get('user_ratings_total', 0),
            'address':      c.get('vicinity', ''),
            'fb_page_name': c.get('fb_page_name', ''),
            'fb_fans':      c.get('fb_fans'),
            'fb_followers': c.get('fb_followers'),
            'running_ads':  running_ads,
        })
    comp_insight = None
    active = [c for c in comp_list if c['rating']]
    if active:
        avg_rev = sum(c['reviews'] for c in active) / len(active)
        avg_rat = sum(c['rating']  for c in active) / len(active)
        if avg_rev > reviews * 1.3:
            comp_insight = (
                f'Your top competitors average {int(avg_rev)} Google reviews '
                f'compared to your {reviews}. That gap directly reduces how often '
                f'you appear when clients search "tattoo near me."'
            )
        elif avg_rat > rating + 0.1:
            comp_insight = (
                f'Competitors in your area average {avg_rat:.1f} stars vs your '
                f'{rating} stars. A 0.2-star gap shifts 20% of undecided clients '
                f'to competing studios.'
            )

    # Free tip
    if not tattoo_extras.get('has_tattoo_booking'):
        free_tip = {
            'action': ('Add your booking link to the first line of your Instagram bio right now. '
                       'If you use Calendly, Booksy, or Vagaro, paste the direct booking URL — '
                       'not your homepage. Test it on mobile to confirm it works. '
                       'This single change can increase direct booking inquiries within 24 hours.'),
            'impact': 'Artists with a direct booking link in their bio receive 3x more booking inquiries than those without.'
        }
    elif reviews < 25:
        free_tip = {
            'action': ('After your next 3 appointments, send each client a personal text: '
                       '"Hey [name], really enjoyed your session today. If you\'d leave us a '
                       'Google review it would mean a lot — here\'s the direct link: [link]." '
                       'Send it individually, not as a group message.'),
            'impact': 'Personal review requests convert at 35–50%. Three messages typically generate 1–2 new reviews within 48 hours.'
        }
    else:
        free_tip = {
            'action': ('Reply to your 5 most recent Google reviews today. Start each reply with '
                       'the client\'s name and mention your city and tattoo style naturally. '
                       'Example: "Thank you [name] — we love doing realism work here in Orlando. '
                       'Come back for your next piece anytime!"'),
            'impact': 'Active review responses improve local search ranking and show potential clients you are attentive and professional.'
        }

    return {
        'place_id':    place_id,
        'business': {
            'name': name, 'address': address, 'city': city,
            'rating': rating, 'reviews': reviews, 'website': website,
            'phone': phone, 'photos': photos, 'has_hours': bool(place.get('opening_hours'))
        },
        'scores':      scores,
        'checklists':  checklist,
        'issues':      issues,
        'roadmap':     roadmap,
        'revenue':     revenue,
        'social_presence': {
            'facebook_followers':      (social_data or {}).get('facebook_followers'),
            'instagram_followers':     (social_data or {}).get('instagram_followers'),
            'instagram_media_count':   (social_data or {}).get('instagram_media_count'),
            'instagram_username':      (social_data or {}).get('instagram_username'),
            'instagram_last_post_days':(social_data or {}).get('instagram_last_post_days'),
            'facebook_last_post_days': (social_data or {}).get('facebook_last_post_days'),
            'social_links':            site_data.get('social_links', []),
        },
        'review_intel': {
            'velocity':          (review_intel or {}).get('velocity', 'No data'),
            'velocity_score':    (review_intel or {}).get('velocity_score', 0),
            'recent_30':         (review_intel or {}).get('recent_30', 0),
            'response_rate':     (review_intel or {}).get('response_rate', 0),
            'newest_review_days':(review_intel or {}).get('newest_review_days'),
            'total_sampled':     (review_intel or {}).get('total_sampled', 0),
        },
        'map_pack':         map_pack_data or [],
        'tattoo_extras':    tattoo_extras,
        'competitors':      comp_list,
        'competitor_insight': comp_insight,
        'keyword_rankings': keyword_rankings,
        'pagespeed_detail': {
            'lcp': lcp, 'fcp': fcp, 'tbt': tbt,
            'cls': cls_val, 'performance': perf_score, 'seo': seo_score_ps
        },
        'luis_farrera_proof': {
            'ctr': '5.06%', 'cpl': '$14.83', 'leads': 84, 'days': 30
        },
        'free_tip':         free_tip,
        'gbp_description':  gbp_desc,
        'ad_library':       ad_library or [],
        'bio_recommendations': bio_recs,
    }


# ── GHL WEBHOOK — INK SYSTEMS ─────────────────────────────────────────

def fire_ghl_ink(report):
    b = report['business']
    s = report['scores']
    try:
        requests.post(GHL_INK_WEBHOOK, json={
            'firstName':        b['name'].split()[0] if b['name'] else '',
            'name':             b['name'],
            'phone':            b.get('phone', ''),
            'website':          b.get('website', ''),
            'address1':         b.get('address', ''),
            'source':           'jrz-ink-grader',
            'overall_score':    s['overall'],
            'grade':            s['grade'],
            'visibility_score': s['visibility'],
            'trust_score':      s['trust'],
            'booking_score':    s['booking_funnel'],
            'content_score':    s['content'],
            'issues_count':     len(report['issues']),
            'revenue_opportunity': report['revenue'].get('opportunity_base', 0),
            'tags': [f"grade:{s['grade']}", 'ink-grader-lead', 'tattoo-artist', 'needs-followup']
        }, timeout=5)
    except Exception:
        pass


# ═══════════════════════════════════════════════════════════════════
#  JRZ INK SYSTEMS — GUEST CITY AUDIT ENGINE
#  A tattoo artist scouts a new city before booking a guest spot.
#  Returns: market opportunity score, competition breakdown, revenue estimate.
# ═══════════════════════════════════════════════════════════════════

@app.route('/api/grade-guest-city', methods=['POST'])
def grade_guest_city():
    data  = request.get_json(force=True)
    city  = data.get('city', '').strip()
    state = data.get('state', '').strip()
    style = data.get('style', '').strip()

    if not city:
        return jsonify({'error': 'City is required'}), 400

    city_display = f'{city}, {state}' if state else city
    cache_key    = hashlib.md5(f'guest:{city_display.lower()}'.encode()).hexdigest()
    if cache_key in CACHE and time.time() - CACHE[cache_key]['ts'] < 600:
        return jsonify(CACHE[cache_key]['data'])

    # 1. Geocode city center
    lat, lng = geocode_city(city, state)
    if not lat:
        return jsonify({'error': f'Could not locate "{city_display}". Try including the state abbreviation.'}), 400

    # 2. Find tattoo artists in city
    artists, artist_count_capped = find_tattoo_artists_in_city(lat, lng)

    # 3. Map pack — who owns the 3-pack for "tattoo artist [city]"?
    map_pack = []
    if DFS_LOGIN and DFS_PASSWORD:
        try:
            map_pack = check_city_map_pack(city, state)
        except Exception:
            pass

    # 4. Meta Ad Library — who's running ads in this city?
    ads = []
    if FB_TOKEN:
        try:
            ads = check_ad_library(city, state)
        except Exception:
            pass

    # 5. City pricing benchmarks
    benchmarks = get_city_benchmarks(city)

    # 6. Demand signal (DataForSEO SERP)
    serp_data = {}
    if DFS_LOGIN and DFS_PASSWORD:
        try:
            serp_data = check_guest_city_demand(city, state)
        except Exception:
            pass

    # 7. Build and return report
    report = build_guest_city_report(city, state, style, artists, map_pack, ads,
                                      benchmarks, serp_data, lat, lng,
                                      artist_count_capped=artist_count_capped)
    CACHE[cache_key] = {'ts': time.time(), 'data': report}

    # ── Log this audit for city benchmarking ─────────────────────────
    try:
        opp_score = report.get('opportunity', {}).get('total', 0)
        avg_rev   = report.get('competition', {}).get('avg_reviews', 0)
        CITY_AUDIT_LOG.append({
            'city':          city,
            'state':         state,
            'style':         style or 'all',
            'artist_count':  len(artists),
            'avg_reviews':   avg_rev,
            'avg_price':     benchmarks.get('avg_price', 0),
            'opp_score':     opp_score,
            'ts':            datetime.datetime.utcnow().isoformat(),
        })
        if len(CITY_AUDIT_LOG) > 500:
            CITY_AUDIT_LOG.pop(0)
    except Exception:
        pass

    try:
        fire_ghl_guest_city(report)
    except Exception:
        pass

    return jsonify(report)


# ── GUEST CITY HELPERS ───────────────────────────────────────────────

def geocode_city(city, state):
    """
    Get lat/lng for a city center.
    Primary: Google Places Text Search (same API key as autocomplete — always enabled).
    Fallback: Google Geocoding API (requires separate enablement — may not be on).
    """
    query = f'{city}, {state}, United States' if state else f'{city}, United States'

    # ── Primary: Places Text Search ──────────────────────────────────────
    try:
        r = requests.get(
            'https://maps.googleapis.com/maps/api/place/textsearch/json',
            params={'query': query, 'key': GOOGLE_KEY},
            timeout=6
        )
        results = r.json().get('results', [])
        if results:
            loc = results[0]['geometry']['location']
            return loc['lat'], loc['lng']
    except Exception:
        pass

    # ── Fallback: Geocoding API ───────────────────────────────────────────
    try:
        r = requests.get(
            'https://maps.googleapis.com/maps/api/geocode/json',
            params={'address': query, 'key': GOOGLE_KEY},
            timeout=6
        )
        results = r.json().get('results', [])
        if results:
            loc = results[0]['geometry']['location']
            return loc['lat'], loc['lng']
    except Exception:
        pass

    return None, None


def find_tattoo_artists_in_city(lat, lng):
    """
    Nearby Search for tattoo artists within 15 km of city center.
    Returns (artists_list, count_capped) — capped=True means Google hit its
    20-result-per-page ceiling and the real count is likely higher.
    """
    try:
        r = requests.get(
            'https://maps.googleapis.com/maps/api/place/nearbysearch/json',
            params={
                'location': f'{lat},{lng}',
                'radius':   15000,
                'type':     'tattoo_parlor',
                'keyword':  'tattoo',
                'key':      GOOGLE_KEY,
            },
            timeout=8
        )
        results   = r.json().get('results', [])
        TATTOO_KW = {'tattoo', 'ink', 'piercing', 'tat'}
        artists   = [
            {
                'name':    a.get('name', ''),
                'rating':  a.get('rating', 0),
                'reviews': a.get('user_ratings_total', 0),
                'address': a.get('vicinity', ''),
            }
            for a in results
            if a.get('business_status') == 'OPERATIONAL'
            and (
                'tattoo_parlor' in a.get('types', []) or
                any(kw in a.get('name', '').lower() for kw in TATTOO_KW)
            )
            and not any(xt in (a.get('types') or []) for xt in [
                'lodging', 'hotel', 'restaurant', 'gas_station',
                'grocery_or_supermarket', 'bank', 'hospital',
            ])
        ]
        # Google Nearby Search caps at 20 per page — flag so UI can show "20+"
        capped = len(artists) >= 20
        return artists[:20], capped
    except Exception:
        return [], False


def check_city_map_pack(city, state):
    """Who's in Google's 3-pack for 'tattoo artist [city]'?"""
    if not (DFS_LOGIN and DFS_PASSWORD):
        return []
    keyword = f'tattoo artist {city}'
    try:
        resp = requests.post(
            'https://api.dataforseo.com/v3/serp/google/local_pack/live/advanced',
            auth=(DFS_LOGIN, DFS_PASSWORD),
            json=[{
                'keyword':       keyword,
                'location_name': f'{city},{state},United States' if state else f'{city},United States',
                'language_name': 'English',
            }],
            timeout=15
        )
        data       = resp.json()
        result_obj = (((data.get('tasks') or [{}])[0].get('result') or [{}])[0])
        items      = result_obj.get('items') or []
        pack_items = [i for i in items if i.get('type') == 'local_pack']
        pack = []
        for item in pack_items:
            rating_obj = item.get('rating') or {}
            pack.append({
                'name':    item.get('title', ''),
                'rating':  rating_obj.get('value')       if isinstance(rating_obj, dict) else None,
                'reviews': rating_obj.get('votes_count') if isinstance(rating_obj, dict) else None,
                'address': item.get('address', ''),
            })
        return pack
    except Exception:
        return []


def check_guest_city_demand(city, state):
    """DataForSEO SERP for 'tattoo artist [city]' — demand proxy."""
    if not (DFS_LOGIN and DFS_PASSWORD):
        return {}
    keyword = f'tattoo artist {city}'
    try:
        resp = requests.post(
            'https://api.dataforseo.com/v3/serp/google/organic/live/advanced',
            auth=(DFS_LOGIN, DFS_PASSWORD),
            json=[{
                'keyword':       keyword,
                'location_name': f'{city},{state},United States' if state else f'{city},United States',
                'language_name': 'English',
                'depth':         10,
            }],
            timeout=12
        )
        data        = resp.json()
        task_result = (data.get('tasks') or [{}])[0].get('result') or []
        total_count = int((task_result[0].get('se_results_count', 0)) if task_result else 0)
        items       = (task_result[0].get('items') or []) if task_result else []
        top_results = [
            {
                'title':  i.get('title', ''),
                'domain': i.get('domain', ''),
                'rank':   i.get('rank_absolute'),
            }
            for i in items[:5] if i.get('type') == 'organic'
        ]
        return {'keyword': keyword, 'result_count': total_count, 'top_results': top_results}
    except Exception:
        return {}


def get_city_benchmarks(city):
    """Return pricing/volume benchmarks for a given city."""
    city_key = city.lower().strip()
    if city_key in TATTOO_CITY_BENCHMARKS:
        return TATTOO_CITY_BENCHMARKS[city_key]
    for key in TATTOO_CITY_BENCHMARKS:
        if key != 'default' and (key in city_key or city_key in key):
            return TATTOO_CITY_BENCHMARKS[key]
    return TATTOO_CITY_BENCHMARKS['default']


def calculate_opportunity_score(artists, map_pack, ads, benchmarks):
    """
    Score a city as a guest artist opportunity. Returns 0–100.
    4 components: Demand signal (35) + Competition barrier (35) +
                  Revenue potential (20) + Market activity (10)
    """
    # ── Demand signal (0-35) ── More artists = proven client base
    n = len(artists)
    if   n == 0:  demand_score = 10   # unknown market
    elif n <= 5:  demand_score = 18   # small / emerging
    elif n <= 10: demand_score = 28   # healthy market
    elif n <= 20: demand_score = 35   # strong demand
    else:         demand_score = 25   # high demand but very saturated

    # ── Competition barrier (0-35) ── Lower avg reviews = easier to stand out
    has_r = [a for a in artists if a.get('reviews', 0) > 0]
    avg_reviews = sum(a['reviews'] for a in has_r) / len(has_r) if has_r else 0
    avg_rating  = sum(a['rating']  for a in has_r) / len(has_r) if has_r else 0

    if   avg_reviews == 0:  barrier_score = 20
    elif avg_reviews < 50:  barrier_score = 35   # new market — low barrier
    elif avg_reviews < 150: barrier_score = 25   # moderate barrier
    elif avg_reviews < 300: barrier_score = 15   # high barrier
    else:                   barrier_score = 8    # very established

    # ── Revenue potential (0-20) ── Higher session prices = better earnings
    avg_price = benchmarks.get('avg_price', 200)
    if   avg_price >= 320: rev_score = 20
    elif avg_price >= 260: rev_score = 16
    elif avg_price >= 220: rev_score = 12
    elif avg_price >= 180: rev_score = 8
    else:                  rev_score = 5

    # ── Market activity (0-10) ── Ads running = active paying client demand
    n_ads = len(ads)
    if   n_ads == 0:  activity_score = 5
    elif n_ads <= 2:  activity_score = 8
    else:             activity_score = 10

    return {
        'total':          min(demand_score + barrier_score + rev_score + activity_score, 100),
        'demand_score':   demand_score,
        'barrier_score':  barrier_score,
        'rev_score':      rev_score,
        'activity_score': activity_score,
        'avg_reviews':    round(avg_reviews, 1),
        'avg_rating':     round(avg_rating, 1),
        'artist_count':   n,
    }


def get_opportunity_verdict(score):
    """Plain-language verdict for the opportunity score."""
    if score >= 70:
        return {
            'label':    'STRONG OPPORTUNITY',
            'color':    '#00cc66',
            'headline': 'This city is worth the trip.',
            'body':     ('Proven tattoo demand, accessible competition, and solid earning potential. '
                         'Guest artists with a strong IG presence can build a clientele here fast. '
                         'JRZ Ink Systems can run city-targeted Meta Ads ahead of your arrival to pre-book slots.'),
        }
    elif score >= 50:
        return {
            'label':    'MODERATE OPPORTUNITY',
            'color':    '#ff9900',
            'headline': 'Viable — with the right positioning.',
            'body':     ('This market has demand but also established local artists. '
                         'Guest artists who specialize in a niche style not well-represented locally '
                         'can carve out strong bookings. Pre-arrival Instagram content targeting this city is key.'),
        }
    elif score >= 30:
        return {
            'label':    'PROCEED WITH CAUTION',
            'color':    '#ff6644',
            'headline': 'High barriers or limited demand.',
            'body':     ('The local market is either very established (artists with 300+ reviews) '
                         'or the client base is smaller than average. Doable with a loyal existing IG following, '
                         'but cold entry is difficult. Consider a nearby larger market first.'),
        }
    else:
        return {
            'label':    'NOT RECOMMENDED',
            'color':    '#ff4444',
            'headline': 'This city is not optimal right now.',
            'body':     ('Limited tattoo demand, very few active artists, or below-average session pricing. '
                         'Your time is better spent in a higher-yield market. Try a nearby major city.'),
        }


def build_guest_city_report(city, state, style, artists, map_pack, ads,
                              benchmarks, serp_data, lat, lng,
                              artist_count_capped=False):
    opp     = calculate_opportunity_score(artists, map_pack, ads, benchmarks)
    verdict = get_opportunity_verdict(opp['total'])

    avg_price  = benchmarks.get('avg_price', 200)
    high_price = benchmarks.get('high', 300)
    max_sess   = benchmarks.get('monthly_sessions', 32)

    # 2-week guest stint estimate (50% of full-time monthly volume)
    g2w_low  = int(max_sess * 0.50 * 0.55 * avg_price)
    g2w_high = int(max_sess * 0.50 * 0.80 * high_price)

    # Seasonal timing note
    month = datetime.datetime.now().month
    if   month in [6, 7, 8]:  season = ('🔥 Peak Season — bookings run 20–30% higher nationwide in summer. '
                                          'Strong timing for a guest spot.')
    elif month in [12, 1, 2]: season = ('❄️ Slower season in most markets. '
                                          'Consider a shorter 1-week trial — or target warmer-weather cities.')
    elif month in [3, 4, 5]:  season = ('🌱 Spring secondary peak — clients book early for summer looks. '
                                          'Good timing, especially for color and fine-line work.')
    else:                      season = ('🍂 Fall is excellent for tattooing — cooler temps = better healing, '
                                          'and clients book before the holidays. Solid window.')

    top_artists = sorted(artists, key=lambda x: x.get('reviews', 0), reverse=True)[:5]

    return {
        'type':         'guest_city',
        'city':         city,
        'state':        state,
        'city_display': f'{city}, {state}' if state else city,
        'style':        style or None,
        'opportunity':  {**opp, **verdict},
        'benchmarks': {
            'avg_price':        avg_price,
            'high_price':       high_price,
            'monthly_sessions': max_sess,
        },
        'revenue_estimate': {
            'low':       g2w_low,
            'high':      g2w_high,
            'avg_price': avg_price,
            'note':      f'Based on {city} market benchmarks for a 2-week guest stint',
        },
        'competition': {
            'artist_count':        opp['artist_count'],
            'artist_count_capped': artist_count_capped,   # True = Google hit 20-result cap; real count is higher
            'avg_reviews':         opp['avg_reviews'],
            'avg_rating':          opp['avg_rating'],
            'top_artists':         top_artists,
        },
        'map_pack':     map_pack,
        'ad_activity':  {'count': len(ads), 'ads': ads[:4]},
        'demand':       serp_data,
        'seasonal_note': season,
    }


def fire_ghl_guest_city(report):
    """GHL lead capture for guest city audit — fire to same ink webhook."""
    try:
        requests.post(GHL_INK_WEBHOOK, json={
            'name':              f'Guest Audit — {report["city_display"]}',
            'firstName':         'Guest',
            'source':            'jrz-ink-guest-city',
            'city':              report.get('city', ''),
            'state':             report.get('state', ''),
            'opportunity_score': report['opportunity']['total'],
            'verdict':           report['opportunity']['label'],
            'artist_count':      report['competition']['artist_count'],
            'avg_price':         report['benchmarks']['avg_price'],
            'tags':              ['guest-city-audit', 'ink-grader-lead', 'tattoo-artist'],
        }, timeout=5)
    except Exception:
        pass


@app.route('/api/city-insights')
def city_insights():
    """
    Real market data accumulated from Guest City Audits run on this server instance.
    Resets on server restart — data grows as more artists run audits.
    Use this to progressively improve TATTOO_CITY_BENCHMARKS with real-world figures.
    """
    if not CITY_AUDIT_LOG:
        return jsonify({
            'message': 'No data yet. City insights accumulate as artists run Guest City Audits.',
            'total_audits': 0,
            'cities_tracked': 0
        })

    from collections import defaultdict
    city_data = defaultdict(list)
    for entry in CITY_AUDIT_LOG:
        key = f"{entry['city'].lower()}, {entry.get('state', '').upper()}".strip(', ')
        city_data[key].append(entry)

    insights = {}
    for city_key, entries in sorted(city_data.items()):
        insights[city_key] = {
            'audit_count':          len(entries),
            'avg_artist_count':     round(sum(e['artist_count'] for e in entries) / len(entries), 1),
            'avg_reviews_market':   round(sum(e['avg_reviews']  for e in entries) / len(entries), 1),
            'avg_price_benchmark':  round(sum(e['avg_price']    for e in entries) / len(entries), 0),
            'avg_opp_score':        round(sum(e['opp_score']    for e in entries) / len(entries), 1),
            'last_audited':         max(e['ts'] for e in entries),
        }

    return jsonify({
        'total_audits':   len(CITY_AUDIT_LOG),
        'cities_tracked': len(insights),
        'city_insights':  insights,
        'note':           'Data accumulates in-memory. Resets on server restart. 50+ audits per city unlocks reliable real-world benchmark updates.',
    })


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=False)
