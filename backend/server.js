require('dotenv').config();
const express = require('express');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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
    res.json({ content: message.content[0].text.trim() });
  } catch (err) {
    console.error('Anthropic error:', err.message);
    res.status(500).json({ error: 'Failed to generate. Please try again.' });
  }
});

// Fallback — serve frontend for all other routes
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
