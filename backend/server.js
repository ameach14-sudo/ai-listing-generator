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
  const { type, price, beds, baths, sqft, year, neighborhood, features, tone, length } = req.body;

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

// Fallback — serve frontend for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
