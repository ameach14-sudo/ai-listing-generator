require('dotenv').config();
const express = require('express');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

function getIP(req) {
  const forwarded = req.headers['x-forwarded-for'];
  return forwarded ? forwarded.split(',')[0].trim() : req.socket.remoteAddress;
}

function checkAdmin(req) {
  return req.headers['x-admin-token'] === process.env.ADMIN_TOKEN;
}

async function getLocation(ip) {
  try {
    if (!ip) return null;
    // Strip IPv6-mapped IPv4 prefix (e.g. ::ffff:1.2.3.4 -> 1.2.3.4)
    const clean = ip.replace(/^::ffff:/, '');
    if (clean === '::1' || clean.startsWith('127.') || clean.startsWith('10.') || clean.startsWith('192.168.')) return null;
    const res = await fetch(`http://ip-api.com/json/${clean}?fields=city,regionName,country`);
    const data = await res.json();
    console.log('Geolocation result for', clean, ':', data);
    return data.city ? `${data.city}, ${data.regionName}` : null;
  } catch (e) {
    console.error('Geolocation failed:', e.message);
    return null;
  }
}

function getDevice(req) {
  const ua = req.headers['user-agent'] || '';

  // iPhone / iPad — model not exposed in modern iOS, use iOS version
  if (/iPhone|iPod/i.test(ua)) {
    const ver = (ua.match(/OS ([\d_]+) like/) || [])[1]?.replace(/_/g, '.');
    return ver ? `iPhone (iOS ${ver})` : 'iPhone';
  }
  if (/iPad/i.test(ua)) {
    const ver = (ua.match(/OS ([\d_]+) like/) || [])[1]?.replace(/_/g, '.');
    return ver ? `iPad (iOS ${ver})` : 'iPad';
  }

  // Android — model name is between second semicolon and closing paren
  if (/Android/i.test(ua)) {
    const model = (ua.match(/Android[\d. ]+;([^)]+)/) || [])[1]?.trim();
    const type = /Mobile/i.test(ua) ? 'Android Phone' : 'Android Tablet';
    return model ? `${type} — ${model}` : type;
  }

  // Windows — extract version
  if (/Windows/i.test(ua)) {
    const nt = (ua.match(/Windows NT ([\d.]+)/) || [])[1];
    const versions = { '10.0': '10/11', '6.3': '8.1', '6.2': '8', '6.1': '7' };
    return nt ? `Windows ${versions[nt] || nt}` : 'Windows';
  }

  // Mac — extract macOS version
  if (/Macintosh|Mac OS X/i.test(ua)) {
    const ver = (ua.match(/Mac OS X ([\d_]+)/) || [])[1]?.replace(/_/g, '.');
    return ver ? `Mac (macOS ${ver})` : 'Mac';
  }

  if (/Linux/i.test(ua)) return 'Linux';
  return 'Unknown';
}

function getBrowser(req) {
  const ua = req.headers['user-agent'] || '';
  if (/Edg\//i.test(ua)) return 'Edge';
  if (/OPR\/|Opera/i.test(ua)) return 'Opera';
  if (/Firefox\/[\d.]+/i.test(ua)) return 'Firefox';
  if (/Chrome\/[\d.]+/i.test(ua) && !/Chromium/i.test(ua)) {
    const ver = (ua.match(/Chrome\/([\d]+)/) || [])[1];
    return ver ? `Chrome ${ver}` : 'Chrome';
  }
  if (/Safari\/[\d.]+/i.test(ua) && !/Chrome/i.test(ua)) return 'Safari';
  return 'Unknown';
}

async function logUsage(tool, req, details = {}) {
  try {
    const ip = getIP(req);
    const location = await getLocation(ip);
    await supabase.from('tool_usage').insert({
      tool,
      is_admin: checkAdmin(req),
      ip_address: ip,
      session_id: req.headers['x-session-id'] || null,
      details,
      location,
      device: getDevice(req),
      browser: getBrowser(req),
    });
  } catch (err) {
    console.error('Analytics log failed:', err.message);
  }
}

app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

const LENGTH_GUIDE = {
  short: 'approximately 100 words',
  medium: 'approximately 200 words',
  long: 'approximately 300 words',
};

app.post('/api/generate', async (req, res) => {
  const { type, price, beds, baths, sqft, year, neighborhood, features, tone, length, styleReference, notes } = req.body;

  if (!features) {
    return res.status(400).json({ error: 'Features are required.' });
  }

  const details = [
    type && `Property type: ${type}`,
    beds && `Bedrooms: ${beds}`,
    baths && `Bathrooms: ${baths}`,
    sqft && `Square footage: ${sqft} sq ft`,
    year && `Year built: ${year}`,
    price && `Asking price: ${price}`,
    neighborhood && `Location/neighborhood: ${neighborhood}`,
    `Key features: ${features}`,
  ].filter(Boolean).join('\n');

  const prompt = `You are an expert real estate copywriter. Write a compelling MLS listing description based on the property details below.

Guidelines:
- Tone: ${tone}
- Length: ${LENGTH_GUIDE[length] || LENGTH_GUIDE.medium}
- Do NOT include the price or address in the description unless it adds value
- Do NOT use generic filler phrases like "must see" or "won't last long"
- Lead with the most compelling feature
- Write in third person, present tense
- Output only the listing description — no title, no commentary, no formatting
${styleReference ? `\nStyle Reference — match the tone, voice, and structure of this example listing:\n"${styleReference}"` : ''}
${notes ? `\nAdditional Instructions: ${notes}` : ''}

Property Details:
${details}`;

  try {
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    });

    const description = message.content[0].text.trim();
    logUsage('listing', req, { type, beds, baths, sqft, tone, length });
    res.json({ description });
  } catch (err) {
    console.error('Anthropic error:', err.message);
    res.status(500).json({ error: 'Failed to generate listing. Please try again.' });
  }
});

const EXTRA_PROMPTS = {
  social: `You are a real estate social media expert. Based on the listing description below, write an engaging Instagram/Facebook post for a real estate agent.

Guidelines:
- Conversational, energetic tone
- Caption must be 150-250 characters (not counting hashtags) — short enough to read at a glance
- End with 8-10 relevant hashtags on a new line
- Output only the post — no commentary

Listing Description:
`,
  email: `You are a real estate copywriter. Based on the listing description below, write a "Just Listed" email a real estate agent can send to their database.

Guidelines:
- Include a subject line on the first line, formatted as: Subject: ...
- Leave a blank line, then write the email body
- Warm, professional tone
- 200-250 words total for the email body
- 3 short paragraphs max
- End with a clear call to action to schedule a showing
- Sign off with [Agent Name] as a placeholder
- Output only the subject line and email — no commentary

Listing Description:
`,
  zillow: `You are a real estate copywriter. Based on the listing description below, write an optimized version for listing sites like Zillow, Realtor.com, and Redfin.

Guidelines:
- 300-400 characters maximum — listing sites truncate long descriptions
- Lead with the 2-3 most buyer-friendly highlights
- Use natural, searchable language
- No fluff or filler phrases
- Output only the description — no commentary

Listing Description:
`,
};

app.post('/api/extra', async (req, res) => {
  const { description, type } = req.body;
  if (!description || !EXTRA_PROMPTS[type]) {
    return res.status(400).json({ error: 'Invalid request.' });
  }

  try {
    const maxTokens = { social: 150, email: 400, zillow: 100 };
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: maxTokens[type] || 300,
      messages: [{ role: 'user', content: EXTRA_PROMPTS[type] + description }],
    });
    logUsage(type, req);
    res.json({ content: message.content[0].text.trim() });
  } catch (err) {
    console.error('Anthropic error:', err.message);
    res.status(500).json({ error: 'Failed to generate. Please try again.' });
  }
});

app.post('/api/followup', async (req, res) => {
  const { name, leadType, source, timeline, priceRange, area, notes, tone } = req.body;
  if (!name) return res.status(400).json({ error: 'Lead name is required.' });

  const context = [
    `Lead name: ${name}`,
    `Lead type: ${leadType}`,
    `Lead source: ${source}`,
    `Timeline: ${timeline}`,
    priceRange && `Price range: ${priceRange}`,
    area && `Area of interest: ${area}`,
    notes && `Notes: ${notes}`,
  ].filter(Boolean).join('\n');

  const prompt = `You are an expert real estate follow-up copywriter. Write a 5-email follow-up sequence for a real estate agent to send to a lead.

Tone: ${tone}

Lead Details:
${context}

Rules:
- Each email must feel personal, not templated
- Do NOT use generic filler like "I hope this email finds you well"
- Each email has a different purpose and angle
- Keep emails concise — 100-150 words each
- The agent signs off as [Agent Name]

Return ONLY valid JSON in this exact format, no commentary:
{
  "emails": [
    {
      "purpose": "Initial Outreach",
      "timing": "Same day as first contact",
      "subject": "...",
      "body": "..."
    },
    {
      "purpose": "Value Add",
      "timing": "2 days later",
      "subject": "...",
      "body": "..."
    },
    {
      "purpose": "Check-In",
      "timing": "5 days later",
      "subject": "...",
      "body": "..."
    },
    {
      "purpose": "Market Insight",
      "timing": "10 days later",
      "subject": "...",
      "body": "..."
    },
    {
      "purpose": "Final Touch",
      "timing": "2 weeks later",
      "subject": "...",
      "body": "..."
    }
  ]
}`;

  try {
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = message.content[0].text.trim().replace(/^```json\s*/i, '').replace(/```\s*$/i, '');
    const parsed = JSON.parse(raw);
    logUsage('followup', req, { leadType, source, timeline, tone });
    res.json(parsed);
  } catch (err) {
    console.error('Follow-up error:', err.message);
    res.status(500).json({ error: 'Failed to generate sequence. Please try again.' });
  }
});

app.post('/api/objection', async (req, res) => {
  const { objection, role, delivery, context, tone } = req.body;
  if (!objection) return res.status(400).json({ error: 'Objection is required.' });

  const prompt = `You are an expert real estate coach. Write a natural, confident response a real estate agent can use when they hear this objection from a client.

Agent role: ${role}
Delivery: ${delivery}
Tone: ${tone}
${context ? `Context: ${context}` : ''}

Objection: "${objection}"

Guidelines:
- Sound like a real person talking, not a script
- Acknowledge the concern before responding — don't be dismissive
- Be concise — 3-5 sentences max for in-person/phone, slightly longer for text/email
- Do NOT use cheesy sales phrases like "Great question!" or "I totally understand where you're coming from"
- Give them a reason to keep the conversation going
- Output only the response — no labels, no commentary`;

  try {
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    });
    logUsage('objection', req, { role, delivery, tone });
    res.json({ response: message.content[0].text.trim() });
  } catch (err) {
    console.error('Objection error:', err.message);
    res.status(500).json({ error: 'Failed to generate response. Please try again.' });
  }
});

app.post('/api/prospecting', async (req, res) => {
  const { target, delivery, goal, context, tone } = req.body;
  if (!target) return res.status(400).json({ error: 'Target is required.' });

  const prompt = `You are an expert real estate prospecting copywriter. Write 3 distinct outreach templates a real estate agent can use right now.

Target: ${target}
Delivery method: ${delivery}
Goal: ${goal}
Tone: ${tone}
${context ? `Context: ${context}` : ''}

Rules:
- Each variation must have a meaningfully different angle or hook — not just rephrased
- Sound like a real person, not a script
- No generic openers like "I hope this message finds you well" or "My name is [Agent] and I'm a real estate agent"
- Get to the point fast — especially for call scripts and texts
- For call scripts: include natural pauses and a clear ask
- For texts: keep it under 160 characters if possible
- For emails: include a subject line on the first line as "Subject: ..."
- The agent signs off as [Agent Name]
- Do NOT use cheesy lines or pressure tactics

Return ONLY valid JSON in this exact format, no commentary:
{
  "variations": [
    { "angle": "Short label for this angle", "body": "Full template text here" },
    { "angle": "Short label for this angle", "body": "Full template text here" },
    { "angle": "Short label for this angle", "body": "Full template text here" }
  ]
}`;

  try {
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1200,
      messages: [{ role: 'user', content: prompt }],
    });
    const raw = message.content[0].text.trim().replace(/^```json\s*/i, '').replace(/```\s*$/i, '');
    const parsed = JSON.parse(raw);
    logUsage('prospecting', req, { target, delivery, goal, tone });
    res.json(parsed);
  } catch (err) {
    console.error('Prospecting error:', err.message);
    res.status(500).json({ error: 'Failed to generate templates. Please try again.' });
  }
});

app.post('/api/log/paywall', async (req, res) => {
  await logUsage('paywall', req);
  res.json({ ok: true });
});

app.post('/api/log/visit', async (req, res) => {
  const { page, referrer, visit_count } = req.body;
  try {
    const ip = getIP(req);
    const location = await getLocation(ip);
    const { data } = await supabase.from('tool_usage').insert({
      tool: 'visit',
      is_admin: checkAdmin(req),
      ip_address: ip,
      session_id: req.headers['x-session-id'] || null,
      details: { page: page || 'unknown' },
      location,
      device: getDevice(req),
      browser: getBrowser(req),
      referrer: referrer || null,
      visit_count: visit_count || 1,
    }).select('id').single();
    res.json({ ok: true, id: data?.id || null });
  } catch (err) {
    console.error('Visit log failed:', err.message);
    res.json({ ok: false });
  }
});

app.post('/api/log/exit', async (req, res) => {
  const { id, time_on_page } = req.body;
  if (!id || !time_on_page) return res.json({ ok: false });
  try {
    await supabase.from('tool_usage').update({ time_on_page }).eq('id', id);
    res.json({ ok: true });
  } catch (err) {
    console.error('Exit log failed:', err.message);
    res.json({ ok: false });
  }
});

app.get('/api/admin/since', async (req, res) => {
  if (!checkAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const { since } = req.query;
  if (!since) return res.json({ visits: 0, generations: 0 });
  try {
    const sinceDate = new Date(parseInt(since)).toISOString();
    const [visits, generations] = await Promise.all([
      supabase.from('tool_usage').select('id', { count: 'exact', head: true }).eq('tool', 'visit').gte('created_at', sinceDate),
      supabase.from('tool_usage').select('id', { count: 'exact', head: true }).neq('tool', 'visit').neq('tool', 'paywall').gte('created_at', sinceDate),
    ]);
    res.json({ visits: visits.count || 0, generations: generations.count || 0 });
  } catch (err) {
    res.status(500).json({ error: 'Failed.' });
  }
});

app.get('/api/admin/stats', async (req, res) => {
  if (!checkAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [allRows, todayRows, paywallRows, visitRows, byTool, topVisitors, recent, dailyCounts] = await Promise.all([
      supabase.from('tool_usage').select('id', { count: 'exact', head: true }).neq('tool', 'paywall').neq('tool', 'visit'),
      supabase.from('tool_usage').select('id', { count: 'exact', head: true }).neq('tool', 'paywall').neq('tool', 'visit').gte('created_at', today.toISOString()),
      supabase.from('tool_usage').select('id', { count: 'exact', head: true }).eq('tool', 'paywall'),
      supabase.from('tool_usage').select('id', { count: 'exact', head: true }).eq('tool', 'visit'),
      supabase.rpc('get_by_tool'),
      supabase.rpc('get_top_visitors'),
      supabase.from('tool_usage').select('tool, ip_address, location, is_admin, session_id, device, browser, referrer, visit_count, time_on_page, created_at').order('created_at', { ascending: false }).limit(20),
      supabase.rpc('get_daily_counts'),
    ]);

    const allSessions = await supabase.from('tool_usage').select('session_id').neq('session_id', null);
    const uniqueSessions = new Set((allSessions.data || []).map(r => r.session_id)).size;

    const uniqueVisitors = await supabase.from('tool_usage').select('ip_address').neq('ip_address', null);
    const uniqueIPs = new Set((uniqueVisitors.data || []).map(r => r.ip_address)).size;

    res.json({
      total: allRows.count || 0,
      today: todayRows.count || 0,
      paywallHits: paywallRows.count || 0,
      totalVisits: visitRows.count || 0,
      uniqueVisitors: uniqueIPs,
      uniqueSessions,
      byTool: byTool.data || [],
      topVisitors: topVisitors.data || [],
      recent: recent.data || [],
      dailyCounts: dailyCounts.data || [],
    });
  } catch (err) {
    console.error('Stats error:', err.message);
    res.status(500).json({ error: 'Failed to load stats.' });
  }
});

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (
    username === process.env.ADMIN_USERNAME &&
    password === process.env.ADMIN_PASSWORD
  ) {
    res.json({ token: process.env.ADMIN_TOKEN });
  } else {
    res.status(401).json({ error: 'Invalid credentials.' });
  }
});

// Fallback — serve frontend for all other routes
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
